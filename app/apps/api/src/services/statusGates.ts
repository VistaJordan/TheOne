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
  PARTS_REQUIRED_KEY,
  STATUS_GATE_ERROR_CODE,
  describeStatusGate,
  partsRequiredFilled,
  statusGateFor,
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
 * Why a move of ONE work order into `targetStatusName` would be refused, or
 * null when it may go ahead. `partsValue` lets a caller that already holds
 * (or is about to write) the bag value skip the read — the bulk editor may
 * set Parts Required and the status in the same patch.
 */
export async function statusGateBlocker(
  q: Queryable,
  taskId: string,
  targetStatusName: string,
  partsValue?: unknown,
): Promise<{ gate: StatusGate; message: string } | null> {
  const gate = statusGateFor(targetStatusName);
  if (!gate) return null;
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
): Promise<void> {
  const blocked = await statusGateBlocker(q, taskId, targetStatusName, partsValue);
  if (blocked) {
    throw new ApiError('CONFLICT', blocked.message, {
      code: STATUS_GATE_ERROR_CODE,
      gate: blocked.gate,
      status: targetStatusName,
    });
  }
}
