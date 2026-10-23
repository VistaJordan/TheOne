// UAT round 1, Wave D (migration 0086): the database half of data quality.
//
//   #11  the Client on a work order (field editor, bulk edit, Add work order,
//        intake, PM schedules, CSV import) is the name of an ACTIVE client
//        record, matched case-insensitively and stored in the record's own
//        spelling — never free text. `ensureClientRecords` is what the Ecotrak
//        ingest calls after its commit, so a client Ecotrak names gets its
//        record (the sync itself writes only our database).
//   #22 / M22  an assignee being ADDED to the seat is an active human whose
//        role is a dispatcher (D3: `isDispatcherRole`).
//   M2   field values by type (`checkFieldValue`): a dropdown value is one of
//        its options, a State a US code, money not negative, no date before
//        2000; and Received on ≤ Due date (`assertDateOrder`).
//   L3   history fields (`HISTORY_FIELD_KEYS`) are refused for everyone.
//
// The pure vocabulary is packages/shared/src/dataQuality.ts. Every refusal is
// a 400 with `details.code` and `details.field`.

import {
  ASSIGNEE_DISABLED_CODE,
  ASSIGNEE_NOT_DISPATCHER_CODE,
  assigneeDisabledMessage,
  CLIENT_FIELD_KEY,
  CLIENT_NOT_ON_FILE_CODE,
  DISPATCHER_ROLE_CODES,
  DUE_DATE_KEY,
  HISTORY_FIELD_KEYS,
  RECEIVED_ON_KEY,
  STATE_FIELD_KEY,
  VALIDATION_CODE,
  assigneeNotDispatcherMessage,
  clientKey,
  clientNotOnFileMessage,
  dateFloorProblem,
  dateOrderProblem,
  historyFieldMessage,
  matchClientRecord,
  matchOption,
  normalizeUsState,
} from '@theone/shared';
import { query, type Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import type { ResolvedField } from './woFields.js';

const pool: Queryable = { query };

// ── #11 · clients ────────────────────────────────────────────────────────────

export async function clientRecordNames(q: Queryable = pool): Promise<{ name: string; is_active: boolean }[]> {
  const res = await q.query<{ name: string; is_active: boolean }>(
    `SELECT name, is_active FROM client WHERE deleted_at IS NULL`,
  );
  return res.rows;
}

/** The record's spelling of `typed`, or a 400 `CLIENT_NOT_ON_FILE`. A blank
    value is returned as null (clearing the client is the caller's call). */
export async function canonicalClient(
  typed: string | null | undefined,
  field = CLIENT_FIELD_KEY,
  q: Queryable = pool,
): Promise<string | null> {
  const s = String(typed ?? '').trim();
  if (s === '') return null;
  const hit = matchClientRecord(s, await clientRecordNames(q));
  if (!hit) {
    throw new ApiError('BAD_REQUEST', clientNotOnFileMessage(s), {
      code: CLIENT_NOT_ON_FILE_CODE,
      field,
      client: s,
    });
  }
  return hit;
}

/** A client record for every name not on file yet (the 0062 join: case and
    outer spaces). Idempotent; never throws — a failure here must not undo
    the ingest that called it. Returns how many were created. */
export async function ensureClientRecords(names: readonly (string | null | undefined)[]): Promise<number> {
  const wanted = new Map<string, string>();
  for (const n of names) {
    const s = String(n ?? '').trim();
    if (s && !wanted.has(clientKey(s))) wanted.set(clientKey(s), s);
  }
  if (wanted.size === 0) return 0;
  try {
    const res = await query(
      `INSERT INTO client (name)
       SELECT n FROM unnest($1::text[]) AS x(n)
        WHERE NOT EXISTS (SELECT 1 FROM client c WHERE c.deleted_at IS NULL AND lower(btrim(c.name)) = lower(btrim(x.n)))
       ON CONFLICT DO NOTHING`,
      [[...wanted.values()]],
    );
    return res.rowCount ?? 0;
  } catch (err) {
    console.error('[dataRules] ensureClientRecords failed', (err as Error).message);
    return 0;
  }
}

/** Every client NAMED on a work order, a site or a PM schedule gets its
    record (the 0062 adoption, widened to schedules). What the Ecotrak ingest
    calls after its commits, so a client Ecotrak sends for the first time is
    on the list before anyone opens the work order. Never throws. */
export async function adoptClientsFromRecords(): Promise<number> {
  try {
    const res = await query(
      `INSERT INTO client (name)
       SELECT DISTINCT ON (lower(btrim(n))) btrim(n)
         FROM (
           SELECT client AS n FROM task WHERE deleted_at IS NULL AND btrim(COALESCE(client, '')) <> ''
           UNION
           SELECT client FROM site WHERE deleted_at IS NULL AND btrim(COALESCE(client, '')) <> ''
           UNION
           SELECT client FROM pm_schedule WHERE btrim(COALESCE(client, '')) <> ''
         ) x
        WHERE NOT EXISTS (SELECT 1 FROM client c WHERE c.deleted_at IS NULL AND lower(btrim(c.name)) = lower(btrim(x.n)))
        ORDER BY lower(btrim(n))
       ON CONFLICT DO NOTHING`,
    );
    return res.rowCount ?? 0;
  } catch (err) {
    console.error('[dataRules] adoptClientsFromRecords failed', (err as Error).message);
    return 0;
  }
}

// ── #22 / M22 · dispatchers ──────────────────────────────────────────────────

/** Each name must be an active human whose role is a dispatcher (D3).
    Returns the names in their display spelling; 400
    `ASSIGNEE_NOT_DISPATCHER` naming the ones that are not. */
export async function assertDispatchers(
  names: readonly string[],
  field = 'Assignee',
  q: Queryable = pool,
): Promise<string[]> {
  if (names.length === 0) return [];
  const res = await q.query<{ name: string }>(
    `SELECT display_name AS name FROM principal
      WHERE kind = 'human' AND status <> 'disabled' AND role = ANY($1::text[])
        AND lower(btrim(display_name)) = ANY($2::text[])`,
    [[...DISPATCHER_ROLE_CODES], names.map((n) => n.trim().toLowerCase())],
  );
  const byKey = new Map(res.rows.map((r) => [r.name.trim().toLowerCase(), r.name]));
  const bad = names.filter((n) => !byKey.has(n.trim().toLowerCase()));
  if (bad.length > 0) {
    throw new ApiError('BAD_REQUEST', assigneeNotDispatcherMessage(bad), {
      code: ASSIGNEE_NOT_DISPATCHER_CODE,
      field,
      assignees: bad,
    });
  }
  return names.map((n) => byKey.get(n.trim().toLowerCase()) as string);
}

/** The names that belong to a disabled account and to no account that is
    not disabled (display names are not unique) — lower-cased keys. */
export async function disabledAssigneeKeys(names: readonly string[], q: Queryable = pool): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const res = await q.query<{ k: string }>(
    `SELECT lower(btrim(display_name)) AS k FROM principal
      WHERE lower(btrim(display_name)) = ANY($1::text[])
      GROUP BY 1
     HAVING bool_and(status = 'disabled')`,
    [names.map((n) => n.trim().toLowerCase())],
  );
  return new Set(res.rows.map((r) => r.k));
}

/** The lighter check for writers that need not name a dispatcher (a rule's
    own write, the PM raise): a disabled account is still refused, 400
    `ASSIGNEE_DISABLED`. */
export async function assertNoDisabledAssignees(
  names: readonly string[],
  field = 'Assignee',
  q: Queryable = pool,
): Promise<void> {
  const disabled = await disabledAssigneeKeys(names, q);
  const bad = names.filter((n) => disabled.has(n.trim().toLowerCase()));
  if (bad.length > 0) {
    throw new ApiError('BAD_REQUEST', assigneeDisabledMessage(bad), {
      code: ASSIGNEE_DISABLED_CODE,
      field,
      assignees: bad,
    });
  }
}

// ── M2 / L3 · one field value ────────────────────────────────────────────────

const refuse = (field: ResolvedField, message: string, extra: Record<string, unknown> = {}) =>
  new ApiError('BAD_REQUEST', message, { code: VALIDATION_CODE, field: field.key, ...extra });

/** L3: a history field is not written by hand, whoever asks. */
export function assertNotHistoryField(jsonKeys: readonly string[], labelOf: (k: string) => string = (k) => k): void {
  for (const k of jsonKeys) {
    if (HISTORY_FIELD_KEYS.includes(k)) {
      throw new ApiError('BAD_REQUEST', historyFieldMessage(labelOf(k)), {
        code: VALIDATION_CODE,
        field: `fields.${k}`,
        history_field: k,
      });
    }
  }
}

/**
 * Checks ONE coerced custom-field value (null = clearing, always allowed) and
 * returns what to store — the client record's or the option's own spelling,
 * an upper-case State. Throws 400 VALIDATION naming the field.
 */
export async function checkFieldValue(f: ResolvedField, value: unknown, q: Queryable = pool): Promise<unknown> {
  if (value === null || value === undefined) return null;
  const jsonKey = f.jsonKey ?? '';
  if (jsonKey === CLIENT_FIELD_KEY) return canonicalClient(String(value), f.key, q);
  if (jsonKey === STATE_FIELD_KEY) {
    const st = normalizeUsState(value);
    if (!st) throw refuse(f, `"${f.label}" needs a US state code (for example TX)`);
    return st;
  }
  if (f.type === 'money' && typeof value === 'number' && value < 0) {
    throw refuse(f, `"${f.label}" cannot be negative`);
  }
  if ((f.type === 'date' || f.type === 'datetime') && typeof value === 'string') {
    const p = dateFloorProblem(f.label, value);
    if (p) throw refuse(f, p);
  }
  if (f.subtype === 'dropdown' && f.options && f.options.length > 0) {
    const hit = matchOption(f.options, value);
    if (!hit) throw refuse(f, `"${String(value)}" is not one of the choices for "${f.label}"`, { value });
    return hit;
  }
  return value;
}

/** Received on ≤ Due date, asked only when the patch touches one of the two
    (a bag loaded before the rule keeps what it has until someone edits it). */
export function assertDateOrder(merged: Record<string, unknown>, touched: readonly string[]): void {
  if (!touched.includes(RECEIVED_ON_KEY) && !touched.includes(DUE_DATE_KEY)) return;
  const p = dateOrderProblem(merged[RECEIVED_ON_KEY], merged[DUE_DATE_KEY]);
  if (p) {
    throw new ApiError('BAD_REQUEST', p, {
      code: VALIDATION_CODE,
      field: `fields.${touched.includes(DUE_DATE_KEY) ? DUE_DATE_KEY : RECEIVED_ON_KEY}`,
    });
  }
}
