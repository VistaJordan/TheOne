// Approval tasks (0020) — the manager's inbox.
//
// One `approval_task` row per thing that needs a yes or a no from somebody
// with authority. Rule 1.5.2 (cost over NTE) is the first source: the rules
// engine raises one through createApprovalTask when an 'approval_task' action
// fires (automations.ts). The row moves:
//
//   open ──approve──▶ approved
//     │──reject────▶ rejected    (note on the row AND an internal WO comment)
//     └──cancel────▶ cancelled   (the reason went away: cost back under NTE —
//                                 reconcileApprovalTasks, run on every write)
//
// Routing is by role (`assigned_role`, a role code) with an optional claim
// (`assigned_to`). The permission is what gates a decision — approvals:approve
// — the role is only whose inbox lane it shows in. One OPEN task per
// (work order, type): a repeat raise refreshes the numbers instead of
// stacking up.
//
// Every move writes an activity_log row on the work order, so the audit
// trail, the inbox and the Finances card can never disagree about whether an
// override was granted.

import { query, getDb } from '../db.js';
import type {
  ActivityActor,
  ApprovalListItem,
  ApprovalListResponse,
  ApprovalTask,
  ApprovalTaskStatus,
  ApprovalTaskType,
  ApprovalTasksResponse,
} from '@theone/shared';
import { APPROVALS_PERM_KEY, APPROVAL_TASK_TYPES } from '@theone/shared';
import { ApiError, badRequest, conflict } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { requirePerm } from './permissions.js';
import { K_COST } from './money.js';

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const TYPES = new Set<string>(APPROVAL_TASK_TYPES.map((t) => t.code));
const STATUSES: ApprovalTaskStatus[] = ['open', 'approved', 'rejected', 'cancelled'];

export function isApprovalTaskType(v: unknown): v is ApprovalTaskType {
  return typeof v === 'string' && TYPES.has(v);
}

interface Row {
  id: string;
  type: ApprovalTaskType;
  task_id: string;
  title: string;
  detail: Record<string, unknown> | null;
  assigned_role: string | null;
  assigned_role_label: string | null;
  assigned_to_id: string | null;
  assigned_to_name: string | null;
  assigned_to_kind: 'human' | 'service' | null;
  status: ApprovalTaskStatus;
  source_automation_id: string | null;
  source_name: string | null;
  created_by_id: string | null;
  created_by_name: string | null;
  created_by_kind: 'human' | 'service' | null;
  created_at: string;
  updated_at: string;
  decided_by_id: string | null;
  decided_by_name: string | null;
  decided_by_kind: 'human' | 'service' | null;
  decided_at: string | null;
  decision_note: string | null;
  wo_number: string;
  wo_title: string | null;
  client: string | null;
  billing_entity: string | null;
  trade: string | null;
}

const SELECT_SQL = `
  SELECT a.id::text            AS id,
         a.type, a.task_id::text AS task_id, a.title, a.detail,
         a.assigned_role,
         r.label                AS assigned_role_label,
         at.id::text AS assigned_to_id, at.display_name AS assigned_to_name, at.kind::text AS assigned_to_kind,
         a.status,
         a.source_automation_id::text AS source_automation_id,
         a.source_name,
         cb.id::text AS created_by_id, cb.display_name AS created_by_name, cb.kind::text AS created_by_kind,
         ${ISO('a.created_at')} AS created_at,
         ${ISO('a.updated_at')} AS updated_at,
         db.id::text AS decided_by_id, db.display_name AS decided_by_name, db.kind::text AS decided_by_kind,
         ${ISO('a.decided_at')} AS decided_at,
         a.decision_note,
         t.wo_number, t.title AS wo_title, t.client, t.billing_entity, t.trade
    FROM approval_task a
    JOIN task t            ON t.id = a.task_id
    LEFT JOIN role r       ON r.code = a.assigned_role
    LEFT JOIN principal at ON at.id = a.assigned_to
    LEFT JOIN principal cb ON cb.id = a.created_by
    LEFT JOIN principal db ON db.id = a.decided_by
`;

function actorOf(
  id: string | null,
  name: string | null,
  kind: 'human' | 'service' | null,
): ActivityActor | null {
  return id === null ? null : { id, display_name: name ?? '', kind: kind ?? 'human' };
}

function mapTask(r: Row): ApprovalTask {
  return {
    id: r.id,
    type: r.type,
    task_id: r.task_id,
    title: r.title,
    detail: r.detail ?? {},
    assigned_role: r.assigned_role,
    assigned_role_label: r.assigned_role_label,
    assigned_to: actorOf(r.assigned_to_id, r.assigned_to_name, r.assigned_to_kind),
    status: r.status,
    source:
      r.source_automation_id || r.source_name
        ? { automation_id: r.source_automation_id, name: r.source_name }
        : null,
    created_by: actorOf(r.created_by_id, r.created_by_name, r.created_by_kind),
    created_at: r.created_at,
    updated_at: r.updated_at,
    decided_by: actorOf(r.decided_by_id, r.decided_by_name, r.decided_by_kind),
    decided_at: r.decided_at,
    decision_note: r.decision_note,
  };
}

function mapListItem(r: Row): ApprovalListItem {
  return {
    ...mapTask(r),
    wo_number: r.wo_number,
    wo_title: r.wo_title,
    client: r.client,
    billing_entity: r.billing_entity,
    trade: r.trade,
  };
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A bag/column value as a finite number ("$1,610" → 1610), else null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const digits = String(v).replace(/[^0-9.-]/g, '');
  if (!/^-?\d*\.?\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The inbox: every task across every live work order, open ones first, then
 * newest first. Deleted work orders keep their rows but leave the list.
 */
export async function listApprovalTasks(limit = 500): Promise<ApprovalListResponse> {
  const res = await query<Row>(
    `${SELECT_SQL}
      WHERE t.deleted_at IS NULL
      ORDER BY CASE a.status WHEN 'open' THEN 0 ELSE 1 END,
               a.created_at DESC, a.id DESC
      LIMIT $1`,
    [limit],
  );
  const items = res.rows.map(mapListItem);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ApprovalTaskStatus, number>;
  for (const i of items) counts[i.status] += 1;
  return { items, total: items.length, counts };
}

/** The tasks on one work order, newest first (the Finances card reads the
    latest NTE override from here). */
export async function listApprovalTasksForWorkOrder(taskId: string): Promise<ApprovalTasksResponse> {
  const res = await query<Row>(
    `${SELECT_SQL} WHERE a.task_id = $1 ORDER BY a.created_at DESC, a.id DESC`,
    [taskId],
  );
  const items = res.rows.map(mapTask);
  return { items, total: items.length };
}

async function getApprovalTask(id: string): Promise<ApprovalTask> {
  const res = await query<Row>(`${SELECT_SQL} WHERE a.id = $1`, [id]);
  if (res.rows.length === 0) throw new ApiError('NOT_FOUND', 'Approval task not found');
  return mapTask(res.rows[0]);
}

// ── Raising one ──────────────────────────────────────────────────────────────

/** Cost and NTE as the work order holds them right now. */
async function costAndNte(taskId: string): Promise<{ cost: number | null; nte: number | null } | null> {
  const res = await query<{ nte: number | string | null; cost: string | null }>(
    `SELECT t.nte, t.fields->>$2 AS cost
       FROM task t WHERE t.id = $1 AND t.deleted_at IS NULL LIMIT 1`,
    [taskId, K_COST],
  );
  const r = res.rows[0];
  if (!r) return null;
  return { cost: num(r.cost), nte: num(r.nte) };
}

export interface RaiseInput {
  taskId: string;
  type: ApprovalTaskType;
  /** Role code whose inbox it lands in; null = any approver. */
  assignRole?: string | null;
  /** Who (or what) raised it — the automations service principal for a rule. */
  actorId: string;
  source?: { automationId: string | null; name: string | null } | null;
  /** For 'manager_review': what the rule saw change, for the title. */
  cause?: { field_label: string; value: string } | null;
}

/** The title and detail a type carries, from the work order's current numbers. */
async function describe(
  input: RaiseInput,
): Promise<{ title: string; detail: Record<string, unknown> }> {
  if (input.type === 'nte_override') {
    const m = await costAndNte(input.taskId);
    const cost = m?.cost ?? null;
    const nte = m?.nte ?? null;
    const overBy = cost !== null && nte !== null ? Math.round((cost - nte) * 100) / 100 : null;
    const title =
      cost !== null && nte !== null
        ? `Cost ${money(cost)} is over the client NTE ${money(nte)} by ${money(Math.max(overBy ?? 0, 0))}`
        : 'Cost is over the client NTE';
    return { title, detail: { cost, nte, over_by: overBy } };
  }
  const rule = input.source?.name ?? null;
  const title = rule ? `Manager review requested by “${rule}”` : 'Manager review requested';
  return {
    title,
    detail: {
      rule,
      ...(input.cause ? { changed_field: input.cause.field_label, new_value: input.cause.value } : {}),
    },
  };
}

/**
 * Raise a task — or, when an OPEN one of the same type already sits on the
 * work order, refresh its title and numbers instead. `created` says which.
 * The insert and its activity row share one transaction.
 */
export async function createApprovalTask(
  input: RaiseInput,
): Promise<{ item: ApprovalTask; created: boolean }> {
  if (!isApprovalTaskType(input.type)) {
    throw badRequest(`Unknown approval task type "${String(input.type)}"`, { type: input.type });
  }
  const role = input.assignRole?.trim() || null;
  if (role) {
    const hit = await query<{ code: string }>(`SELECT code FROM role WHERE code = $1 LIMIT 1`, [role]);
    if (!hit.rows[0]) throw badRequest(`No role is coded "${role}"`, { assign_role: role });
  }
  const { title, detail } = await describe(input);

  const open = await query<{ id: string }>(
    `SELECT id::text AS id FROM approval_task
      WHERE task_id = $1 AND type = $2 AND status = 'open' LIMIT 1`,
    [input.taskId, input.type],
  );
  if (open.rows[0]) {
    await query(
      `UPDATE approval_task SET title = $1, detail = $2::jsonb, updated_at = now() WHERE id = $3`,
      [title, JSON.stringify(detail), open.rows[0].id],
    );
    return { item: await getApprovalTask(open.rows[0].id), created: false };
  }

  const db = getDb();
  let createdId: string | null = null;
  await db.transaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO approval_task
         (type, task_id, title, detail, assigned_role, status, source_automation_id, source_name, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'open', $6, $7, $8)
       RETURNING id::text AS id`,
      [
        input.type,
        input.taskId,
        title,
        JSON.stringify(detail),
        role,
        input.source?.automationId ?? null,
        input.source?.name ?? null,
        input.actorId,
      ],
    );
    createdId = ins.rows[0].id;
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'approval_task_created', 'approval_task.status', NULL, $3::jsonb)`,
      [
        input.actorId,
        input.taskId,
        JSON.stringify({
          approval_task_id: createdId,
          type: input.type,
          status: 'open',
          title,
          assigned_role: role,
          ...(input.source?.name ? { rule: input.source.name } : {}),
        }),
      ],
    );
  });
  if (!createdId) throw new ApiError('INTERNAL', 'Approval task insert produced no row');
  return { item: await getApprovalTask(createdId), created: true };
}

// ── Decisions ────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<ApprovalTaskType, string> = {
  nte_override: 'NTE override',
  manager_review: 'Manager review',
};

/**
 * approve / reject. The status, its stamps, the activity row and an internal
 * comment on the work order all land in one transaction — the decision is
 * feedback for whoever is running the job, and the Updates feed is where
 * they look.
 */
async function decide(
  id: string,
  to: 'approved' | 'rejected',
  note: string | null,
  actor: ActingPrincipal,
): Promise<ApprovalTask> {
  const cur = await getApprovalTask(id);
  if (cur.status !== 'open') {
    throw badRequest(`This task is already ${cur.status}; it cannot be ${to} now`, {
      status: cur.status,
    });
  }
  const action = to === 'approved' ? 'approval_task_approved' : 'approval_task_rejected';
  const verb = to === 'approved' ? 'approved' : 'rejected';
  const body = `${TYPE_LABEL[cur.type]} ${verb} — ${cur.title}${note ? ` — ${note}` : ''}`;

  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE approval_task
          SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3,
              assigned_to = COALESCE(assigned_to, $2), updated_at = now()
        WHERE id = $4`,
      [to, actor.id, note, id],
    );
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, $3, 'approval_task.status', $4::jsonb, $5::jsonb)`,
      [
        actor.id,
        cur.task_id,
        action,
        JSON.stringify({ approval_task_id: id, status: 'open' }),
        JSON.stringify({
          approval_task_id: id,
          type: cur.type,
          status: to,
          title: cur.title,
          ...(note ? { note } : {}),
        }),
      ],
    );
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO comment (task_id, author_principal_id, body, client_visible)
       VALUES ($1, $2, $3, false) RETURNING id::text AS id`,
      [cur.task_id, actor.id, body],
    );
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
      [
        actor.id,
        cur.task_id,
        JSON.stringify({ comment_id: ins.rows[0].id, client_visible: false, approval_task_id: id }),
      ],
    );
  });
  return getApprovalTask(id);
}

/** open → approved (approvals:approve). */
export async function approveApprovalTask(
  id: string,
  note: string | null,
  actor: ActingPrincipal,
): Promise<ApprovalTask> {
  requirePerm(actor, APPROVALS_PERM_KEY, 'approve', 'You cannot approve tasks');
  return decide(id, 'approved', note, actor);
}

/** open → rejected, with the reason (approvals:approve). */
export async function rejectApprovalTask(
  id: string,
  note: string,
  actor: ActingPrincipal,
): Promise<ApprovalTask> {
  requirePerm(actor, APPROVALS_PERM_KEY, 'approve', 'You cannot reject tasks');
  return decide(id, 'rejected', note, actor);
}

/** Take an open task into your own lane (approvals:approve). Claiming is
    routing, not a decision — no comment, just the audit row. */
export async function claimApprovalTask(id: string, actor: ActingPrincipal): Promise<ApprovalTask> {
  requirePerm(actor, APPROVALS_PERM_KEY, 'approve', 'You cannot claim tasks');
  const cur = await getApprovalTask(id);
  if (cur.status !== 'open') {
    throw badRequest(`This task is already ${cur.status}`, { status: cur.status });
  }
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE approval_task SET assigned_to = $1, updated_at = now() WHERE id = $2`, [
      actor.id,
      id,
    ]);
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'approval_task_claimed', 'approval_task.assigned_to', $3::jsonb, $4::jsonb)`,
      [
        actor.id,
        cur.task_id,
        JSON.stringify({ approval_task_id: id, assigned_to: cur.assigned_to?.display_name ?? null }),
        JSON.stringify({ approval_task_id: id, type: cur.type, title: cur.title, assigned_to: actor.name }),
      ],
    );
  });
  return getApprovalTask(id);
}

// ── The block (rule 1.5.2, second half) ──────────────────────────────────────

/** The open NTE-override task on a work order, if there is one. */
export async function openNteOverride(
  taskId: string,
): Promise<{ id: string; title: string } | null> {
  const res = await query<{ id: string; title: string }>(
    `SELECT id::text AS id, title FROM approval_task
      WHERE task_id = $1 AND type = 'nte_override' AND status = 'open' LIMIT 1`,
    [taskId],
  );
  return res.rows[0] ?? null;
}

/**
 * "WO financial progression is blocked until Manager clears this." Approving
 * or sending the quote and approving or sending a technician payment call
 * this first; while an NTE override waits on a manager the move is refused
 * with a 409 that names the task, so the screen can point at the inbox.
 * Rejecting stays allowed — saying no never needs the override.
 *
 * Runs BEFORE the caller's transaction opens (PGlite single-connection rule).
 */
export async function assertNoOpenNteOverride(taskId: string, move: string): Promise<void> {
  const open = await openNteOverride(taskId);
  if (!open) return;
  throw conflict(
    `${move} is on hold: the cost is over the client NTE and a manager has not decided the NTE override yet (rule 1.5.2). Decide it under Approvals first.`,
    { rule: '1.5.2', approval_task_id: open.id, approval_task_title: open.title },
  );
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

/**
 * Called after every work-order write (from the automations dispatcher, so no
 * write path can forget it). An open NTE-override task whose reason is gone —
 * the cost is back at or under the NTE, or either number was cleared — is
 * cancelled rather than left for a manager to decide on stale numbers. Never
 * throws: housekeeping must not fail the user's request.
 */
export async function reconcileApprovalTasks(taskId: string, actorId: string): Promise<void> {
  try {
    const open = await query<{ id: string; title: string }>(
      `SELECT id::text AS id, title FROM approval_task
        WHERE task_id = $1 AND type = 'nte_override' AND status = 'open' LIMIT 1`,
      [taskId],
    );
    if (!open.rows[0]) return;
    const m = await costAndNte(taskId);
    if (!m) return;
    const stillOver = m.cost !== null && m.nte !== null && m.cost > m.nte;
    if (stillOver) return;

    const why =
      m.cost === null || m.nte === null
        ? 'Cost or NTE was cleared'
        : `Cost ${money(m.cost)} is back within the NTE ${money(m.nte)}`;
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE approval_task
            SET status = 'cancelled', decided_by = $1, decided_at = now(), decision_note = $2,
                updated_at = now()
          WHERE id = $3`,
        [actorId, why, open.rows[0].id],
      );
      await tx.query(
        `INSERT INTO activity_log
           (actor_principal_id, entity_type, entity_id, action, field, before, after)
         VALUES ($1, 'task', $2, 'approval_task_cancelled', 'approval_task.status', $3::jsonb, $4::jsonb)`,
        [
          actorId,
          taskId,
          JSON.stringify({ approval_task_id: open.rows[0].id, status: 'open' }),
          JSON.stringify({
            approval_task_id: open.rows[0].id,
            type: 'nte_override',
            status: 'cancelled',
            title: open.rows[0].title,
            note: why,
          }),
        ],
      );
    });
  } catch (err) {
    console.error('[approvals] reconcile failed:', err);
  }
}
