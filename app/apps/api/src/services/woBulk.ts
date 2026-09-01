// Bulk edit, CSV export and CSV import for work orders.
//
// These three belong together because they share one rule: a change that
// touches many rows must still leave the same audit trail as the change that
// touches one. Every mutation below writes an `activity_log` row per work order
// per field, exactly as the single-row status path does — a bulk edit is a
// shortcut for the operator, not a hole in the record.
//
// PGlite is single-connection, so every lookup a transaction needs (the actor,
// the target status, the home list) is resolved BEFORE the transaction opens.
// Calling the non-transactional query() from inside db.transaction() queues
// behind the open transaction and self-deadlocks.

import { getDb, query } from '../db.js';
import { ApiError } from '../errors.js';
import { listWorkOrders, type ListFilters } from './workOrders.js';
import { listCustomFields, resolveField } from './woFields.js';
import { changed, logTaskChanges, type TaskChange } from './woAudit.js';
import { dispatchAutomations } from './automations.js';
import { applyProfitFormula } from './money.js';
import type { WorkOrderListItem } from '@theone/shared';

/** `$1, $2, …` for a list of values. PGlite's parameter serialisation for
    array types is not exercised anywhere else in this codebase, so the id sets
    below are bound as ordinary scalars — the one binding style every other
    query here already proves works. */
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
      WHERE t.id IN (${placeholders(ids.length)}) AND t.deleted_at IS NULL`,
    ids,
  );

  const found = new Map(rows.rows.map((r) => [r.id, r]));
  const skipped: { wo_number: string; reason: string }[] = [];
  for (const id of ids) {
    if (!found.has(id)) skipped.push({ wo_number: id, reason: 'Not found or deleted' });
  }

  const db = getDb();
  let updated = 0;
  // What each row's write logged, for the automations engine (post-commit).
  const firedRows: { id: string; log: TaskChange[] }[] = [];

  await db.transaction(async (tx) => {
    for (const row of rows.rows) {
      const sets: string[] = [];
      const params: unknown[] = [];
      // One activity row per entry, written after the UPDATE (see woAudit.ts).
      const log: TaskChange[] = [];

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
          (c) => String(row.fields?.[c.key] ?? '') !== String(c.value ?? ''),
        );
        if (changed.length > 0) {
          // Merge rather than replace — the bag holds ~100 keys this patch does
          // not mention. A null value removes the key outright.
          const merged: Record<string, unknown> = { ...(row.fields ?? {}) };
          for (const c of changed) {
            if (c.value === null || c.value === '') delete merged[c.key];
            else merged[c.key] = c.value;
            log.push({ field: `fields.${c.key}`, before: row.fields?.[c.key] ?? null, after: c.value });
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
      firedRows.push({ id: row.id, log });
      updated += 1;
    }
  });

  // Automations react per row, after the whole batch has committed.
  for (const r of firedRows) {
    await dispatchAutomations({ taskId: r.id, kind: 'changed', changes: r.log });
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

  const db = getDb();
  await db.transaction(async (tx) => {
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
  if (key.startsWith('fields.')) return item.custom?.[key] ?? '';
  switch (key) {
    case 'status':
      return item.status.name;
    case 'status_group':
      return item.status.group;
    default:
      return (item as unknown as Record<string, unknown>)[key] ?? '';
  }
}

export async function exportCsv(
  filters: Omit<ListFilters, 'limit' | 'offset'>,
  columns: string[],
): Promise<string> {
  const cols = columns.length > 0 ? columns : ['wo_number', 'title', 'client', 'status', 'nte'];
  const labels: string[] = [];
  for (const key of cols) labels.push((await resolveField(key)).label);

  const page = await listWorkOrders({
    ...filters,
    columns: cols,
    // Grouping only affects presentation; ordering by the group key still makes
    // the file easier to read, so it is left in.
    limit: EXPORT_CAP,
    offset: 0,
  });

  return toCsv(
    labels,
    page.items.map((item) => cols.map((key) => cellFor(item, key))),
  );
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

/** A matched work order as it stands before the import touches it. */
interface ExistingRow {
  id: string;
  wo_number: string;
  fields: Record<string, unknown>;
  status_id: string;
  status_name: string;
  status_group: string;
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

/**
 * Create or update work orders from parsed CSV rows.
 *
 * `dry_run` runs the whole validation pass and reports what WOULD happen
 * without writing. The import dialog always runs it first: an operator pasting
 * 400 rows from a client spreadsheet needs to see the damage before it lands,
 * not after.
 */
export async function importWorkOrders(
  rows: ImportRow[],
  opts: { mode: 'create' | 'upsert'; dry_run: boolean },
  actorId: string,
): Promise<ImportResult> {
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
  // A file with no WO numbers at all is pure creation — skip the lookup rather
  // than send `IN ()`, which is a syntax error.
  const existing = numbers.length
    ? await query<ExistingRow>(
        // Everything the import may overwrite, so an update can be diffed
        // column by column and logged as what actually changed.
        `SELECT t.id, t.wo_number, t.fields, t.status_id, s.name AS status_name, s.status_group,
                t.ext_name, t.title, t.description, t.client, t.city, t.state, t.trade,
                t.billing_entity, t.nte::text AS nte, t.priority,
                t.date_received::text AS date_received
           FROM task t JOIN status s ON s.id = t.status_id
          WHERE t.wo_number IN (${placeholders(numbers.length)})`,
        numbers,
      )
    : { rows: [] as ExistingRow[] };
  const existingByNumber = new Map(existing.rows.map((r) => [r.wo_number, r]));

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
    /** The full bag to write (existing keys merged with the file's). */
    fields: Record<string, unknown>;
    /** Only the keys the file supplied — what an update is diffed against. */
    fieldPatch: Record<string, unknown>;
    status_id: string;
    status_name: string;
    status_group: string;
    home_list_id: string | null;
  }

  const plans: Plan[] = [];
  const results: ImportRowResult[] = [];
  const seenNumbers = new Set<string>();

  rows.forEach((row, i) => {
    const rowNo = i + 1;
    const raw = (row.wo_number ?? '').toString().trim();
    const match = raw ? existingByNumber.get(raw) : undefined;

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
    if (!match && fields['Date Created'] === undefined) {
      // The field is a datetime — stamp to the minute (UTC).
      fields['Date Created'] = new Date().toISOString().slice(0, 16);
    }

    // Profit = Total Invoiced − Cost, kept in step whatever the file said.
    const mergedBag = match ? { ...(match.fields ?? {}), ...fields } : fields;
    applyProfitFormula(mergedBag);

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
  const db = getDb();
  // For the automations engine, dispatched after the whole file commits.
  const createdIds: string[] = [];
  const updatedRows: { id: string; changes: TaskChange[] }[] = [];
  await db.transaction(async (tx) => {
    for (const plan of plans) {
      if (plan.action === 'create') {
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
        // Diff against the row as it is now, so the trail records the change
        // that happened — not the list of columns the file happened to have.
        const cur = existingByNumber.get(plan.wo_number) as ExistingRow;
        const changes: TaskChange[] = [];
        for (const [col, value] of Object.entries(plan.cols)) {
          const before = cur[col as keyof ExistingRow] ?? null;
          if (changed(before, value)) changes.push({ field: col, before, after: value });
        }
        for (const [key, value] of Object.entries(plan.fieldPatch)) {
          const before = cur.fields?.[key] ?? null;
          if (changed(before, value)) changes.push({ field: `fields.${key}`, before, after: value });
        }
        if (plan.status_id !== cur.status_id) {
          changes.push({
            field: 'status_id',
            before: { status_id: cur.status_id, status_name: cur.status_name },
            after: { status_id: plan.status_id, status_name: plan.status_name },
          });
        }
        // The row already holds every value in the file: nothing to write.
        if (changes.length === 0) continue;

        const sets: string[] = [];
        const params: unknown[] = [];
        for (const [col, value] of Object.entries(plan.cols)) {
          params.push(value);
          const cast = NUMERIC_COLS.has(col) ? '::numeric' : DATE_COLS.has(col) ? '::date' : '';
          sets.push(`${col} = $${params.length}${cast}`);
        }
        params.push(JSON.stringify(plan.fields));
        sets.push(`fields = $${params.length}::jsonb`);
        params.push(plan.status_id);
        sets.push(`status_id = $${params.length}`);
        params.push(plan.status_group);
        sets.push(`status_group = $${params.length}`);
        params.push(plan.id);

        await tx.query(
          `UPDATE task SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
          params,
        );
        await logTaskChanges(tx, actorId, plan.id as string, changes, 'import');
        updatedRows.push({ id: plan.id as string, changes });
      }
    }
  });

  for (const id of createdIds) {
    await dispatchAutomations({ taskId: id, kind: 'created' });
  }
  for (const r of updatedRows) {
    await dispatchAutomations({ taskId: r.id, kind: 'changed', changes: r.changes });
  }

  return summary;
}
