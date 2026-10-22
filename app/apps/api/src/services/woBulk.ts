// Bulk edit, CSV export and CSV import for work orders.
//
// These three belong together because they share one rule: a change that
// touches many rows must still leave the same audit trail as the change that
// touches one. Every mutation below writes an `activity_log` row per work order
// per field, exactly as the single-row status path does — a bulk edit is a
// shortcut for the operator, not a hole in the record.
//
// Reads that need no lock run on the pool first; the bag is read FOR NO KEY UPDATE inside the
// transaction (the lock strength is explained once, in woFieldValues.ts).

import { withTransaction, query } from '../db.js';
import { ApiError } from '../errors.js';
import { listWorkOrders, type ListFilters } from './workOrders.js';
import type { ActingPrincipal } from './activity.js';
import { Params, listCustomFields, resolveField } from './woFields.js';
import { woScopeSql } from './woScope.js';
import { changed, logTaskChanges, type TaskChange } from './woAudit.js';
import { addressWritten, fillFromAddress } from './addressFill.js';
import { ADDRESS_KEY } from '@theone/shared';
import { dispatchAutomations } from './automations.js';
import { raiseAcceptanceTasks } from './approvals.js';
import { assertReadyToAssign, awaitingAcceptance } from './intakeGate.js';
import { applyProfitFormula } from './money.js';
import { stampDateCreated } from './dateCreated.js';
import { assertNotVisitOwned } from './visits.js';
import { assertDateOrder, assertDispatchers, assertNotHistoryField, canonicalClient, clientRecordNames } from './dataRules.js';
import { checkWriteValue } from './woFieldValues.js';
import { assertMoneyNotLocked } from './moneySync.js';
import { assertGateHoldsFields, doneGateMissingFor, quoteFilledTaskIds } from './statusGates.js';
import {
  PARTS_REQUIRED_KEY,
  STATUS_GATE_ERROR_CODE,
  describeStatusGate,
  partsRequiredFilled,
  statusGateFor,
  type DoneGateCheck,
  type WorkOrderListItem,
  isComputedWoColumn,
  permAllows,
  VALIDATION_CODE,
  CLIENT_FIELD_KEY,
  IMPORT_UNKNOWN_CLIENT_CODE,
  assigneeNames,
  matchClientRecord,
  normalizeUsState,
} from '@theone/shared';

/** `$1, $2, …` for a list of values — the id sets below are bound as ordinary scalars. */
function placeholders(n: number): string {
  return Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ');
}

// ── Bulk edit ────────────────────────────────────────────────────────────────

/** Promoted columns a bulk edit may write. Anything not here is a custom field
    and lands in the JSONB bag instead. */
const BULK_COLUMNS = {
  client: 'text',
  trade: 'text',
  city: 'text',
  state: 'text',
  billing_entity: 'text',
  priority: 'text',
  nte: 'numeric',
  date_received: 'date',
} as const;

export type BulkColumn = keyof typeof BULK_COLUMNS;

export interface BulkPatch {
  status_id?: string;
  /** Route the work orders to a different home list, by list id. */
  home_list_id?: string | null;
  client?: string | null;
  trade?: string | null;
  city?: string | null;
  state?: string | null;
  billing_entity?: string | null;
  priority?: string | null;
  nte?: number | null;
  date_received?: string | null;
  /** Custom fields, keyed `fields.<key>`. A null value clears the key. */
  fields?: Record<string, string | null>;
}

export interface BulkResult {
  requested: number;
  updated: number;
  skipped: { wo_number: string; reason: string }[];
}

/** True when the patch would write nothing — the caller opened the editor and
    saved without choosing anything. */
function isEmptyPatch(patch: BulkPatch): boolean {
  const scalar = Object.keys(patch).filter((k) => k !== 'fields');
  return scalar.length === 0 && Object.keys(patch.fields ?? {}).length === 0;
}

export async function bulkUpdate(
  ids: string[],
  patch: BulkPatch,
  actorId: string,
): Promise<BulkResult> {
  if (ids.length === 0) throw new ApiError('BAD_REQUEST', 'No work orders selected');
  if (isEmptyPatch(patch)) throw new ApiError('BAD_REQUEST', 'Nothing to change');

  // ── Pre-transaction resolution ─────────────────────────────────────────────
  let targetStatus: { id: string; name: string; status_group: string } | null = null;
  if (patch.status_id) {
    const res = await query<{ id: string; name: string; status_group: string }>(
      `SELECT id, name, status_group FROM status WHERE id = $1 LIMIT 1`,
      [patch.status_id],
    );
    if (!res.rows[0]) {
      throw new ApiError('BAD_REQUEST', 'Unknown status_id', { status_id: patch.status_id });
    }
    targetStatus = res.rows[0];
  }

  let targetList: { id: string; name: string } | null = null;
  if (patch.home_list_id) {
    const res = await query<{ id: string; name: string }>(
      `SELECT id, name FROM container WHERE id = $1 AND kind = 'list' LIMIT 1`,
      [patch.home_list_id],
    );
    if (!res.rows[0]) {
      throw new ApiError('BAD_REQUEST', 'Unknown home list', { home_list_id: patch.home_list_id });
    }
    targetList = res.rows[0];
  }

  // Custom field keys are checked against the catalogue so a typo cannot quietly
  // create a new key nothing reads.
  const customPatch: { key: string; value: string | null }[] = [];
  for (const [key, value] of Object.entries(patch.fields ?? {})) {
    const f = await resolveField(key);
    if (!f.custom) throw new ApiError('BAD_REQUEST', `"${f.label}" is not a custom field`);
    customPatch.push({ key: f.jsonKey as string, value });
  }
  // The check-in/out fields mirror the visit log (0021): not bulk-editable.
  assertNotVisitOwned(customPatch.map((c) => c.key));
  // L3 (Wave D): nor a history the system keeps.
  assertNotHistoryField(customPatch.map((c) => c.key));
  // M2 / #11 (Wave D): each value checked for its type, the Client a record,
  // a State a code, a dropdown one of its options (their spelling is kept).
  for (const c of customPatch) {
    if (c.value === null || c.value === '') continue;
    const f = await resolveField(`fields.${c.key}`);
    c.value = String(await checkWriteValue(f, c.value));
  }
  if (patch.client !== undefined && patch.client !== null && patch.client.trim() !== '') {
    patch = { ...patch, client: await canonicalClient(patch.client, 'client') };
  }
  if (patch.state !== undefined && patch.state !== null && patch.state.trim() !== '') {
    const st = normalizeUsState(patch.state);
    if (!st) throw new ApiError('BAD_REQUEST', '"State" needs a US state code (for example TX)', { code: VALIDATION_CODE, field: 'state' });
    patch = { ...patch, state: st };
  }
  // #22 / M22 (D3): an Assignee written in bulk names active dispatchers.
  {
    const seat = customPatch.find((c) => c.key === 'Assignee');
    if (seat && seat.value) await assertDispatchers(assigneeNames(seat.value), 'fields.Assignee');
  }

  const rows = await query<{
    id: string;
    wo_number: string;
    status_id: string;
    status_name: string;
    home_list_id: string | null;
    home_list_name: string | null;
    client: string | null;
    trade: string | null;
    city: string | null;
    state: string | null;
    billing_entity: string | null;
    priority: string | null;
    nte: string | null;
    date_received: string | null;
    fields: Record<string, unknown>;
  }>(
    `SELECT t.id, t.wo_number, t.status_id, s.name AS status_name,
            t.home_list_id, hl.name AS home_list_name,
            t.client, t.trade, t.city, t.state, t.billing_entity, t.priority,
            t.nte::text AS nte, t.date_received::text AS date_received, t.fields
       FROM task t
       JOIN status s ON s.id = t.status_id
       LEFT JOIN container hl ON hl.id = t.home_list_id
      WHERE t.id IN (${placeholders(ids.length)}) AND t.deleted_at IS NULL
      ORDER BY t.id`,
    ids,
  );

  // Cost / Total Invoiced the system put there are not bulk-typed over; the
  // 400 names the work orders in the way.
  await assertMoneyNotLocked(rows.rows.map((r) => r.id), customPatch.map((c) => c.key));

  const found = new Map(rows.rows.map((r) => [r.id, r]));
  const skipped: { wo_number: string; reason: string }[] = [];
  for (const id of ids) {
    if (!found.has(id)) skipped.push({ wo_number: id, reason: 'Not found or deleted' });
  }

  // Rules 11.2.1 / 11.2.2: a bulk move into a gated status is refused for the
  // WHOLE selection when any row would fail — like the scope check, a bulk
  // edit never half-applies. A Parts Required value in the same patch counts
  // for every row it lands on.
  if (targetStatus) {
    const target = targetStatus;
    // #2 (Wave C): the gate depends on where each row sits — a billing
    // status is open to a row already done or later — so it is asked per row.
    const moving = rows.rows.filter((r) => r.status_id !== target.id);
    const gated = moving.map((r) => ({ r, gate: statusGateFor(target.name, r.status_name) })).filter((x) => x.gate !== null);
    if (gated.length > 0) {
      const gate = gated[0].gate as NonNullable<ReturnType<typeof statusGateFor>>;
      const partsPatch = customPatch.find((c) => c.key === PARTS_REQUIRED_KEY);
      const quoteOk = gate === 'quote' ? await quoteFilledTaskIds({ query }, gated.map((x) => x.r.id)) : null;
      // Rules 11.3.1–11.3.3: the Done gate reads visits, cost and quote per row.
      const doneMissing = new Map<string, DoneGateCheck[]>();
      if (gate === 'done') {
        for (const { r } of gated) doneMissing.set(r.id, await doneGateMissingFor({ query }, r.id));
      }
      const blocked = gated
        .map((x) => x.r)
        .filter((r) =>
          gate === 'quote'
            ? !(quoteOk as Set<string>).has(r.id)
            : gate === 'done'
              ? (doneMissing.get(r.id)?.length ?? 0) > 0
              : !partsRequiredFilled(partsPatch ? partsPatch.value : r.fields?.[PARTS_REQUIRED_KEY]),
        );
      if (blocked.length > 0) {
        const names = blocked.map((r) => r.wo_number);
        const who =
          names.length === 1
            ? `${names[0]} is missing it.`
            : `${names.length} of the selected work orders are missing it (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}).`;
        throw new ApiError('CONFLICT', `${describeStatusGate(gate, target.name)} ${who}`, {
          code: STATUS_GATE_ERROR_CODE,
          gate,
          status: target.name,
          wo_numbers: names,
        });
      }
    }
  }

  // M3 (Wave C): a row that stays in (or moves to) a gated status keeps what
  // the gate asked for — the whole selection is refused, like the gate above.
  if (customPatch.length > 0) {
    for (const r of rows.rows) {
      const statusAfter = targetStatus ? targetStatus.name : r.status_name;
      assertGateHoldsFields(
        statusAfter,
        customPatch.map((c) => ({ jsonKey: c.key, value: c.value })),
        (k) => k,
        r.wo_number,
      );
    }
  }

  let updated = 0;
  // What each row's write logged, for the automations engine (post-commit).
  const firedRows: { id: string; log: TaskChange[] }[] = [];

  await withTransaction(async (tx) => {
    // The rows came ORDER BY id and are locked in that order — the import's
    // update loop sorts the same way — so two overlapping runs can never wait
    // on each other in a circle (40P01).
    for (const row of rows.rows) {
      // D4 (W3-3): the bag is read FOR NO KEY UPDATE here (the strength is
      // explained in woFieldValues.ts), so the merge below is against what
      // the row holds NOW — a write that landed between the pool read above
      // and this lock is kept, not overwritten.
      const locked = await tx.query<{ fields: Record<string, unknown> | null }>(
        `SELECT fields FROM task WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`,
        [row.id],
      );
      if (!locked.rows[0]) {
        skipped.push({ wo_number: row.wo_number, reason: 'Deleted meanwhile' });
        continue;
      }
      const rowFields = locked.rows[0].fields ?? {};
      // Re-asked under the lock: the pool check above named every row in the
      // way up front; this one catches a system write that landed since (W3-3).
      await assertMoneyNotLocked([row.id], customPatch.map((c) => c.key), tx);
      // M3, re-asked under the lock: the status cannot move while we hold it.
      if (customPatch.length > 0 && !targetStatus) {
        const st = await tx.query<{ name: string }>(
          `SELECT s.name FROM task t JOIN status s ON s.id = t.status_id WHERE t.id = $1`,
          [row.id],
        );
        assertGateHoldsFields(st.rows[0]?.name ?? null, customPatch.map((c) => ({ jsonKey: c.key, value: c.value })), (k) => k, row.wo_number);
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      // One activity row per entry, written after the UPDATE (see woAudit.ts).
      const log: TaskChange[] = [];
      // City / State / Zip Code read off an address this edit wrote (addressFill.ts).
      const addressLog: TaskChange[] = [];

      const push = (col: string, value: unknown) => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };

      if (targetStatus && targetStatus.id !== row.status_id) {
        push('status_id', targetStatus.id);
        push('status_group', targetStatus.status_group);
        log.push({
          field: 'status_id',
          before: { status_id: row.status_id, status_name: row.status_name },
          after: { status_id: targetStatus.id, status_name: targetStatus.name },
        });
      }

      if (targetList && targetList.id !== row.home_list_id) {
        push('home_list_id', targetList.id);
        log.push({
          field: 'home_list_id',
          before: { list_id: row.home_list_id, list_name: row.home_list_name },
          after: { list_id: targetList.id, list_name: targetList.name },
        });
      }

      for (const col of Object.keys(BULK_COLUMNS) as BulkColumn[]) {
        if (!(col in patch)) continue;
        const next = patch[col] ?? null;
        const before = row[col];
        if (!changed(before, next)) continue;
        const cast = BULK_COLUMNS[col];
        params.push(next);
        sets.push(`${col} = $${params.length}::${cast}`);
        log.push({ field: col, before, after: next });
      }

      if (customPatch.length > 0) {
        const changed = customPatch.filter(
          (c) => String(rowFields[c.key] ?? '') !== String(c.value ?? ''),
        );
        if (changed.length > 0) {
          // Merge rather than replace — the bag holds ~100 keys this patch does
          // not mention. A null value removes the key outright.
          const merged: Record<string, unknown> = { ...rowFields };
          for (const c of changed) {
            if (c.value === null || c.value === '') delete merged[c.key];
            else merged[c.key] = c.value;
            log.push({ field: `fields.${c.key}`, before: rowFields[c.key] ?? null, after: c.value });
          }
          // The address fills City, State and Zip Code, unless this same edit
          // set them (the bag key, or the city / state column).
          const addr = changed.find((c) => c.key === ADDRESS_KEY);
          if (addr && addressWritten(rowFields[ADDRESS_KEY], addr.value)) {
            const explicit = new Set(customPatch.map((c) => c.key));
            if ('city' in patch) explicit.add('City');
            if ('state' in patch) explicit.add('State');
            for (const f of await fillFromAddress(merged, explicit, tx)) {
              addressLog.push({ field: `fields.${f.key}`, before: f.before, after: f.after });
              const col = f.key === 'City' ? 'city' : f.key === 'State' ? 'state' : null;
              if (col) {
                params.push(f.after);
                sets.push(`${col} = $${params.length}::text`);
              }
            }
          }
          // M2 (Wave D): Received on ≤ Due date on the row as the save leaves it.
          try {
            assertDateOrder(merged, changed.map((c) => c.key));
          } catch (err) {
            if (err instanceof ApiError) err.message = `${row.wo_number}: ${err.message}`;
            throw err;
          }
          // Rule 11.1.1: a bulk fill of the Assignee seat on a work order still
          // waiting in Incoming is gated like an accept (against the merged
          // bag); the 409 names the work order so the selection can be fixed.
          if (
            changed.some((c) => c.key === 'Assignee' && c.value !== null && String(c.value).trim() !== '') &&
            (await awaitingAcceptance(tx, row.id))
          ) {
            await assertReadyToAssign(tx, row.id, merged);
          }
          // Profit = Total Invoiced − Cost, kept in step on every bag write.
          applyProfitFormula(merged);
          params.push(JSON.stringify(merged));
          sets.push(`fields = $${params.length}::jsonb`);
        }
      }

      // Nothing to do for this row — the value it already had was the target.
      // Not an error and not a skip: the requested end state holds.
      if (sets.length === 0) continue;

      params.push(row.id);
      await tx.query(
        `UPDATE task SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
        params,
      );

      await logTaskChanges(tx, actorId, row.id, log, 'bulk');
      if (addressLog.length > 0) await logTaskChanges(tx, actorId, row.id, addressLog, 'address');
      firedRows.push({ id: row.id, log: [...log, ...addressLog] });
      updated += 1;
    }
  });

  // Automations react per row, after the whole batch has committed.
  for (const r of firedRows) {
    await dispatchAutomations({ taskId: r.id, kind: 'changed', changes: r.log });
    // 0083 (#10): no Total Invoiced stamp on a bulk move to Invoiced — the
    // figure comes from the invoice when it is sent.
  }

  return { requested: ids.length, updated, skipped };
}

/** Soft delete — the row moves to Trash, where the admin console restores it. */
export async function bulkDelete(ids: string[], actorId: string): Promise<BulkResult> {
  if (ids.length === 0) throw new ApiError('BAD_REQUEST', 'No work orders selected');

  const rows = await query<{ id: string; wo_number: string }>(
    `SELECT id, wo_number FROM task WHERE id IN (${placeholders(ids.length)})
       AND deleted_at IS NULL`,
    ids,
  );

  await withTransaction(async (tx) => {
    for (const row of rows.rows) {
      await tx.query(`UPDATE task SET deleted_at = now(), updated_at = now() WHERE id = $1`, [
        row.id,
      ]);
      await tx.query(
        `INSERT INTO activity_log
           (actor_principal_id, entity_type, entity_id, action, field, before, after)
         VALUES ($1, 'task', $2, 'deleted', 'deleted_at', NULL, 'true'::jsonb)`,
        [actorId, row.id],
      );
    }
  });

  const foundIds = new Set(rows.rows.map((r) => r.id));
  return {
    requested: ids.length,
    updated: rows.rows.length,
    skipped: ids.filter((id) => !foundIds.has(id)).map((id) => ({
      wo_number: id,
      reason: 'Not found or already deleted',
    })),
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** RFC-4180 quoting. A leading `=`, `+`, `-` or `@` is also prefixed with a
    single quote: spreadsheets treat those as formulas, and a WO description
    that starts with "-" should not execute in Excel. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/["\n\r,]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  // CRLF + a UTF-8 BOM is what makes Excel open the file in the right encoding.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** An export is a page of the list with the paging taken off. Capped so a
    mis-clicked "export everything" cannot pull the whole database into memory. */
export const EXPORT_CAP = 10_000;

/** Pull a value out of a list item by field key, for CSV and nothing else. */
function cellFor(item: WorkOrderListItem, key: string): unknown {
  if (key.startsWith('fields.') || isComputedWoColumn(key)) return item.custom?.[key] ?? '';
  switch (key) {
    case 'status':
      return item.status.name;
    case 'status_group':
      return item.status.group;
    default:
      return (item as unknown as Record<string, unknown>)[key] ?? '';
  }
}

/** The file plus what went into it, so the route can log the download (1.2.1). */
export async function exportCsv(
  filters: Omit<ListFilters, 'limit' | 'offset'>,
  columns: string[],
  actor?: ActingPrincipal,
): Promise<{ csv: string; rows: number; columns: string[] }> {
  // The list may carry UI-only columns the catalogue does not know (the
  // default arrangement's `clock` chip, lib/woView.ts): they draw nothing in
  // a CSV, so they are dropped here instead of failing the whole export with
  // `Unknown field "clock"`.
  const known: string[] = [];
  const labels: string[] = [];
  for (const key of columns) {
    try {
      labels.push((await resolveField(key)).label);
      known.push(key);
    } catch {
      /* not a field — a presentation column */
    }
  }
  const cols = known.length > 0 ? known : ['wo_number', 'title', 'client', 'status', 'nte'];
  if (known.length === 0) {
    labels.length = 0;
    for (const key of cols) labels.push((await resolveField(key)).label);
  }

  const page = await listWorkOrders(
    {
      ...filters,
      columns: cols,
      // Grouping only affects presentation; ordering by the group key still
      // makes the file easier to read, so it is left in.
      limit: EXPORT_CAP,
      offset: 0,
    },
    actor,
  );

  const csv = toCsv(
    labels,
    page.items.map((item) => cols.map((key) => cellFor(item, key))),
  );
  return { csv, rows: page.items.length, columns: cols };
}

// ── Import ───────────────────────────────────────────────────────────────────

export interface ImportRow {
  /** Values keyed by field key (`client`, `fields.Trade`, …). */
  [key: string]: string | null | undefined;
}

export interface ImportRowResult {
  row: number;
  wo_number: string | null;
  action: 'create' | 'update' | 'skip' | 'error';
  message?: string;
}

export interface ImportResult {
  dry_run: boolean;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
  rows: ImportRowResult[];
}

export const IMPORT_CAP = 2000;

/** A matched work order as the plan sees it: the bag the preview merges over,
    the status an update keeps, and whether the row is theirs or in Trash. The
    write diffs against its own locked read (`LockedRow`), not this. */
interface ExistingRow {
  id: string;
  wo_number: string;
  fields: Record<string, unknown>;
  status_id: string;
  status_name: string;
  status_group: string;
  /** D7 (W4-4): the actor's row scope, projected by the lookup — false = refuse. */
  in_scope: boolean;
  /** In Trash: the number is taken, the row is never written. */
  trashed: boolean;
}

/** What an update reads FOR NO KEY UPDATE: the bag, the status and every
    column the file may set, so the diff and the write come from one locked
    read. `wo_number` is never among the SETs (it is the match key), which is
    what lets the lock be that strength — see woFieldValues.ts. */
interface LockedRow {
  fields: Record<string, unknown> | null;
  status_id: string;
  ext_name: string | null;
  title: string | null;
  description: string | null;
  client: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  billing_entity: string | null;
  nte: string | null;
  priority: string | null;
  date_received: string | null;
}

/** Columns an import may write directly. `wo_number` is the match key, not a
    value, and `age_days` is derived — neither is settable. */
const IMPORTABLE = new Set([
  'ext_name',
  'title',
  'description',
  'client',
  'city',
  'state',
  'trade',
  'billing_entity',
  'nte',
  'priority',
  'date_received',
]);

const NUMERIC_COLS = new Set(['nte']);
const DATE_COLS = new Set(['date_received']);

function cleanNumber(v: string): number | null {
  // Strip currency symbols and thousands separators, but NOT to the point of
  // accepting nonsense: "abc" strips to "" and `Number("")` is 0, which would
  // silently import a garbage cell as $0.00 rather than reporting the row.
  const digits = v.replace(/[^0-9.-]/g, '');
  if (!/^-?\d*\.?\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function cleanDate(v: string): string | null {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Accept the M/D/YYYY a spreadsheet export produces.
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/** The bag an import writes: the file's keys over what the row holds, with
    Profit (= Total Invoiced − Cost) re-derived — one rule for the preview's
    plan and for the locked write. */
function applyFieldPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...patch };
  applyProfitFormula(merged);
  return merged;
}

export interface ImportGuardInput {
  /** WO numbers in the file that matched a work order outside the actor's scope. */
  outsideScope: string[];
  /** The rows that carry a status cell: the WO number, or `row N` for a create. */
  statusRows: string[];
  /** The rows whose home-list cell would route them (creates only), named the same way. */
  routingRows?: string[];
  /** `work_orders/status` edit — may the actor set a status directly? */
  canSetStatus: boolean;
  isSuperAdmin: boolean;
}

/** How a refusal names a row: its WO number, or `row N` (1-based) without one. */
function importRowName(r: ImportRow, i: number): string {
  return (r.wo_number ?? '').toString().trim() || `row ${i + 1}`;
}

/** The rows of a file that name a status, as `importRefusal` lists them. */
export function importStatusRows(rows: ImportRow[]): string[] {
  return rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => (r.status ?? '').toString().trim() !== '')
    .map(({ r, i }) => importRowName(r, i));
}

/** The rows whose home-list cell would take effect. Only a create honours it
    (an update keeps the list it has), so a row matching a work order on file
    is left out. Routing rides with the status grant, as it does in bulk edit. */
export function importRoutingRows(rows: ImportRow[], existing: ReadonlySet<string>): string[] {
  return rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => (r.home_list ?? '').toString().trim() !== '')
    .filter(({ r }) => !existing.has((r.wo_number ?? '').toString().trim()))
    .map(({ r, i }) => importRowName(r, i));
}

/** W4-4 (D7): the whole file is refused when any matched row is outside the
    actor's scope, or any row names a status the actor may not set — like a
    bulk edit, an import never half-applies. Super admins are never refused. */
export function importRefusal(g: ImportGuardInput): ApiError | null {
  if (g.isSuperAdmin) return null;
  if (g.outsideScope.length > 0) {
    return new ApiError('FORBIDDEN', 'Some rows in this file are work orders that are not assigned to you', {
      code: 'IMPORT_SCOPE',
      wo_numbers: g.outsideScope,
      required_permission: 'work_orders/scope:view',
    });
  }
  if (!g.canSetStatus && g.statusRows.length > 0) {
    return new ApiError(
      'FORBIDDEN',
      'You cannot set work-order status — remove the status column, or clear it on these rows',
      { code: 'IMPORT_STATUS_PERMISSION', wo_numbers: g.statusRows, required_permission: 'work_orders/status:edit' },
    );
  }
  // Routing (the home list) rides with the status grant, as in bulk edit.
  const routing = g.routingRows ?? [];
  if (!g.canSetStatus && routing.length > 0) {
    return new ApiError(
      'FORBIDDEN',
      'You cannot route work orders to a home list — remove the home list column, or clear it on these rows',
      { code: 'IMPORT_STATUS_PERMISSION', wo_numbers: routing, required_permission: 'work_orders/status:edit' },
    );
  }
  return null;
}

/**
 * Create or update work orders from parsed CSV rows.
 *
 * `dry_run` runs the whole validation pass and reports what WOULD happen
 * without writing. The import dialog always runs it first: an operator pasting
 * 400 rows from a client spreadsheet needs to see the damage before it lands,
 * not after.
 *
 * The acting principal, not just an id: a file that touches work orders
 * outside their scope, or sets a status they may not, is refused whole (D7).
 */
export async function importWorkOrders(
  rows: ImportRow[],
  opts: { mode: 'create' | 'upsert'; dry_run: boolean },
  actor: ActingPrincipal,
): Promise<ImportResult> {
  const actorId = actor.id;
  if (rows.length === 0) throw new ApiError('BAD_REQUEST', 'Nothing to import');
  if (rows.length > IMPORT_CAP) {
    throw new ApiError('BAD_REQUEST', `An import is capped at ${IMPORT_CAP} rows`);
  }

  // ── Pre-transaction lookups ────────────────────────────────────────────────
  const statuses = await query<{ id: string; name: string; status_group: string; position: number }>(
    `SELECT id, name, status_group, position FROM status ORDER BY position ASC`,
  );
  if (statuses.rows.length === 0) {
    throw new ApiError('INTERNAL', 'No statuses are configured');
  }
  const statusByName = new Map(statuses.rows.map((s) => [s.name.toLowerCase(), s]));
  const statusById = new Map(statuses.rows.map((s) => [s.id, s]));
  const defaultStatus = statuses.rows.find((s) => s.status_group === 'open') ?? statuses.rows[0];

  const lists = await query<{ id: string; name: string }>(
    `SELECT id, name FROM container WHERE kind = 'list'`,
  );
  const listByName = new Map(lists.rows.map((l) => [l.name.toLowerCase(), l]));
  const defaultList = lists.rows[0] ?? null;

  const customKeys = new Map(
    (await listCustomFields()).map((f) => [f.key, (f.key as string).slice('fields.'.length)]),
  );

  const numbers = rows
    .map((r) => (r.wo_number ?? '').toString().trim())
    .filter((n) => n.length > 0);
  // D7 (W4-4): the actor's row scope rides along as a column — the trick
  // resolveTaskId uses — so a match outside their book is known before
  // anything is planned, previewed or written. A null scope (super admin,
  // "Everything") projects TRUE.
  const p = new Params();
  const holes = numbers.map((n) => p.add(n)).join(', ');
  const scope = woScopeSql(actor, p);
  // A file with no WO numbers at all is pure creation — skip the lookup rather
  // than send `IN ()`, which is a syntax error.
  const existing = numbers.length
    ? await query<ExistingRow>(
        // A row in Trash is matched too: its number is taken (createWorkOrder
        // refuses it the same way), but the plan skips it rather than write it.
        `SELECT t.id, t.wo_number, t.fields, t.status_id, s.name AS status_name, s.status_group,
                ${scope ?? 'TRUE'} AS in_scope,
                (t.deleted_at IS NOT NULL) AS trashed
           FROM task t JOIN status s ON s.id = t.status_id
          WHERE t.wo_number IN (${holes})`,
        p.values,
      )
    : { rows: [] as ExistingRow[] };
  const existingByNumber = new Map(existing.rows.map((r) => [r.wo_number, r]));

  // Refused as a whole — like a bulk edit outside the scope — and BEFORE the
  // plan runs, in create and upsert mode alike: a dry run must not reveal
  // out-of-scope numbers, and a status the actor may not set must never land
  // by way of a file.
  const refusal = importRefusal({
    outsideScope: existing.rows.filter((r) => !r.in_scope).map((r) => r.wo_number),
    statusRows: importStatusRows(rows),
    routingRows: importRoutingRows(rows, new Set(existingByNumber.keys())),
    canSetStatus: permAllows(actor.perms, 'work_orders/status', 'edit', actor.isSuperAdmin),
    isSuperAdmin: actor.isSuperAdmin,
  });
  if (refusal) throw refusal;

  // #11 (Wave D): a file names clients that are records, or it is refused
  // whole (the import never creates a client — a typo would fork the list);
  // the rows that name an unknown one come back so the file can be fixed.
  // Matching cells are rewritten in the record's own spelling.
  {
    const records = await clientRecordNames();
    const unknownRows: string[] = [];
    const unknownNames = new Set<string>();
    rows = rows.map((r, i) => {
      const out: ImportRow = { ...r };
      for (const col of ['client', `fields.${CLIENT_FIELD_KEY}`]) {
        const cell = (r[col] ?? '').toString().trim();
        if (!cell) continue;
        const hit = matchClientRecord(cell, records);
        if (hit) out[col] = hit;
        else {
          unknownNames.add(cell);
          unknownRows.push(importRowName(r, i));
        }
      }
      return out;
    });
    if (unknownRows.length > 0) {
      const names = [...unknownNames];
      throw new ApiError(
        'BAD_REQUEST',
        `Some rows name a client that is not on file (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}) — add the client under Clients first, or correct the spelling`,
        { code: IMPORT_UNKNOWN_CLIENT_CODE, wo_numbers: [...new Set(unknownRows)], clients: names },
      );
    }
  }

  // New WO numbers continue the existing WO-#### series rather than restarting
  // it, so an imported batch sorts alongside what is already there.
  const maxRes = await query<{ n: number | null }>(
    `SELECT MAX(NULLIF(regexp_replace(wo_number, '\\D', '', 'g'), '')::bigint) AS n FROM task`,
  );
  let nextNumber = Number(maxRes.rows[0]?.n ?? 0) + 1;

  // ── Plan ───────────────────────────────────────────────────────────────────
  interface Plan {
    index: number;
    action: 'create' | 'update';
    id?: string;
    wo_number: string;
    cols: Record<string, unknown>;
    /** The full bag a CREATE writes. An update re-merges `fieldPatch` over the
        bag it locks (D4), so for it this is only the preview's view. */
    fields: Record<string, unknown>;
    /** Only the keys the file supplied — what an update is diffed against. */
    fieldPatch: Record<string, unknown>;
    status_id: string;
    status_name: string;
    status_group: string;
    /** True when the file's status cell chose it. False = the row's own: an
        update then leaves the status alone, whatever moved it meanwhile. */
    status_named: boolean;
    home_list_id: string | null;
  }

  const plans: Plan[] = [];
  const results: ImportRowResult[] = [];
  const seenNumbers = new Set<string>();

  rows.forEach((row, i) => {
    const rowNo = i + 1;
    const raw = (row.wo_number ?? '').toString().trim();
    const match = raw ? existingByNumber.get(raw) : undefined;

    // A number in Trash is taken, but the row behind it is not written:
    // restoring it is the admin console's job, in either mode.
    if (match?.trashed) {
      results.push({ row: rowNo, wo_number: raw, action: 'skip', message: 'In trash' });
      return;
    }
    if (match && opts.mode === 'create') {
      results.push({ row: rowNo, wo_number: raw, action: 'skip', message: 'Already exists' });
      return;
    }
    // An unrecognised number in upsert mode falls through to create: it is a
    // new work order the client numbered themselves.
    const woNumber = raw || `WO-${nextNumber++}`;
    if (seenNumbers.has(woNumber)) {
      results.push({
        row: rowNo,
        wo_number: woNumber,
        action: 'error',
        message: 'Duplicate WO # within this file',
      });
      return;
    }
    seenNumbers.add(woNumber);

    // Status by name. Without one, a create starts in the first open status and
    // an update keeps the status it has — a file that lists only NTEs must not
    // quietly reopen every work order it touches.
    let status = match
      ? { id: match.status_id, name: match.status_name, status_group: match.status_group }
      : defaultStatus;
    const statusName = (row.status ?? '').toString().trim();
    if (statusName) {
      const found = statusByName.get(statusName.toLowerCase());
      if (!found) {
        results.push({
          row: rowNo,
          wo_number: woNumber,
          action: 'error',
          message: `Unknown status "${statusName}"`,
        });
        return;
      }
      status = found;
    }

    let homeList = defaultList;
    const listName = (row.home_list ?? '').toString().trim();
    if (listName) {
      const found = listByName.get(listName.toLowerCase());
      if (!found) {
        results.push({
          row: rowNo,
          wo_number: woNumber,
          action: 'error',
          message: `Unknown home list "${listName}"`,
        });
        return;
      }
      homeList = found;
    }

    const cols: Record<string, unknown> = {};
    let bad: string | null = null;
    for (const [key, value] of Object.entries(row)) {
      if (!IMPORTABLE.has(key)) continue;
      const v = (value ?? '').toString().trim();
      if (v === '') continue;
      if (NUMERIC_COLS.has(key)) {
        const n = cleanNumber(v);
        if (n === null) { bad = `"${key}" is not a number: ${v}`; break; }
        cols[key] = n;
      } else if (DATE_COLS.has(key)) {
        const d = cleanDate(v);
        if (d === null) { bad = `"${key}" is not a date: ${v}`; break; }
        cols[key] = d;
      } else {
        cols[key] = v;
      }
    }
    if (bad) {
      results.push({ row: rowNo, wo_number: woNumber, action: 'error', message: bad });
      return;
    }

    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      const jsonKey = customKeys.get(key);
      if (!jsonKey) continue;
      const v = (value ?? '').toString().trim();
      if (v !== '') fields[jsonKey] = v;
    }

    // A create needs something to call the work order. An update does not —
    // the row it is updating already has a title.
    if (!match && !cols.title) {
      const fallback = (cols.description ?? '').toString().split('\n')[0].trim();
      if (!fallback) {
        results.push({
          row: rowNo,
          wo_number: woNumber,
          action: 'error',
          message: 'A new work order needs a title',
        });
        return;
      }
      cols.title = fallback.slice(0, 200);
    }

    // A new work order stamps its own creation date into the record — 'Date
    // Created' is a real field the operators read, not just task.created_at.
    // A CSV that supplies the column keeps its value (a backdated import).
    if (!match) stampDateCreated(fields);

    // Profit = Total Invoiced − Cost, kept in step whatever the file said.
    const mergedBag = applyFieldPatch(match ? (match.fields ?? {}) : {}, fields);

    plans.push({
      index: rowNo,
      action: match ? 'update' : 'create',
      id: match?.id,
      wo_number: woNumber,
      cols,
      fields: mergedBag,
      fieldPatch: fields,
      status_id: status.id,
      status_name: status.name,
      status_group: status.status_group,
      status_named: statusName !== '',
      home_list_id: homeList?.id ?? null,
    });
    results.push({ row: rowNo, wo_number: woNumber, action: match ? 'update' : 'create' });
  });

  const tally = (a: ImportRowResult['action']) => results.filter((r) => r.action === a).length;
  const summary: ImportResult = {
    dry_run: opts.dry_run,
    created: tally('create'),
    updated: tally('update'),
    skipped: tally('skip'),
    errored: tally('error'),
    rows: results,
  };

  if (opts.dry_run) return summary;

  // ── Write ──────────────────────────────────────────────────────────────────
  // One transaction for the whole file: a half-imported spreadsheet is worse
  // than a rejected one, because nobody can tell which half landed.
  // For the automations engine, dispatched after the whole file commits.
  const createdIds: string[] = [];
  const updatedRows: { id: string; changes: TaskChange[] }[] = [];
  // Updates first, locked in id order — bulk edit locks the same way — then
  // the creates: two overlapping runs can never wait on each other in a circle.
  const byId = (a: Plan, b: Plan) => ((a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0);
  const ordered = [
    ...plans.filter((pl) => pl.action === 'update').sort(byId),
    ...plans.filter((pl) => pl.action === 'create'),
  ];
  await withTransaction(async (tx) => {
    for (const plan of ordered) {
      if (plan.action === 'create') {
        // The address fills City, State and Zip Code the file left out
        // (addressFill.ts); part of the creation, so no rows of their own.
        if (addressWritten(null, plan.fields[ADDRESS_KEY])) {
          const explicit = new Set(Object.keys(plan.fields).filter((k) => String(plan.fields[k] ?? '').trim() !== ''));
          if (plan.cols.city) explicit.add('City');
          if (plan.cols.state) explicit.add('State');
          for (const f of await fillFromAddress(plan.fields, explicit, tx)) {
            if (f.key === 'City') plan.cols.city = f.after;
            if (f.key === 'State') plan.cols.state = f.after;
          }
        }
        const res = await tx.query<{ id: string }>(
          `INSERT INTO task
             (wo_number, ext_name, title, description, client, city, state, trade,
              billing_entity, nte, priority, date_received, home_list_id,
              status_id, status_group, fields)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12::date, $13, $14, $15, $16::jsonb)
           RETURNING id`,
          [
            plan.wo_number,
            plan.cols.ext_name ?? null,
            plan.cols.title ?? plan.wo_number,
            plan.cols.description ?? null,
            plan.cols.client ?? null,
            plan.cols.city ?? null,
            plan.cols.state ?? null,
            plan.cols.trade ?? null,
            plan.cols.billing_entity ?? null,
            plan.cols.nte ?? null,
            plan.cols.priority ?? null,
            plan.cols.date_received ?? null,
            plan.home_list_id,
            plan.status_id,
            plan.status_group,
            JSON.stringify(plan.fields),
          ],
        );
        const id = res.rows[0].id;

        // task.home_list_id is a denormalised mirror of the is_home membership
        // row (see 0001_init.sql); the two are written together or not at all.
        if (plan.home_list_id) {
          await tx.query(
            `INSERT INTO task_list_membership (task_id, list_id, is_home)
             VALUES ($1, $2, true) ON CONFLICT (task_id, list_id) DO NOTHING`,
            [id, plan.home_list_id],
          );
        }
        await tx.query(
          `INSERT INTO activity_log
             (actor_principal_id, entity_type, entity_id, action, field, before, after)
           VALUES ($1, 'task', $2, 'created', NULL, NULL, $3::jsonb)`,
          [actorId, id, JSON.stringify({ wo_number: plan.wo_number, source: 'import' })],
        );
        createdIds.push(id);
      } else {
        // D4 (W3-3): the row is read FOR NO KEY UPDATE inside the transaction
        // (the strength is explained in woFieldValues.ts) — the bag, the
        // status and every column the file may set — and the file is diffed
        // against and merged over THAT, not the pool read the plan was built
        // from, so a write that landed in between is kept, not overwritten.
        // Only what the diff names is written, so every SET has its audit row
        // and the trail records the change that happened.
        const locked = await tx.query<LockedRow>(
          `SELECT fields, status_id, ext_name, title, description, client, city, state, trade,
                  billing_entity, nte::text AS nte, priority, date_received::text AS date_received
             FROM task WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`,
          [plan.id],
        );
        const live = locked.rows[0];
        if (!live) {
          // Trashed since the preview: the file does not restore it.
          const r = results.find((x) => x.row === plan.index);
          if (r) {
            r.action = 'skip';
            r.message = 'Deleted meanwhile';
          }
          continue;
        }
        const curFields = live.fields ?? {};
        const changes: TaskChange[] = [];
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const [col, value] of Object.entries(plan.cols)) {
          const before = live[col as keyof LockedRow] ?? null;
          if (!changed(before, value)) continue;
          changes.push({ field: col, before, after: value });
          params.push(value);
          const cast = NUMERIC_COLS.has(col) ? '::numeric' : DATE_COLS.has(col) ? '::date' : '';
          sets.push(`${col} = $${params.length}${cast}`);
        }
        const bagChanges: TaskChange[] = Object.entries(plan.fieldPatch)
          .map(([key, value]) => ({ field: `fields.${key}`, before: curFields[key] ?? null, after: value }))
          .filter((c) => changed(c.before, c.after));
        // City / State / Zip Code read off an address the file wrote (addressFill.ts).
        const addressLog: TaskChange[] = [];
        if (bagChanges.length > 0) {
          changes.push(...bagChanges);
          const nextBag = applyFieldPatch(curFields, plan.fieldPatch);
          if (ADDRESS_KEY in plan.fieldPatch && addressWritten(curFields[ADDRESS_KEY], plan.fieldPatch[ADDRESS_KEY])) {
            const explicit = new Set(Object.keys(plan.fieldPatch));
            if ('city' in plan.cols) explicit.add('City');
            if ('state' in plan.cols) explicit.add('State');
            for (const f of await fillFromAddress(nextBag, explicit, tx)) {
              addressLog.push({ field: `fields.${f.key}`, before: f.before, after: f.after });
              const col = f.key === 'City' ? 'city' : f.key === 'State' ? 'state' : null;
              if (col) {
                params.push(f.after);
                sets.push(`${col} = $${params.length}`);
              }
            }
          }
          params.push(JSON.stringify(nextBag));
          sets.push(`fields = $${params.length}::jsonb`);
        }
        // The status moves only when the file named one, and against the
        // status the row holds NOW: a row without a status cell keeps whatever
        // moved it meanwhile instead of being put back.
        if (plan.status_named && plan.status_id !== live.status_id) {
          changes.push({
            field: 'status_id',
            before: { status_id: live.status_id, status_name: statusById.get(live.status_id)?.name ?? null },
            after: { status_id: plan.status_id, status_name: plan.status_name },
          });
          params.push(plan.status_id);
          sets.push(`status_id = $${params.length}`);
          params.push(plan.status_group);
          sets.push(`status_group = $${params.length}`);
        }
        // The row already holds every value in the file: nothing to write.
        if (changes.length === 0) continue;
        params.push(plan.id);

        await tx.query(
          `UPDATE task SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
          params,
        );
        await logTaskChanges(tx, actorId, plan.id as string, changes, 'import');
        if (addressLog.length > 0) await logTaskChanges(tx, actorId, plan.id as string, addressLog, 'address');
        updatedRows.push({ id: plan.id as string, changes: [...changes, ...addressLog] });
      }
    }
  });

  for (const id of createdIds) {
    await dispatchAutomations({ taskId: id, kind: 'created' });
  }
  for (const r of updatedRows) {
    await dispatchAutomations({ taskId: r.id, kind: 'changed', changes: r.changes });
  }
  // Rule 7.1.1 (0036): a created row nobody assigned — not the file, not a
  // rule on create — waits in the manager's Pending Acceptance queue. After
  // the rules ran, so an auto-assign on create needs no acceptance.
  await raiseAcceptanceTasks(createdIds, actorId, 'import');
  // 0071 � a SharePoint folder for each new row, when that switch is on.
  // Each call is bounded and never throws; the hourly sweep retries.
  if (createdIds.length > 0) {
    const { fileWorkOrder } = await import('./sharepoint.js');
    for (const id of createdIds) await fileWorkOrder(id, actorId);
  }

  // Recounted: a row trashed between the preview and the write is a skip now.
  return { ...summary, updated: tally('update'), skipped: tally('skip') };
}
