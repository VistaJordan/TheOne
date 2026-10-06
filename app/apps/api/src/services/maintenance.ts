// 0065 · Maintenance modules: the services catalogue, job plans, the services
// and technician time on a work order, work permits, and the Assignment
// Manager.
//
// Every per-work-order call arrives with a task id that was resolved through
// `resolveTaskId(id, actor)`, so the viewer's scope applies before anything
// here runs; the cross-work-order reads (the time tracker, the permit list,
// the assignment board) append `woScopeSql` themselves. Writes on a work
// order are logged through `logTaskChanges`, catalogue writes through
// `logAdminEvent`.
//
// What this deliberately does NOT do: services and time entries are a record
// of what was done. They do not feed `34. Cost`, the quote or the invoice —
// the cost of a work order still has exactly one source.

import { MAINT_PERM, permAllows, permitRequestProblem, permitState, timeAmount } from '@theone/shared';
import type {
  AssignmentBoard,
  AssignmentPerson,
  AssignmentWorkOrder,
  FeedActor,
  JobPlan,
  JobPlanInput,
  JobPlansResponse,
  PermAction,
  PermitAction,
  PermitPrecaution,
  PermitState,
  PermitStatus,
  PermitsResponse,
  ServiceItem,
  ServiceItemInput,
  ServicesResponse,
  TimeEntry,
  TimeEntryInput,
  TimeKind,
  TimeTrackerResponse,
  WoMaintenance,
  WoServiceLine,
  WorkPermit,
  WorkPermitInput,
} from '@theone/shared';
import { query } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { notify } from './notices.js';
import { requirePerm } from './permissions.js';
import { logTaskChanges } from './woAudit.js';
import { Params } from './woFields.js';
import { assertIdsInScope, woScopeSql } from './woScope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const can = (a: ActingPrincipal, key: string, action: PermAction): boolean => permAllows(a.perms, key, action, a.isSuperAdmin);
const today = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

async function peopleByIds(ids: (string | null | undefined)[]): Promise<Map<string, FeedActor>> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x) && UUID_RE.test(x!)))];
  if (want.length === 0) return new Map();
  const res = await query<FeedActor>(`SELECT id::text AS id, display_name AS name, kind FROM principal WHERE id = ANY($1::uuid[])`, [want]);
  return new Map(res.rows.map((r) => [r.id, r]));
}

async function tradeOptions(): Promise<string[]> {
  const res = await query<{ options: unknown }>(`SELECT type_config->'options' AS options FROM field_def WHERE key = 'Trade' LIMIT 1`);
  const opts = Array.isArray(res.rows[0]?.options) ? (res.rows[0]!.options as unknown[]) : [];
  return opts
    .map((o) => (typeof o === 'string' ? o : String((o as Record<string, unknown>)?.name ?? (o as Record<string, unknown>)?.label ?? '')))
    .filter(Boolean);
}

async function logWo(taskId: string, actor: ActingPrincipal, field: string, before: unknown, after: unknown): Promise<void> {
  await logTaskChanges({ query: (sql, params) => query(sql, params) }, actor.id, taskId, [{ field, before, after }]);
}

function requireWoEdit(a: ActingPrincipal): void {
  requirePerm(a, 'work_orders', 'edit', 'You cannot edit work orders');
}

/** People whose ROLE grants `action` at `key` (or, unset there, at its
 *  parent), plus super admins — the audience of a notice. Per-person
 *  overrides are not read: one notice too many or too few is harmless. */
async function holdersOf(key: string, action: PermAction): Promise<string[]> {
  const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : key;
  const res = await query<{ id: string }>(
    `SELECT p.id::text AS id
       FROM principal p LEFT JOIN role r ON r.code = p.role
      WHERE p.kind = 'human' AND p.status <> 'disabled'
        AND (p.is_super_admin
             OR COALESCE(r.permissions -> $1 ->> $3, r.permissions -> $2 ->> $3) = 'true')`,
    [key, parent, action],
  );
  return res.rows.map((r) => r.id);
}

// ═══ Services catalogue ══════════════════════════════════════════════════════

type ServiceRow = {
  id: string;
  code: string | null;
  name: string;
  trade: string | null;
  description: string | null;
  unit: string;
  unit_price: string | null;
  unit_cost: string | null;
  est_minutes: number | null;
  is_active: boolean;
  used: number;
};

const mapService = (r: ServiceRow): ServiceItem => ({ ...r, unit_price: num(r.unit_price), unit_cost: num(r.unit_cost), used: Number(r.used) });

export async function listServices(actor: ActingPrincipal): Promise<ServicesResponse> {
  requirePerm(actor, MAINT_PERM.services, 'view', 'You cannot open the services catalogue');
  const [rows, trades] = await Promise.all([
    query<ServiceRow>(
      `SELECT s.id::text AS id, s.code, s.name, s.trade, s.description, s.unit, s.unit_price, s.unit_cost, s.est_minutes, s.is_active,
              (SELECT count(DISTINCT w.task_id)::int FROM wo_service w WHERE w.service_id = s.id) AS used
         FROM service_item s
        ORDER BY s.is_active DESC, lower(COALESCE(s.trade, '')), lower(s.name)`,
    ),
    tradeOptions(),
  ]);
  return {
    services: rows.rows.map(mapService),
    trades,
    can: { create: can(actor, MAINT_PERM.services, 'create'), edit: can(actor, MAINT_PERM.services, 'edit'), delete: can(actor, MAINT_PERM.services, 'delete') },
  };
}

function money(v: number | null | undefined, label: string): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v) || v < 0 || v > 10_000_000) throw badRequest(`${label} must be a positive amount`);
  return Math.round(v * 100) / 100;
}

export async function saveService(id: string | null, input: ServiceItemInput, actor: ActingPrincipal): Promise<ServicesResponse> {
  requirePerm(actor, MAINT_PERM.services, id ? 'edit' : 'create', 'You cannot change the services catalogue');
  let before: ServiceRow | null = null;
  if (id) {
    if (!UUID_RE.test(id)) throw notFound('That service does not exist');
    const cur = await query<ServiceRow>(`SELECT id::text AS id, code, name, trade, description, unit, unit_price, unit_cost, est_minutes, is_active, 0 AS used FROM service_item WHERE id = $1`, [id]);
    before = cur.rows[0] ?? null;
    if (!before) throw notFound('That service does not exist');
  }
  const name = input.name !== undefined ? input.name.trim() : (before?.name ?? '');
  if (!name) throw badRequest('The service needs a name', { field: 'name' });
  const next = {
    code: input.code !== undefined ? clean(input.code) : (before?.code ?? null),
    name: name.slice(0, 200),
    trade: input.trade !== undefined ? clean(input.trade) : (before?.trade ?? null),
    description: input.description !== undefined ? clean(input.description) : (before?.description ?? null),
    unit: (input.unit !== undefined ? clean(input.unit) : before?.unit) ?? 'each',
    unit_price: input.unit_price !== undefined ? money(input.unit_price, 'The price') : num(before?.unit_price),
    unit_cost: input.unit_cost !== undefined ? money(input.unit_cost, 'The cost') : num(before?.unit_cost),
    est_minutes: input.est_minutes !== undefined ? (input.est_minutes === null ? null : Math.max(0, Math.round(input.est_minutes))) : (before?.est_minutes ?? null),
    is_active: input.is_active ?? before?.is_active ?? true,
  };
  const clash = await query(`SELECT 1 FROM service_item WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid)`, [next.name, id]);
  if (clash.rows[0]) throw conflict(`There is already a service called “${next.name}”`);
  let rowId = id;
  if (id) {
    await query(
      `UPDATE service_item SET code = $2, name = $3, trade = $4, description = $5, unit = $6, unit_price = $7, unit_cost = $8,
              est_minutes = $9, is_active = $10, updated_at = now() WHERE id = $1`,
      [id, next.code, next.name, next.trade, next.description, next.unit, next.unit_price, next.unit_cost, next.est_minutes, next.is_active],
    );
  } else {
    const ins = await query<{ id: string }>(
      `INSERT INTO service_item (code, name, trade, description, unit, unit_price, unit_cost, est_minutes, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text AS id`,
      [next.code, next.name, next.trade, next.description, next.unit, next.unit_price, next.unit_cost, next.est_minutes, next.is_active, actor.id],
    );
    rowId = ins.rows[0].id;
  }
  await logAdminEvent({
    actorId: actor.id,
    entity: 'service_item',
    entityId: rowId!,
    action: id ? 'service_item_updated' : 'service_item_added',
    before: before ? { ...before, name: before.name } : null,
    after: next,
  });
  return listServices(actor);
}

export async function deleteService(id: string, actor: ActingPrincipal): Promise<ServicesResponse> {
  requirePerm(actor, MAINT_PERM.services, 'delete', 'You cannot delete from the services catalogue');
  if (!UUID_RE.test(id)) throw notFound('That service does not exist');
  const cur = await query<{ name: string }>(`DELETE FROM service_item WHERE id = $1 RETURNING name`, [id]);
  if (!cur.rows[0]) throw notFound('That service does not exist');
  // The lines already on work orders keep their name and prices.
  await logAdminEvent({ actorId: actor.id, entity: 'service_item', entityId: id, action: 'service_item_deleted', before: { name: cur.rows[0].name } });
  return listServices(actor);
}

// ═══ Job plans ═══════════════════════════════════════════════════════════════

async function loadPlans(onlyId?: string): Promise<JobPlan[]> {
  const plans = await query<{ id: string; name: string; trade: string | null; description: string | null; est_minutes: number | null; is_active: boolean; used: number }>(
    `SELECT p.id::text AS id, p.name, p.trade, p.description, p.est_minutes, p.is_active,
            (SELECT count(*)::int FROM wo_job_plan w WHERE w.plan_id = p.id) AS used
       FROM job_plan p
      WHERE ($1::uuid IS NULL OR p.id = $1::uuid)
      ORDER BY p.is_active DESC, lower(COALESCE(p.trade, '')), lower(p.name)`,
    [onlyId ?? null],
  );
  if (plans.rows.length === 0) return [];
  const ids = plans.rows.map((p) => p.id);
  const [steps, services] = await Promise.all([
    query<{ id: string; plan_id: string; title: string }>(`SELECT id::text AS id, plan_id::text AS plan_id, title FROM job_plan_step WHERE plan_id = ANY($1::uuid[]) ORDER BY position, title`, [ids]),
    query<{ plan_id: string; service_id: string; name: string; unit: string; qty: string }>(
      `SELECT js.plan_id::text AS plan_id, js.service_id::text AS service_id, s.name, s.unit, js.qty
         FROM job_plan_service js JOIN service_item s ON s.id = js.service_id
        WHERE js.plan_id = ANY($1::uuid[]) ORDER BY lower(s.name)`,
      [ids],
    ),
  ]);
  return plans.rows.map((p) => ({
    ...p,
    used: Number(p.used),
    steps: steps.rows.filter((s) => s.plan_id === p.id).map((s) => ({ id: s.id, title: s.title })),
    services: services.rows.filter((s) => s.plan_id === p.id).map((s) => ({ service_id: s.service_id, name: s.name, unit: s.unit, qty: Number(s.qty) })),
  }));
}

export async function listJobPlans(actor: ActingPrincipal): Promise<JobPlansResponse> {
  requirePerm(actor, MAINT_PERM.plans, 'view', 'You cannot open job plans');
  const [plans, trades, services] = await Promise.all([
    loadPlans(),
    tradeOptions(),
    query<{ id: string; name: string; unit: string }>(`SELECT id::text AS id, name, unit FROM service_item WHERE is_active ORDER BY lower(name)`),
  ]);
  return {
    plans,
    trades,
    services: services.rows,
    can: { create: can(actor, MAINT_PERM.plans, 'create'), edit: can(actor, MAINT_PERM.plans, 'edit'), delete: can(actor, MAINT_PERM.plans, 'delete') },
  };
}

export async function saveJobPlan(id: string | null, input: JobPlanInput, actor: ActingPrincipal): Promise<JobPlansResponse> {
  requirePerm(actor, MAINT_PERM.plans, id ? 'edit' : 'create', 'You cannot change job plans');
  let before: JobPlan | null = null;
  if (id) {
    if (!UUID_RE.test(id)) throw notFound('That job plan does not exist');
    before = (await loadPlans(id))[0] ?? null;
    if (!before) throw notFound('That job plan does not exist');
  }
  const name = (input.name !== undefined ? input.name : (before?.name ?? '')).trim().slice(0, 200);
  if (!name) throw badRequest('The job plan needs a name', { field: 'name' });
  const clash = await query(`SELECT 1 FROM job_plan WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid)`, [name, id]);
  if (clash.rows[0]) throw conflict(`There is already a job plan called “${name}”`);
  const trade = input.trade !== undefined ? clean(input.trade) : (before?.trade ?? null);
  const description = input.description !== undefined ? clean(input.description) : (before?.description ?? null);
  const est = input.est_minutes !== undefined ? (input.est_minutes === null ? null : Math.max(0, Math.round(input.est_minutes))) : (before?.est_minutes ?? null);
  const active = input.is_active ?? before?.is_active ?? true;
  let planId = id;
  if (id) {
    await query(`UPDATE job_plan SET name = $2, trade = $3, description = $4, est_minutes = $5, is_active = $6, updated_at = now() WHERE id = $1`, [id, name, trade, description, est, active]);
  } else {
    const ins = await query<{ id: string }>(
      `INSERT INTO job_plan (name, trade, description, est_minutes, is_active, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
      [name, trade, description, est, active, actor.id],
    );
    planId = ins.rows[0].id;
  }
  if (input.steps !== undefined) {
    const steps = input.steps.map((s) => s.trim()).filter(Boolean).slice(0, 100);
    await query(`DELETE FROM job_plan_step WHERE plan_id = $1`, [planId]);
    let pos = 0;
    for (const title of steps) await query(`INSERT INTO job_plan_step (plan_id, position, title) VALUES ($1, $2, $3)`, [planId, pos++, title.slice(0, 300)]);
  }
  if (input.services !== undefined) {
    await query(`DELETE FROM job_plan_service WHERE plan_id = $1`, [planId]);
    const seen = new Set<string>();
    for (const s of input.services) {
      if (!UUID_RE.test(s.service_id) || seen.has(s.service_id)) continue;
      seen.add(s.service_id);
      const qty = Number.isFinite(s.qty) && s.qty > 0 ? s.qty : 1;
      await query(
        `INSERT INTO job_plan_service (plan_id, service_id, qty) SELECT $1, id, $3 FROM service_item WHERE id = $2`,
        [planId, s.service_id, qty],
      );
    }
  }
  const after = (await loadPlans(planId!))[0];
  await logAdminEvent({
    actorId: actor.id,
    entity: 'job_plan',
    entityId: planId!,
    action: id ? 'job_plan_updated' : 'job_plan_added',
    before: before ? { name: before.name, trade: before.trade, steps: before.steps.map((s) => s.title), services: before.services.map((s) => s.name), is_active: before.is_active } : null,
    after: { name: after.name, trade: after.trade, steps: after.steps.map((s) => s.title), services: after.services.map((s) => s.name), is_active: after.is_active },
  });
  return listJobPlans(actor);
}

export async function deleteJobPlan(id: string, actor: ActingPrincipal): Promise<JobPlansResponse> {
  requirePerm(actor, MAINT_PERM.plans, 'delete', 'You cannot delete job plans');
  if (!UUID_RE.test(id)) throw notFound('That job plan does not exist');
  const cur = await query<{ name: string }>(`DELETE FROM job_plan WHERE id = $1 RETURNING name`, [id]);
  if (!cur.rows[0]) throw notFound('That job plan does not exist');
  await query(`UPDATE pm_schedule SET job_plan_id = NULL WHERE job_plan_id = $1`, [id]);
  await logAdminEvent({ actorId: actor.id, entity: 'job_plan', entityId: id, action: 'job_plan_deleted', before: { name: cur.rows[0].name } });
  return listJobPlans(actor);
}

/** Lay a plan over a work order: its steps join the checklist, its services
 *  the service lines. No permission check — the callers gate it. Returns
 *  false when the plan is gone, inactive or already applied. */
export async function applyPlanToTask(taskId: string, planId: string, actorId: string | null): Promise<{ applied: boolean; name: string | null; steps: number; services: number }> {
  const plan = (await loadPlans(planId))[0];
  if (!plan) return { applied: false, name: null, steps: 0, services: 0 };
  const claim = await query(
    `INSERT INTO wo_job_plan (task_id, plan_id, plan_name, applied_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING plan_id`,
    [taskId, planId, plan.name, actorId],
  );
  if (!claim.rows[0]) return { applied: false, name: plan.name, steps: 0, services: 0 };
  const base = await query<{ n: number }>(`SELECT COALESCE(max(position), -1)::int + 1 AS n FROM wo_checklist_item WHERE task_id = $1`, [taskId]);
  let pos = base.rows[0]?.n ?? 0;
  for (const s of plan.steps) {
    await query(`INSERT INTO wo_checklist_item (task_id, title, position, created_by) VALUES ($1, $2, $3, $4)`, [taskId, s.title, pos++, actorId]);
  }
  for (const s of plan.services) {
    await query(
      `INSERT INTO wo_service (task_id, service_id, name, unit, qty, unit_price, unit_cost, added_by)
       SELECT $1, i.id, i.name, i.unit, $3, i.unit_price, i.unit_cost, $4 FROM service_item i WHERE i.id = $2`,
      [taskId, s.service_id, s.qty, actorId],
    );
  }
  return { applied: true, name: plan.name, steps: plan.steps.length, services: plan.services.length };
}

export async function applyJobPlan(taskId: string, planId: string, actor: ActingPrincipal): Promise<WoMaintenance> {
  requireWoEdit(actor);
  requirePerm(actor, MAINT_PERM.plans, 'edit', 'You cannot apply job plans');
  if (!UUID_RE.test(planId)) throw badRequest('That job plan does not exist', { field: 'plan_id' });
  const res = await applyPlanToTask(taskId, planId, actor.id);
  if (!res.name) throw badRequest('That job plan does not exist', { field: 'plan_id' });
  if (!res.applied) throw conflict(`“${res.name}” is already applied to this work order`);
  await logWo(taskId, actor, 'Job plan', null, `applied “${res.name}” (${res.steps} ${res.steps === 1 ? 'step' : 'steps'}, ${res.services} ${res.services === 1 ? 'service' : 'services'})`);
  return getWoMaintenance(taskId, actor);
}

// ═══ Time entries ════════════════════════════════════════════════════════════

type TimeRow = {
  id: string;
  task_id: string;
  wo_number: string;
  client: string | null;
  store: string | null;
  vendor_id: string | null;
  tech_name: string;
  kind: TimeKind;
  started_at: Date;
  ended_at: Date | null;
  billable: boolean;
  hourly_rate: string | null;
  note: string | null;
  created_by: string | null;
};

const TIME_SELECT = `
  SELECT e.id::text AS id, e.task_id::text AS task_id, t.wo_number, t.client, t.fields->>'Store' AS store, e.vendor_id::text AS vendor_id,
         e.tech_name, e.kind, e.started_at, e.ended_at, e.billable, e.hourly_rate, e.note, e.created_by::text AS created_by
    FROM wo_time_entry e JOIN task t ON t.id = e.task_id`;

async function mapTime(rows: TimeRow[]): Promise<TimeEntry[]> {
  const people = await peopleByIds(rows.map((r) => r.created_by));
  const now = Date.now();
  return rows.map((r) => {
    const minutes = Math.max(0, Math.round(((r.ended_at ? r.ended_at.getTime() : now) - r.started_at.getTime()) / 60_000));
    const rate = num(r.hourly_rate);
    return {
      id: r.id,
      task_id: r.task_id,
      wo_number: r.wo_number,
      place: [r.client, r.store ? `#${String(r.store).replace(/^#/, '')}` : null].filter(Boolean).join(' ') || null,
      vendor_id: r.vendor_id,
      tech_name: r.tech_name,
      kind: r.kind,
      started_at: r.started_at.toISOString(),
      ended_at: iso(r.ended_at),
      minutes,
      billable: r.billable,
      hourly_rate: rate,
      amount: r.billable ? timeAmount(minutes, rate) : null,
      note: r.note,
      created_by: r.created_by ? (people.get(r.created_by) ?? null) : null,
    };
  });
}

const sumTime = (entries: TimeEntry[]) => ({
  minutes: entries.reduce((n, e) => n + e.minutes, 0),
  billable_minutes: entries.reduce((n, e) => n + (e.billable ? e.minutes : 0), 0),
  amount: Math.round(entries.reduce((n, e) => n + (e.amount ?? 0), 0) * 100) / 100,
});

function stamp(v: string | null | undefined, label: string): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest(`${label} is not a date and time`);
  return d;
}

export async function addTimeEntry(taskId: string, input: TimeEntryInput, actor: ActingPrincipal): Promise<WoMaintenance> {
  requirePerm(actor, MAINT_PERM.time, 'create', 'You cannot log technician time');
  const tech = (input.tech_name ?? '').trim().slice(0, 160);
  if (!tech) throw badRequest('Say whose time this is', { field: 'tech_name' });
  const kind = input.kind ?? 'labor';
  const started = stamp(input.started_at, 'The start') ?? new Date();
  const ended = stamp(input.ended_at, 'The end');
  if (ended && ended < started) throw badRequest('The end is before the start', { field: 'ended_at' });
  if (started.getTime() > Date.now() + 5 * 60_000) throw badRequest('The start is in the future', { field: 'started_at' });
  if (!ended) {
    // One running timer per technician: a second one is always a mistake.
    const running = await query<{ wo_number: string }>(
      `SELECT t.wo_number FROM wo_time_entry e JOIN task t ON t.id = e.task_id WHERE lower(e.tech_name) = lower($1) AND e.ended_at IS NULL LIMIT 1`,
      [tech],
    );
    if (running.rows[0]) throw conflict(`${tech} already has a timer running on ${running.rows[0].wo_number}. Stop it first.`);
  }
  const vendorId = input.vendor_id && UUID_RE.test(input.vendor_id) ? input.vendor_id : null;
  await query(
    `INSERT INTO wo_time_entry (task_id, vendor_id, tech_name, kind, started_at, ended_at, billable, hourly_rate, note, created_by)
     VALUES ($1, (SELECT id FROM vendor WHERE id = $2::uuid), $3, $4, $5, $6, $7, $8, $9, $10)`,
    [taskId, vendorId, tech, kind, started, ended, input.billable ?? true, money(input.hourly_rate ?? null, 'The rate'), clean(input.note), actor.id],
  );
  await logWo(taskId, actor, 'Technician time', null, ended ? `logged ${Math.round((ended.getTime() - started.getTime()) / 60_000)} min for ${tech}` : `started a timer for ${tech}`);
  return getWoMaintenance(taskId, actor);
}

export async function updateTimeEntry(taskId: string, entryId: string, input: TimeEntryInput & { stop?: boolean }, actor: ActingPrincipal): Promise<WoMaintenance> {
  requirePerm(actor, MAINT_PERM.time, 'edit', 'You cannot change technician time');
  if (!UUID_RE.test(entryId)) throw notFound('That time entry does not exist');
  const cur = await query<{ tech_name: string; started_at: Date; ended_at: Date | null }>(
    `SELECT tech_name, started_at, ended_at FROM wo_time_entry WHERE id = $1 AND task_id = $2`,
    [entryId, taskId],
  );
  const row = cur.rows[0];
  if (!row) throw notFound('That time entry does not exist');
  const started = input.started_at !== undefined ? (stamp(input.started_at, 'The start') ?? row.started_at) : row.started_at;
  let ended = input.ended_at !== undefined ? stamp(input.ended_at, 'The end') : row.ended_at;
  if (input.stop && !ended) ended = new Date();
  if (ended && ended < started) throw badRequest('The end is before the start', { field: 'ended_at' });
  await query(
    `UPDATE wo_time_entry
        SET started_at = $3, ended_at = $4,
            tech_name = COALESCE($5, tech_name), kind = COALESCE($6, kind), billable = COALESCE($7, billable),
            hourly_rate = CASE WHEN $8 THEN $9::numeric ELSE hourly_rate END,
            note = CASE WHEN $10 THEN $11 ELSE note END
      WHERE id = $1 AND task_id = $2`,
    [
      entryId,
      taskId,
      started,
      ended,
      input.tech_name !== undefined ? clean(input.tech_name) : null,
      input.kind ?? null,
      input.billable ?? null,
      input.hourly_rate !== undefined,
      input.hourly_rate !== undefined ? money(input.hourly_rate, 'The rate') : null,
      input.note !== undefined,
      input.note !== undefined ? clean(input.note) : null,
    ],
  );
  if (input.stop && !row.ended_at) await logWo(taskId, actor, 'Technician time', null, `stopped the timer for ${row.tech_name}`);
  else await logWo(taskId, actor, 'Technician time', null, `changed an entry for ${row.tech_name}`);
  return getWoMaintenance(taskId, actor);
}

export async function deleteTimeEntry(taskId: string, entryId: string, actor: ActingPrincipal): Promise<WoMaintenance> {
  requirePerm(actor, MAINT_PERM.time, 'delete', 'You cannot delete technician time');
  if (!UUID_RE.test(entryId)) throw notFound('That time entry does not exist');
  const cur = await query<{ tech_name: string }>(`DELETE FROM wo_time_entry WHERE id = $1 AND task_id = $2 RETURNING tech_name`, [entryId, taskId]);
  if (!cur.rows[0]) throw notFound('That time entry does not exist');
  await logWo(taskId, actor, 'Technician time', `an entry for ${cur.rows[0].tech_name}`, null);
  return getWoMaintenance(taskId, actor);
}

/** Every entry that started inside [from, to] (Chicago days), over the work
 *  orders the viewer may see. */
export async function timeTracker(actor: ActingPrincipal, opts: { from?: string; to?: string; tech?: string }): Promise<TimeTrackerResponse> {
  requirePerm(actor, MAINT_PERM.time, 'view', 'You cannot open the time tracker');
  const to = opts.to && DAY_RE.test(opts.to) ? opts.to : today();
  const fromDefault = new Date(`${to}T12:00:00Z`);
  fromDefault.setUTCDate(fromDefault.getUTCDate() - 6);
  const from = opts.from && DAY_RE.test(opts.from) ? opts.from : fromDefault.toISOString().slice(0, 10);
  const p = new Params();
  const where = [
    `t.deleted_at IS NULL`,
    `(e.started_at AT TIME ZONE 'America/Chicago')::date BETWEEN ${p.add(from)}::date AND ${p.add(to)}::date`,
  ];
  if (opts.tech && opts.tech.trim()) where.push(`lower(e.tech_name) = lower(${p.add(opts.tech.trim())})`);
  const scope = woScopeSql(actor, p);
  if (scope) where.push(scope);
  const res = await query<TimeRow>(`${TIME_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.started_at DESC LIMIT 2000`, p.values);
  const entries = await mapTime(res.rows);
  const byTech = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    const k = e.tech_name.trim().toLowerCase();
    byTech.set(k, [...(byTech.get(k) ?? []), e]);
  }
  const technicians = [...byTech.values()]
    .map((list) => ({
      tech_name: list[0].tech_name,
      ...sumTime(list),
      entries: list.length,
      running: list.filter((e) => !e.ended_at).length,
      work_orders: new Set(list.map((e) => e.task_id)).size,
    }))
    .sort((a, b) => b.minutes - a.minutes);
  return {
    from,
    to,
    entries,
    technicians,
    totals: { ...sumTime(entries), running: entries.filter((e) => !e.ended_at).length },
    can: { create: can(actor, MAINT_PERM.time, 'create'), edit: can(actor, MAINT_PERM.time, 'edit'), delete: can(actor, MAINT_PERM.time, 'delete') },
  };
}

// ═══ Services on a work order ════════════════════════════════════════════════

export async function addWoService(
  taskId: string,
  input: { service_id?: string | null; name?: string; unit?: string; qty?: number; unit_price?: number | null; unit_cost?: number | null; note?: string | null },
  actor: ActingPrincipal,
): Promise<WoMaintenance> {
  requireWoEdit(actor);
  requirePerm(actor, MAINT_PERM.services, 'edit', 'You cannot add services to a work order');
  const qty = input.qty !== undefined && Number.isFinite(input.qty) && input.qty > 0 ? Math.round(input.qty * 100) / 100 : 1;
  let line: { service_id: string | null; name: string; unit: string; unit_price: number | null; unit_cost: number | null };
  if (input.service_id) {
    if (!UUID_RE.test(input.service_id)) throw badRequest('That service does not exist', { field: 'service_id' });
    const s = await query<{ id: string; name: string; unit: string; unit_price: string | null; unit_cost: string | null }>(
      `SELECT id::text AS id, name, unit, unit_price, unit_cost FROM service_item WHERE id = $1`,
      [input.service_id],
    );
    if (!s.rows[0]) throw badRequest('That service does not exist', { field: 'service_id' });
    line = {
      service_id: s.rows[0].id,
      name: s.rows[0].name,
      unit: s.rows[0].unit,
      unit_price: input.unit_price !== undefined ? money(input.unit_price, 'The price') : num(s.rows[0].unit_price),
      unit_cost: input.unit_cost !== undefined ? money(input.unit_cost, 'The cost') : num(s.rows[0].unit_cost),
    };
  } else {
    const name = (input.name ?? '').trim().slice(0, 200);
    if (!name) throw badRequest('Pick a service or name one', { field: 'name' });
    line = { service_id: null, name, unit: clean(input.unit) ?? 'each', unit_price: money(input.unit_price ?? null, 'The price'), unit_cost: money(input.unit_cost ?? null, 'The cost') };
  }
  await query(
    `INSERT INTO wo_service (task_id, service_id, name, unit, qty, unit_price, unit_cost, note, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [taskId, line.service_id, line.name, line.unit, qty, line.unit_price, line.unit_cost, clean(input.note), actor.id],
  );
  await logWo(taskId, actor, 'Services', null, `added ${qty} × ${line.name}`);
  return getWoMaintenance(taskId, actor);
}

export async function updateWoService(
  taskId: string,
  lineId: string,
  input: { qty?: number; unit_price?: number | null; unit_cost?: number | null; note?: string | null },
  actor: ActingPrincipal,
): Promise<WoMaintenance> {
  requireWoEdit(actor);
  requirePerm(actor, MAINT_PERM.services, 'edit', 'You cannot change the services on a work order');
  if (!UUID_RE.test(lineId)) throw notFound('That service line does not exist');
  const cur = await query<{ name: string; qty: string }>(`SELECT name, qty FROM wo_service WHERE id = $1 AND task_id = $2`, [lineId, taskId]);
  if (!cur.rows[0]) throw notFound('That service line does not exist');
  if (input.qty !== undefined && !(Number.isFinite(input.qty) && input.qty > 0)) throw badRequest('The quantity must be more than zero', { field: 'qty' });
  await query(
    `UPDATE wo_service
        SET qty = COALESCE($3, qty),
            unit_price = CASE WHEN $4 THEN $5::numeric ELSE unit_price END,
            unit_cost = CASE WHEN $6 THEN $7::numeric ELSE unit_cost END,
            note = CASE WHEN $8 THEN $9 ELSE note END
      WHERE id = $1 AND task_id = $2`,
    [
      lineId,
      taskId,
      input.qty ?? null,
      input.unit_price !== undefined,
      input.unit_price !== undefined ? money(input.unit_price, 'The price') : null,
      input.unit_cost !== undefined,
      input.unit_cost !== undefined ? money(input.unit_cost, 'The cost') : null,
      input.note !== undefined,
      input.note !== undefined ? clean(input.note) : null,
    ],
  );
  await logWo(taskId, actor, 'Services', null, `changed ${cur.rows[0].name}`);
  return getWoMaintenance(taskId, actor);
}

export async function removeWoService(taskId: string, lineId: string, actor: ActingPrincipal): Promise<WoMaintenance> {
  requireWoEdit(actor);
  requirePerm(actor, MAINT_PERM.services, 'edit', 'You cannot change the services on a work order');
  if (!UUID_RE.test(lineId)) throw notFound('That service line does not exist');
  const cur = await query<{ name: string }>(`DELETE FROM wo_service WHERE id = $1 AND task_id = $2 RETURNING name`, [lineId, taskId]);
  if (!cur.rows[0]) throw notFound('That service line does not exist');
  await logWo(taskId, actor, 'Services', cur.rows[0].name, null);
  return getWoMaintenance(taskId, actor);
}

// ═══ Work permits ════════════════════════════════════════════════════════════

type PermitRow = {
  id: string;
  permit_number: string;
  task_id: string;
  wo_number: string;
  client: string | null;
  store: string | null;
  permit_type: string;
  status: PermitStatus;
  holder: string | null;
  valid_from: string | null;
  valid_to: string | null;
  hazards: string | null;
  precautions: unknown;
  requested_by: string | null;
  requested_at: Date | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  closed_at: Date | null;
  created_at: Date;
};

const PERMIT_SELECT = `
  SELECT w.id::text AS id, w.permit_number, w.task_id::text AS task_id, t.wo_number, t.client, t.fields->>'Store' AS store,
         w.permit_type, w.status, w.holder, to_char(w.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(w.valid_to, 'YYYY-MM-DD') AS valid_to,
         w.hazards, w.precautions, w.requested_by::text AS requested_by, w.requested_at, w.decided_by::text AS decided_by, w.decided_at,
         w.decision_note, w.closed_at, w.created_at
    FROM work_permit w JOIN task t ON t.id = w.task_id`;

function cleanPrecautions(raw: unknown): PermitPrecaution[] {
  if (!Array.isArray(raw)) return [];
  const out: PermitPrecaution[] = [];
  for (const x of raw) {
    const text = typeof (x as PermitPrecaution)?.text === 'string' ? (x as PermitPrecaution).text.trim().slice(0, 200) : '';
    if (text) out.push({ text, done: Boolean((x as PermitPrecaution).done) });
    if (out.length >= 40) break;
  }
  return out;
}

async function mapPermits(rows: PermitRow[]): Promise<WorkPermit[]> {
  const people = await peopleByIds(rows.flatMap((r) => [r.requested_by, r.decided_by]));
  const day = today();
  return rows.map((r) => ({
    id: r.id,
    permit_number: r.permit_number,
    task_id: r.task_id,
    wo_number: r.wo_number,
    place: [r.client, r.store ? `#${String(r.store).replace(/^#/, '')}` : null].filter(Boolean).join(' ') || null,
    permit_type: r.permit_type,
    status: r.status,
    state: permitState(r.status, r.valid_from, r.valid_to, day),
    holder: r.holder,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    hazards: r.hazards,
    precautions: cleanPrecautions(r.precautions),
    requested_by: r.requested_by ? (people.get(r.requested_by) ?? null) : null,
    requested_at: iso(r.requested_at),
    decided_by: r.decided_by ? (people.get(r.decided_by) ?? null) : null,
    decided_at: iso(r.decided_at),
    decision_note: r.decision_note,
    closed_at: iso(r.closed_at),
    created_at: r.created_at.toISOString(),
  }));
}

export async function listPermits(actor: ActingPrincipal, opts: { state?: string; search?: string }): Promise<PermitsResponse> {
  requirePerm(actor, MAINT_PERM.permits, 'view', 'You cannot open work permits');
  const p = new Params();
  const where = [`t.deleted_at IS NULL`];
  const scope = woScopeSql(actor, p);
  if (scope) where.push(scope);
  if (opts.search && opts.search.trim()) {
    const hole = p.add(`%${opts.search.trim().toLowerCase()}%`);
    where.push(`(lower(w.permit_number) LIKE ${hole} OR lower(t.wo_number) LIKE ${hole} OR lower(COALESCE(w.holder, '')) LIKE ${hole} OR lower(COALESCE(t.client, '')) LIKE ${hole})`);
  }
  const res = await query<PermitRow>(`${PERMIT_SELECT} WHERE ${where.join(' AND ')} ORDER BY w.created_at DESC LIMIT 1000`, p.values);
  const all = await mapPermits(res.rows);
  const counts: Record<PermitState, number> = { draft: 0, requested: 0, approved: 0, active: 0, expired: 0, rejected: 0, closed: 0 };
  for (const x of all) counts[x.state] += 1;
  const wanted = opts.state && opts.state in counts ? (opts.state as PermitState) : null;
  return {
    permits: wanted ? all.filter((x) => x.state === wanted) : all,
    counts,
    can: { create: can(actor, MAINT_PERM.permits, 'create'), edit: can(actor, MAINT_PERM.permits, 'edit'), approve: can(actor, MAINT_PERM.permits, 'approve') },
  };
}

function day(v: string | null | undefined, label: string): string | null {
  const s = clean(v);
  if (s === null) return null;
  if (!DAY_RE.test(s)) throw badRequest(`${label} is not a date`);
  return s;
}

export async function createPermit(taskId: string, input: WorkPermitInput, actor: ActingPrincipal): Promise<WoMaintenance> {
  requirePerm(actor, MAINT_PERM.permits, 'create', 'You cannot write work permits');
  const type = (input.permit_type ?? '').trim().slice(0, 80);
  if (!type) throw badRequest('Pick the kind of permit', { field: 'permit_type' });
  const from = day(input.valid_from, 'The first day');
  const to = day(input.valid_to, 'The last day');
  if (from && to && to < from) throw badRequest('The last day is before the first', { field: 'valid_to' });
  const ins = await query<{ permit_number: string }>(
    `INSERT INTO work_permit (task_id, permit_type, holder, valid_from, valid_to, hazards, precautions, created_by)
     VALUES ($1, $2, $3, $4::date, $5::date, $6, $7::jsonb, $8) RETURNING permit_number`,
    [taskId, type, clean(input.holder), from, to, clean(input.hazards), JSON.stringify(cleanPrecautions(input.precautions)), actor.id],
  );
  await logWo(taskId, actor, 'Work permit', null, `${ins.rows[0].permit_number} written (${type})`);
  return getWoMaintenance(taskId, actor);
}

async function loadPermit(taskId: string, permitId: string): Promise<WorkPermit> {
  if (!UUID_RE.test(permitId)) throw notFound('That permit does not exist');
  const res = await query<PermitRow>(`${PERMIT_SELECT} WHERE w.id = $1 AND w.task_id = $2`, [permitId, taskId]);
  if (!res.rows[0]) throw notFound('That permit does not exist');
  return (await mapPermits(res.rows))[0];
}

export async function updatePermit(taskId: string, permitId: string, input: WorkPermitInput, actor: ActingPrincipal): Promise<WoMaintenance> {
  requirePerm(actor, MAINT_PERM.permits, 'edit', 'You cannot change work permits');
  const cur = await loadPermit(taskId, permitId);
  if (cur.status === 'closed') throw conflict('A closed permit cannot be changed');
  // Once it is with a manager or approved, only the precaution ticks move:
  // changing what was approved would make the approval mean nothing.
  const locked = cur.status === 'requested' || cur.status === 'approved';
  const touchesTerms = input.permit_type !== undefined || input.holder !== undefined || input.valid_from !== undefined || input.valid_to !== undefined || input.hazards !== undefined;
  if (locked && touchesTerms) throw conflict(cur.status === 'approved' ? 'This permit is approved: only its precautions can be ticked' : 'This permit is waiting for approval: only its precautions can be ticked');
  const type = input.permit_type !== undefined ? input.permit_type.trim().slice(0, 80) : cur.permit_type;
  if (!type) throw badRequest('Pick the kind of permit', { field: 'permit_type' });
  const from = input.valid_from !== undefined ? day(input.valid_from, 'The first day') : cur.valid_from;
  const to = input.valid_to !== undefined ? day(input.valid_to, 'The last day') : cur.valid_to;
  if (from && to && to < from) throw badRequest('The last day is before the first', { field: 'valid_to' });
  let precautions = cur.precautions;
  if (input.precautions !== undefined) {
    const next = cleanPrecautions(input.precautions);
    // Locked: the list itself is fixed, only the ticks change.
    precautions = locked ? cur.precautions.map((c) => ({ text: c.text, done: next.find((n) => n.text === c.text)?.done ?? c.done })) : next;
  }
  await query(
    `UPDATE work_permit SET permit_type = $3, holder = $4, valid_from = $5::date, valid_to = $6::date, hazards = $7, precautions = $8::jsonb, updated_at = now()
      WHERE id = $1 AND task_id = $2`,
    [permitId, taskId, type, input.holder !== undefined ? clean(input.holder) : cur.holder, from, to, input.hazards !== undefined ? clean(input.hazards) : cur.hazards, JSON.stringify(precautions)],
  );
  await logWo(taskId, actor, 'Work permit', null, `${cur.permit_number} changed`);
  return getWoMaintenance(taskId, actor);
}

export async function actOnPermit(taskId: string, permitId: string, action: PermitAction, note: string | null, actor: ActingPrincipal): Promise<WoMaintenance> {
  const cur = await loadPermit(taskId, permitId);
  const link = `/work-orders/${encodeURIComponent(cur.wo_number)}?tab=related`;
  if (action === 'request') {
    requirePerm(actor, MAINT_PERM.permits, 'create', 'You cannot request work permits');
    if (cur.status !== 'draft' && cur.status !== 'rejected') throw conflict('Only a draft can be sent for approval');
    const problem = permitRequestProblem(cur);
    if (problem) throw badRequest(problem);
    await query(
      `UPDATE work_permit SET status = 'requested', requested_by = $2, requested_at = now(), decided_by = NULL, decided_at = NULL, decision_note = NULL, updated_at = now() WHERE id = $1`,
      [permitId, actor.id],
    );
    await logWo(taskId, actor, 'Work permit', 'draft', `${cur.permit_number} sent for approval`);
    await notify(await holdersOf(MAINT_PERM.permits, 'approve'), {
      kind: 'work_permit',
      title: `${cur.permit_number} needs approval`,
      body: `${cur.permit_type} permit on ${cur.wo_number}${cur.place ? ` · ${cur.place}` : ''}, for ${cur.holder}.`,
      link,
      actorId: actor.id,
    });
  } else if (action === 'approve' || action === 'reject') {
    requirePerm(actor, MAINT_PERM.permits, 'approve', 'Deciding a work permit is a manager’s job');
    if (cur.status !== 'requested') throw conflict('This permit is not waiting for a decision');
    const reason = clean(note);
    if (action === 'reject' && !reason) throw badRequest('Say why the permit is rejected', { field: 'note' });
    await query(
      `UPDATE work_permit SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now() WHERE id = $1`,
      [permitId, action === 'approve' ? 'approved' : 'rejected', actor.id, reason],
    );
    await logWo(taskId, actor, 'Work permit', 'requested', `${cur.permit_number} ${action === 'approve' ? 'approved' : `rejected: ${reason}`}`);
    await notify([cur.requested_by?.id], {
      kind: 'work_permit',
      title: `${cur.permit_number} was ${action === 'approve' ? 'approved' : 'rejected'}`,
      body: action === 'approve' ? `${cur.permit_type} permit on ${cur.wo_number}.` : `${cur.permit_type} permit on ${cur.wo_number}: ${reason}`,
      link,
      actorId: actor.id,
    });
  } else if (action === 'close') {
    requirePerm(actor, MAINT_PERM.permits, 'edit', 'You cannot close work permits');
    if (cur.status !== 'approved') throw conflict('Only an approved permit can be closed');
    await query(`UPDATE work_permit SET status = 'closed', closed_by = $2, closed_at = now(), updated_at = now() WHERE id = $1`, [permitId, actor.id]);
    await logWo(taskId, actor, 'Work permit', 'approved', `${cur.permit_number} closed`);
  } else {
    requirePerm(actor, MAINT_PERM.permits, 'edit', 'You cannot change work permits');
    if (cur.status !== 'rejected') throw conflict('Only a rejected permit can go back to draft');
    await query(`UPDATE work_permit SET status = 'draft', updated_at = now() WHERE id = $1`, [permitId]);
    await logWo(taskId, actor, 'Work permit', 'rejected', `${cur.permit_number} back to draft`);
  }
  return getWoMaintenance(taskId, actor);
}

export async function deletePermit(taskId: string, permitId: string, actor: ActingPrincipal): Promise<WoMaintenance> {
  requirePerm(actor, MAINT_PERM.permits, 'edit', 'You cannot change work permits');
  const cur = await loadPermit(taskId, permitId);
  if (cur.status !== 'draft' && cur.status !== 'rejected') throw conflict('Only a draft or a rejected permit can be deleted');
  await query(`DELETE FROM work_permit WHERE id = $1`, [permitId]);
  await logWo(taskId, actor, 'Work permit', `${cur.permit_number} (${cur.permit_type})`, null);
  return getWoMaintenance(taskId, actor);
}

// ═══ Everything maintenance on one work order ════════════════════════════════

export async function getWoMaintenance(taskId: string, actor: ActingPrincipal): Promise<WoMaintenance> {
  requirePerm(actor, 'work_orders', 'view', 'You cannot open work orders');
  const seePlans = can(actor, MAINT_PERM.plans, 'view');
  const seeServices = can(actor, MAINT_PERM.services, 'view');
  const seeTime = can(actor, MAINT_PERM.time, 'view');
  const seePermits = can(actor, MAINT_PERM.permits, 'view');
  const none = { rows: [] as never[] };
  const [task, applied, plans, services, catalogue, time, techs, permits] = await Promise.all([
    query<{ wo_number: string; trade: string | null; permit: string | null }>(`SELECT wo_number, trade, fields->>'Work Permit Needed' AS permit FROM task WHERE id = $1`, [taskId]),
    seePlans
      ? query<{ plan_id: string; name: string; applied_at: Date; applied_by: string | null }>(
          `SELECT plan_id::text AS plan_id, plan_name AS name, applied_at, applied_by::text AS applied_by FROM wo_job_plan WHERE task_id = $1 ORDER BY applied_at`,
          [taskId],
        )
      : none,
    seePlans
      ? query<{ id: string; name: string; trade: string | null; steps: number; services: number }>(
          `SELECT p.id::text AS id, p.name, p.trade,
                  (SELECT count(*)::int FROM job_plan_step s WHERE s.plan_id = p.id) AS steps,
                  (SELECT count(*)::int FROM job_plan_service s WHERE s.plan_id = p.id) AS services
             FROM job_plan p WHERE p.is_active ORDER BY lower(p.name)`,
        )
      : none,
    seeServices
      ? query<{ id: string; service_id: string | null; name: string; unit: string; qty: string; unit_price: string | null; unit_cost: string | null; note: string | null; added_by: string | null; added_at: Date }>(
          `SELECT id::text AS id, service_id::text AS service_id, name, unit, qty, unit_price, unit_cost, note, added_by::text AS added_by, added_at
             FROM wo_service WHERE task_id = $1 ORDER BY added_at`,
          [taskId],
        )
      : none,
    seeServices
      ? query<{ id: string; name: string; unit: string; unit_price: string | null; unit_cost: string | null; trade: string | null }>(
          `SELECT id::text AS id, name, unit, unit_price, unit_cost, trade FROM service_item WHERE is_active ORDER BY lower(name)`,
        )
      : none,
    seeTime ? query<TimeRow>(`${TIME_SELECT} WHERE e.task_id = $1 ORDER BY e.started_at`, [taskId]) : none,
    seeTime
      ? query<{ vendor_id: string; name: string }>(
          `SELECT v.id::text AS vendor_id, v.name FROM wo_technician wt JOIN vendor v ON v.id = wt.vendor_id
            WHERE wt.task_id = $1 AND wt.released_at IS NULL ORDER BY lower(v.name)`,
          [taskId],
        )
      : none,
    seePermits ? query<PermitRow>(`${PERMIT_SELECT} WHERE w.task_id = $1 ORDER BY w.created_at`, [taskId]) : none,
  ]);
  if (!task.rows[0]) throw notFound('Work order not found');
  const people = await peopleByIds([...applied.rows.map((r) => r.applied_by), ...services.rows.map((r) => r.added_by)]);
  const appliedIds = new Set(applied.rows.map((r) => r.plan_id));
  const lines: WoServiceLine[] = services.rows.map((r) => ({
    id: r.id,
    service_id: r.service_id,
    name: r.name,
    unit: r.unit,
    qty: Number(r.qty),
    unit_price: num(r.unit_price),
    unit_cost: num(r.unit_cost),
    note: r.note,
    added_by: r.added_by ? (people.get(r.added_by) ?? null) : null,
    added_at: r.added_at.toISOString(),
  }));
  const entries = await mapTime(time.rows);
  const woEdit = can(actor, 'work_orders', 'edit');
  const permitFlag = String(task.rows[0].permit ?? '').toLowerCase();
  return {
    wo_number: task.rows[0].wo_number,
    permit_needed: permitFlag === 'true' || permitFlag === 'yes',
    plans_applied: applied.rows.map((r) => ({ plan_id: r.plan_id, name: r.name, applied_at: r.applied_at.toISOString(), applied_by: r.applied_by ? (people.get(r.applied_by) ?? null) : null })),
    plans: plans.rows.map((p) => ({ ...p, steps: Number(p.steps), services: Number(p.services), applied: appliedIds.has(p.id) })),
    services: lines,
    services_total: {
      price: Math.round(lines.reduce((n, l) => n + l.qty * (l.unit_price ?? 0), 0) * 100) / 100,
      cost: Math.round(lines.reduce((n, l) => n + l.qty * (l.unit_cost ?? 0), 0) * 100) / 100,
    },
    catalogue: catalogue.rows.map((c) => ({ ...c, unit_price: num(c.unit_price), unit_cost: num(c.unit_cost) })),
    time: entries,
    time_total: sumTime(entries),
    technicians: techs.rows,
    permits: await mapPermits(permits.rows),
    can: {
      plans: seePlans && woEdit && can(actor, MAINT_PERM.plans, 'edit'),
      services: seeServices && woEdit && can(actor, MAINT_PERM.services, 'edit'),
      time_view: seeTime,
      time_create: can(actor, MAINT_PERM.time, 'create'),
      time_edit: can(actor, MAINT_PERM.time, 'edit'),
      time_delete: can(actor, MAINT_PERM.time, 'delete'),
      permits_view: seePermits,
      permits_create: can(actor, MAINT_PERM.permits, 'create'),
      permits_edit: can(actor, MAINT_PERM.permits, 'edit'),
      permits_approve: can(actor, MAINT_PERM.permits, 'approve'),
    },
  };
}

// ═══ Assignment Manager ══════════════════════════════════════════════════════
//
// Who carries what, and the queue of open work orders to hand out. It reads
// the Assignee field the scope rule (0026) already keys on, so what it shows
// is what each person's "Only theirs" list shows. Assigning goes through the
// ordinary field edit, so the audit trail, the intake gate and the automations
// all see it.

// Exported for the Assignee pickers' availability view (services/principals.ts),
// so "active" and "assigned to" mean one thing everywhere a load is counted.
export const OPEN_SQL = `t.deleted_at IS NULL AND t.status_group::text NOT IN ('done', 'closed') AND t.cancelled_at IS NULL`;
export const ASSIGNEE_SQL = `COALESCE(NULLIF(t.fields->>'Assignee', ''), t.fields->>'Assignee Name TXT', '')`;

export async function assignmentBoard(actor: ActingPrincipal, opts: { who?: string; search?: string; trade?: string }): Promise<AssignmentBoard> {
  requirePerm(actor, MAINT_PERM.assignment, 'view', 'You cannot open the Assignment Manager');
  const day = today();
  const [people, load] = await Promise.all([
    query<{ id: string; name: string; role_label: string | null }>(
      `SELECT p.id::text AS id, p.display_name AS name, r.label AS role_label
         FROM principal p LEFT JOIN role r ON r.code = p.role
        WHERE p.kind = 'human' AND p.status <> 'disabled'
        ORDER BY lower(p.display_name)`,
    ),
    query<{ name: string; open: number; emergencies: number; overdue: number }>(
      `SELECT lower(btrim(asg.n)) AS name, count(*)::int AS open,
              count(*) FILTER (WHERE lower(COALESCE(t.fields->>'Emergency', '')) IN ('true', 'yes'))::int AS emergencies,
              count(*) FILTER (WHERE NULLIF(t.fields->>'SLA Due Date', '') IS NOT NULL AND left(t.fields->>'SLA Due Date', 10) < $1)::int AS overdue
         FROM task t, unnest(string_to_array(${ASSIGNEE_SQL}, ',')) AS asg(n)
        WHERE ${OPEN_SQL} AND btrim(asg.n) <> ''
        GROUP BY 1`,
      [day],
    ),
  ]);
  const byName = new Map(load.rows.map((r) => [r.name, r]));
  const rows: AssignmentPerson[] = people.rows.map((p) => {
    const l = byName.get(p.name.trim().toLowerCase());
    return { ...p, open: Number(l?.open ?? 0), emergencies: Number(l?.emergencies ?? 0), overdue: Number(l?.overdue ?? 0) };
  });
  const unassigned = await query<{ n: number }>(`SELECT count(*)::int AS n FROM task t WHERE ${OPEN_SQL} AND btrim(${ASSIGNEE_SQL}) = ''`);

  const p = new Params();
  const where = [OPEN_SQL];
  const who = (opts.who ?? '').trim();
  if (who === '' || who === 'unassigned') where.push(`btrim(${ASSIGNEE_SQL}) = ''`);
  else if (who !== 'all') {
    where.push(`EXISTS (SELECT 1 FROM unnest(string_to_array(${ASSIGNEE_SQL}, ',')) AS a(n) WHERE lower(btrim(a.n)) = lower(btrim(${p.add(who)})))`);
  }
  if (opts.trade && opts.trade.trim()) where.push(`lower(COALESCE(t.trade, '')) = lower(${p.add(opts.trade.trim())})`);
  if (opts.search && opts.search.trim()) {
    const hole = p.add(`%${opts.search.trim().toLowerCase()}%`);
    where.push(`(lower(t.wo_number) LIKE ${hole} OR lower(COALESCE(t.client, '')) LIKE ${hole} OR lower(COALESCE(t.city, '')) LIKE ${hole} OR lower(COALESCE(t.fields->>'Store', '')) LIKE ${hole})`);
  }
  const scope = woScopeSql(actor, p);
  if (scope) where.push(scope);
  const list = await query<AssignmentWorkOrder & { total: number }>(
    `SELECT t.id::text AS id, t.wo_number, t.client, t.fields->>'Store' AS store, t.city, t.state, t.trade, st.name AS status_name,
            t.priority, lower(COALESCE(t.fields->>'Emergency', '')) IN ('true', 'yes') AS emergency,
            NULLIF(btrim(${ASSIGNEE_SQL}), '') AS assignee, v.name AS vendor,
            GREATEST(0, (now()::date - COALESCE(t.date_received, t.created_at::date)))::int AS age_days,
            count(*) OVER ()::int AS total
       FROM task t JOIN status st ON st.id = t.status_id LEFT JOIN vendor v ON v.id = t.vendor_id
      WHERE ${where.join(' AND ')}
      ORDER BY (lower(COALESCE(t.fields->>'Emergency', '')) IN ('true', 'yes')) DESC, COALESCE(t.date_received, t.created_at::date) ASC
      LIMIT 300`,
    p.values,
  );
  return {
    people: rows.filter((r) => r.open > 0 || r.role_label !== null).sort((a, b) => b.open - a.open || a.name.localeCompare(b.name)),
    unassigned: Number(unassigned.rows[0]?.n ?? 0),
    work_orders: list.rows.map(({ total: _total, ...r }) => ({ ...r, age_days: Number(r.age_days) })),
    total: Number(list.rows[0]?.total ?? 0),
    can: { edit: can(actor, MAINT_PERM.assignment, 'edit') && can(actor, 'work_orders', 'edit') },
  };
}

/** Hand a set of work orders to one person (or to nobody). Each one is an
 *  ordinary field edit; one that is refused (a gate, a locked field) is
 *  reported and the rest still go through. */
export async function assignWorkOrders(ids: string[], principalId: string | null, actor: ActingPrincipal): Promise<{ assigned: number; failed: { wo_number: string; reason: string }[] }> {
  requirePerm(actor, MAINT_PERM.assignment, 'edit', 'You cannot assign work orders from the Assignment Manager');
  requireWoEdit(actor);
  const list = [...new Set(ids.filter((x) => UUID_RE.test(x)))].slice(0, 200);
  if (list.length === 0) throw badRequest('Pick at least one work order');
  await assertIdsInScope(actor, list);
  let name = '';
  if (principalId) {
    if (!UUID_RE.test(principalId)) throw badRequest('That person does not exist', { field: 'principal_id' });
    const who = await query<{ name: string }>(`SELECT display_name AS name FROM principal WHERE id = $1 AND kind = 'human' AND status <> 'disabled'`, [principalId]);
    if (!who.rows[0]) throw badRequest('That person does not exist', { field: 'principal_id' });
    name = who.rows[0].name;
  }
  const { updateWorkOrderFields } = await import('./woFieldValues.js');
  const numbers = await query<{ id: string; wo_number: string }>(`SELECT id::text AS id, wo_number FROM task WHERE id = ANY($1::uuid[])`, [list]);
  const failed: { wo_number: string; reason: string }[] = [];
  let assigned = 0;
  for (const row of numbers.rows) {
    try {
      await updateWorkOrderFields(row.id, { 'fields.Assignee': name }, actor.id);
      assigned += 1;
    } catch (err) {
      failed.push({ wo_number: row.wo_number, reason: err instanceof Error ? err.message : 'could not be assigned' });
    }
  }
  if (principalId && assigned > 0) {
    await notify([principalId], {
      kind: 'assignment',
      title: assigned === 1 ? `${numbers.rows[0].wo_number} was assigned to you` : `${assigned} work orders were assigned to you`,
      body: `By ${actor.name}, from the Assignment Manager.`,
      link: assigned === 1 ? `/work-orders/${encodeURIComponent(numbers.rows[0].wo_number)}` : '/',
      actorId: actor.id,
    });
  }
  return { assigned, failed };
}
