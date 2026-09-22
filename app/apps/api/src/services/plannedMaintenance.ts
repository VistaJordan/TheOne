// Planned maintenance (0051) — work orders raised by the calendar.
//
// Two halves. The first is the schedules: list, create, edit, delete, each
// logged as an admin change (a schedule is a promise to a client, and a
// changed rhythm has to be explicable). The second is the raise: for every
// active schedule, every due date inside its lead window that has no
// occurrence yet becomes a work order — one INSERT into task the way the
// intake draft's Submit does it (same start status family, same profit
// formula, same 'created' activity row, same automations, assignment through
// the ordinary field path so it is audited and scope-mirrored), plus a
// pm_occurrence row whose UNIQUE (schedule_id, due_on) makes the whole thing
// idempotent: the page read, the Raise now button and the cron can all run at
// once and a date is raised exactly once.
//
// Raised work orders do NOT go through the 7.1 acceptance queue: that queue
// is for work that arrives from a client and needs a manager to say yes;
// planned work was said yes to when the schedule was made, and it carries
// its dispatcher already.

import {
  PM_PERM_KEY,
  PM_START_STATUS_NAME,
  PM_UNITS,
  isDueToRaise,
  nextDueOn,
  pmWoNumber,
  type PmOccurrence,
  type PmSchedule,
  type PmScheduleInput,
  type PmSchedulesResponse,
  type PmUnit,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { requirePerm } from './permissions.js';
import { logAdminEvent } from './adminAudit.js';
import type { ActingPrincipal } from './activity.js';
import { applyProfitFormula } from './money.js';
import { INTAKE_START_STATUS_NAME } from './intake.js';
import { dispatchAutomations } from './automations.js';
import { serviceActorId } from './serviceActors.js';

export function requirePmView(p: ActingPrincipal): void {
  requirePerm(p, PM_PERM_KEY, 'view', 'You cannot see planned maintenance');
}
function requirePmEdit(p: ActingPrincipal, action: 'create' | 'edit' | 'delete'): void {
  requirePmView(p);
  requirePerm(p, PM_PERM_KEY, action, 'You cannot change planned maintenance');
}

/** The machine that raises on the clock, so the audit trail says which
    system acted rather than naming whoever happened to open the page. */
function pmActorId(): Promise<string> {
  return serviceActorId('Planned maintenance', 'PM');
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  code: string;
  name: string;
  client: string | null;
  billing_entity: string | null;
  store: string | null;
  site_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  description: string | null;
  nte: string | number | null;
  assignee: string | null;
  every: number;
  unit: string;
  starts_on: string;
  ends_on: string | null;
  lead_days: number;
  active: boolean;
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  last_due_on: string | null;
  raised_count: number | string;
  last_task_id: string | null;
  last_wo_number: string | null;
  last_wo_due_on: string | null;
}

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const SELECT = `
  SELECT s.id::text AS id, s.code, s.name, s.client, s.billing_entity, s.store, s.site_name,
         s.address, s.city, s.state, s.trade, s.description, s.nte, s.assignee,
         s.every, s.unit,
         to_char(s.starts_on, 'YYYY-MM-DD') AS starts_on,
         to_char(s.ends_on, 'YYYY-MM-DD') AS ends_on,
         s.lead_days, s.active,
         s.created_by::text AS created_by_id, p.display_name AS created_by_name,
         ${ISO('s.created_at')} AS created_at,
         ${ISO('s.updated_at')} AS updated_at,
         (SELECT to_char(MAX(o.due_on), 'YYYY-MM-DD') FROM pm_occurrence o WHERE o.schedule_id = s.id) AS last_due_on,
         (SELECT count(*)::int FROM pm_occurrence o WHERE o.schedule_id = s.id AND o.status = 'raised') AS raised_count,
         lw.task_id AS last_task_id, lw.wo_number AS last_wo_number, lw.due_on AS last_wo_due_on
    FROM pm_schedule s
    LEFT JOIN principal p ON p.id = s.created_by
    LEFT JOIN LATERAL (
      SELECT o.task_id::text AS task_id, t.wo_number, to_char(o.due_on, 'YYYY-MM-DD') AS due_on
        FROM pm_occurrence o JOIN task t ON t.id = o.task_id
       WHERE o.schedule_id = s.id AND o.status = 'raised'
       ORDER BY o.due_on DESC LIMIT 1
    ) lw ON true`;

function mapRow(r: Row): PmSchedule {
  const unit = (PM_UNITS as readonly string[]).includes(r.unit) ? (r.unit as PmUnit) : 'month';
  const rhythm = { every: r.every, unit, starts_on: r.starts_on, ends_on: r.ends_on };
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    client: r.client,
    billing_entity: r.billing_entity,
    store: r.store,
    site_name: r.site_name,
    address: r.address,
    city: r.city,
    state: r.state,
    trade: r.trade,
    description: r.description,
    nte: r.nte === null ? null : Number(r.nte),
    assignee: r.assignee,
    every: r.every,
    unit,
    starts_on: r.starts_on,
    ends_on: r.ends_on,
    lead_days: r.lead_days,
    active: r.active,
    created_by: r.created_by_id ? { id: r.created_by_id, display_name: r.created_by_name ?? '—' } : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_due_on: r.last_due_on,
    next_due_on: nextDueOn(rhythm, r.last_due_on),
    raised_count: Number(r.raised_count ?? 0),
    last_wo:
      r.last_task_id && r.last_wo_number && r.last_wo_due_on
        ? { task_id: r.last_task_id, wo_number: r.last_wo_number, due_on: r.last_wo_due_on }
        : null,
  };
}

export async function listSchedules(actor: ActingPrincipal): Promise<PmSchedulesResponse> {
  requirePmView(actor);
  // Opening the page is the most reliable clock this deployment has, so
  // anything due goes out first and the list shows it already raised.
  await raiseDueWorkOrders();
  const res = await query<Row>(`${SELECT} ORDER BY s.active DESC, s.name, s.code`);
  return { items: res.rows.map(mapRow) };
}

async function rowById(id: string): Promise<Row> {
  const res = await query<Row>(`${SELECT} WHERE s.id = $1`, [id]);
  if (!res.rows[0]) throw notFound('No such schedule');
  return res.rows[0];
}

export async function getSchedule(
  id: string,
  actor: ActingPrincipal,
): Promise<{ schedule: PmSchedule; occurrences: PmOccurrence[] }> {
  requirePmView(actor);
  const schedule = mapRow(await rowById(id));
  const occ = await query<PmOccurrence>(
    `SELECT o.id::text AS id, o.schedule_id::text AS schedule_id,
            to_char(o.due_on, 'YYYY-MM-DD') AS due_on, o.status,
            o.task_id::text AS task_id, t.wo_number, st.name AS wo_status,
            ${ISO('o.created_at')} AS created_at
       FROM pm_occurrence o
       LEFT JOIN task t ON t.id = o.task_id
       LEFT JOIN status st ON st.id = t.status_id
      WHERE o.schedule_id = $1
      ORDER BY o.due_on DESC`,
    [id],
  );
  return { schedule, occurrences: occ.rows };
}

// ── Writing ──────────────────────────────────────────────────────────────────

function snapshot(s: PmSchedule): Record<string, unknown> & { name: string } {
  return {
    name: `${s.code} · ${s.name}`,
    code: s.code,
    client: s.client,
    billing_entity: s.billing_entity,
    store: s.store,
    site_name: s.site_name,
    address: s.address,
    city: s.city,
    state: s.state,
    trade: s.trade,
    description: s.description,
    nte: s.nte,
    assignee: s.assignee,
    every: s.every,
    unit: s.unit,
    starts_on: s.starts_on,
    ends_on: s.ends_on,
    lead_days: s.lead_days,
    active: s.active,
  };
}

const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s.length > 0 ? s : null;
};

async function assertAssignee(name: string | null): Promise<void> {
  if (!name) return;
  // The value lands in the Assignee seat, which the 0032 scope matches by
  // display name — a typo would hide every raised work order from everyone.
  const person = await query<{ id: string }>(
    `SELECT id::text AS id FROM principal
      WHERE kind = 'human' AND display_name = $1 AND status <> 'disabled' LIMIT 1`,
    [name],
  );
  if (!person.rows[0]) throw badRequest(`"${name}" is not an active person on file`, { assignee: name });
}

function validate(input: PmScheduleInput): void {
  if (clean(input.name) === null) throw badRequest('A schedule needs a name');
  if (!Number.isInteger(input.every) || input.every < 1 || input.every > 365) {
    throw badRequest('"Every" must be a whole number from 1 to 365');
  }
  if (!(PM_UNITS as readonly string[]).includes(input.unit)) throw badRequest('Unknown period');
  if (input.ends_on && input.ends_on < input.starts_on) throw badRequest('The end date is before the start');
}

const VALUES = (s: PmScheduleInput, actorId: string | null) => [
  clean(s.name),
  clean(s.client),
  clean(s.billing_entity),
  clean(s.store),
  clean(s.site_name),
  clean(s.address),
  clean(s.city),
  clean(s.state),
  clean(s.trade),
  clean(s.description),
  s.nte ?? null,
  clean(s.assignee),
  s.every,
  s.unit,
  s.starts_on,
  s.ends_on ?? null,
  s.lead_days ?? 7,
  s.active ?? true,
  actorId,
];

export async function createSchedule(input: PmScheduleInput, actor: ActingPrincipal): Promise<PmSchedule> {
  requirePmEdit(actor, 'create');
  validate(input);
  await assertAssignee(clean(input.assignee));
  const res = await query<{ id: string }>(
    `INSERT INTO pm_schedule
       (name, client, billing_entity, store, site_name, address, city, state, trade, description,
        nte, assignee, every, unit, starts_on, ends_on, lead_days, active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12, $13, $14, $15::date, $16::date, $17, $18, $19)
     RETURNING id::text AS id`,
    VALUES(input, actor.id),
  );
  const created = mapRow(await rowById(res.rows[0].id));
  await logAdminEvent({
    actorId: actor.id,
    entity: 'pm_schedule',
    entityId: created.id,
    action: 'pm_schedule_created',
    after: snapshot(created),
  });
  // Anything already inside the lead window goes out straight away, so a
  // schedule that starts today has its first work order before the dialog
  // closes.
  await raiseDueWorkOrders(created.id);
  return mapRow(await rowById(created.id));
}

export async function updateSchedule(id: string, input: PmScheduleInput, actor: ActingPrincipal): Promise<PmSchedule> {
  requirePmEdit(actor, 'edit');
  validate(input);
  await assertAssignee(clean(input.assignee));
  const before = mapRow(await rowById(id));
  await query(
    `UPDATE pm_schedule
        SET name = $2, client = $3, billing_entity = $4, store = $5, site_name = $6, address = $7,
            city = $8, state = $9, trade = $10, description = $11, nte = $12::numeric, assignee = $13,
            every = $14, unit = $15, starts_on = $16::date, ends_on = $17::date, lead_days = $18, active = $19
      WHERE id = $1`,
    [id, ...VALUES(input, null).slice(0, 18)],
  );
  const after = mapRow(await rowById(id));
  await logAdminEvent({
    actorId: actor.id,
    entity: 'pm_schedule',
    entityId: id,
    action: 'pm_schedule_updated',
    before: snapshot(before),
    after: snapshot(after),
  });
  await raiseDueWorkOrders(id);
  return mapRow(await rowById(id));
}

export async function deleteSchedule(id: string, actor: ActingPrincipal): Promise<void> {
  requirePmEdit(actor, 'delete');
  const before = mapRow(await rowById(id));
  // Its work orders stay (task.pm_schedule_id → NULL); only the plan goes.
  await query(`DELETE FROM pm_schedule WHERE id = $1`, [id]);
  await logAdminEvent({
    actorId: actor.id,
    entity: 'pm_schedule',
    entityId: id,
    action: 'pm_schedule_deleted',
    before: snapshot(before),
    after: null,
  });
}

// ── The raise ────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** First meaningful line, the way the import and the intake title a work order. */
function titleOf(s: PmSchedule): string {
  const line = (s.description ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  const base = line ?? s.name;
  const title = `PM · ${base}`;
  return title.length > 120 ? title.slice(0, 120) : title;
}

/**
 * Raise ONE due date of a schedule as a work order. Returns the task id, or
 * null when that date was already dealt with (the UNIQUE on pm_occurrence
 * decides, inside the transaction, so two callers cannot both insert).
 */
async function raiseOne(s: PmSchedule, dueOn: string, actorId: string): Promise<string | null> {
  const start = await query<{ id: string; status_group: string }>(
    `SELECT id::text AS id, status_group::text AS status_group FROM status
      WHERE lower(name) = lower($1) OR lower(name) = lower($2)
      ORDER BY (lower(name) = lower($1)) DESC LIMIT 1`,
    [PM_START_STATUS_NAME, INTAKE_START_STATUS_NAME],
  );
  if (!start.rows[0]) return null;

  const woNumber = pmWoNumber(s.code, dueOn);
  const bag: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== null && v !== undefined && v !== '') bag[k] = v;
  };
  put('Client', s.client);
  put('21. Comp', s.billing_entity);
  put('Store', s.store);
  put('17. Address', s.address);
  put('City', s.city);
  put('State', s.state);
  put('Trade', s.trade);
  put('16. Client NTE 🔴', s.nte);
  put('35. WO Description', `${s.code} · ${s.name}${s.description ? `\n\n${s.description}` : ''}`);
  put('Date-Time Received', today());
  put('Scheduled Date', dueOn);
  put('Due Date', dueOn);
  applyProfitFormula(bag);

  let taskId: string | null = null;
  await withTransaction(async (tx) => {
    // Claim the date first; a duplicate key here means someone else has it.
    const claim = await tx.query<{ id: string }>(
      `INSERT INTO pm_occurrence (schedule_id, due_on, status, created_by)
       VALUES ($1, $2::date, 'raised', $3)
       ON CONFLICT (schedule_id, due_on) DO NOTHING
       RETURNING id::text AS id`,
      [s.id, dueOn, actorId],
    );
    if (!claim.rows[0]) return;
    const taken = await tx.query<{ id: string }>(`SELECT id FROM task WHERE wo_number = $1`, [woNumber]);
    if (taken.rows[0]) return; // raised by hand under that number: leave it be

    const ins = await tx.query<{ id: string }>(
      `INSERT INTO task
         (wo_number, ext_name, title, description, client, city, state, trade,
          billing_entity, nte, priority, date_received, home_list_id,
          status_id, status_group, fields, pm_schedule_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12::date, $13, $14, $15, $16::jsonb, $17)
       RETURNING id::text AS id`,
      [
        woNumber,
        s.code,
        titleOf(s),
        String(bag['35. WO Description']),
        s.client,
        s.city,
        s.state,
        s.trade,
        s.billing_entity,
        s.nte,
        null,
        today(),
        null,
        start.rows[0].id,
        start.rows[0].status_group,
        JSON.stringify(bag),
        s.id,
      ],
    );
    taskId = ins.rows[0].id;
    await tx.query(`UPDATE pm_occurrence SET task_id = $2 WHERE id = $1`, [claim.rows[0].id, taskId]);
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'created', NULL, NULL, $3::jsonb)`,
      [
        actorId,
        taskId,
        JSON.stringify({ wo_number: woNumber, source: 'planned_maintenance', schedule: s.code, due_on: dueOn }),
      ],
    );
  });
  if (!taskId) return null;

  // After the commit, exactly as Add work order does it: the create rules
  // first, then the assignment as an ordinary field edit so it is audited
  // and the 0032 scope sees it.
  await dispatchAutomations({ taskId, kind: 'created' });
  if (s.assignee) {
    const { updateWorkOrderFields } = await import('./woFieldValues.js');
    await updateWorkOrderFields(taskId, { 'fields.Assignee': s.assignee }, actorId);
  }
  return taskId;
}

/**
 * Every active schedule (or one), every due date inside its lead window that
 * has not been raised or skipped: raise it. Safe to call as often as anyone
 * likes. Returns how many work orders went out.
 */
export async function raiseDueWorkOrders(onlyId?: string): Promise<{ raised: number }> {
  const res = await query<Row>(
    `${SELECT} WHERE s.active AND ($1::uuid IS NULL OR s.id = $1::uuid)`,
    [onlyId ?? null],
  );
  const actorId = await pmActorId();
  const now = today();
  let raised = 0;
  for (const r of res.rows) {
    const s = mapRow(r);
    let due = s.next_due_on;
    // Bounded: a schedule created with a start years back would otherwise
    // raise every missed date at once.
    for (let n = 0; due && n < 12 && isDueToRaise(due, now, s.lead_days); n += 1) {
      if (await raiseOne(s, due, actorId)) raised += 1;
      due = nextDueOn(s, due);
    }
  }
  return { raised };
}

/** The button: raise the NEXT due date now, lead window or not. */
export async function raiseNext(id: string, actor: ActingPrincipal): Promise<{ schedule: PmSchedule; task_id: string | null }> {
  requirePmEdit(actor, 'edit');
  const s = mapRow(await rowById(id));
  if (!s.next_due_on) throw badRequest('This schedule has reached its end date');
  const taskId = await raiseOne(s, s.next_due_on, actor.id);
  return { schedule: mapRow(await rowById(id)), task_id: taskId };
}

/** Skip the next due date: it is recorded so it is never raised. */
export async function skipNext(id: string, actor: ActingPrincipal): Promise<PmSchedule> {
  requirePmEdit(actor, 'edit');
  const s = mapRow(await rowById(id));
  if (!s.next_due_on) throw badRequest('This schedule has reached its end date');
  await query(
    `INSERT INTO pm_occurrence (schedule_id, due_on, status, created_by)
     VALUES ($1, $2::date, 'skipped', $3) ON CONFLICT (schedule_id, due_on) DO NOTHING`,
    [id, s.next_due_on, actor.id],
  );
  await logAdminEvent({
    actorId: actor.id,
    entity: 'pm_schedule',
    entityId: id,
    action: 'pm_schedule_skipped',
    before: snapshot(s),
    after: { ...snapshot(s), skipped_due_on: s.next_due_on },
  });
  return mapRow(await rowById(id));
}
