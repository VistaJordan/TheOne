// The obligation engine (S5) — who owes what, on which work order, by when.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE MODEL
// ═══════════════════════════════════════════════════════════════════════════
// An OBLIGATION is a clock with an owner and a silencer. A NOTIFICATION is a
// view of one — never a second source of truth. Three properties, inherited
// straight from the escalation bot (Inbox Monitor/ESCALATION-BOT.md), decide
// almost every design choice in this file:
//
//   1. EVIDENCE SILENCES, NOT PEOPLE. There is no dismiss endpoint. An
//      obligation closes when the world stops owing it — a comment landed, a
//      quote exists, the status advanced. A human may only SNOOZE it, and only
//      with a written reason.
//   2. ONCE PER OBLIGATION PER TIER. Escalation pings are recorded in
//      obligation_ping with UNIQUE(obligation_id, tier). Re-evaluating a
//      hundred times cannot produce a second notification for the same tier.
//   3. THE CLOCKS PAUSE. Everything but an emergency runs on business hours
//      (lib/businessTime.ts). A quote requested at 17:00 Friday is not late on
//      Saturday morning.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE EVALUATION MODEL
// ═══════════════════════════════════════════════════════════════════════════
// There is no cron in the prototype. `evaluate()` is a PURE FUNCTION OF CURRENT
// DB STATE — it derives the set of obligations the world currently implies, and
// reconciles the table against it. That means it is safe to call at any time,
// from anywhere, any number of times:
//   · lazily on the read endpoints, debounced to once per 30s;
//   · immediately after a write that could start or silence a clock.
// Stable identity is (rule_key, subject_id) — enforced by a partial unique
// index — so reconciliation UPDATES and never duplicates.
//
// ═══════════════════════════════════════════════════════════════════════════
// DEMO-DAY SAFETY
// ═══════════════════════════════════════════════════════════════════════════
// Every entry point checks `obligationsReady()` first. Before migration 0004 is
// applied the tables do not exist, and this module answers "nothing" instead of
// throwing — so the running app keeps serving work orders while the migration
// is still pending. Write hooks additionally swallow their own errors: the
// engine may never be the reason a status change fails.
//
// PGlite is single-connection: nothing here runs inside a caller's transaction,
// and every hook is invoked AFTER the transaction it follows has committed.

import { query } from '../db.js';
import type {
  Obligation,
  ObligationOwner,
  ObligationState,
  ObligationSubjectKind,
  ObligationTier,
  NotificationItem,
} from '@theone/shared';
import {
  addClockMs,
  diffClockMs,
  subBusinessMs,
  businessDays,
  businessHours,
  humanizeClockMs,
  clockLabel,
  chicagoWallToInstant,
  type ClockKind,
} from '../lib/businessTime.js';
import { forbidden, notFound, badRequest } from '../errors.js';
import type { ActingPrincipal } from './activity.js';

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

// ═══════════════════════════════════════════════════════════════════════════
// 0 · READINESS — the migration may not have run yet
// ═══════════════════════════════════════════════════════════════════════════

let tablesReady: boolean | null = null;
let lastProbeAt = 0;

/**
 * True once migration 0004 has been applied. Cached forever on success; retried
 * at most every 10s while absent, so a pre-migration API answers empty
 * obligations at full speed instead of probing on every request.
 */
export async function obligationsReady(): Promise<boolean> {
  if (tablesReady === true) return true;
  const now = Date.now();
  if (tablesReady === false && now - lastProbeAt < 10_000) return false;
  lastProbeAt = now;
  try {
    const res = await query<{ reg: string | null }>(
      `SELECT to_regclass('public.obligation')::text AS reg`,
    );
    tablesReady = res.rows[0]?.reg != null;
  } catch {
    tablesReady = false;
  }
  return tablesReady === true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · RULES — thresholds are DATA (obligation_rule.params)
// ═══════════════════════════════════════════════════════════════════════════

export interface RuleParams {
  clock?: ClockKind;
  hours?: number;
  business_hours?: number;
  business_days?: number;
  statuses?: string[];
  priorities?: string[];
  quote_status?: string;
  payment_status?: string;
  status_groups?: string[];
  field?: string;
  grace_business_hours?: number;
  owed_by_role?: string;
  critical_on_breach?: boolean;
  chip_label?: string;
}

export interface Rule {
  rule_key: string;
  name: string;
  description: string | null;
  params: RuleParams;
  active: boolean;
}

let rulesCache: Map<string, Rule> | null = null;
let rulesLoadedAt = 0;

/** Rules are config an operator may edit live, so the cache expires every 30s. */
async function loadRules(): Promise<Map<string, Rule>> {
  const now = Date.now();
  if (rulesCache && now - rulesLoadedAt < 30_000) return rulesCache;
  const res = await query<{
    rule_key: string;
    name: string;
    description: string | null;
    params: RuleParams | string | null;
    active: boolean;
  }>(`SELECT rule_key, name, description, params, active FROM obligation_rule`);
  const map = new Map<string, Rule>();
  for (const r of res.rows) {
    map.set(r.rule_key, {
      rule_key: r.rule_key,
      name: r.name,
      description: r.description,
      params: parseParams(r.params),
      active: r.active === true,
    });
  }
  rulesCache = map;
  rulesLoadedAt = now;
  return map;
}

function parseParams(raw: RuleParams | string | null): RuleParams {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as RuleParams;
    } catch {
      return {};
    }
  }
  return raw;
}

/** The rule's budget in CLOCK milliseconds. business_days counts 10h days. */
function budgetOf(params: RuleParams): number {
  if (typeof params.business_days === 'number') return businessDays(params.business_days);
  if (typeof params.business_hours === 'number') return businessHours(params.business_hours);
  if (typeof params.hours === 'number') return params.hours * 3_600_000;
  if (typeof params.grace_business_hours === 'number') return businessHours(params.grace_business_hours);
  return businessHours(4);
}

function clockOf(params: RuleParams): ClockKind {
  return params.clock === '24x7' ? '24x7' : 'business';
}

/** Chip label for the table's Clock column; falls back to the rule's name. */
function chipLabel(rule: Rule | undefined, ruleKey: string): string {
  if (rule?.params.chip_label) return rule.params.chip_label;
  if (rule?.name) return rule.name;
  return ruleKey.replace(/_/g, ' ');
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · OWNERSHIP — the work order's home list names a person
// ═══════════════════════════════════════════════════════════════════════════

interface Person {
  id: string;
  display_name: string;
  role: string | null;
}

/**
 * Every human principal. Loaded once per evaluation run (and once per read) so
 * ownership resolution and notification fan-out are pure JS map lookups rather
 * than a query per obligation.
 */
async function loadPeople(): Promise<Person[]> {
  const res = await query<Person>(
    `SELECT id::text AS id, display_name, role FROM principal WHERE kind = 'human'`,
  );
  return res.rows;
}

/**
 * Home list → the OM who owns it.
 *
 * The routing lists ARE people ("Matt Hammond", "Zach Malden"), which is the
 * whole reason this resolves at all. Two passes, both requiring an UNAMBIGUOUS
 * hit — a guess that names the wrong person is worse than no name, because the
 * obligation then falls through to the role fan-out and still gets seen:
 *   1. exact display-name match, case- and whitespace-insensitive;
 *   2. the account-manager lists ("AM Peter", "AM Kevin") against first names.
 * Everything else ("Incoming WOs", "Template") resolves to null.
 */
function ownerForList(listName: string | null, people: Person[]): string | null {
  if (!listName) return null;
  const name = listName.trim().toLowerCase();
  if (name.length === 0) return null;

  const exact = people.filter((p) => p.display_name.trim().toLowerCase() === name);
  if (exact.length === 1) return exact[0].id;

  const amMatch = /^am\s+(.+)$/.exec(name);
  if (amMatch) {
    const first = amMatch[1].trim();
    const byFirstName = people.filter(
      (p) => p.display_name.trim().toLowerCase().split(/\s+/)[0] === first,
    );
    if (byFirstName.length === 1) return byFirstName[0].id;
  }
  return null;
}

/** Roles that receive the tier-2 escalation (team leads). */
const TIER2_ROLES = ['tl', 'atl'];
/** Roles that receive the tier-3 escalation (leadership). */
const TIER3_ROLES = ['admin', 'am'];
/** Roles that may snooze a tier-3 obligation, and that see the whole storm. */
export const LEADERSHIP_ROLES = ['atl', 'tl', 'am', 'admin'];

function peopleWithRoles(people: Person[], roles: string[]): Person[] {
  return people.filter((p) => p.role !== null && roles.includes(p.role));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · TIERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Where a clock stands, as a fraction of its budget, and the tier that implies.
 *
 *   tier 0  ambient    progress < 0.8
 *   tier 1  due soon   progress >= 0.8
 *   tier 2  breached   progress > 1
 *   tier 3  critical   progress > 2, or ANY breach of a rule flagged
 *                      critical_on_breach (emergencies have no "mildly late")
 */
export function tierFor(
  clock: ClockKind,
  openedAt: Date,
  dueAt: Date,
  now: Date,
  criticalOnBreach: boolean,
): { tier: ObligationTier; progress: number } {
  const budget = diffClockMs(clock, openedAt, dueAt);
  const elapsed = diffClockMs(clock, openedAt, now);
  // A zero-or-negative budget cannot be divided; treat any elapsed time on it as
  // a breach rather than dividing by zero and rendering NaN on the Pulse.
  const progress = budget > 0 ? elapsed / budget : elapsed > 0 ? 2 : 0;

  let tier: ObligationTier = 0;
  if (progress >= 0.8) tier = 1;
  if (progress > 1) tier = 2;
  if (progress > 2) tier = 3;
  if (criticalOnBreach && progress > 1) tier = 3;
  return { tier, progress };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · CANDIDATES — one query per rule, reading current state
// ═══════════════════════════════════════════════════════════════════════════

/** One obligation the world currently implies. */
interface Desired {
  rule_key: string;
  task_id: string;
  subject_kind: ObligationSubjectKind;
  subject_id: string;
  clock: ClockKind;
  opened_at: Date;
  due_at: Date;
  owed_by_principal: string | null;
  owed_by_role: string | null;
}

/** Push values and return the `($1, $2, …)` fragment — never interpolate data. */
function inList(params: unknown[], values: readonly string[]): string {
  const placeholders = values.map((v) => {
    params.push(v);
    return `$${params.length}`;
  });
  return `(${placeholders.join(', ')})`;
}

/**
 * When a work order entered its CURRENT status. Prefers the newest
 * `status_changed` activity row naming that status, falls back to the WO's
 * `created` row, then to `task.created_at` — so a work order that was seeded
 * straight into a status still has an honest clock start.
 */
const STATUS_SINCE_SQL = `
  COALESCE(
    (SELECT max(a.created_at) FROM activity_log a
      WHERE a.entity_type = 'task' AND a.entity_id = t.id
        AND a.action = 'status_changed' AND a.after ->> 'status_name' = s.name),
    (SELECT min(a.created_at) FROM activity_log a
      WHERE a.entity_type = 'task' AND a.entity_id = t.id AND a.action = 'created'),
    t.created_at)
`;

interface StatusCandidateRow {
  task_id: string;
  home_list: string | null;
  opened_at: string;
}

/**
 * Candidates for a status-driven rule (1–4). `extraWhere` carries the rule's
 * own evidence silencer and may reference `b.task_id` / `b.opened_at`.
 */
async function statusCandidates(
  statuses: string[],
  priorities: string[] | undefined,
  extraWhere: string,
  scopeTaskId: string | undefined,
): Promise<StatusCandidateRow[]> {
  if (statuses.length === 0) return [];
  const params: unknown[] = [];
  const where = [`t.deleted_at IS NULL`, `s.name IN ${inList(params, statuses)}`];
  if (priorities && priorities.length > 0) {
    where.push(`t.priority IN ${inList(params, priorities)}`);
  }
  if (scopeTaskId) {
    params.push(scopeTaskId);
    where.push(`t.id = $${params.length}`);
  }
  const res = await query<StatusCandidateRow>(
    `WITH b AS (
       SELECT t.id AS task_id, hl.name AS home_list, ${STATUS_SINCE_SQL} AS opened_at
         FROM task t
         JOIN status s ON s.id = t.status_id
         LEFT JOIN container hl ON hl.id = t.home_list_id
        WHERE ${where.join(' AND ')}
     )
     SELECT b.task_id::text AS task_id, b.home_list, ${ISO('b.opened_at')} AS opened_at
       FROM b
      ${extraWhere ? `WHERE ${extraWhere}` : ''}`,
    params,
  );
  return res.rows;
}

/**
 * The seven rule implementations. Each returns the obligations its rule
 * currently implies; anything it does NOT return is resolved by the reconciler,
 * which is how the implicit silencers (status advanced, quote approved, payment
 * processed, work order closed) work without a line of code each.
 */
async function collectDesired(
  rules: Map<string, Rule>,
  people: Person[],
  now: Date,
  scopeTaskId: string | undefined,
): Promise<Desired[]> {
  const out: Desired[] = [];

  const push = (
    rule: Rule,
    taskId: string,
    subjectKind: ObligationSubjectKind,
    subjectId: string,
    openedAt: Date,
    homeList: string | null,
    dueOverride?: Date,
  ) => {
    const clock = clockOf(rule.params);

    // OWNERSHIP IS EITHER/OR, and the RULE decides which.
    //
    // A rule that declares `owed_by_role` is owed by a FUNCTION, not a person:
    // reviewing a quote is the ATL desk's job and processing a payment is AP's,
    // whoever happens to own the work order. Those never take a home-list owner
    // — handing quote_review_owed to the dispatcher who submitted the quote
    // would put the obligation on the one person who cannot discharge it.
    //
    // Every other rule is owed by the OM whose home list the work order sits in.
    // When that list names nobody resolvable ("Incoming WOs"), both members stay
    // null and fanOut() falls back to leadership — unowned is never unseen.
    const roleOwned = typeof rule.params.owed_by_role === 'string';
    const owner = roleOwned ? null : ownerForList(homeList, people);

    out.push({
      rule_key: rule.rule_key,
      task_id: taskId,
      subject_kind: subjectKind,
      subject_id: subjectId,
      clock,
      opened_at: openedAt,
      due_at: dueOverride ?? addClockMs(clock, openedAt, budgetOf(rule.params)),
      owed_by_principal: owner,
      owed_by_role: roleOwned ? (rule.params.owed_by_role ?? null) : null,
    });
  };

  const active = (key: string): Rule | null => {
    const rule = rules.get(key);
    return rule && rule.active ? rule : null;
  };

  // ── 1 · emergency_ack — 2 hours, 24/7 ─────────────────────────────────────
  // Silenced by ANY activity or comment on the work order after the clock
  // started: somebody touched it, which is exactly what "acknowledged" means.
  // Engine-authored rows (`obligation…`, e.g. a snooze) are excluded — an
  // obligation must never silence itself.
  {
    const rule = active('emergency_ack');
    if (rule) {
      const rows = await statusCandidates(
        rule.params.statuses ?? ['Open', 'emergency'],
        rule.params.priorities ?? ['high'],
        `NOT EXISTS (SELECT 1 FROM activity_log a
                      WHERE a.entity_type = 'task' AND a.entity_id = b.task_id
                        AND a.created_at > b.opened_at
                        AND a.action NOT LIKE 'obligation%')
         AND NOT EXISTS (SELECT 1 FROM comment c
                          WHERE c.task_id = b.task_id AND c.created_at > b.opened_at)`,
        scopeTaskId,
      );
      for (const r of rows) {
        push(rule, r.task_id, 'wo', r.task_id, new Date(r.opened_at), r.home_list);
      }
    }
  }

  // ── 2 · quote_owed — 2 business days in "waiting for quote" ───────────────
  // Silenced by a quote existing at all: a draft is still work done.
  {
    const rule = active('quote_owed');
    if (rule) {
      const rows = await statusCandidates(
        rule.params.statuses ?? ['waiting for quote'],
        undefined,
        `NOT EXISTS (SELECT 1 FROM quote q WHERE q.task_id = b.task_id)`,
        scopeTaskId,
      );
      for (const r of rows) {
        push(rule, r.task_id, 'wo', r.task_id, new Date(r.opened_at), r.home_list);
      }
    }
  }

  // ── 3 · schedule_owed — 2 business hours after approval ───────────────────
  // The bot's "client approved, no ETA". Silenced implicitly: the moment the
  // status advances to anything scheduled or ongoing it stops being a candidate.
  {
    const rule = active('schedule_owed');
    if (rule) {
      const rows = await statusCandidates(
        rule.params.statuses ?? ['approved'],
        undefined,
        '',
        scopeTaskId,
      );
      for (const r of rows) {
        push(rule, r.task_id, 'wo', r.task_id, new Date(r.opened_at), r.home_list);
      }
    }
  }

  // ── 4 · approval_followup — 5 business days waiting on the client ─────────
  // Silenced by a CLIENT-VISIBLE comment newer than the clock start (we chased
  // them) or by the status moving on. An internal note is not a chase.
  {
    const rule = active('approval_followup');
    if (rule) {
      const rows = await statusCandidates(
        rule.params.statuses ?? ['!! waiting for approval'],
        undefined,
        `NOT EXISTS (SELECT 1 FROM comment c
                      WHERE c.task_id = b.task_id AND c.client_visible
                        AND c.created_at > b.opened_at)`,
        scopeTaskId,
      );
      for (const r of rows) {
        push(rule, r.task_id, 'wo', r.task_id, new Date(r.opened_at), r.home_list);
      }
    }
  }

  // ── 5 · quote_review_owed — 4 business hours in pending_approval ──────────
  // Owed by the ATL desk. The clock starts at the SUBMISSION (the activity row),
  // not at quote.updated_at, so a reviewer's own edit cannot silently reset it.
  // Silenced implicitly by approve or reject, both of which leave the status.
  {
    const rule = active('quote_review_owed');
    if (rule) {
      const params: unknown[] = [rule.params.quote_status ?? 'pending_approval'];
      let scope = '';
      if (scopeTaskId) {
        params.push(scopeTaskId);
        scope = `AND q.task_id = $${params.length}`;
      }
      const res = await query<{
        quote_id: string;
        task_id: string;
        home_list: string | null;
        opened_at: string;
      }>(
        `SELECT q.id::text AS quote_id, q.task_id::text AS task_id, hl.name AS home_list,
                ${ISO(`COALESCE(
                   (SELECT max(a.created_at) FROM activity_log a
                     WHERE a.entity_type = 'task' AND a.entity_id = q.task_id
                       AND a.action = 'quote_submitted'),
                   q.updated_at)`)} AS opened_at
           FROM quote q
           JOIN task t ON t.id = q.task_id
           LEFT JOIN container hl ON hl.id = t.home_list_id
          WHERE q.status = $1 AND t.deleted_at IS NULL ${scope}`,
        params,
      );
      for (const r of res.rows) {
        push(rule, r.task_id, 'quote', r.quote_id, new Date(r.opened_at), r.home_list);
      }
    }
  }

  // ── 6 · payment_processing — 2 business days in "requested" ───────────────
  // Owed by AP (role admin for now — §4.3 leaves the real routing to the
  // import). Silenced implicitly by any status change on the request.
  {
    const rule = active('payment_processing');
    if (rule) {
      const params: unknown[] = [rule.params.payment_status ?? 'requested'];
      let scope = '';
      if (scopeTaskId) {
        params.push(scopeTaskId);
        scope = `AND pr.task_id = $${params.length}`;
      }
      const res = await query<{
        payment_id: string;
        task_id: string;
        home_list: string | null;
        opened_at: string;
      }>(
        `SELECT pr.id::text AS payment_id, pr.task_id::text AS task_id, hl.name AS home_list,
                ${ISO('pr.created_at')} AS opened_at
           FROM payment_request pr
           JOIN task t ON t.id = pr.task_id
           LEFT JOIN container hl ON hl.id = t.home_list_id
          WHERE pr.status = $1 AND t.deleted_at IS NULL ${scope}`,
        params,
      );
      for (const r of res.rows) {
        push(rule, r.task_id, 'payment', r.payment_id, new Date(r.opened_at), r.home_list);
      }
    }
  }

  // ── 7 · sla_blown — the platform's own due date has passed ────────────────
  // Fires ONCE (the bot's "platform says SLA blown, once per WO"), silenced by
  // the work order reaching done/closed.
  //
  // The date lives in `task.fields` under the rule's `field` key. The CASE is
  // what makes the cast safe: Postgres would happily try `'MM/DD/YYYY'::date`
  // on a non-matching row if the guard were a sibling WHERE clause.
  //
  // There is no natural "budget" for a date-based rule, so the clock is
  // BACKDATED: opened_at = sla − grace, due_at = sla. Tier maths then works
  // unchanged, and an SLA a day past due reads as breached rather than dividing
  // by a zero budget.
  {
    const rule = active('sla_blown');
    if (rule) {
      const fieldKey = rule.params.field ?? 'SLA Due Date';
      const groups = rule.params.status_groups ?? ['open', 'active'];
      const params: unknown[] = [fieldKey];
      const where = [
        `t.deleted_at IS NULL`,
        `s.status_group::text IN ${inList(params, groups)}`,
      ];
      if (scopeTaskId) {
        params.push(scopeTaskId);
        where.push(`t.id = $${params.length}`);
      }
      const res = await query<{
        task_id: string;
        home_list: string | null;
        sla_date: string | null;
      }>(
        `WITH b AS (
           SELECT t.id AS task_id, hl.name AS home_list,
                  CASE WHEN t.fields ->> $1 ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                       THEN substring(t.fields ->> $1 from 1 for 10)
                       ELSE NULL END AS sla_date
             FROM task t
             JOIN status s ON s.id = t.status_id
             LEFT JOIN container hl ON hl.id = t.home_list_id
            WHERE ${where.join(' AND ')}
         )
         SELECT b.task_id::text AS task_id, b.home_list, b.sla_date
           FROM b WHERE b.sla_date IS NOT NULL`,
        params,
      );
      const grace = businessHours(rule.params.grace_business_hours ?? 10);
      for (const r of res.rows) {
        if (!r.sla_date) continue;
        const [y, m, d] = r.sla_date.split('-').map(Number);
        // The SLA lands at the CLOSE of business on its date — a date-only field
        // means "by end of that day", not "by midnight as it began".
        const due = chicagoWallToInstant(y, m, d, 18, 0);
        if (due.getTime() >= now.getTime()) continue; // not blown yet
        push(rule, r.task_id, 'wo', r.task_id, subBusinessMs(due, grace), r.home_list, due);
      }
    }
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 · RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════

/** What closed the clock, per rule. Read straight off the obligation row. */
const RESOLUTION_EVIDENCE: Record<string, string> = {
  emergency_ack: 'acknowledged_on_work_order',
  quote_owed: 'quote_exists',
  schedule_owed: 'status_advanced',
  approval_followup: 'client_update_sent',
  quote_review_owed: 'quote_reviewed',
  payment_processing: 'payment_status_changed',
  sla_blown: 'work_order_closed',
};

interface LiveRow {
  id: string;
  rule_key: string;
  subject_id: string;
  status: ObligationState;
  tier: number;
  clock: ClockKind;
  opened_at: string;
  due_at: string;
  owed_by_principal: string | null;
  owed_by_role: string | null;
  task_id: string | null;
}

const TIER_WORD = ['Watching', 'Due soon', 'Breached', 'Critical'];

/**
 * Reconcile the obligation table against what the world currently implies.
 *
 * `scopeTaskId` narrows BOTH halves — the candidates and the live rows — so a
 * post-write hook only ever touches its own work order. A full run passes
 * undefined and reconciles everything.
 */
async function reconcile(scopeTaskId: string | undefined): Promise<void> {
  const now = new Date();
  const rules = await loadRules();
  const people = await loadPeople();
  const desired = await collectDesired(rules, people, now, scopeTaskId);

  const liveParams: unknown[] = [];
  let liveScope = '';
  if (scopeTaskId) {
    liveParams.push(scopeTaskId);
    liveScope = `AND task_id = $${liveParams.length}`;
  }
  const liveRes = await query<LiveRow>(
    `SELECT id::text AS id, rule_key, subject_id::text AS subject_id, status, tier, clock,
            ${ISO('opened_at')} AS opened_at, ${ISO('due_at')} AS due_at,
            owed_by_principal::text AS owed_by_principal, owed_by_role,
            task_id::text AS task_id
       FROM obligation
      WHERE status <> 'resolved' ${liveScope}`,
    liveParams,
  );

  const identity = (ruleKey: string, subjectId: string) => `${ruleKey}::${subjectId}`;
  const live = new Map<string, LiveRow>();
  for (const row of liveRes.rows) live.set(identity(row.rule_key, row.subject_id), row);
  const wanted = new Set(desired.map((d) => identity(d.rule_key, d.subject_id)));

  // ── (a) RESOLVE what the world no longer owes ────────────────────────────
  for (const [key, row] of live) {
    if (wanted.has(key)) continue;
    await query(
      `UPDATE obligation
          SET status = 'resolved', resolved_at = now(), resolved_by_evidence = $2, tier = 0
        WHERE id = $1`,
      [row.id, RESOLUTION_EVIDENCE[row.rule_key] ?? 'condition_cleared'],
    );
  }

  // ── (b) INSERT or UPDATE everything still owed ───────────────────────────
  for (const d of desired) {
    const rule = rules.get(d.rule_key);
    const critical = rule?.params.critical_on_breach === true;
    const existing = live.get(identity(d.rule_key, d.subject_id));

    if (!existing) {
      const { tier } = tierFor(d.clock, d.opened_at, d.due_at, now, critical);
      const ins = await query<{ id: string }>(
        `INSERT INTO obligation
           (rule_key, task_id, subject_kind, subject_id, owed_by_principal, owed_by_role,
            opened_at, due_at, clock, tier, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open')
         RETURNING id::text AS id`,
        [
          d.rule_key,
          d.task_id,
          d.subject_kind,
          d.subject_id,
          d.owed_by_principal,
          d.owed_by_role,
          d.opened_at.toISOString(),
          d.due_at.toISOString(),
          d.clock,
          tier,
        ],
      );
      if (tier >= 1) await fanOut(ins.rows[0].id, tier, people, rules);
      continue;
    }

    // A SNOOZED obligation owns its own window: the snooze moved opened_at and
    // due_at deliberately, and re-deriving them from the world would undo it.
    // It wakes up on its own terms, when the moved deadline passes.
    const snoozed = existing.status === 'snoozed';
    const openedAt = snoozed ? new Date(existing.opened_at) : d.opened_at;
    const dueAt = snoozed ? new Date(existing.due_at) : d.due_at;
    const clock = snoozed ? existing.clock : d.clock;
    const { tier } = tierFor(clock, openedAt, dueAt, now, critical);
    const wakes = snoozed && now.getTime() > dueAt.getTime();
    const nextStatus: ObligationState = snoozed && !wakes ? 'snoozed' : 'open';

    await query(
      `UPDATE obligation
          SET opened_at = $2, due_at = $3, clock = $4, tier = $5, status = $6,
              owed_by_principal = $7, owed_by_role = $8
        WHERE id = $1`,
      [
        existing.id,
        openedAt.toISOString(),
        dueAt.toISOString(),
        clock,
        tier,
        nextStatus,
        d.owed_by_principal,
        d.owed_by_role,
      ],
    );

    // Escalate only UPWARD. A tier that falls (a snooze, or a clock restarted by
    // a status change) is recorded silently — the ping ledger still remembers
    // every tier ever reached, so climbing back cannot re-spam.
    if (tier > existing.tier && tier >= 1) {
      await fanOut(existing.id, tier, people, rules);
    }
  }
}

/**
 * Record the tier transition and notify. Returns the number of notifications
 * written — zero when this tier was already pinged, which is the no-respam rule
 * enforced by UNIQUE(obligation_id, tier) rather than by remembering.
 *
 * Fan-out is CUMULATIVE:
 *   tier 1  the owed principal, or everyone holding the owed role
 *   tier 2  + team leads (tl, atl)
 *   tier 3  + leadership (admin, am)
 */
async function fanOut(
  obligationId: string,
  tier: number,
  people: Person[],
  rules: Map<string, Rule>,
): Promise<number> {
  const ping = await query<{ id: string }>(
    `INSERT INTO obligation_ping (obligation_id, tier) VALUES ($1, $2)
     ON CONFLICT (obligation_id, tier) DO NOTHING
     RETURNING id::text AS id`,
    [obligationId, tier],
  );
  if (ping.rows.length === 0) return 0;

  const res = await query<{
    rule_key: string;
    owed_by_principal: string | null;
    owed_by_role: string | null;
    clock: ClockKind;
    due_at: string;
    wo_number: string | null;
    wo_title: string | null;
  }>(
    `SELECT o.rule_key, o.owed_by_principal::text AS owed_by_principal, o.owed_by_role,
            o.clock, ${ISO('o.due_at')} AS due_at,
            t.wo_number, t.title AS wo_title
       FROM obligation o
       LEFT JOIN task t ON t.id = o.task_id
      WHERE o.id = $1`,
    [obligationId],
  );
  if (res.rows.length === 0) return 0;
  const ob = res.rows[0];

  const recipients = new Set<string>();
  if (ob.owed_by_principal) recipients.add(ob.owed_by_principal);
  else if (ob.owed_by_role) {
    for (const p of peopleWithRoles(people, [ob.owed_by_role])) recipients.add(p.id);
  }
  if (tier >= 2) for (const p of peopleWithRoles(people, TIER2_ROLES)) recipients.add(p.id);
  if (tier >= 3) for (const p of peopleWithRoles(people, TIER3_ROLES)) recipients.add(p.id);
  if (recipients.size === 0) {
    // Nobody resolved — leadership is the backstop. An obligation with no
    // audience is the one failure mode this engine must never have.
    for (const p of peopleWithRoles(people, LEADERSHIP_ROLES)) recipients.add(p.id);
  }

  const rule = rules.get(ob.rule_key);
  const ownerName = ob.owed_by_principal
    ? (people.find((p) => p.id === ob.owed_by_principal)?.display_name ?? 'someone')
    : ob.owed_by_role
      ? `the ${ob.owed_by_role.toUpperCase()} desk`
      : 'nobody yet';

  const title = `${ob.wo_number ?? 'WO not found'} · ${rule?.name ?? ob.rule_key}`;
  const overdueMs = diffClockMs(ob.clock, new Date(ob.due_at), new Date());
  const timing =
    overdueMs > 0
      ? `${humanizeClockMs(ob.clock, overdueMs)} past due`
      : `due in ${humanizeClockMs(ob.clock, -overdueMs)}`;
  const body = `${TIER_WORD[tier] ?? `Tier ${tier}`} — ${timing} (${clockLabel(ob.clock)}). Owed by ${ownerName}.${ob.wo_title ? ` ${ob.wo_title}` : ''}`;

  for (const principalId of recipients) {
    await query(
      `INSERT INTO notification (principal_id, obligation_id, tier, title, body, wo_number)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [principalId, obligationId, tier, title, body, ob.wo_number],
    );
  }
  return recipients.size;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6 · ENTRY POINTS — lazy debounce + write hooks
// ═══════════════════════════════════════════════════════════════════════════

const DEBOUNCE_MS = 30_000;
let lastFullRunAt = 0;
let inFlight: Promise<void> | null = null;

/**
 * The lazy evaluator behind every read endpoint. At most one full run per 30s,
 * and concurrent callers share the in-flight run rather than queueing a second
 * one behind PGlite's single connection.
 */
export async function evaluateDebounced(): Promise<void> {
  if (!(await obligationsReady())) return;
  if (inFlight) return inFlight;
  if (Date.now() - lastFullRunAt < DEBOUNCE_MS) return;

  inFlight = reconcile(undefined)
    .catch((err) => {
      console.error('obligations: evaluation failed', err);
    })
    .finally(() => {
      lastFullRunAt = Date.now();
      inFlight = null;
    });
  return inFlight;
}

/**
 * The post-write hook. Called AFTER a status change, a comment, a quote
 * transition or a payment request — inline and scoped to one work order, so it
 * is a handful of indexed queries.
 *
 * It NEVER throws. The obligation engine is a watchdog; a watchdog that can
 * break the door it guards is worse than no watchdog. A failure here is logged
 * and the write it followed still succeeds.
 */
export async function evaluateForTask(taskId: string | null | undefined): Promise<void> {
  if (!taskId) return;
  try {
    if (!(await obligationsReady())) return;
    await reconcile(taskId);
  } catch (err) {
    console.error('obligations: post-write evaluation failed', err);
  }
}

/** Full re-evaluation, ignoring the debounce. Used by the snooze path. */
export async function evaluateNow(): Promise<void> {
  if (!(await obligationsReady())) return;
  try {
    await reconcile(undefined);
    lastFullRunAt = Date.now();
  } catch (err) {
    console.error('obligations: forced evaluation failed', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7 · READ — the shapes the web renders
// ═══════════════════════════════════════════════════════════════════════════

interface ObligationRow {
  id: string;
  rule_key: string;
  subject_kind: ObligationSubjectKind;
  subject_id: string;
  clock: ClockKind;
  tier: number;
  status: ObligationState;
  task_id: string | null;
  owed_by_principal: string | null;
  owed_by_role: string | null;
  snooze_reason: string | null;
  opened_at: string;
  due_at: string;
  created_at: string;
  updated_at: string;
  wo_number: string | null;
  wo_title: string | null;
  client: string | null;
  status_name: string | null;
  owner_name: string | null;
  owner_role: string | null;
}

const OBLIGATION_SELECT = `
  SELECT o.id::text AS id, o.rule_key, o.subject_kind, o.subject_id::text AS subject_id,
         o.clock, o.tier, o.status, o.task_id::text AS task_id,
         o.owed_by_principal::text AS owed_by_principal, o.owed_by_role, o.snooze_reason,
         ${ISO('o.opened_at')} AS opened_at, ${ISO('o.due_at')} AS due_at,
         ${ISO('o.created_at')} AS created_at, ${ISO('o.updated_at')} AS updated_at,
         t.wo_number, t.title AS wo_title, t.client,
         s.name AS status_name,
         p.display_name AS owner_name, p.role AS owner_role
    FROM obligation o
    LEFT JOIN task t ON t.id = o.task_id
    LEFT JOIN status s ON s.id = t.status_id
    LEFT JOIN principal p ON p.id = o.owed_by_principal
`;

function clampTier(n: number): ObligationTier {
  const t = Math.max(0, Math.min(3, Math.round(n)));
  return t as ObligationTier;
}

function ownerOf(row: ObligationRow): ObligationOwner {
  const label = row.owner_name
    ? row.owner_name
    : row.owed_by_role
      ? `Any ${row.owed_by_role.toUpperCase()}`
      : 'Unassigned';
  return {
    principal_id: row.owed_by_principal,
    display_name: row.owner_name,
    role: row.owner_role ?? row.owed_by_role,
    label,
  };
}

function mapObligation(row: ObligationRow, rules: Map<string, Rule>, actor: ActingPrincipal | null, now: Date): Obligation {
  const rule = rules.get(row.rule_key);
  const openedAt = new Date(row.opened_at);
  const dueAt = new Date(row.due_at);
  const remaining = diffClockMs(row.clock, now, dueAt);
  const overdue = remaining < 0;
  const { progress } = tierFor(row.clock, openedAt, dueAt, now, rule?.params.critical_on_breach === true);

  const ownedByMe =
    actor !== null &&
    (row.owed_by_principal === actor.id ||
      (row.owed_by_principal === null && row.owed_by_role !== null && row.owed_by_role === actor.role));

  return {
    id: row.id,
    rule_key: row.rule_key,
    rule_name: rule?.name ?? row.rule_key,
    label: chipLabel(rule, row.rule_key),
    tier: clampTier(row.tier),
    state: row.status,
    due_at: row.due_at,
    started_at: row.opened_at,
    wo_id: row.task_id,
    wo_number: row.wo_number,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    clock: row.clock,
    wo_title: row.wo_title,
    client: row.client,
    status_name: row.status_name,
    owed_by: ownerOf(row),
    owed_role: row.owed_by_role,
    owed_by_me: ownedByMe,
    overdue,
    progress: Math.round(progress * 1000) / 1000,
    time_left: overdue ? null : humanizeClockMs(row.clock, remaining),
    overdue_by: overdue ? humanizeClockMs(row.clock, remaining) : null,
    clock_label: clockLabel(row.clock),
    snooze_reason: row.snooze_reason,
    snoozed_until: row.status === 'snoozed' ? row.due_at : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface ObligationQuery {
  /** Work-order uuid or wo_number. */
  wo?: string;
  /** `open` means NOT RESOLVED — a snoozed clock is still a clock the board shows. */
  state?: ObligationState;
  limit?: number;
}

/** GET /api/obligations. Sorted worst-first: tier, then closest to breach. */
export async function listObligations(
  filters: ObligationQuery,
  actor: ActingPrincipal | null,
): Promise<Obligation[]> {
  if (!(await obligationsReady())) return [];
  const rules = await loadRules();
  const params: unknown[] = [];
  const where: string[] = [];

  const state = filters.state ?? 'open';
  if (state === 'open') where.push(`o.status <> 'resolved'`);
  else {
    params.push(state);
    where.push(`o.status = $${params.length}`);
  }

  if (filters.wo) {
    params.push(filters.wo);
    const p = `$${params.length}`;
    where.push(`(t.id::text = ${p} OR t.wo_number = ${p})`);
  }

  params.push(Math.min(Math.max(filters.limit ?? 200, 1), 500));
  const res = await query<ObligationRow>(
    `${OBLIGATION_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY o.tier DESC, o.due_at ASC
      LIMIT $${params.length}`,
    params,
  );
  const now = new Date();
  return res.rows.map((r) => mapObligation(r, rules, actor, now));
}

/** The worst live obligation per task — the list page's Clock column. */
export interface WorstObligationRow {
  task_id: string;
  id: string;
  rule_key: string;
  label: string;
  tier: ObligationTier;
  state: ObligationState;
  due_at: string;
  started_at: string;
}

export async function worstObligationsByTask(
  taskIds: readonly string[],
): Promise<Map<string, WorstObligationRow>> {
  const out = new Map<string, WorstObligationRow>();
  if (taskIds.length === 0) return out;
  if (!(await obligationsReady())) return out;
  const rules = await loadRules();

  const params: unknown[] = [];
  const res = await query<{
    task_id: string;
    id: string;
    rule_key: string;
    tier: number;
    status: ObligationState;
    due_at: string;
    opened_at: string;
  }>(
    `SELECT o.task_id::text AS task_id, o.id::text AS id, o.rule_key, o.tier, o.status,
            ${ISO('o.due_at')} AS due_at, ${ISO('o.opened_at')} AS opened_at
       FROM obligation o
      WHERE o.status <> 'resolved' AND o.task_id::text IN ${inList(params, taskIds)}
      ORDER BY o.tier DESC, o.due_at ASC`,
    params,
  );
  // Already ordered worst-first, so the FIRST row per task wins.
  for (const r of res.rows) {
    if (out.has(r.task_id)) continue;
    out.set(r.task_id, {
      task_id: r.task_id,
      id: r.id,
      rule_key: r.rule_key,
      label: chipLabel(rules.get(r.rule_key), r.rule_key),
      tier: clampTier(r.tier),
      state: r.status,
      due_at: r.due_at,
      started_at: r.opened_at,
    });
  }
  return out;
}

// ── The Pulse ───────────────────────────────────────────────────────────────

/**
 * Column assignment.
 *
 * The three columns are TIER-shaped, exactly as apps/web's own
 * `groupObligations()` fallback assumes — so the server-grouped and
 * client-grouped paths can never disagree about which card sits where.
 * What the ACTOR changes is what reaches the first two columns at all:
 *
 *   needs_me_now  tier 2–3, and either owed to me or I am leadership
 *   due_soon      tier 1,   and either owed to me or I am leadership
 *   watching      everything else still live — my ambient clocks, plus other
 *                 people's fires when I am not in their escalation chain
 *
 * An OM therefore opens the Pulse on their own work with the storm visible but
 * not shouting; a TL/ATL/AM/admin opens it on the whole floor, which is what
 * "notify owed_by + their TL … + leadership" means once it is a screen rather
 * than a message. Nothing is ever hidden — `watching` is the catch-all, so no
 * obligation can fall out of every column.
 */
export interface PulseBoard {
  needs_me_now: Obligation[];
  due_soon: Obligation[];
  watching: Obligation[];
  counts: {
    needs_me_now: number;
    due_soon: number;
    watching: number;
    mine: number;
    breached: number;
    critical: number;
    open_total: number;
    unread_notifications: number;
  };
}

export async function getPulse(actor: ActingPrincipal): Promise<PulseBoard> {
  const empty: PulseBoard = {
    needs_me_now: [],
    due_soon: [],
    watching: [],
    counts: {
      needs_me_now: 0,
      due_soon: 0,
      watching: 0,
      mine: 0,
      breached: 0,
      critical: 0,
      open_total: 0,
      unread_notifications: 0,
    },
  };
  if (!(await obligationsReady())) return empty;

  const items = await listObligations({ state: 'open', limit: 500 }, actor);
  const isLeadership = actor.role !== null && LEADERSHIP_ROLES.includes(actor.role);

  const board: PulseBoard = { ...empty, needs_me_now: [], due_soon: [], watching: [] };
  for (const ob of items) {
    const forMe = ob.owed_by_me || isLeadership;
    if (forMe && ob.tier >= 2) board.needs_me_now.push(ob);
    else if (forMe && ob.tier === 1) board.due_soon.push(ob);
    else board.watching.push(ob);
  }

  // Within a column, my own clocks lead — then the worst, then the closest to
  // (or furthest past) its deadline.
  const order = (a: Obligation, b: Obligation) =>
    Number(b.owed_by_me) - Number(a.owed_by_me) ||
    b.tier - a.tier ||
    Date.parse(a.due_at) - Date.parse(b.due_at);
  board.needs_me_now.sort(order);
  board.due_soon.sort(order);
  board.watching.sort(order);

  const unread = await unreadCount(actor.id);
  board.counts = {
    needs_me_now: board.needs_me_now.length,
    due_soon: board.due_soon.length,
    watching: board.watching.length,
    mine: items.filter((o) => o.owed_by_me).length,
    breached: items.filter((o) => o.tier === 2).length,
    critical: items.filter((o) => o.tier === 3).length,
    open_total: items.length,
    unread_notifications: unread,
  };
  return board;
}

// ── Notifications ───────────────────────────────────────────────────────────

async function unreadCount(principalId: string): Promise<number> {
  if (!(await obligationsReady())) return 0;
  const res = await query<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM notification WHERE principal_id = $1 AND read_at IS NULL`,
    [principalId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function listNotifications(
  principalId: string,
  limit = 50,
): Promise<{ items: NotificationItem[]; unread: number }> {
  if (!(await obligationsReady())) return { items: [], unread: 0 };
  const res = await query<{
    id: string;
    obligation_id: string;
    rule_key: string;
    tier: number;
    title: string;
    body: string | null;
    wo_number: string | null;
    wo_id: string | null;
    due_at: string | null;
    created_at: string;
    read_at: string | null;
  }>(
    `SELECT n.id::text AS id, n.obligation_id::text AS obligation_id, n.tier, n.title, n.body,
            n.wo_number, ${ISO('n.created_at')} AS created_at, ${ISO('n.read_at')} AS read_at,
            o.rule_key, o.task_id::text AS wo_id, ${ISO('o.due_at')} AS due_at
       FROM notification n
       JOIN obligation o ON o.id = n.obligation_id
      WHERE n.principal_id = $1
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $2`,
    [principalId, Math.min(Math.max(limit, 1), 200)],
  );
  return {
    items: res.rows.map((r) => ({
      id: r.id,
      obligation_id: r.obligation_id,
      rule_key: r.rule_key,
      tier: clampTier(r.tier),
      title: r.title,
      body: r.body,
      wo_id: r.wo_id,
      wo_number: r.wo_number,
      due_at: r.due_at,
      created_at: r.created_at,
      read_at: r.read_at,
    })),
    unread: await unreadCount(principalId),
  };
}

/** Mark one notification read. Scoped to the actor — you cannot read someone
 *  else's bell, and a foreign id is simply "not found". */
export async function markNotificationRead(id: string, principalId: string): Promise<void> {
  if (!(await obligationsReady())) throw notFound('Notification not found');
  const res = await query<{ id: string }>(
    `UPDATE notification SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND principal_id = $2
      RETURNING id::text AS id`,
    [id, principalId],
  );
  if (res.rows.length === 0) throw notFound('Notification not found');
}

export async function markAllNotificationsRead(principalId: string): Promise<number> {
  if (!(await obligationsReady())) return 0;
  const res = await query<{ id: string }>(
    `UPDATE notification SET read_at = now()
      WHERE principal_id = $1 AND read_at IS NULL
      RETURNING id::text AS id`,
    [principalId],
  );
  return res.rows.length;
}

// ── Snooze — the only human lever ───────────────────────────────────────────

export const SNOOZE_MAX_HOURS = 72;

/**
 * Move a clock, on the record.
 *
 * Both halves of the contract are enforced here:
 *   · REASON IS MANDATORY (the route's Zod requires it too) — a snooze without
 *     a reason is a dismissal wearing a costume, and the whole point of this
 *     engine is that nothing gets silently dismissed.
 *   · A TIER-3 obligation needs ATL or above. Critical work is not something an
 *     individual can quietly push out of their own way.
 *
 * The snooze rewrites BOTH ends of the window — opened_at = now, due_at = now +
 * hours — so the tier genuinely resets instead of staying breached against an
 * old start. The ping ledger is deliberately left intact: tiers already reached
 * are never re-notified, snooze or no snooze (rule 2 at the top of this file).
 */
export async function snoozeObligation(
  id: string,
  hours: number,
  reason: string,
  actor: ActingPrincipal,
): Promise<Obligation> {
  if (!(await obligationsReady())) throw notFound('Obligation not found');
  if (!(hours > 0) || hours > SNOOZE_MAX_HOURS) {
    throw badRequest(`Snooze must be between 1 and ${SNOOZE_MAX_HOURS} hours`, { hours });
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) throw badRequest('A snooze needs a reason');

  const cur = await query<{
    id: string;
    tier: number;
    clock: ClockKind;
    status: ObligationState;
    task_id: string | null;
    rule_key: string;
  }>(
    `SELECT id::text AS id, tier, clock, status, task_id::text AS task_id, rule_key
       FROM obligation WHERE id = $1 AND status <> 'resolved' LIMIT 1`,
    [id],
  );
  if (cur.rows.length === 0) throw notFound('Obligation not found');
  const ob = cur.rows[0];

  if (ob.tier >= 3 && !(actor.role !== null && LEADERSHIP_ROLES.includes(actor.role))) {
    throw forbidden('Snoozing a critical obligation requires ATL or above', {
      actor: actor.name,
      role: actor.role,
      required_roles: LEADERSHIP_ROLES,
      tier: ob.tier,
    });
  }

  const now = new Date();
  // A business-clock snooze is measured in BUSINESS hours: "give me 4 hours" at
  // 16:00 means until 10:00 tomorrow, not until 20:00 tonight when nobody is
  // working. An emergency snooze is wall time, like its clock.
  const until = addClockMs(ob.clock, now, hours * 3_600_000);

  await query(
    `UPDATE obligation
        SET status = 'snoozed', opened_at = $2, due_at = $3, tier = 0,
            snooze_reason = $4, snoozed_by = $5, snoozed_at = now()
      WHERE id = $1`,
    [ob.id, now.toISOString(), until.toISOString(), trimmed, actor.id],
  );

  // The audit trail. `obligation_snoozed` is prefixed so the emergency_ack
  // silencer skips it — snoozing a clock must not also silence it.
  if (ob.task_id) {
    await query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'obligation_snoozed', 'obligation.due_at', $3::jsonb, $4::jsonb)`,
      [
        actor.id,
        ob.task_id,
        JSON.stringify({ obligation_id: ob.id, rule_key: ob.rule_key, tier: ob.tier }),
        JSON.stringify({
          obligation_id: ob.id,
          rule_key: ob.rule_key,
          hours,
          reason: trimmed,
          due_at: until.toISOString(),
        }),
      ],
    );
  }

  const rules = await loadRules();
  const res = await query<ObligationRow>(`${OBLIGATION_SELECT} WHERE o.id = $1`, [ob.id]);
  if (res.rows.length === 0) throw notFound('Obligation not found');
  return mapObligation(res.rows[0], rules, actor, new Date());
}
