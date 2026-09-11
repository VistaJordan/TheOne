// Section 14 — Incoming Work Order Intake (0040): the OP Admin's staging
// area and the manual entry form.
//
// A draft is a `wo_intake_draft` row, NOT a task: nothing that lists work
// orders needs to know it exists (14.1.1, "separate from the main table").
// The one moment a task is written is submitWorkOrderDraft: every 11.1.1
// field filled (the same intakeMissing the manager's Accept runs) and an
// assignee named (14.3.2) → the task is INSERTed the way the CSV import
// inserts one, the Assignee seat is written through the ordinary field
// path (audited as the OP Admin's edit, mirrors and automations included —
// and it is the Assignee value that puts the work order in that
// dispatcher's list, 14.3.3), the draft is stamped with the task it became
// and leaves the staging list. No acceptance task is raised: the OP Admin's
// assignment IS the handoff (14.3.3 routes it straight to the dispatcher;
// rule 7.1 is for work orders the system or a client created unassigned).
//
// Audit (rule 1.2.1): intake_draft_created | updated | submitted | discarded
// in activity_log, entity 'intake_draft', whole before/after snapshots with
// a `name` — the shape the admin entities use, so Admin › Audit prints them.
// The task's own 'created' row says `source: 'intake'` and names the draft.

import { query, withTransaction } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import {
  INTAKE_ASSIGNEE_KEY,
  INTAKE_PERM_KEY,
  INTAKE_SUBMIT_ERROR_CODE,
  describeIntakeSubmit,
  intakeDraftMissing,
  intakeValueFilled,
  type IntakeDraft,
  type IntakeDraftInput,
  type IntakeDraftsResponse,
  type IntakeSubmitResponse,
} from '@theone/shared';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent, snapshotsDiffer, type Snapshot } from './adminAudit.js';
import { applyProfitFormula } from './money.js';
import { requirePerm } from './permissions.js';
import { dispatchAutomations } from './automations.js';

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/** The status a manually entered work order starts in (BRD 2.7: Open is
    the first status; every internal order begins there). Looked up by name. */
export const INTAKE_START_STATUS_NAME = 'Open';

// ── Permission gates ─────────────────────────────────────────────────────────

export function requireIntakeView(p: ActingPrincipal): void {
  requirePerm(p, INTAKE_PERM_KEY, 'view', 'You cannot view the work order intake');
}

export function requireIntakeCreate(p: ActingPrincipal): void {
  requireIntakeView(p);
  requirePerm(p, INTAKE_PERM_KEY, 'create', 'You cannot start work orders in the intake');
}

export function requireIntakeEdit(p: ActingPrincipal): void {
  requireIntakeView(p);
  requirePerm(p, INTAKE_PERM_KEY, 'edit', 'You cannot edit work orders in the intake');
}

// ── Rows ─────────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  wo_number: string | null;
  fields: Record<string, unknown> | null;
  assignee: string | null;
  cb_id: string | null;
  cb_name: string | null;
  ub_id: string | null;
  ub_name: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  submitted_task_id: string | null;
  submitted_wo_number: string | null;
  discarded_at: string | null;
}

const SELECT_SQL = `
  SELECT d.id::text AS id, d.wo_number, d.fields, d.assignee,
         cb.id::text AS cb_id, cb.display_name AS cb_name,
         ub.id::text AS ub_id, ub.display_name AS ub_name,
         ${ISO('d.created_at')}   AS created_at,
         ${ISO('d.updated_at')}   AS updated_at,
         ${ISO('d.submitted_at')} AS submitted_at,
         d.submitted_task_id::text AS submitted_task_id,
         t.wo_number              AS submitted_wo_number,
         ${ISO('d.discarded_at')} AS discarded_at
    FROM wo_intake_draft d
    LEFT JOIN principal cb ON cb.id = d.created_by
    LEFT JOIN principal ub ON ub.id = d.updated_by
    LEFT JOIN task t       ON t.id = d.submitted_task_id`;

function who(id: string | null, name: string | null): { id: string; display_name: string } | null {
  return id === null ? null : { id, display_name: name ?? '' };
}

function mapRow(r: Row): IntakeDraft {
  const fields = r.fields ?? {};
  const draft = {
    id: r.id,
    wo_number: r.wo_number,
    fields,
    assignee: r.assignee,
    created_by: who(r.cb_id, r.cb_name),
    updated_by: who(r.ub_id, r.ub_name),
    created_at: r.created_at,
    updated_at: r.updated_at,
    submitted_at: r.submitted_at,
    submitted_task_id: r.submitted_task_id,
    submitted_wo_number: r.submitted_wo_number,
    discarded_at: r.discarded_at,
    missing: [] as string[],
  };
  draft.missing = intakeDraftMissing(draft);
  return draft;
}

type Q = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

async function rowById(q: Q, id: string): Promise<IntakeDraft | null> {
  const res = await q.query<Row>(`${SELECT_SQL} WHERE d.id = $1 LIMIT 1`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

function snapshot(d: IntakeDraft): Snapshot {
  return {
    name: d.wo_number?.trim() ? `Draft ${d.wo_number.trim()}` : 'Draft (no WO# yet)',
    id: d.id,
    wo_number: d.wo_number,
    fields: d.fields,
    assignee: d.assignee,
    submitted_task_id: d.submitted_task_id,
    submitted_wo_number: d.submitted_wo_number,
    discarded_at: d.discarded_at,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The staging list (14.3.1): open drafts, most recently touched first. */
export async function listIntakeDrafts(): Promise<IntakeDraftsResponse> {
  const res = await query<Row>(
    `${SELECT_SQL}
      WHERE d.submitted_at IS NULL AND d.discarded_at IS NULL
      ORDER BY d.updated_at DESC, d.created_at DESC`,
  );
  const items = res.rows.map(mapRow);
  return { items, total: items.length };
}

export async function getIntakeDraft(id: string): Promise<IntakeDraft> {
  const d = await rowById({ query }, id);
  if (!d) throw notFound('Draft not found');
  return d;
}

// ── Input ────────────────────────────────────────────────────────────────────

function cleanText(v: unknown, label: string, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s.length > max) throw badRequest(`${label} is too long (max ${max})`);
  return s === '' ? null : s;
}

/** A bag patch: strings are trimmed, blanks become "clear this key". */
function cleanFields(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('fields must be an object');
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const key = k.trim();
    if (!key || key.length > 120) throw badRequest(`Bad field key "${k}"`);
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (s.length > 20_000) throw badRequest(`"${key}" is too long`);
      out[key] = s === '' ? null : s;
    } else {
      out[key] = raw ?? null;
    }
  }
  return out;
}

function mergeFields(cur: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return merged;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createIntakeDraft(input: IntakeDraftInput, actor: ActingPrincipal): Promise<IntakeDraft> {
  requireIntakeCreate(actor);
  const woNumber = cleanText(input.wo_number, 'WO#', 80);
  const assignee = cleanText(input.assignee, 'Assignee', 200);
  const fields = mergeFields({}, cleanFields(input.fields));
  const res = await query<{ id: string }>(
    `INSERT INTO wo_intake_draft (wo_number, fields, assignee, created_by, updated_by)
     VALUES ($1, $2::jsonb, $3, $4, $4)
     RETURNING id::text AS id`,
    [woNumber, JSON.stringify(fields), assignee, actor.id],
  );
  const created = (await rowById({ query }, res.rows[0].id)) as IntakeDraft;
  await logAdminEvent({
    actorId: actor.id,
    entity: 'intake_draft',
    entityId: created.id,
    action: 'intake_draft_created',
    after: snapshot(created),
  });
  return created;
}

export async function updateIntakeDraft(
  id: string,
  input: IntakeDraftInput,
  actor: ActingPrincipal,
): Promise<IntakeDraft> {
  requireIntakeEdit(actor);
  const cur = await getIntakeDraft(id);
  if (cur.submitted_at) throw conflict('This draft was already submitted; open the work order instead');
  if (cur.discarded_at) throw conflict('This draft was discarded');

  const woNumber = 'wo_number' in input ? cleanText(input.wo_number, 'WO#', 80) : cur.wo_number;
  const assignee = 'assignee' in input ? cleanText(input.assignee, 'Assignee', 200) : cur.assignee;
  const fields = 'fields' in input ? mergeFields(cur.fields, cleanFields(input.fields)) : cur.fields;

  await query(
    `UPDATE wo_intake_draft
        SET wo_number = $2, fields = $3::jsonb, assignee = $4, updated_by = $5, updated_at = now()
      WHERE id = $1`,
    [id, woNumber, JSON.stringify(fields), assignee, actor.id],
  );
  const updated = (await rowById({ query }, id)) as IntakeDraft;
  const before = snapshot(cur);
  const after = snapshot(updated);
  if (snapshotsDiffer(before, after)) {
    await logAdminEvent({
      actorId: actor.id,
      entity: 'intake_draft',
      entityId: id,
      action: 'intake_draft_updated',
      before,
      after,
    });
  }
  return updated;
}

/** Rule 8.1.1: a draft is never deleted — it is marked discarded and
    leaves the staging list; the row and its trail stay. */
export async function discardIntakeDraft(id: string, actor: ActingPrincipal): Promise<IntakeDraft> {
  requireIntakeEdit(actor);
  const cur = await getIntakeDraft(id);
  if (cur.submitted_at) throw conflict('This draft was already submitted; open the work order instead');
  if (cur.discarded_at) return cur;
  await query(
    `UPDATE wo_intake_draft SET discarded_at = now(), updated_by = $2, updated_at = now() WHERE id = $1`,
    [id, actor.id],
  );
  const updated = (await rowById({ query }, id)) as IntakeDraft;
  await logAdminEvent({
    actorId: actor.id,
    entity: 'intake_draft',
    entityId: id,
    action: 'intake_draft_discarded',
    before: snapshot(cur),
    after: snapshot(updated),
  });
  return updated;
}

// ── Submit: the draft becomes a work order ───────────────────────────────────

/** First meaningful line of the description, the way the seed and the
    import title a work order; the WO# when there is none. */
function titleOf(description: string | null, woNumber: string): string {
  const line = (description ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return woNumber;
  return line.length > 120 ? line.slice(0, 120) : line;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** "$1,610.00" → 1610; anything that is not a number → null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const digits = String(v).replace(/[^0-9.-]/g, '');
  if (!/^-?\d*\.?\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM-DD…' → the day; anything else → null (the column is a date). */
function day(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export async function submitIntakeDraft(id: string, actor: ActingPrincipal): Promise<IntakeSubmitResponse> {
  requireIntakeEdit(actor);
  const cur = await getIntakeDraft(id);
  if (cur.submitted_at) throw conflict('This draft was already submitted; open the work order instead');
  if (cur.discarded_at) throw conflict('This draft was discarded');

  // 14.2.2 + 14.2.3: every intake field, and an assignee. The list comes
  // back on the 409 so the form can mark what is still empty.
  const missing = intakeDraftMissing(cur);
  const assigneeMissing = !intakeValueFilled(cur.assignee);
  if (missing.length > 0 || assigneeMissing) {
    throw new ApiError('CONFLICT', describeIntakeSubmit(missing, assigneeMissing), {
      code: INTAKE_SUBMIT_ERROR_CODE,
      missing,
      assignee_missing: assigneeMissing,
    });
  }
  const woNumber = (cur.wo_number as string).trim();
  const assignee = (cur.assignee as string).trim();

  // The assignee must be a person on file — the value lands in the Assignee
  // seat, which the 0032 scope matches by display name (the same check the
  // manager's Accept runs), so a typo would hide the work order from everyone.
  const person = await query<{ id: string }>(
    `SELECT id::text AS id FROM principal
      WHERE kind = 'human' AND display_name = $1 AND status <> 'disabled' LIMIT 1`,
    [assignee],
  );
  if (!person.rows[0]) throw badRequest(`"${assignee}" is not an active person on file`, { assignee });

  // WO# is the work order's identity: one per number, trash included.
  const dup = await query<{ id: string }>(`SELECT id::text AS id FROM task WHERE wo_number = $1 LIMIT 1`, [woNumber]);
  if (dup.rows[0]) {
    throw conflict(`A work order numbered ${woNumber} already exists`, {
      code: INTAKE_SUBMIT_ERROR_CODE,
      wo_number: woNumber,
      task_id: dup.rows[0].id,
    });
  }

  const start = await query<{ id: string; status_group: string }>(
    `SELECT id::text AS id, status_group::text AS status_group FROM status WHERE lower(name) = lower($1) LIMIT 1`,
    [INTAKE_START_STATUS_NAME],
  );
  if (!start.rows[0]) {
    throw conflict(
      `There is no "${INTAKE_START_STATUS_NAME}" status to start the work order in. Add it under Admin › Statuses first.`,
      { status_name: INTAKE_START_STATUS_NAME },
    );
  }

  // The bag the work order carries: what was typed, minus the Assignee (it
  // is written through the field path below so it is audited and mirrored
  // like any assignment), plus the profit formula the import applies.
  const bag: Record<string, unknown> = { ...cur.fields };
  delete bag[INTAKE_ASSIGNEE_KEY];
  applyProfitFormula(bag);

  const description = str(bag['35. WO Description']);
  let taskId = '';
  await withTransaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO task
         (wo_number, ext_name, title, description, client, city, state, trade,
          billing_entity, nte, priority, date_received, home_list_id,
          status_id, status_group, fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12::date, $13, $14, $15, $16::jsonb)
       RETURNING id::text AS id`,
      [
        woNumber,
        null,
        titleOf(description, woNumber),
        description,
        str(bag['Client']),
        str(bag['City']),
        str(bag['State']),
        str(bag['Trade']),
        str(bag['21. Comp']),
        num(bag['16. Client NTE 🔴']),
        null,
        day(bag['Date-Time Received']),
        null,
        start.rows[0].id,
        start.rows[0].status_group,
        JSON.stringify(bag),
      ],
    );
    taskId = ins.rows[0].id;
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'created', NULL, NULL, $3::jsonb)`,
      [actor.id, taskId, JSON.stringify({ wo_number: woNumber, source: 'intake', draft_id: id })],
    );
    await tx.query(
      `UPDATE wo_intake_draft
          SET submitted_at = now(), submitted_task_id = $2, updated_by = $3, updated_at = now()
        WHERE id = $1`,
      [id, taskId, actor.id],
    );
  });

  // After the commit (each opens its own transaction and dispatches rules):
  // the rules on create, then the assignment through the ordinary field
  // write — audited as this person's edit, scope-visible to the dispatcher.
  await dispatchAutomations({ taskId, kind: 'created' });
  const { updateWorkOrderFields } = await import('./woFieldValues.js');
  await updateWorkOrderFields(taskId, { [`fields.${INTAKE_ASSIGNEE_KEY}`]: assignee }, actor.id);

  const after = (await rowById({ query }, id)) as IntakeDraft;
  await logAdminEvent({
    actorId: actor.id,
    entity: 'intake_draft',
    entityId: id,
    action: 'intake_draft_submitted',
    before: snapshot(cur),
    after: snapshot(after),
  });
  return { draft: after, task_id: taskId, wo_number: woNumber };
}
