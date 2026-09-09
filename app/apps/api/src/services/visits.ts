// Visits (0021) — check-in / check-out as a log.
//
// One `wo_visit` row per visit of a work order: its type (Assessment, Job,
// Return trip), the tech who went (name + phone), how they checked in (IVR,
// app, …) and its own check-in / check-out stamps to the second. The status
// is what the operator moves; the stamps follow it:
//
//   planned ──▶ checked_in    checked_in_at  = now (unless the patch carries one)
//           ──▶ checked_out   checked_out_at = now (unless the patch carries one)
//   any     ──▶ planned       both stamps cleared
//
// The seven legacy bag fields ('Visit Type', '18. Check-in/out Status',
// 'Checked-in At', 'Checked-out At', 'Tech Name', 'Tech Phone Number',
// 'CICO Method') MIRROR THE LATEST VISIT — syncMirrors() runs after every
// write here — so list columns, filters, exports and any automation that
// triggers on the status keep reading what they read before. A direct write
// to one of them is refused (assertNotVisitOwned, called by both bag write
// paths) with a message that points at the visit log.
//
// Audit (activity_log, entity 'task' = the work order):
//   visit_created / visit_updated / visit_deleted
//       field  'visit:<id>'   before/after = whole snapshots with a `name`
//                             ('Visit 2 · Job') — the same shape the admin
//                             rows use, so the audit readers print them.
//   field_updated             the mirror rows, stamped via 'visit', so the
//                             per-field history of the old fields continues.
//
// A new visit takes its method from the FM table (fm_cico_method) keyed by the
// work order's '22. FM' — "we have a database of the method for each client".

import { getDb, query } from '../db.js';
import { ApiError } from '../errors.js';
import {
  cicoMethodText,
  fieldSectionPermKey,
  CICO_SECTION_SLUG,
  COMPUTED_KEYS,
  QUOTE_CLOCK_VISIT_TYPE,
  QUOTE_DUE_HOURS,
  QUOTE_DUE_KEY,
  VISIT_METHODS,
  VISIT_MIRROR_KEYS,
  VISIT_OWNED_KEYS,
  type ActivityActor,
  type ActivityEntry,
  type FmCicoMethod,
  type VisitInput,
  type VisitStatus,
  type WoVisit,
  type WoVisitsResponse,
} from '@theone/shared';
import type { ActingPrincipal } from './activity.js';
import { CREATED_AT_SQL } from './activity.js';
import { requirePerm } from './permissions.js';
import { changed, logTaskChanges, type TaskChange } from './woAudit.js';
import { dispatchAutomations } from './automations.js';
import { addWorkingHours } from '../lib/businessDays.js';
import { holidayDays } from './holidays.js';

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const K_FM = '22. FM';
const STATUSES: VisitStatus[] = ['planned', 'checked_in', 'checked_out'];

export const CICO_PERM_KEY = fieldSectionPermKey(CICO_SECTION_SLUG);

// ── Permission gates ─────────────────────────────────────────────────────────

export function requireVisitView(p: ActingPrincipal): void {
  requirePerm(p, 'work_orders', 'view', 'You cannot view work orders');
  requirePerm(p, CICO_PERM_KEY, 'view', 'You cannot view check-in / check-out');
}

export function requireVisitEdit(p: ActingPrincipal): void {
  requireVisitView(p);
  requirePerm(p, 'work_orders', 'edit', 'You cannot edit work orders');
  requirePerm(p, CICO_PERM_KEY, 'edit', 'You cannot edit check-in / check-out');
}

// ── The write guard for the legacy fields ────────────────────────────────────

const OWNED = new Set(VISIT_OWNED_KEYS);
/** Derived from the visits too, but with its own story (0024). */
const COMPUTED = new Set(COMPUTED_KEYS);

/** 400 when a bag patch names a key the visit log owns — or one the API
    computes from it (Quote Due Date). `labelOf` turns a json key into what
    the caller called it. */
export function assertNotVisitOwned(jsonKeys: string[], labelOf?: (k: string) => string): void {
  for (const k of jsonKeys) {
    const label = labelOf ? labelOf(k) : k;
    if (COMPUTED.has(k)) {
      throw new ApiError(
        'BAD_REQUEST',
        `"${label}" is computed from the assessment visit's check-out (+${QUOTE_DUE_HOURS} working hours) — correct the visit's check-out time instead`,
        { visit_owned_field: k },
      );
    }
    if (!OWNED.has(k)) continue;
    throw new ApiError(
      'BAD_REQUEST',
      `"${label}" is recorded per visit now — open the CICO tab and edit the visit instead`,
      { visit_owned_field: k },
    );
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  task_id: string;
  seq: number | string;
  visit_type: string;
  status: VisitStatus;
  return_trip_needed: boolean;
  tech_name: string | null;
  tech_phone: string | null;
  method: string | null;
  method_detail: string | null;
  checked_in_at: string | null;
  checked_out_at: string | null;
  ci_id: string | null; ci_name: string | null; ci_kind: 'human' | 'service' | null;
  co_id: string | null; co_name: string | null; co_kind: 'human' | 'service' | null;
  cb_id: string | null; cb_name: string | null; cb_kind: 'human' | 'service' | null;
  created_at: string;
  updated_at: string;
}

const SELECT_SQL = `
  SELECT v.id::text AS id, v.task_id::text AS task_id, v.seq, v.visit_type, v.status,
         v.return_trip_needed, v.tech_name, v.tech_phone, v.method, v.method_detail,
         ${ISO('v.checked_in_at')}  AS checked_in_at,
         ${ISO('v.checked_out_at')} AS checked_out_at,
         ci.id::text AS ci_id, ci.display_name AS ci_name, ci.kind::text AS ci_kind,
         co.id::text AS co_id, co.display_name AS co_name, co.kind::text AS co_kind,
         cb.id::text AS cb_id, cb.display_name AS cb_name, cb.kind::text AS cb_kind,
         ${ISO('v.created_at')} AS created_at,
         ${ISO('v.updated_at')} AS updated_at
    FROM wo_visit v
    LEFT JOIN principal ci ON ci.id = v.checked_in_by
    LEFT JOIN principal co ON co.id = v.checked_out_by
    LEFT JOIN principal cb ON cb.id = v.created_by`;

function actorOf(id: string | null, name: string | null, kind: 'human' | 'service' | null): ActivityActor | null {
  return id === null ? null : { id, display_name: name ?? '', kind: kind ?? 'human' };
}

function mapRow(r: Row): WoVisit {
  return {
    id: r.id,
    task_id: r.task_id,
    seq: Number(r.seq),
    visit_type: r.visit_type,
    status: r.status,
    return_trip_needed: Boolean(r.return_trip_needed),
    tech_name: r.tech_name,
    tech_phone: r.tech_phone,
    method: r.method,
    method_detail: r.method_detail,
    checked_in_at: r.checked_in_at,
    checked_out_at: r.checked_out_at,
    checked_in_by: actorOf(r.ci_id, r.ci_name, r.ci_kind),
    checked_out_by: actorOf(r.co_id, r.co_name, r.co_kind),
    created_by: actorOf(r.cb_id, r.cb_name, r.cb_kind),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

type Q = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

async function rowsForTask(q: Q, taskId: string): Promise<WoVisit[]> {
  const res = await q.query<Row>(`${SELECT_SQL} WHERE v.task_id = $1 ORDER BY v.seq ASC`, [taskId]);
  return res.rows.map(mapRow);
}

async function rowById(q: Q, id: string): Promise<WoVisit | null> {
  const res = await q.query<Row>(`${SELECT_SQL} WHERE v.id = $1 LIMIT 1`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** The work order a visit belongs to — for the permission gates before a write. */
export async function taskIdOfVisit(visitId: string): Promise<string | null> {
  const res = await query<{ task_id: string }>(
    `SELECT task_id::text AS task_id FROM wo_visit WHERE id = $1`,
    [visitId],
  );
  return res.rows[0]?.task_id ?? null;
}

// ── FM → method table ────────────────────────────────────────────────────────

const METHODS = new Set<string>(VISIT_METHODS);

const METHOD_SELECT = `SELECT fm, method, detail, ${ISO('updated_at')} AS updated_at FROM fm_cico_method`;

export async function listCicoMethods(): Promise<FmCicoMethod[]> {
  const res = await query<FmCicoMethod>(`${METHOD_SELECT} ORDER BY lower(fm)`);
  return res.rows;
}

/** The FM's entry — matched trimmed and case-insensitively, because the FM
    dropdown and the table are typed by different people. */
export async function methodForFm(
  fm: string | null,
): Promise<{ method: string; detail: string | null } | null> {
  if (!fm || !fm.trim()) return null;
  const res = await query<{ method: string; detail: string | null }>(
    `SELECT method, detail FROM fm_cico_method WHERE lower(btrim(fm)) = lower(btrim($1)) LIMIT 1`,
    [fm],
  );
  return res.rows[0] ?? null;
}

export async function setCicoMethod(
  fm: string,
  method: string,
  detail: string | null,
  actorId: string,
): Promise<FmCicoMethod> {
  const name = fm.trim();
  if (!name) throw new ApiError('BAD_REQUEST', 'Which FM company?');
  if (!METHODS.has(method)) {
    throw new ApiError('BAD_REQUEST', `Method must be one of ${[...METHODS].join(', ')}`);
  }
  const note = detail?.trim() ? detail.trim() : null;
  await query(
    `INSERT INTO fm_cico_method (fm, method, detail, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (fm) DO UPDATE
       SET method = EXCLUDED.method, detail = EXCLUDED.detail,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [name, method, note, actorId],
  );
  const res = await query<FmCicoMethod>(`${METHOD_SELECT} WHERE fm = $1`, [name]);
  return res.rows[0];
}

export async function deleteCicoMethod(fm: string): Promise<FmCicoMethod | null> {
  const res = await query<FmCicoMethod>(
    `DELETE FROM fm_cico_method WHERE fm = $1 RETURNING fm, method, detail, ${ISO('updated_at')} AS updated_at`,
    [fm],
  );
  return res.rows[0] ?? null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listVisits(taskId: string): Promise<WoVisitsResponse> {
  const t = await query<{ fm: string | null }>(
    `SELECT t.fields->>$2 AS fm FROM task t WHERE t.id = $1`,
    [taskId, K_FM],
  );
  const fm = t.rows[0]?.fm ?? null;
  const entry = await methodForFm(fm);
  return {
    items: await rowsForTask({ query }, taskId),
    fm,
    default_method: entry?.method ?? null,
    default_method_detail: entry?.detail ?? null,
  };
}

// ── Input validation ─────────────────────────────────────────────────────────

function text(v: unknown, label: string, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s.length > max) throw new ApiError('BAD_REQUEST', `${label} is too long (max ${max})`);
  return s === '' ? null : s;
}

/** An ISO datetime (with or without seconds / zone) → UTC ISO to the second. */
function stamp(v: unknown, label: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) {
    throw new ApiError('BAD_REQUEST', `${label} needs a date and time`);
  }
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function nowStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface Clean {
  visit_type?: string;
  status?: VisitStatus;
  return_trip_needed?: boolean;
  tech_name?: string | null;
  tech_phone?: string | null;
  method?: string | null;
  method_detail?: string | null;
  checked_in_at?: string | null;
  checked_out_at?: string | null;
}

function clean(input: VisitInput, forCreate: boolean): Clean {
  const out: Clean = {};
  if ('visit_type' in input || forCreate) {
    const t = text(input.visit_type, 'Visit type', 80);
    if (!t) throw new ApiError('BAD_REQUEST', 'Pick a visit type (Assessment, Job or Return trip)');
    out.visit_type = t;
  }
  if ('status' in input && input.status !== undefined) {
    if (!STATUSES.includes(input.status)) {
      throw new ApiError('BAD_REQUEST', 'Status must be planned, checked_in or checked_out');
    }
    out.status = input.status;
  }
  if ('return_trip_needed' in input && input.return_trip_needed !== undefined) {
    out.return_trip_needed = Boolean(input.return_trip_needed);
  }
  if ('tech_name' in input) out.tech_name = text(input.tech_name, 'Tech name', 200);
  if ('tech_phone' in input) out.tech_phone = text(input.tech_phone, 'Tech phone', 60);
  if ('method' in input) out.method = text(input.method, 'Method', 60);
  if ('method_detail' in input) out.method_detail = text(input.method_detail, 'Method detail', 300);
  if ('checked_in_at' in input) out.checked_in_at = stamp(input.checked_in_at, 'Checked-in time');
  if ('checked_out_at' in input) out.checked_out_at = stamp(input.checked_out_at, 'Checked-out time');
  return out;
}

// ── The mirror ───────────────────────────────────────────────────────────────

/** What '18. Check-in/out Status' reads for a visit — the seed vocabulary. */
export function legacyStatusOf(v: Pick<WoVisit, 'status' | 'return_trip_needed'>): string | null {
  if (v.status === 'checked_in') return 'Checked-in';
  if (v.status === 'checked_out') return v.return_trip_needed ? 'Checked-out - RTN' : 'Checked-out';
  return null;
}

/**
 * The quote clock (rules 2.3.1–2.3.2, 0024): the LATEST Assessment visit
 * that has checked out, plus QUOTE_DUE_HOURS working hours (weekends and
 * holidays skipped whole). Null when no assessment has checked out — a job or
 * a return trip owes no quote. Re-derived on every visit write, so correcting
 * a check-out time, or deleting the visit, moves or clears the due date.
 */
async function quoteDueFor(q: Q, taskId: string): Promise<string | null> {
  const res = await q.query<{ out: string | null }>(
    `SELECT ${ISO('v.checked_out_at')} AS out
       FROM wo_visit v
      WHERE v.task_id = $1
        AND v.status = 'checked_out'
        AND v.checked_out_at IS NOT NULL
        AND lower(btrim(v.visit_type)) = lower($2)
      ORDER BY v.seq DESC
      LIMIT 1`,
    [taskId, QUOTE_CLOCK_VISIT_TYPE],
  );
  const out = res.rows[0]?.out ?? null;
  if (!out) return null;
  const due = addWorkingHours(new Date(out), QUOTE_DUE_HOURS, await holidayDays(q));
  // Same shape as the check-out stamps: ISO to the second, UTC.
  return due.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Rewrite the seven mirrored bag keys from the LATEST visit (highest seq), or
 * clear them when the work order has no visit left — and the Quote Due Date
 * the visits imply (0024). Returns the changes so the caller can log them and
 * hand them to the automations engine.
 */
async function syncMirrors(q: Q, taskId: string): Promise<TaskChange[]> {
  const latest = await q.query<Row>(
    `${SELECT_SQL} WHERE v.task_id = $1 ORDER BY v.seq DESC LIMIT 1`,
    [taskId],
  );
  const v = latest.rows[0] ? mapRow(latest.rows[0]) : null;
  const t = await q.query<{ fields: Record<string, unknown> | null }>(
    `SELECT fields FROM task WHERE id = $1`,
    [taskId],
  );
  const fields = t.rows[0]?.fields ?? {};

  const desired: Record<string, unknown> = {
    [QUOTE_DUE_KEY]: await quoteDueFor(q, taskId),
    [VISIT_MIRROR_KEYS.visitType]: v?.visit_type ?? null,
    [VISIT_MIRROR_KEYS.status]: v ? legacyStatusOf(v) : null,
    [VISIT_MIRROR_KEYS.checkedInAt]: v?.checked_in_at ?? null,
    [VISIT_MIRROR_KEYS.checkedOutAt]: v?.checked_out_at ?? null,
    [VISIT_MIRROR_KEYS.techName]: v?.tech_name ?? null,
    [VISIT_MIRROR_KEYS.techPhone]: v?.tech_phone ?? null,
    // "IVR - (866) 254-8780": the shape the operation wrote by hand before.
    [VISIT_MIRROR_KEYS.method]: v ? cicoMethodText(v.method, v.method_detail) : null,
  };

  const merged: Record<string, unknown> = { ...fields };
  const changes: TaskChange[] = [];
  for (const [key, after] of Object.entries(desired)) {
    const before = fields[key] ?? null;
    if (!changed(before, after)) continue;
    if (after === null) delete merged[key];
    else merged[key] = after;
    changes.push({ field: `fields.${key}`, before, after });
  }
  if (changes.length > 0) {
    await q.query(`UPDATE task SET fields = $1::jsonb, updated_at = now() WHERE id = $2`, [
      JSON.stringify(merged),
      taskId,
    ]);
  }
  return changes;
}

// ── Snapshots for the audit rows ─────────────────────────────────────────────

function snapshot(v: WoVisit): Record<string, unknown> & { name: string } {
  return {
    name: `Visit ${v.seq} · ${v.visit_type}`,
    id: v.id,
    seq: v.seq,
    visit_type: v.visit_type,
    status: v.status,
    return_trip_needed: v.return_trip_needed,
    tech_name: v.tech_name,
    tech_phone: v.tech_phone,
    method: v.method,
    method_detail: v.method_detail,
    checked_in_at: v.checked_in_at,
    checked_out_at: v.checked_out_at,
  };
}

async function logVisitEvent(
  q: Q,
  actorId: string,
  taskId: string,
  action: 'visit_created' | 'visit_updated' | 'visit_deleted',
  visitId: string,
  before: WoVisit | null,
  after: WoVisit | null,
): Promise<void> {
  await q.query(
    `INSERT INTO activity_log
       (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      actorId,
      taskId,
      action,
      `visit:${visitId}`,
      before ? JSON.stringify(snapshot(before)) : null,
      after ? JSON.stringify(snapshot(after)) : null,
    ],
  );
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createVisit(
  taskId: string,
  input: VisitInput,
  actor: ActingPrincipal,
): Promise<{ item: WoVisit; items: WoVisit[] }> {
  requireVisitEdit(actor);
  const c = clean(input, true);

  // Everything that reads OUTSIDE the transaction goes first (PGlite is one
  // connection): the FM's entry, for whatever the caller did not choose —
  // the method when none was sent, and the instruction when the method is
  // the FM's own and no instruction was sent.
  let method = c.method;
  let detail = c.method_detail;
  if (method === undefined || detail === undefined) {
    const t = await query<{ fm: string | null }>(`SELECT t.fields->>$2 AS fm FROM task t WHERE t.id = $1`, [taskId, K_FM]);
    const entry = await methodForFm(t.rows[0]?.fm ?? null);
    if (method === undefined) method = entry?.method ?? null;
    if (detail === undefined) detail = entry && entry.method === method ? entry.detail : null;
  }

  const status: VisitStatus = c.status ?? 'planned';
  const now = nowStamp();
  // A visit logged straight as checked-in stamps now; one logged straight as
  // checked-out (recorded after the fact) stamps only the check-out unless the
  // caller supplied the check-in time too.
  const checkedIn =
    status === 'planned' ? null : (c.checked_in_at ?? (status === 'checked_in' ? now : null));
  const checkedOut = status === 'checked_out' ? (c.checked_out_at ?? now) : null;
  const rtn = status === 'checked_out' ? Boolean(c.return_trip_needed) : false;

  let created: WoVisit | null = null;
  let items: WoVisit[] = [];
  let mirror: TaskChange[] = [];
  const db = getDb();
  await db.transaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO wo_visit
         (task_id, seq, visit_type, status, return_trip_needed, tech_name, tech_phone, method,
          method_detail, checked_in_at, checked_out_at, checked_in_by, checked_out_by, created_by)
       VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM wo_visit WHERE task_id = $1),
               $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11, $12, $13)
       RETURNING id::text AS id`,
      [
        taskId,
        c.visit_type,
        status,
        rtn,
        c.tech_name ?? null,
        c.tech_phone ?? null,
        method ?? null,
        detail ?? null,
        checkedIn,
        checkedOut,
        checkedIn ? actor.id : null,
        checkedOut ? actor.id : null,
        actor.id,
      ],
    );
    created = await rowById(tx, ins.rows[0].id);
    await logVisitEvent(tx, actor.id, taskId, 'visit_created', ins.rows[0].id, null, created);
    mirror = await syncMirrors(tx, taskId);
    await logTaskChanges(tx, actor.id, taskId, mirror, 'visit');
    items = await rowsForTask(tx, taskId);
  });
  // Rules on the mirrored fields ("when Check-in/out Status changes to …")
  // fire after the commit, exactly as a hand edit of the old field did.
  await dispatchAutomations({ taskId, kind: 'changed', changes: mirror });
  return { item: created!, items };
}

export async function updateVisit(
  visitId: string,
  input: VisitInput,
  actor: ActingPrincipal,
): Promise<{ item: WoVisit; items: WoVisit[] }> {
  requireVisitEdit(actor);
  const c = clean(input, false);
  if (Object.keys(c).length === 0) throw new ApiError('BAD_REQUEST', 'Nothing to change');

  const cur = await rowById({ query }, visitId);
  if (!cur) throw new ApiError('NOT_FOUND', 'Visit not found');

  // The next state: plain fields first, then the status move and the stamps
  // it earns, then explicit stamps (a correction) on top.
  const next = { ...cur };
  if (c.visit_type !== undefined) next.visit_type = c.visit_type;
  if (c.tech_name !== undefined) next.tech_name = c.tech_name;
  if (c.tech_phone !== undefined) next.tech_phone = c.tech_phone;
  if (c.method !== undefined) next.method = c.method;
  if (c.method_detail !== undefined) next.method_detail = c.method_detail;

  const now = nowStamp();
  let inBy = cur.checked_in_by?.id ?? null;
  let outBy = cur.checked_out_by?.id ?? null;
  if (c.status !== undefined && c.status !== cur.status) {
    next.status = c.status;
    if (c.status === 'planned') {
      next.checked_in_at = null; next.checked_out_at = null; next.return_trip_needed = false;
      inBy = null; outBy = null;
    } else if (c.status === 'checked_in') {
      next.checked_in_at = c.checked_in_at ?? now; inBy = actor.id;
      next.checked_out_at = null; outBy = null;
      next.return_trip_needed = false;
    } else {
      next.checked_out_at = c.checked_out_at ?? now; outBy = actor.id;
    }
  }
  if (c.checked_in_at !== undefined) {
    next.checked_in_at = c.checked_in_at;
    if (c.checked_in_at && !inBy) inBy = actor.id;
    if (!c.checked_in_at) inBy = null;
  }
  if (c.checked_out_at !== undefined) {
    next.checked_out_at = c.checked_out_at;
    if (c.checked_out_at && !outBy) outBy = actor.id;
    if (!c.checked_out_at) outBy = null;
  }
  if (c.return_trip_needed !== undefined) next.return_trip_needed = c.return_trip_needed;

  let updated: WoVisit | null = null;
  let items: WoVisit[] = [];
  let mirror: TaskChange[] = [];
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE wo_visit
          SET visit_type = $2, status = $3, return_trip_needed = $4,
              tech_name = $5, tech_phone = $6, method = $7, method_detail = $12,
              checked_in_at = $8::timestamptz, checked_out_at = $9::timestamptz,
              checked_in_by = $10, checked_out_by = $11
        WHERE id = $1`,
      [
        visitId,
        next.visit_type,
        next.status,
        next.return_trip_needed,
        next.tech_name,
        next.tech_phone,
        next.method,
        next.checked_in_at,
        next.checked_out_at,
        inBy,
        outBy,
        next.method_detail,
      ],
    );
    updated = await rowById(tx, visitId);
    await logVisitEvent(tx, actor.id, cur.task_id, 'visit_updated', visitId, cur, updated);
    mirror = await syncMirrors(tx, cur.task_id);
    await logTaskChanges(tx, actor.id, cur.task_id, mirror, 'visit');
    items = await rowsForTask(tx, cur.task_id);
  });
  await dispatchAutomations({ taskId: cur.task_id, kind: 'changed', changes: mirror });
  return { item: updated!, items };
}

export async function deleteVisit(visitId: string, actor: ActingPrincipal): Promise<{ items: WoVisit[] }> {
  requireVisitEdit(actor);
  const cur = await rowById({ query }, visitId);
  if (!cur) throw new ApiError('NOT_FOUND', 'Visit not found');

  let items: WoVisit[] = [];
  let mirror: TaskChange[] = [];
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.query(`DELETE FROM wo_visit WHERE id = $1`, [visitId]);
    await logVisitEvent(tx, actor.id, cur.task_id, 'visit_deleted', visitId, cur, null);
    mirror = await syncMirrors(tx, cur.task_id);
    await logTaskChanges(tx, actor.id, cur.task_id, mirror, 'visit');
    items = await rowsForTask(tx, cur.task_id);
  });
  await dispatchAutomations({ taskId: cur.task_id, kind: 'changed', changes: mirror });
  return { items };
}

// ── History ──────────────────────────────────────────────────────────────────

/** Every recorded change of ONE visit, newest first — the drawer behind the
    clock on a visit row. */
export async function getVisitHistory(visitId: string, limit = 100): Promise<ActivityEntry[]> {
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
            p.id AS actor_id, p.display_name AS actor_name, p.kind AS actor_kind,
            ${CREATED_AT_SQL} AS created_at
       FROM activity_log a
       JOIN principal p ON p.id = a.actor_principal_id
      WHERE a.entity_type = 'task' AND a.field = $1
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $2`,
    [`visit:${visitId}`, limit],
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
