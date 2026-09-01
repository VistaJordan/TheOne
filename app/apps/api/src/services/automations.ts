// Automations — the rules engine. When (trigger) → If (conditions) → Then (actions).
//
// A rule row (see 0012_automations.sql) is pure configuration: the trigger
// names a catalogue field (or any), the conditions are the SAME FilterSet the
// list's filter builder produces (compiled by woFields.ts against the ONE work
// order that fired), and each action sets a catalogue field to a value.
//
// The engine is called by every write path AFTER its transaction commits
// (dispatchAutomations below) — PGlite is single-connection, so nothing here
// may run while a caller's transaction is open. Actions are applied through
// the ordinary write services (changeStatus / updateWorkOrderFields), so an
// automation's writes carry the same audit rows, mirror-column sync and typed
// coercion as a human's — attributed to the "Automations" service principal.
//
// LOOP GUARDS, two of them:
//   1. one root event fires each rule AT MOST ONCE per work order — the fired
//      set travels down the whole chain, so A→B→A cannot ping-pong;
//   2. a chain of DISTINCT rules stops at MAX_DEPTH hops regardless.
// A rule whose actions fail (a status renamed away, a bad value) logs an
// 'error' run and never breaks the user's request — the engine swallows its
// own failures by design.

import { query } from '../db.js';
import { ApiError } from '../errors.js';
import {
  compileFilters,
  resolveField,
  Params,
  type FilterSet,
} from './woFields.js';
import type { TaskChange } from './woAudit.js';
import type {
  AutomationAction,
  AutomationItem,
  AutomationRunItem,
  AutomationTrigger,
} from '@theone/shared';

const MAX_DEPTH = 5;
const MAX_ACTIONS = 10;

export const PRIORITY_VALUES = ['urgent', 'high', 'normal', 'low'];

// ── The event a write path reports ───────────────────────────────────────────

export interface AutomationEvent {
  taskId: string;
  kind: 'created' | 'changed';
  /** The audit-log changes of a 'changed' event, exactly as logTaskChanges saw
      them ('status_id', 'client', 'fields.<key>', …). */
  changes?: TaskChange[];
}

/** Travels down a chain of automation-caused writes. */
export interface AutoCtx {
  depth: number;
  /** Rule ids that already fired for this root event (per work order). */
  fired: Set<string>;
}

// ── Mirror translation ───────────────────────────────────────────────────────
// Seven bag keys are also promoted columns (see woMirrors.ts). A change to
// either side must match a trigger written against the other, and an action on
// the core key ('client') is applied through the bag key so the mirror logic
// runs.

import { MIRROR_BY_JSON_KEY } from './woMirrors.js';

const CORE_BY_JSON_KEY = new Map(
  Object.entries(MIRROR_BY_JSON_KEY).map(([jsonKey, m]) => [jsonKey, m.column]),
);
const JSON_KEY_BY_CORE = new Map(
  Object.entries(MIRROR_BY_JSON_KEY).map(([jsonKey, m]) => [m.column, jsonKey]),
);

/** Every catalogue key a change record answers to. */
function matchKeysOf(change: TaskChange): string[] {
  const f = change.field;
  if (f === 'status_id') return ['status'];
  if (f === 'home_list_id') return ['home_list'];
  if (f.startsWith('fields.')) {
    const jsonKey = f.slice('fields.'.length);
    const core = CORE_BY_JSON_KEY.get(jsonKey);
    return core ? [f, core] : [f];
  }
  const jsonKey = JSON_KEY_BY_CORE.get(f);
  return jsonKey ? [f, `fields.${jsonKey}`] : [f];
}

/** The human-comparable "new value" of a change, for the trigger's `to` test. */
function afterValueOf(change: TaskChange): string {
  const a = change.after;
  if (a === null || a === undefined) return '';
  if (typeof a === 'object') {
    const rec = a as Record<string, unknown>;
    const v = rec.status_name ?? rec.list_name ?? null;
    return v === null ? JSON.stringify(a) : String(v);
  }
  return String(a);
}

const norm = (s: string) => s.trim().toLowerCase();

/** A value as a number, currency chrome stripped ("$1,500.00" → 1500), or null
    when it does not read as one — the same tolerance the filter coercion has. */
function numOf(s: string): number | null {
  const digits = s.replace(/[^0-9.-]/g, '');
  if (!/^-?\d*\.?\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** Does a change's new value satisfy the trigger's `to` test? */
function toValueMatches(trigger: AutomationTrigger, after: string): boolean {
  const op = trigger.to_op ?? 'eq';
  if (op === 'eq') return norm(after) === norm(String(trigger.to));
  const a = numOf(after);
  const b = numOf(String(trigger.to));
  if (a === null || b === null) return false;
  switch (op) {
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    default: return false;
  }
}

// ── The service principal automations act as ─────────────────────────────────
// Resolved lazily and (re)created if missing: seed.ts truncates principal, and
// a rules engine that dies after every re-seed would be a support ticket.

let actorIdCache: string | null = null;

async function automationActorId(): Promise<string> {
  if (actorIdCache) {
    const still = await query<{ id: string }>(`SELECT id FROM principal WHERE id = $1`, [actorIdCache]);
    if (still.rows[0]) return actorIdCache;
    actorIdCache = null;
  }
  const found = await query<{ id: string }>(
    `SELECT id FROM principal WHERE kind = 'service' AND display_name = 'Automations' LIMIT 1`,
  );
  if (found.rows[0]) return (actorIdCache = found.rows[0].id);
  const made = await query<{ id: string }>(
    `INSERT INTO principal (kind, display_name, role, initials)
     VALUES ('service', 'Automations', 'service', 'AT') RETURNING id`,
  );
  return (actorIdCache = made.rows[0].id);
}

// ── Validation (shared by create and update) ─────────────────────────────────

/** Longest allowed wait: 30 days, in minutes. */
const MAX_DELAY_MINUTES = 43_200;

/** The builder offers all four; only work orders have data + a UI today. */
const LIVE_ENTITIES = new Set(['work_order']);
const ENTITY_LABEL: Record<string, string> = {
  vendor: 'Vendor',
  quote: 'Quote',
  invoice: 'Invoice',
};

function validateEntity(entity: string): void {
  if (LIVE_ENTITIES.has(entity)) return;
  const label = ENTITY_LABEL[entity] ?? entity;
  throw new ApiError(
    'BAD_REQUEST',
    `${label} automations arrive when that module goes live — Work orders is the only record type today`,
  );
}

async function validateTrigger(trigger: AutomationTrigger): Promise<void> {
  if (trigger.kind !== 'created' && trigger.kind !== 'changed' && trigger.kind !== 'manual') {
    throw new ApiError('BAD_REQUEST', 'The trigger must be "created", "changed" or "manual"');
  }
  if (trigger.kind === 'changed' && trigger.field) {
    await resolveField(trigger.field); // throws on an unknown key
  }
  const op = trigger.to_op;
  if (op != null && op !== 'eq') {
    if (!['gt', 'gte', 'lt', 'lte'].includes(op)) {
      throw new ApiError('BAD_REQUEST', `Unknown "to" comparison "${op}"`);
    }
    if (trigger.kind !== 'changed' || !trigger.field || trigger.to == null) {
      throw new ApiError(
        'BAD_REQUEST',
        'A more-than/less-than trigger needs a specific field and a value to compare against',
      );
    }
    const f = await resolveField(trigger.field);
    if (f.type !== 'money' && f.type !== 'number') {
      throw new ApiError(
        'BAD_REQUEST',
        `"${f.label}" is not a number — more-than/less-than triggers apply to money and number fields`,
      );
    }
    if (numOf(String(trigger.to)) === null) {
      throw new ApiError('BAD_REQUEST', `"${trigger.to}" is not a number to compare against`);
    }
  }
  const d = trigger.delay_minutes;
  if (d != null && (!Number.isInteger(d) || d < 0 || d > MAX_DELAY_MINUTES)) {
    throw new ApiError(
      'BAD_REQUEST',
      `The wait must be a whole number of minutes between 0 and ${MAX_DELAY_MINUTES} (30 days)`,
    );
  }
}

async function validateConditions(conditions: FilterSet): Promise<void> {
  // compileFilters checks every field key AND every operator against the
  // field's type — the same errors the filter builder gets.
  await compileFilters(conditions, new Params());
}

/** An action target, resolved to how the engine will apply it. */
interface ResolvedAction {
  kind: 'status' | 'priority' | 'custom';
  /** For 'custom': the catalogue key (`fields.<json key>`). */
  catalogueKey?: string;
  value: string | null;
}

async function resolveAction(a: AutomationAction): Promise<ResolvedAction> {
  const field = a.field.trim();
  const value = a.value === undefined ? null : a.value;

  if (field === 'status' || field === 'status_id') {
    if (!value) throw new ApiError('BAD_REQUEST', 'A status action needs a status to move to');
    return { kind: 'status', value };
  }
  if (field === 'priority') {
    if (value !== null && !PRIORITY_VALUES.includes(norm(value))) {
      throw new ApiError('BAD_REQUEST', `Priority must be one of: ${PRIORITY_VALUES.join(', ')}`);
    }
    return { kind: 'priority', value: value === null ? null : norm(value) };
  }

  // A mirrored core key ('client', 'nte', …) is applied through its bag twin so
  // the mirror-column sync in woFieldValues runs; anything else must be a
  // custom field the inline editor could write.
  const jsonKey = JSON_KEY_BY_CORE.get(field);
  const catalogueKey = jsonKey ? `fields.${jsonKey}` : field;
  const f = await resolveField(catalogueKey);
  if (!f.custom) {
    throw new ApiError('BAD_REQUEST', `"${f.label}" cannot be set by an automation`);
  }
  const sub = await query<{ type: string }>(
    `SELECT type::text AS type FROM field_def WHERE key = $1 LIMIT 1`,
    [f.jsonKey],
  );
  const subtype = sub.rows[0]?.type;
  if (subtype === 'formula' || subtype === 'attachment') {
    throw new ApiError('BAD_REQUEST', `"${f.label}" is ${subtype === 'formula' ? 'computed' : 'a file'} — an automation cannot set it`);
  }
  return { kind: 'custom', catalogueKey, value };
}

async function validateActions(actions: AutomationAction[]): Promise<void> {
  if (actions.length === 0) throw new ApiError('BAD_REQUEST', 'Add at least one action');
  if (actions.length > MAX_ACTIONS) {
    throw new ApiError('BAD_REQUEST', `An automation is capped at ${MAX_ACTIONS} actions`);
  }
  for (const a of actions) {
    await resolveAction(a);
    if (a.field === 'status' || a.field === 'status_id') {
      // Statuses are matched by name at run time (they carry no stable code);
      // reject a name that matches nothing NOW so the builder catches typos —
      // a later rename still lands in the run log as an error.
      const v = a.value as string;
      const hit = await query<{ id: string }>(
        `SELECT id FROM status WHERE id::text = $1 OR lower(name) = $2 LIMIT 1`,
        [v, norm(v)],
      );
      if (!hit.rows[0]) throw new ApiError('BAD_REQUEST', `No status is named "${a.value}"`);
    }
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

interface AutomationRow {
  id: string;
  name: string;
  enabled: boolean;
  entity: 'work_order' | 'vendor' | 'quote' | 'invoice';
  trigger: AutomationTrigger;
  conditions: FilterSet;
  actions: AutomationAction[];
  run_count: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

const AUTOMATION_COLS = `id, name, enabled, entity, trigger, conditions, actions,
       run_count, last_run_at::text AS last_run_at,
       created_at::text AS created_at, updated_at::text AS updated_at`;

export async function listAutomations(): Promise<AutomationItem[]> {
  const res = await query<AutomationRow>(
    `SELECT ${AUTOMATION_COLS} FROM automation ORDER BY position ASC, created_at ASC`,
  );
  return res.rows;
}

export interface AutomationInput {
  name: string;
  enabled?: boolean;
  entity?: string;
  trigger: AutomationTrigger;
  conditions?: FilterSet;
  actions: AutomationAction[];
}

export async function createAutomation(
  input: AutomationInput,
  actorId: string,
): Promise<AutomationItem> {
  validateEntity(input.entity ?? 'work_order');
  await validateTrigger(input.trigger);
  const conditions = input.conditions ?? { match: 'all' as const, rules: [] };
  await validateConditions(conditions);
  await validateActions(input.actions);

  const res = await query<AutomationRow>(
    `INSERT INTO automation (name, enabled, entity, trigger, conditions, actions, position, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb,
             COALESCE((SELECT MAX(position) + 1 FROM automation), 0), $7)
     RETURNING ${AUTOMATION_COLS}`,
    [
      input.name,
      input.enabled ?? true,
      input.entity ?? 'work_order',
      JSON.stringify(input.trigger),
      JSON.stringify(conditions),
      JSON.stringify(input.actions),
      actorId,
    ],
  );
  return res.rows[0];
}

export async function updateAutomation(
  id: string,
  input: Partial<AutomationInput>,
): Promise<AutomationItem> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (frag: string, v: unknown) => {
    params.push(v);
    sets.push(frag.replace('?', `$${params.length}`));
  };

  if (input.name !== undefined) push('name = ?', input.name);
  if (input.enabled !== undefined) push('enabled = ?', input.enabled);
  if (input.entity !== undefined) {
    validateEntity(input.entity);
    push('entity = ?', input.entity);
  }
  if (input.trigger !== undefined) {
    await validateTrigger(input.trigger);
    push('trigger = ?::jsonb', JSON.stringify(input.trigger));
  }
  if (input.conditions !== undefined) {
    await validateConditions(input.conditions);
    push('conditions = ?::jsonb', JSON.stringify(input.conditions));
  }
  if (input.actions !== undefined) {
    await validateActions(input.actions);
    push('actions = ?::jsonb', JSON.stringify(input.actions));
  }
  if (sets.length === 0) throw new ApiError('BAD_REQUEST', 'Nothing to change');

  params.push(id);
  const res = await query<AutomationRow>(
    `UPDATE automation SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${params.length} RETURNING ${AUTOMATION_COLS}`,
    params,
  );
  if (!res.rows[0]) throw new ApiError('NOT_FOUND', 'Automation not found');
  return res.rows[0];
}

export async function deleteAutomation(id: string): Promise<void> {
  const res = await query<{ id: string }>(`DELETE FROM automation WHERE id = $1 RETURNING id`, [id]);
  if (!res.rows[0]) throw new ApiError('NOT_FOUND', 'Automation not found');
}

export async function listRuns(automationId: string, limit: number): Promise<AutomationRunItem[]> {
  const res = await query<AutomationRunItem>(
    `SELECT id, automation_id, wo_number, outcome, detail, created_at::text AS created_at
       FROM automation_run
      WHERE automation_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [automationId, limit],
  );
  return res.rows.map((r) => ({ ...r, id: Number(r.id) }));
}

// ── The engine ───────────────────────────────────────────────────────────────

function triggerMatches(trigger: AutomationTrigger, event: AutomationEvent): TaskChange | true | null {
  // Manual rules never fire from events — only from an explicit enrollment.
  if (trigger.kind === 'manual') return null;
  if (trigger.kind === 'created') return event.kind === 'created' ? true : null;
  if (event.kind !== 'changed') return null;
  for (const change of event.changes ?? []) {
    if (trigger.field && !matchKeysOf(change).includes(trigger.field)) continue;
    if (trigger.to != null && !toValueMatches(trigger, afterValueOf(change))) continue;
    return change;
  }
  return null;
}

/** True when the work order still exists and passes the rule's conditions. */
async function conditionsHold(taskId: string, conditions: FilterSet): Promise<boolean> {
  const p = new Params();
  const where = await compileFilters(conditions ?? { match: 'all', rules: [] }, p);
  const idHole = p.add(taskId);
  const res = await query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM task t
       JOIN status s ON s.id = t.status_id
       LEFT JOIN container hl ON hl.id = t.home_list_id
      WHERE t.id = ${idHole} AND t.deleted_at IS NULL${where ? ` AND ${where}` : ''}
      LIMIT 1`,
    p.values,
  );
  return res.rows.length > 0;
}

async function applyActions(
  taskId: string,
  actions: AutomationAction[],
  actorId: string,
  ctx: AutoCtx,
): Promise<{ field: string; value: string | null }[]> {
  // Imported at call time: workOrders/woFieldValues call back into this module
  // after their writes, and a static import each way would be a cycle.
  const { changeStatus } = await import('./workOrders.js');
  const { updateWorkOrderFields } = await import('./woFieldValues.js');

  const applied: { field: string; value: string | null }[] = [];
  for (const a of actions) {
    const r = await resolveAction(a);
    if (r.kind === 'status') {
      const hit = await query<{ id: string; name: string }>(
        `SELECT id, name FROM status WHERE id::text = $1 OR lower(name) = $2 LIMIT 1`,
        [r.value, norm(r.value as string)],
      );
      if (!hit.rows[0]) {
        throw new ApiError('BAD_REQUEST', `No status is named "${r.value}" any more`);
      }
      await changeStatus(taskId, hit.rows[0].id, actorId, ctx);
      applied.push({ field: 'status', value: hit.rows[0].name });
    } else if (r.kind === 'priority') {
      await setPriority(taskId, r.value, actorId, ctx);
      applied.push({ field: 'priority', value: r.value });
    } else {
      await updateWorkOrderFields(taskId, { [r.catalogueKey as string]: r.value }, actorId, ctx);
      applied.push({ field: r.catalogueKey as string, value: r.value });
    }
  }
  return applied;
}

/** Priority is the one settable field that is neither the status nor in the
    bag; a small dedicated write keeps its audit row identical to a bulk edit's. */
async function setPriority(
  taskId: string,
  value: string | null,
  actorId: string,
  ctx: AutoCtx,
): Promise<void> {
  const cur = await query<{ priority: string | null }>(
    `SELECT priority FROM task WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [taskId],
  );
  if (!cur.rows[0]) return;
  const before = cur.rows[0].priority;
  if (before === value) return;

  const { withTransaction } = await import('../db.js');
  const { logTaskChanges } = await import('./woAudit.js');
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE task SET priority = $1, updated_at = now() WHERE id = $2`, [value, taskId]);
    await logTaskChanges(tx, actorId, taskId, [{ field: 'priority', before, after: value }]);
  });
  await dispatchAutomations(
    { taskId, kind: 'changed', changes: [{ field: 'priority', before, after: value }] },
    ctx,
  );
}

/**
 * Entry point: every write path calls this AFTER its transaction commits.
 * Never throws — a broken rule must not fail the user's request.
 */
export async function dispatchAutomations(event: AutomationEvent, ctx?: AutoCtx): Promise<void> {
  const c: AutoCtx = ctx ?? { depth: 0, fired: new Set() };
  if (c.depth >= MAX_DEPTH) return;
  if (event.kind === 'changed' && (event.changes?.length ?? 0) === 0) return;

  try {
    const rules = await query<AutomationRow>(
      `SELECT ${AUTOMATION_COLS} FROM automation
        WHERE enabled AND entity = 'work_order'
        ORDER BY position ASC, created_at ASC`,
    );
    if (rules.rows.length === 0) return;

    const wo = await query<{ wo_number: string }>(
      `SELECT wo_number FROM task WHERE id = $1 LIMIT 1`,
      [event.taskId],
    );
    const woNumber = wo.rows[0]?.wo_number ?? null;
    const actorId = await automationActorId();

    for (const rule of rules.rows) {
      if (c.fired.has(rule.id)) continue;
      if (!triggerMatches(rule.trigger, event)) continue;

      // A delayed rule does not act now — it arms (or re-arms) a DB timer and
      // the scheduler evaluates its conditions when the wait ends. "When CICO
      // is updated and 10 minutes pass, if the quote is STILL not ready …"
      // only works if the IF runs at fire time, so it is deliberately not
      // checked here.
      const delay = Math.max(0, Math.round(Number(rule.trigger.delay_minutes ?? 0)));
      if (delay > 0) {
        await query(
          `INSERT INTO automation_pending (automation_id, task_id, due_at)
           VALUES ($1, $2, now() + make_interval(mins => $3))
           ON CONFLICT (automation_id, task_id)
           DO UPDATE SET due_at = EXCLUDED.due_at, created_at = now()`,
          [rule.id, event.taskId, delay],
        );
        continue;
      }

      let holds = false;
      try {
        holds = await conditionsHold(event.taskId, rule.conditions);
      } catch {
        holds = false; // a condition on a deleted field simply never matches
      }
      if (!holds) continue;

      c.fired.add(rule.id);
      const child: AutoCtx = { depth: c.depth + 1, fired: c.fired };
      try {
        const applied = await applyActions(event.taskId, rule.actions, actorId, child);
        await recordRun(rule.id, event.taskId, woNumber, 'applied', { applied });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recordRun(rule.id, event.taskId, woNumber, 'error', { message });
      }
    }
  } catch (err) {
    // The engine failing must stay invisible to the caller; the dev console
    // still gets the reason.
    console.error('[automations] dispatch failed:', err);
  }
}

async function recordRun(
  automationId: string,
  taskId: string,
  woNumber: string | null,
  outcome: 'applied' | 'error' | 'skipped',
  detail: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO automation_run (automation_id, task_id, wo_number, outcome, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [automationId, taskId, woNumber, outcome, JSON.stringify(detail)],
  );
  await query(
    `UPDATE automation SET run_count = run_count + 1, last_run_at = now() WHERE id = $1`,
    [automationId],
  );
}

// ── The scheduler (delayed rules) ────────────────────────────────────────────
// Polls automation_pending for due timers. Timers are DB rows, so a restart
// loses nothing — the first sweep on boot catches anything that came due while
// the API was down.

const SWEEP_MS = 30_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startAutomationScheduler(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void sweepPending(); }, SWEEP_MS);
  // Do not hold the process open for the sake of the poller.
  sweepTimer.unref?.();
  void sweepPending();
}

async function sweepPending(): Promise<void> {
  try {
    const due = await query<{ id: string; automation_id: string; task_id: string }>(
      `SELECT id, automation_id, task_id FROM automation_pending
        WHERE due_at <= now() ORDER BY due_at ASC LIMIT 25`,
    );
    for (const row of due.rows) {
      // Deleted BEFORE firing so a slow action cannot double-fire on the next
      // sweep; a matching change during the actions simply re-arms the timer.
      await query(`DELETE FROM automation_pending WHERE id = $1`, [row.id]);
      await fireDelayed(row.automation_id, row.task_id);
    }
  } catch (err) {
    console.error('[automations] sweep failed:', err);
  }
}

async function fireDelayed(automationId: string, taskId: string): Promise<void> {
  const rules = await query<AutomationRow>(
    `SELECT ${AUTOMATION_COLS} FROM automation WHERE id = $1 LIMIT 1`,
    [automationId],
  );
  const rule = rules.rows[0];
  // Rule deleted or paused while the timer ran: the timer dies with it.
  if (!rule || !rule.enabled) return;

  const wo = await query<{ wo_number: string }>(
    `SELECT wo_number FROM task WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [taskId],
  );
  if (!wo.rows[0]) return; // deleted (or re-seeded away) — nothing to act on

  await evaluateAndApply(rule, taskId, wo.rows[0].wo_number, {
    skipMessage: 'Conditions no longer matched when the wait ended',
    extraDetail: { waited_minutes: rule.trigger.delay_minutes ?? 0 },
  });
}

/**
 * Check the rule's conditions on ONE work order right now and, if they hold,
 * apply its actions — recording the run either way. Shared by the scheduler
 * (a wait ending) and manual enrollment.
 */
async function evaluateAndApply(
  rule: AutomationRow,
  taskId: string,
  woNumber: string | null,
  opts: { skipMessage: string; extraDetail?: Record<string, unknown> },
): Promise<'applied' | 'skipped' | 'error'> {
  let holds = false;
  try {
    holds = await conditionsHold(taskId, rule.conditions);
  } catch {
    holds = false;
  }
  if (!holds) {
    await recordRun(rule.id, taskId, woNumber, 'skipped', { message: opts.skipMessage });
    return 'skipped';
  }

  try {
    const actorId = await automationActorId();
    // Its own writes must not re-fire or re-arm the same rule, hence the
    // pre-fired id.
    const ctx: AutoCtx = { depth: 1, fired: new Set([rule.id]) };
    const applied = await applyActions(taskId, rule.actions, actorId, ctx);
    await recordRun(rule.id, taskId, woNumber, 'applied', {
      applied,
      ...(opts.extraDetail ?? {}),
    });
    return 'applied';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordRun(rule.id, taskId, woNumber, 'error', { message });
    return 'error';
  }
}

// ── Manual enrollment (the HubSpot model) ────────────────────────────────────
// Any ENABLED work-order rule can be enrolled into from the list's bulk bar;
// a 'manual'-triggered rule is the one that can ONLY start this way. A rule
// with a wait arms its timer instead of acting now — same semantics as the
// automatic triggers, conditions checked when the wait ends.

export const ENROLL_CAP = 500;

export interface EnrollResult {
  requested: number;
  applied: number;
  queued: number;
  skipped: number;
  errored: number;
}

export async function enrollAutomation(automationId: string, taskIds: string[]): Promise<EnrollResult> {
  if (taskIds.length === 0) throw new ApiError('BAD_REQUEST', 'No work orders selected');
  if (taskIds.length > ENROLL_CAP) {
    throw new ApiError('BAD_REQUEST', `An enrollment is capped at ${ENROLL_CAP} work orders`);
  }

  const rules = await query<AutomationRow>(
    `SELECT ${AUTOMATION_COLS} FROM automation WHERE id = $1 LIMIT 1`,
    [automationId],
  );
  const rule = rules.rows[0];
  if (!rule) throw new ApiError('NOT_FOUND', 'Automation not found');
  if (!rule.enabled) {
    throw new ApiError('BAD_REQUEST', `"${rule.name}" is paused — turn it on before enrolling`);
  }
  if (rule.entity !== 'work_order') {
    throw new ApiError('BAD_REQUEST', `"${rule.name}" does not run over work orders`);
  }

  const result: EnrollResult = {
    requested: taskIds.length, applied: 0, queued: 0, skipped: 0, errored: 0,
  };
  const delay = Math.max(0, Math.round(Number(rule.trigger.delay_minutes ?? 0)));

  for (const taskId of taskIds) {
    const wo = await query<{ wo_number: string }>(
      `SELECT wo_number FROM task WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [taskId],
    );
    if (!wo.rows[0]) {
      result.skipped += 1;
      continue;
    }

    if (delay > 0) {
      await query(
        `INSERT INTO automation_pending (automation_id, task_id, due_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))
         ON CONFLICT (automation_id, task_id)
         DO UPDATE SET due_at = EXCLUDED.due_at, created_at = now()`,
        [rule.id, taskId, delay],
      );
      result.queued += 1;
      continue;
    }

    const outcome = await evaluateAndApply(rule, taskId, wo.rows[0].wo_number, {
      skipMessage: 'Conditions did not match at enrollment',
      extraDetail: { enrolled: true },
    });
    if (outcome === 'applied') result.applied += 1;
    else if (outcome === 'skipped') result.skipped += 1;
    else result.errored += 1;
  }

  return result;
}
