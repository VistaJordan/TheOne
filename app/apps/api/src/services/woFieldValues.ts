// Single-work-order field VALUES: the inline editor on the detail page's
// "All fields" tab writes here, and the per-field history panel reads here.
//
// This is deliberately not bulkUpdate() with one id. The bulk path treats every
// value as a string and never returns the row; the inline editor needs typed
// coercion (a checkbox stores a real boolean, a currency a real number), the
// promoted-column mirrors kept in step, and the fresh detail back in one round
// trip. The audit contract is the same one woBulk uses: one activity_log row
// per changed field via logTaskChanges().

import { withTransaction, query } from '../db.js';
import { ApiError } from '../errors.js';
import { resolveField, type ResolvedField } from './woFields.js';
import { changed, logTaskChanges, type TaskChange } from './woAudit.js';
import { dispatchAutomations, type AutoCtx } from './automations.js';
import { assertReadyToAssign, awaitingAcceptance } from './intakeGate.js';
import { applyProfitFormula } from './money.js';
import { assertNotVisitOwned } from './visits.js';
import { assertMoneyNotLocked } from './moneySync.js';
import { assertGateHoldsFields } from './statusGates.js';
import { getWorkOrderDetail } from './workOrders.js';
import { CREATED_AT_SQL } from './activity.js';
import { ACTOR_NAME_SQL } from '../lib/actorName.js';
import type { ActivityEntry } from '@theone/shared';
import { MONEY_MAX, VALIDATION_CODE, addedAssignees, withinMoneyBound } from '@theone/shared';
import { assertDateOrder, assertDispatchers, assertNoDisabledAssignees, assertNotHistoryField, checkFieldValue } from './dataRules.js';
import { addressWritten, fillFromAddress } from './addressFill.js';
import { ADDRESS_KEY } from '@theone/shared';

// ── Promoted-column mirrors ──────────────────────────────────────────────────
// The map moved to woMirrors.ts (the automations engine reads it too). The
// activity log records the FIELD change only — the mirror is derived, and two
// rows for one edit would read as two edits.
import { MIRROR_BY_JSON_KEY } from './woMirrors.js';

/** Coerce an inline-editor value to what the bag should hold for this field's
    type. `null` means "clear the key". Throws on a value that would corrupt a
    typed comparison later (letters in a currency, a non-date in a date). */
function coerceValue(f: ResolvedField, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (f.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).toLowerCase();
      if (['true', 'yes', '1'].includes(s)) return true;
      if (['false', 'no', '0'].includes(s)) return false;
      throw new ApiError('BAD_REQUEST', `"${f.label}" is a checkbox — send true or false`);
    }
    case 'number':
    case 'money': {
      const digits = typeof raw === 'number' ? String(raw) : String(raw).replace(/[^0-9.-]/g, '');
      if (!/^-?\d*\.?\d+$/.test(digits) || !Number.isFinite(Number(digits))) {
        throw new ApiError('BAD_REQUEST', `"${f.label}" needs a number`);
      }
      // 0083 (M1): a figure a column (the NTE mirror is numeric(12,2)) or a
      // sum of a few could not hold is refused here, not as a 500 later.
      if (f.type === 'money' && !withinMoneyBound(Number(digits))) {
        throw new ApiError('BAD_REQUEST', `"${f.label}" can be at most ${MONEY_MAX.toLocaleString('en-US')}`, {
          code: VALIDATION_CODE,
        });
      }
      return Number(digits);
    }
    case 'date': {
      const s = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        throw new ApiError('BAD_REQUEST', `"${f.label}" needs a date (YYYY-MM-DD)`);
      }
      return s;
    }
    case 'datetime': {
      // The editor sends datetime-local's 'YYYY-MM-DDTHH:MM'; a bare date is
      // fine too (an operator may only know the day). Normalized to minutes.
      const s = String(raw).trim().replace(' ', 'T').slice(0, 16);
      if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s)) {
        throw new ApiError(
          'BAD_REQUEST',
          `"${f.label}" needs a date and time (YYYY-MM-DDTHH:MM)`,
        );
      }
      return s;
    }
    default: {
      const s = String(raw).trim();
      return s === '' ? null : s;
    }
  }
}

/** Wave D: one raw value checked the way the field editor checks it (type,
    client record, option, state, sign, date floor); returns the canonical
    spelling for a client / State / dropdown, else the raw value untouched.
    Bulk edit writes strings, so only the spelling is swapped. */
export async function checkWriteValue(f: ResolvedField, raw: unknown): Promise<unknown> {
  if (raw === null || raw === undefined || raw === '') return raw;
  const checked = await checkFieldValue(f, coerceValue(f, raw));
  if (checked !== null && (f.jsonKey === 'Client' || f.jsonKey === 'State' || f.subtype === 'dropdown')) return checked;
  return raw;
}

/**
 * Wave D (M2 / #11 / L3): a whole bag about to be INSERTed (Add work order,
 * an intake draft's Submit) checked the way the field editor checks one
 * value. Values keep the shape the form sent — only a client, a State and a
 * dropdown come back in their canonical spelling — so nothing else about how
 * a new work order is stored changes. Keys the catalogue does not know are
 * left alone (the callers only pass keys their form offers).
 */
export async function validateBagValues(bag: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...bag };
  for (const [jsonKey, raw] of Object.entries(bag)) {
    let f: ResolvedField;
    try {
      f = await resolveField(`fields.${jsonKey}`);
    } catch {
      continue;
    }
    if (!f.custom) continue;
    assertNotHistoryField([jsonKey], () => f.label);
    const checked = await checkFieldValue(f, coerceValue(f, raw));
    if (checked !== null && (jsonKey === 'Client' || jsonKey === 'State' || f.subtype === 'dropdown')) out[jsonKey] = checked;
  }
  assertDateOrder(out, Object.keys(out));
  return out;
}

/** For the mirror column: the value cast the column expects, from the coerced
    bag value. Bag `null` clears the column too. */
function mirrorValue(cast: 'text' | 'numeric' | 'date', v: unknown): unknown {
  if (v === null) return null;
  if (cast === 'numeric') return typeof v === 'number' ? v : Number(v);
  return String(v);
}

export async function updateWorkOrderFields(
  idOrWo: string,
  values: Record<string, unknown>,
  actorId: string,
  auto?: AutoCtx,
  /** `system`: a write the system makes on its own schedule (a PM raise) —
      the assignee it carries was checked when the schedule was saved. */
  opts: { system?: boolean } = {},
) {
  const entries = Object.entries(values);
  if (entries.length === 0) throw new ApiError('BAD_REQUEST', 'Nothing to change');

  // Catalogue lookups need no lock; the bag itself is read FOR NO KEY UPDATE below.
  const patch: { jsonKey: string; value: unknown; resolved: ResolvedField }[] = [];
  for (const [key, raw] of entries) {
    const f = await resolveField(key);
    if (!f.custom) {
      throw new ApiError('BAD_REQUEST', `"${f.label}" is not an editable custom field`);
    }
    const subtype = await subtypeOf(f.key);
    if (subtype === 'formula') {
      throw new ApiError('BAD_REQUEST', `"${f.label}" is computed — it cannot be edited directly`);
    }
    if (subtype === 'attachment') {
      throw new ApiError('BAD_REQUEST', `"${f.label}" holds a file — attachments are not edited here yet`);
    }
    // Wave D (M2 / #11): the value is checked for its type — a client
    // record, an option, a state code, no negative money, no date before
    // 2000 — and stored in the record's / option's own spelling.
    patch.push({ jsonKey: f.jsonKey as string, value: await checkFieldValue(f, coerceValue(f, raw)), resolved: f });
  }
  // L3 (Wave D): a history the system keeps is never typed, super admins included.
  assertNotHistoryField(
    patch.map((p) => p.jsonKey),
    (k) => patch.find((p) => p.jsonKey === k)?.resolved.label ?? k,
  );
  // The seven check-in/out fields mirror the visit log (0021) and are not
  // edited by hand any more — the message points at the CICO tab.
  assertNotVisitOwned(
    patch.map((p) => p.jsonKey),
    (k) => patch.find((p) => p.jsonKey === k)?.resolved.label ?? k,
  );

  const row = await query<{ id: string }>(
    `SELECT t.id FROM task t
      WHERE (t.id::text = $1 OR t.wo_number = $1) AND t.deleted_at IS NULL LIMIT 1`,
    [idOrWo],
  );
  if (!row.rows[0]) throw new ApiError('NOT_FOUND', 'Work order not found');
  const task = row.rows[0];
  // Reads that need no lock run on the pool first; the bag is read FOR NO KEY UPDATE inside the transaction.
  const log: TaskChange[] = [];
  // City / State / Zip Code read off an address this save wrote, logged
  // `via: 'address'` (services/addressFill.ts).
  const addressLog: TaskChange[] = [];
  await withTransaction(async (tx) => {
    // THE lock strength for a bag write — here and in every other writer of
    // task.fields (woBulk, visits, signoff, assigneeHistory, moneySync), which
    // point back to this note: FOR NO KEY UPDATE, not FOR UPDATE. No bag write
    // changes task.id or task.wo_number, the unique-indexed columns, so NO KEY
    // UPDATE serialises bag writers among themselves exactly as FOR UPDATE
    // does, but it does not conflict with the KEY SHARE a child INSERT (a
    // comment, an attachment, a visit, an approval task, a payment request)
    // takes on the task row through its foreign key: a child insert no longer
    // waits behind a bag write, and the deadlock where two transactions each
    // hold that KEY SHARE and wait to upgrade to FOR UPDATE cannot happen.
    // The parent-first order createVisit and the sign-off writes take stays
    // as belt and braces. A SET that ever names id or wo_number takes FOR
    // UPDATE on its own and would need the explicit FOR UPDATE back — keep
    // this true when a SET list grows (tests/bag-lock.test.ts pins it).
    const locked = await tx.query<{ fields: Record<string, unknown> | null }>(
      `SELECT fields FROM task WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`,
      [task.id],
    );
    if (!locked.rows[0]) throw new ApiError('NOT_FOUND', 'Work order not found');
    // Cost and Total Invoiced are not typed over a figure the system put
    // there — asked under the row lock, so a payment or quote write that
    // lands between the pool reads above and this lock is seen (W3-3).
    await assertMoneyNotLocked([task.id], patch.map((p) => p.jsonKey), tx);
    // M3 (Wave C): while the work order sits in a gated status, what the gate
    // asked for is not emptied (Parts Required in a parts status, the Cost
    // done or later). Read under the row lock, so the status cannot move.
    const st = await tx.query<{ name: string }>(
      `SELECT s.name FROM task t JOIN status s ON s.id = t.status_id WHERE t.id = $1`,
      [task.id],
    );
    assertGateHoldsFields(
      st.rows[0]?.name ?? null,
      patch,
      (k) => patch.find((p) => p.jsonKey === k)?.resolved.label ?? k,
    );
    // THE locked read: before / after and the merged bag come from this row,
    // never from an earlier read, so a key another connection wrote in the
    // meantime is kept, not overwritten (W3-3).
    const fields = locked.rows[0].fields ?? {};
    const merged: Record<string, unknown> = { ...fields };
    const mirrorSets: { column: string; cast: string; value: unknown }[] = [];

    for (const p of patch) {
      const before = fields[p.jsonKey] ?? null;
      if (!changed(before, p.value)) continue;
      if (p.value === null) delete merged[p.jsonKey];
      else merged[p.jsonKey] = p.value;
      log.push({ field: `fields.${p.jsonKey}`, before, after: p.value });

      const mirror = MIRROR_BY_JSON_KEY[p.jsonKey];
      if (mirror) mirrorSets.push({ ...mirror, value: mirrorValue(mirror.cast, p.value) });
    }
    if (log.length === 0) return;

    // The address fills City, State and Zip Code; a part this same save set
    // by hand is left as typed.
    const addr = log.find((c) => c.field === `fields.${ADDRESS_KEY}`);
    if (addr && addressWritten(addr.before, addr.after)) {
      const fills = await fillFromAddress(merged, new Set(patch.map((p) => p.jsonKey)), tx);
      for (const f of fills) {
        addressLog.push({ field: `fields.${f.key}`, before: f.before, after: f.after });
        const mirror = MIRROR_BY_JSON_KEY[f.key];
        if (mirror) mirrorSets.push({ ...mirror, value: mirrorValue(mirror.cast, f.after) });
      }
    }

    // M2 (Wave D): Received on ≤ Due date, against the bag as this save leaves it.
    assertDateOrder(merged, log.map((c) => c.field.slice('fields.'.length)));
    // #22 / M22 (Wave D, D3): a name ADDED to the Assignee seat is an active
    // dispatcher. A rule's own write (auto) and the system's (opts.system)
    // are not a person picking — the rule / schedule is checked where it is saved.
    // A disabled account is refused on every path, the rule and the schedule
    // included (either may name someone disabled since it was saved).
    const seat = log.find((c) => c.field === 'fields.Assignee');
    if (seat && !auto && !opts.system) {
      await assertDispatchers(addedAssignees(seat.before, seat.after), 'fields.Assignee', tx);
    } else if (seat) {
      await assertNoDisabledAssignees(addedAssignees(seat.before, seat.after), 'fields.Assignee', tx);
    }

    // Rule 11.1.1: filling the Assignee seat on a work order still waiting in
    // Incoming is the same act as accepting it, so the intake fields must be
    // filled — checked against the bag as this save leaves it.
    if (
      log.some((c) => c.field === 'fields.Assignee' && c.after !== null && String(c.after).trim() !== '') &&
      (await awaitingAcceptance(tx, task.id))
    ) {
      await assertReadyToAssign(tx, task.id, merged);
    }
    // Profit = Total Invoiced − Cost, recomputed on every write. Derived, so
    // no activity row of its own (the mirror-column rule) — the trail shows
    // the input that moved.
    applyProfitFormula(merged);
    const sets = [`fields = $1::jsonb`];
    const params: unknown[] = [JSON.stringify(merged)];
    for (const m of mirrorSets) {
      params.push(m.value);
      sets.push(`${m.column} = $${params.length}::${m.cast}`);
    }
    params.push(task.id);
    await tx.query(
      `UPDATE task SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
      params,
    );
    await logTaskChanges(tx, actorId, task.id, log, auto?.by);
    if (addressLog.length > 0) await logTaskChanges(tx, actorId, task.id, addressLog, 'address');
  });
  if (log.length > 0) {
    // Automations react after the commit, before the fresh detail is read.
    await dispatchAutomations({ taskId: task.id, kind: 'changed', changes: [...log, ...addressLog] }, auto);
  }

  // The fresh detail, whether or not anything changed — saving the value a
  // field already had is a no-op, not an error (unlike bulk, where "nothing to
  // change" means the operator picked nothing in the dialog).
  return { changed: log.length, detail: await getWorkOrderDetail(task.id) };
}

/** The field_def subtype for a catalogue key, for the formula write-guard. */
async function subtypeOf(catalogueKey: string): Promise<string | null> {
  const jsonKey = catalogueKey.startsWith('fields.')
    ? catalogueKey.slice('fields.'.length)
    : catalogueKey;
  const res = await query<{ type: string }>(
    `SELECT type::text AS type FROM field_def WHERE key = $1 LIMIT 1`,
    [jsonKey],
  );
  return res.rows[0]?.type ?? null;
}

// ── Per-field history ────────────────────────────────────────────────────────

/**
 * Every change ever recorded for ONE field of ONE work order, newest first.
 * For a mirrored field the trail also includes writes that went through the
 * promoted column (a bulk edit of `billing_entity` IS a Comp change).
 */
export async function getFieldHistory(
  taskId: string,
  catalogueKey: string,
  limit: number,
): Promise<ActivityEntry[]> {
  const f = await resolveField(catalogueKey); // throws on unknown keys
  const fieldKeys = [f.custom ? `fields.${f.jsonKey}` : f.key];
  if (f.custom && f.jsonKey && MIRROR_BY_JSON_KEY[f.jsonKey]) {
    fieldKeys.push(MIRROR_BY_JSON_KEY[f.jsonKey].column);
  }

  const holes = fieldKeys.map((_, i) => `$${i + 2}`).join(', ');
  const res = await query<{
    id: number | string;
    action: string;
    field: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    actor_id: string;
    actor_name: string;
    actor_kind: 'human' | 'service';
    created_at: string;
  }>(
    `SELECT a.id, a.action, a.field, a.before, a.after,
            p.id AS actor_id, ${ACTOR_NAME_SQL} AS actor_name, p.kind AS actor_kind,
            ${CREATED_AT_SQL} AS created_at
       FROM activity_log a
       JOIN principal p ON p.id = a.actor_principal_id
      WHERE a.entity_type = 'task' AND a.entity_id = $1::text AND a.field IN (${holes})
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${fieldKeys.length + 2}`,
    [taskId, ...fieldKeys, limit],
  );

  return res.rows.map((r) => ({
    id: Number(r.id),
    action: r.action,
    field: r.field,
    before: r.before,
    after: r.after,
    actor: { id: r.actor_id, display_name: r.actor_name, kind: r.actor_kind },
    created_at: r.created_at,
  }));
}
