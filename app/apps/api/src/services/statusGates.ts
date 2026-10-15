// Rules 11.2.1 / 11.2.2 — the "Quoting & Parts" gate, database half.
//
// The vocabulary (which status opens which gate, what "filled" means, the
// sentence) is in @theone/shared statusGates.ts; this file answers the
// question against the rows and throws the 409. Called from every path that
// moves a status: changeStatus (the single move, an approval-driven move and
// an automation's status action all go through it), bulkUpdate (writes the
// status itself), requestStatusChange (a request for a move the gate would
// refuse is refused up front, so a manager is never asked to approve one)
// and decide (asked again at approval time, before the decision commits,
// because the quote or the parts may have been emptied since the request).

import {
  BFI_KEY,
  FINAL_COST_KEY,
  INVOICING_GATED_STATUS_NAMES,
  PARTS_REQUIRED_KEY,
  STATUS_GATE_ERROR_CODE,
  describeGateHold,
  describeStatusGate,
  doneGateMissing,
  gateHoldingField,
  statusHoldsQuote,
  partsRequiredFilled,
  statusGateFor,
  type DoneGateCheck,
  type StatusGate,
} from '@theone/shared';
import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';

/** The ids in `ids` whose quote contains data — a line item or a non-blank
    scope line in any section. An empty draft does not count (11.2.1). */
export async function quoteFilledTaskIds(q: Queryable, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const res = await q.query<{ task_id: string }>(
    `SELECT DISTINCT q.task_id::text AS task_id
       FROM quote q
       JOIN quote_section s ON s.quote_id = q.id
       LEFT JOIN quote_line l ON l.section_id = s.id
      WHERE q.task_id = ANY($1::uuid[])
        AND (l.id IS NOT NULL
             OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.scope_lines) AS sl(v)
                         WHERE btrim(sl.v) <> ''))`,
    [ids],
  );
  return new Set(res.rows.map((r) => r.task_id));
}

/**
 * Rules 11.3.1–11.3.4 against the rows: which of the Done gate's checks
 * fail for one work order. 11.3.1 reads the visit log (0021) — "both stamps
 * NOT NULL" is a visit that checked in and checked out, any visit, since a
 * planned return trip after a finished job must not undo the job; 11.3.2
 * reads the Cost bag key; 11.3.3 asks the 11.2.1 question of the quote.
 */
export async function doneGateMissingFor(q: Queryable, taskId: string): Promise<DoneGateCheck[]> {
  const res = await q.query<{
    visit_complete: boolean;
    cost: unknown;
    bfi: unknown;
    approved_kinds: string[] | null;
  }>(
    `SELECT EXISTS (SELECT 1 FROM wo_visit v
                     WHERE v.task_id = t.id
                       AND v.checked_in_at IS NOT NULL
                       AND v.checked_out_at IS NOT NULL) AS visit_complete,
            t.fields -> $2::text AS cost,
            t.fields -> $3::text AS bfi,
            ARRAY(SELECT DISTINCT a.kind
                    FROM attachment a
                   WHERE a.task_id = t.id
                     AND a.review_status = 'approved'
                     AND a.kind IS NOT NULL
                     AND a.storage_key IS NOT NULL) AS approved_kinds
       FROM task t
      WHERE t.id = $1
      LIMIT 1`,
    [taskId, FINAL_COST_KEY, BFI_KEY],
  );
  const row = res.rows[0];
  const quoteFilled = (await quoteFilledTaskIds(q, [taskId])).has(taskId);
  return doneGateMissing({
    visitComplete: Boolean(row?.visit_complete),
    costValue: row?.cost ?? null,
    quoteFilled,
    // 11.3.4 (0061): an approved after photo, or for a BFI job an approved
    // before photo and sign-off. Only files that are really in storage count.
    proof: { bfi: row?.bfi ?? null, approvedKinds: row?.approved_kinds ?? [] },
  });
}

/**
 * Why a move of ONE work order into `targetStatusName` would be refused, or
 * null when it may go ahead. `partsValue` lets a caller that already holds
 * (or is about to write) the bag value skip the read — the bulk editor may
 * set Parts Required and the status in the same patch. For the Done gate
 * `missing` says which of the three checks failed.
 */
export async function statusGateBlocker(
  q: Queryable,
  taskId: string,
  targetStatusName: string,
  partsValue?: unknown,
  currentStatusName?: string | null,
): Promise<{ gate: StatusGate; message: string; missing?: DoneGateCheck[] } | null> {
  // #2 (Wave C): a billing status is gated unless the work order is already
  // done or later, so the current status is read when the caller did not say.
  let current = currentStatusName;
  const n = targetStatusName.trim().toLowerCase();
  if (current === undefined && INVOICING_GATED_STATUS_NAMES.some((s) => s.toLowerCase() === n)) {
    const res = await q.query<{ name: string }>(
      `SELECT s.name FROM task t JOIN status s ON s.id = t.status_id WHERE t.id = $1 LIMIT 1`,
      [taskId],
    );
    current = res.rows[0]?.name ?? null;
  }
  const gate = statusGateFor(targetStatusName, current);
  if (!gate) return null;
  if (gate === 'done') {
    const missing = await doneGateMissingFor(q, taskId);
    return missing.length === 0
      ? null
      : { gate, message: describeStatusGate(gate, targetStatusName, missing), missing };
  }
  let ok: boolean;
  if (gate === 'quote') {
    ok = (await quoteFilledTaskIds(q, [taskId])).has(taskId);
  } else if (partsValue !== undefined) {
    ok = partsRequiredFilled(partsValue);
  } else {
    const res = await q.query<{ parts: unknown }>(
      `SELECT fields -> $2::text AS parts FROM task WHERE id = $1 LIMIT 1`,
      [taskId, PARTS_REQUIRED_KEY],
    );
    ok = partsRequiredFilled(res.rows[0]?.parts ?? null);
  }
  return ok ? null : { gate, message: describeStatusGate(gate, targetStatusName) };
}

/** Throws the 409 (`details.code = STATUS_GATE`, `details.gate`) when the
    gate refuses the move. */
export async function assertStatusGate(
  q: Queryable,
  taskId: string,
  targetStatusName: string,
  partsValue?: unknown,
  currentStatusName?: string | null,
): Promise<void> {
  const blocked = await statusGateBlocker(q, taskId, targetStatusName, partsValue, currentStatusName);
  if (blocked) {
    throw new ApiError('CONFLICT', blocked.message, {
      code: STATUS_GATE_ERROR_CODE,
      gate: blocked.gate,
      status: targetStatusName,
      ...(blocked.missing ? { missing: blocked.missing } : {}),
    });
  }
}

// ── M3 (Wave C) · a gated status holds its field ─────────────────────────────

/** 409 STATUS_GATE (`details.held = true`) when the write would empty what
    the work order's current status was gated on. `labelOf` names the field
    as the person called it. */
export function assertGateHoldsFields(
  currentStatusName: string | null | undefined,
  patch: readonly { jsonKey: string; value: unknown }[],
  labelOf: (jsonKey: string) => string = (k) => k,
  woNumber?: string,
): void {
  for (const p of patch) {
    const gate = gateHoldingField(currentStatusName, p.jsonKey, p.value);
    if (!gate) continue;
    const status = currentStatusName ?? '';
    throw new ApiError('CONFLICT', `${woNumber ? `${woNumber}: ` : ''}${describeGateHold(`"${labelOf(p.jsonKey)}"`, status)}`, {
      code: STATUS_GATE_ERROR_CODE,
      gate,
      status,
      held: true,
      field: p.jsonKey,
      ...(woNumber ? { wo_numbers: [woNumber] } : {}),
    });
  }
}

/** M3 for the quote: 409 when a quote write leaves the quote without data
    while the work order sits in Quote Ready or done-or-later. Asked on the
    quote's own transaction after the write, so a refusal rolls it back. */
export async function assertQuoteHeld(q: Queryable, taskId: string): Promise<void> {
  const res = await q.query<{ name: string }>(
    `SELECT s.name FROM task t JOIN status s ON s.id = t.status_id WHERE t.id = $1 LIMIT 1`,
    [taskId],
  );
  const status = res.rows[0]?.name ?? null;
  if (!statusHoldsQuote(status)) return;
  if ((await quoteFilledTaskIds(q, [taskId])).has(taskId)) return;
  throw new ApiError('CONFLICT', describeGateHold('The quote', status ?? ''), {
    code: STATUS_GATE_ERROR_CODE,
    gate: 'quote',
    status,
    held: true,
  });
}
