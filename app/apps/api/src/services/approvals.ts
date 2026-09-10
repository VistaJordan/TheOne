// Approval tasks (0026) — the manager's inbox.
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

import { query, withTransaction } from '../db.js';
import type {
  ActivityActor,
  ApprovalCounts,
  ApprovalListItem,
  ApprovalListResponse,
  ApprovalTask,
  ApprovalTaskStatus,
  ApprovalTaskType,
  ApprovalTasksResponse,
  StatusChangeDetail,
} from '@theone/shared';
import {
  APPROVAL_TASK_LABEL,
  APPROVAL_TASK_TYPES,
  STATUS_PERM_KEY,
  approvalSectionOf,
  approvalSectionPermKey,
} from '@theone/shared';
import { ApiError, badRequest, conflict } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { Params } from './woFields.js';
import { woScopeSql } from './woScope.js';
import { allowFor, requirePerm } from './permissions.js';
import { K_COST } from './money.js';
import { assertStatusGate } from './statusGates.js';

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

// The rule-raised kinds plus the one a person asks for (0025).
const TYPES = new Set<string>([...APPROVAL_TASK_TYPES.map((t) => t.code), 'status_change']);
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
  ab_id: string | null;
  ab_name: string | null;
  ab_kind: 'human' | 'service' | null;
  acknowledged_at: string | null;
  wo_number: string;
  wo_title: string | null;
  client: string | null;
  billing_entity: string | null;
  trade: string | null;
  wo_due: string | null;
  wo_nte: number | string | null;
  wo_cost: string | null;
  wo_emergency: boolean | null;
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
         ab.id::text AS ab_id, ab.display_name AS ab_name, ab.kind::text AS ab_kind,
         ${ISO('a.acknowledged_at')} AS acknowledged_at,
         t.wo_number, t.title AS wo_title, t.client, t.billing_entity, t.trade,
         t.fields->>'Due Date'   AS wo_due,
         t.nte::float8           AS wo_nte,
         t.fields->>'34. Cost'   AS wo_cost,
         COALESCE(t.fields->'Emergency' = 'true'::jsonb, false) AS wo_emergency
    FROM approval_task a
    JOIN task t            ON t.id = a.task_id
    LEFT JOIN role r       ON r.code = a.assigned_role
    LEFT JOIN principal at ON at.id = a.assigned_to
    LEFT JOIN principal cb ON cb.id = a.created_by
    LEFT JOIN principal db ON db.id = a.decided_by
    LEFT JOIN principal ab ON ab.id = a.acknowledged_by
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
    acknowledged_by: actorOf(r.ab_id, r.ab_name, r.ab_kind),
    acknowledged_at: r.acknowledged_at,
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
    wo_due: r.wo_due,
    wo_nte: num(r.wo_nte),
    wo_cost: num(r.wo_cost),
    wo_emergency: Boolean(r.wo_emergency),
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
 *
 * 0025: trimmed to the sections the viewer may see (approvals/<section>:view)
 * — except a person's OWN requests, which they always see, so a dispatcher
 * with no section grant still gets "My requests".
 */
export async function listApprovalTasks(viewer: ActingPrincipal, limit = 500): Promise<ApprovalListResponse> {
  // 0026: a scoped viewer sees the tasks on THEIR work orders — plus the
  // requests they raised themselves, which stay theirs even if the work order
  // was reassigned afterwards.
  const p = new Params();
  const scope = woScopeSql(viewer, p);
  const scopeSql = scope ? `AND (${scope} OR a.created_by = ${p.add(viewer.id)})` : '';
  const res = await query<Row>(
    `${SELECT_SQL}
      WHERE t.deleted_at IS NULL ${scopeSql}
      ORDER BY CASE a.status WHEN 'open' THEN 0 ELSE 1 END,
               a.created_at DESC, a.id DESC
      LIMIT ${p.add(limit)}`,
    p.values,
  );
  const allow = allowFor(viewer);
  const items = res.rows
    .map(mapListItem)
    .filter(
      (i) =>
        i.created_by?.id === viewer.id ||
        allow(approvalSectionPermKey(approvalSectionOf(i.type)), 'view'),
    );
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

/**
 * The from → to of a status-change request, checked against the work order
 * and the status table right now (0025). Refuses an unknown target and a
 * no-op (asking for the status the work order already has).
 */
async function statusChangeDetail(taskId: string, toStatusId: string | null): Promise<StatusChangeDetail> {
  if (!toStatusId) throw badRequest('Which status is being asked for?', { status_id: toStatusId });
  const cur = await query<{ status_id: string; status_name: string }>(
    `SELECT t.status_id::text AS status_id, s.name AS status_name
       FROM task t JOIN status s ON s.id = t.status_id
      WHERE t.id = $1 AND t.deleted_at IS NULL LIMIT 1`,
    [taskId],
  );
  if (!cur.rows[0]) throw new ApiError('NOT_FOUND', 'Work order not found');
  const to = await query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM status WHERE id = $1 LIMIT 1`,
    [toStatusId],
  );
  if (!to.rows[0]) throw badRequest('Unknown status_id', { status_id: toStatusId });
  if (to.rows[0].id === cur.rows[0].status_id) {
    throw badRequest(`The work order is already in ${cur.rows[0].status_name}`, { status_id: toStatusId });
  }
  return {
    from_status_id: cur.rows[0].status_id,
    from_status_name: cur.rows[0].status_name,
    to_status_id: to.rows[0].id,
    to_status_name: to.rows[0].name,
  };
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
  /** For 'status_change': the status asked for (rule 2.4.1). */
  toStatusId?: string | null;
}

/** The title and detail a type carries, from the work order's current numbers. */
async function describe(
  input: RaiseInput,
): Promise<{ title: string; detail: Record<string, unknown> }> {
  if (input.type === 'status_change') {
    const d = await statusChangeDetail(input.taskId, input.toStatusId ?? null);
    return { title: `Status change requested: ${d.from_status_name} → ${d.to_status_name}`, detail: { ...d } };
  }
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
    const before = await getApprovalTask(open.rows[0].id);
    await withTransaction(async (tx) => {
      // A person's repeat request replaces the target AND becomes theirs;
      // a rule's refresh keeps the numbers current and the row as it was.
      await tx.query(
        `UPDATE approval_task
            SET title = $1, detail = $2::jsonb, updated_at = now(),
                created_by = CASE WHEN $4::boolean THEN $5::uuid ELSE created_by END
          WHERE id = $3`,
        [title, JSON.stringify(detail), open.rows[0].id, input.type === 'status_change', input.actorId],
      );
      // Rule 1.2.1: the refresh is a change to the record, so it is logged —
      // the trail shows both asks, not just the last one.
      if (before.title !== title || JSON.stringify(before.detail) !== JSON.stringify(detail)) {
        await tx.query(
          `INSERT INTO activity_log
             (actor_principal_id, entity_type, entity_id, action, field, before, after)
           VALUES ($1, 'task', $2, 'approval_task_updated', 'approval_task.detail', $3::jsonb, $4::jsonb)`,
          [
            input.actorId,
            input.taskId,
            JSON.stringify({ approval_task_id: before.id, type: before.type, title: before.title, detail: before.detail }),
            JSON.stringify({ approval_task_id: before.id, type: input.type, title, detail }),
          ],
        );
      }
    });
    return { item: await getApprovalTask(open.rows[0].id), created: false };
  }

  let createdId: string | null = null;
  await withTransaction(async (tx) => {
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
          detail,
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

const TYPE_LABEL = APPROVAL_TASK_LABEL;

/** 403 unless the actor may decide in the section this task lives in (0025). */
function requireDecide(actor: ActingPrincipal, type: ApprovalTaskType, verb: string): void {
  requirePerm(
    actor,
    approvalSectionPermKey(approvalSectionOf(type)),
    'approve',
    `You cannot ${verb} ${APPROVAL_TASK_LABEL[type].toLowerCase()} tasks`,
  );
}

/**
 * approve / reject. The status, its stamps, the activity row and an internal
 * comment on the work order all land in one transaction — the decision is
 * feedback for whoever is running the job, and the Updates feed is where
 * they look.
 *
 * Approving a status_change (rule 2.4.3) then moves the work order through
 * the ordinary changeStatus — after this transaction commits, since that
 * service opens its own and dispatches automations — stamped `via:
 * 'approval_task'` so the trail names the request. If the target status was
 * deleted in the meantime the task stays open and the caller gets a 409.
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

  // The target must still exist before anything is written, so an approval
  // never lands without the move it promises.
  let moveTo: string | null = null;
  if (to === 'approved' && cur.type === 'status_change') {
    const d = cur.detail as Partial<StatusChangeDetail>;
    const hit = d.to_status_id
      ? await query<{ id: string; name: string }>(`SELECT id::text AS id, name FROM status WHERE id = $1 LIMIT 1`, [d.to_status_id])
      : { rows: [] as { id: string; name: string }[] };
    if (!hit.rows[0]) {
      throw conflict(
        `The status "${d.to_status_name ?? '?'}" no longer exists, so this request cannot be approved. Reject it with a note instead.`,
        { approval_task_id: id, status_id: d.to_status_id ?? null },
      );
    }
    // Rules 11.2.1 / 11.2.2: asked again at approval time — the quote or the
    // parts list may have been emptied since the request — and BEFORE the
    // decision commits, so a refused move leaves the request open (409).
    await assertStatusGate({ query }, cur.task_id, hit.rows[0].name);
    moveTo = hit.rows[0].id;
  }

  await withTransaction(async (tx) => {
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
          detail: cur.detail,
          ...(note ? { note } : {}),
        }),
      ],
    );
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO comment (task_id, author_principal_id, body, client_visible)
       VALUES ($1, $2, $3, false) RETURNING id::text AS id`,
      [cur.task_id, actor.id, body],
    );
    // The comment row names the decision it carries, so the audit trail can
    // say WHAT the internal update was about without reading the comment.
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
      [
        actor.id,
        cur.task_id,
        JSON.stringify({
          comment_id: ins.rows[0].id,
          client_visible: false,
          approval_task_id: id,
          approval: { type: cur.type, title: cur.title, detail: cur.detail, status: to, note },
        }),
      ],
    );
  });

  // Rule 2.4.3, "update WO_Status to requested status": the manager's approval
  // is the act that moves it, so the manager is the actor on the status row.
  if (moveTo !== null) {
    const { changeStatus } = await import('./workOrders.js');
    await changeStatus(cur.task_id, moveTo, actor.id, undefined, { kind: 'approval_task', id });
  }
  return getApprovalTask(id);
}

/** open → approved (approvals/<section>:approve). */
export async function approveApprovalTask(
  id: string,
  note: string | null,
  actor: ActingPrincipal,
): Promise<ApprovalTask> {
  const cur = await getApprovalTask(id);
  requireDecide(actor, cur.type, 'approve');
  return decide(id, 'approved', note, actor);
}

/** open → rejected, with the reason (approvals/<section>:approve). */
export async function rejectApprovalTask(
  id: string,
  note: string,
  actor: ActingPrincipal,
): Promise<ApprovalTask> {
  const cur = await getApprovalTask(id);
  requireDecide(actor, cur.type, 'reject');
  return decide(id, 'rejected', note, actor);
}

/** Take an open task into your own lane (approvals/<section>:approve).
    Claiming is routing, not a decision — no comment, just the audit row. */
export async function claimApprovalTask(id: string, actor: ActingPrincipal): Promise<ApprovalTask> {
  const cur = await getApprovalTask(id);
  requireDecide(actor, cur.type, 'claim');
  if (cur.status !== 'open') {
    throw badRequest(`This task is already ${cur.status}`, { status: cur.status });
  }
  await withTransaction(async (tx) => {
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
        JSON.stringify({ approval_task_id: id, type: cur.type, title: cur.title, detail: cur.detail, assigned_to: actor.name }),
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
    await reconcileNteOverride(taskId, actorId);
    await reconcileStatusChange(taskId, actorId);
  } catch (err) {
    console.error('[approvals] reconcile failed:', err);
  }
}

async function reconcileNteOverride(taskId: string, actorId: string): Promise<void> {
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
  await cancelTask(taskId, open.rows[0].id, 'nte_override', open.rows[0].title, why, actorId);
}

/** 0025: an open status-change request whose target the work order now sits
    in (a manager moved it by hand) has nothing left to decide. */
async function reconcileStatusChange(taskId: string, actorId: string): Promise<void> {
  const open = await query<{
    id: string;
    title: string;
    detail: Record<string, unknown> | null;
    to_id: string | null;
    to_name: string | null;
  }>(
    `SELECT a.id::text AS id, a.title, a.detail, a.detail->>'to_status_id' AS to_id, a.detail->>'to_status_name' AS to_name
       FROM approval_task a
      WHERE a.task_id = $1 AND a.type = 'status_change' AND a.status = 'open' LIMIT 1`,
    [taskId],
  );
  const r = open.rows[0];
  if (!r || !r.to_id) return;
  const cur = await query<{ status_id: string }>(
    `SELECT status_id::text AS status_id FROM task WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  if (!cur.rows[0] || cur.rows[0].status_id !== r.to_id) return;
  await cancelTask(
    taskId,
    r.id,
    'status_change',
    r.title,
    `The work order was moved to ${r.to_name ?? 'the requested status'} directly`,
    actorId,
    r.detail,
  );
}

/** open → cancelled with a reason; one audit row (no comment — nobody decided). */
async function cancelTask(
  taskId: string,
  id: string,
  type: ApprovalTaskType,
  title: string,
  why: string,
  actorId: string,
  detail: Record<string, unknown> | null = null,
): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE approval_task
          SET status = 'cancelled', decided_by = $1, decided_at = now(), decision_note = $2,
              updated_at = now()
        WHERE id = $3`,
      [actorId, why, id],
    );
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'approval_task_cancelled', 'approval_task.status', $3::jsonb, $4::jsonb)`,
      [
        actorId,
        taskId,
        JSON.stringify({ approval_task_id: id, status: 'open' }),
        JSON.stringify({ approval_task_id: id, type, status: 'cancelled', title, detail, note: why }),
      ],
    );
  });
}

// ── Status change requests (rules 2.4.1 – 2.4.3, 0025) ──────────────────────

/**
 * Rule 2.4.1: a person who may only REQUEST a status change (work_orders/
 * status:create without :edit) asks here. One open request per work order —
 * asking again replaces the target and makes the request theirs. The
 * automations engine does not react: nothing on the work order changed yet.
 */
export async function requestStatusChange(
  taskId: string,
  toStatusId: string,
  actor: ActingPrincipal,
): Promise<{ item: ApprovalTask; created: boolean }> {
  requirePerm(actor, STATUS_PERM_KEY, 'create', 'You cannot request status changes');
  // Rules 11.2.1 / 11.2.2: a request for a move the gate would refuse is
  // refused here, with the same sentence a direct move gets — a manager is
  // never asked to approve something the system will then block.
  const to = await query<{ name: string }>(`SELECT name FROM status WHERE id = $1 LIMIT 1`, [toStatusId]);
  if (to.rows[0]) await assertStatusGate({ query }, taskId, to.rows[0].name);
  return createApprovalTask({
    taskId,
    type: 'status_change',
    actorId: actor.id,
    toStatusId,
  });
}

/**
 * The requester says they saw the decision (rule 2.4.3's "notify"): the row
 * leaves their My requests. An approver may acknowledge on their behalf.
 */
export async function acknowledgeApprovalTask(id: string, actor: ActingPrincipal): Promise<ApprovalTask> {
  const cur = await getApprovalTask(id);
  if (cur.status !== 'approved' && cur.status !== 'rejected') {
    throw badRequest(`Only a decided task can be acknowledged; this one is ${cur.status}`, { status: cur.status });
  }
  if (cur.acknowledged_at) return cur;
  const own = cur.created_by?.id === actor.id;
  if (!own) requireDecide(actor, cur.type, 'acknowledge');
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE approval_task SET acknowledged_by = $1, acknowledged_at = now(), updated_at = now() WHERE id = $2`,
      [actor.id, id],
    );
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'approval_task_acknowledged', 'approval_task.acknowledged', NULL, $3::jsonb)`,
      [
        actor.id,
        cur.task_id,
        JSON.stringify({ approval_task_id: id, type: cur.type, status: cur.status, title: cur.title, detail: cur.detail }),
      ],
    );
  });
  return getApprovalTask(id);
}

/** The requester (or an approver) takes an open request back. */
export async function withdrawApprovalTask(id: string, actor: ActingPrincipal): Promise<ApprovalTask> {
  const cur = await getApprovalTask(id);
  if (cur.status !== 'open') {
    throw badRequest(`This task is already ${cur.status}`, { status: cur.status });
  }
  const own = cur.created_by?.id === actor.id;
  if (!own) requireDecide(actor, cur.type, 'withdraw');
  await cancelTask(cur.task_id, id, cur.type, cur.title, `Withdrawn by ${actor.name}`, actor.id, cur.detail);
  return getApprovalTask(id);
}

/**
 * The sidebar badge: what waits on this person. Approvers count the open
 * tasks in the sections they may decide; requesters count their own decided
 * requests not yet acknowledged. (Quotes and payments waiting are not
 * counted here — they have their own pages and badges are for the inbox.)
 */
export async function approvalCounts(viewer: ActingPrincipal): Promise<ApprovalCounts> {
  const allow = allowFor(viewer);
  const decideTypes = (['nte_override', 'status_change', 'manager_review'] as ApprovalTaskType[]).filter(
    (t) => allow(approvalSectionPermKey(approvalSectionOf(t)), 'approve'),
  );
  const p = new Params();
  const me = p.add(viewer.id);
  const scope = woScopeSql(viewer, p);
  const scopeSql = scope ? `AND (${scope} OR a.created_by = ${me})` : '';
  const res = await query<{ type: ApprovalTaskType; status: ApprovalTaskStatus; mine: boolean; acked: boolean; n: number | string }>(
    `SELECT a.type, a.status, (a.created_by = ${me}) AS mine, (a.acknowledged_at IS NOT NULL) AS acked, count(*)::int AS n
       FROM approval_task a JOIN task t ON t.id = a.task_id
      WHERE t.deleted_at IS NULL
        AND (a.status = 'open' OR (a.created_by = ${me} AND a.acknowledged_at IS NULL))
        ${scopeSql}
      GROUP BY 1, 2, 3, 4`,
    p.values,
  );
  let to_decide = 0;
  let to_acknowledge = 0;
  for (const r of res.rows) {
    const n = Number(r.n);
    if (r.status === 'open' && decideTypes.includes(r.type)) to_decide += n;
    if ((r.status === 'approved' || r.status === 'rejected') && r.mine && !r.acked) to_acknowledge += n;
  }
  // The inbox's "For me" lane also holds the quotes and technician payments
  // waiting on this person; the badge counts what that lane shows.
  const only = scope ? `AND ${scope}` : '';
  if (allow('quotes', 'approve') && allow(approvalSectionPermKey('quotes'), 'view')) {
    const q = await query<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM quote q JOIN task t ON t.id = q.task_id
        WHERE q.status = 'pending_approval' AND t.deleted_at IS NULL ${only}`,
      p.values,
    );
    to_decide += Number(q.rows[0]?.n ?? 0);
  }
  if (allow('payments', 'approve') && allow(approvalSectionPermKey('payments'), 'view')) {
    const pr = await query<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM payment_request pr JOIN task t ON t.id = pr.task_id
        WHERE pr.status = 'requested' AND t.deleted_at IS NULL ${only}`,
      p.values,
    );
    to_decide += Number(pr.rows[0]?.n ?? 0);
  }
  return { to_decide, to_acknowledge };
}
