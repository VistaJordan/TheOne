// Reminders to managers (Elise, 2026-11-16, UAT #48). What is waiting for a
// manager on one work order, and the reminder a dispatcher or the OP Admin
// sends about one of them. Vocabulary in shared `approvalReminders.ts`.
//
// Who is reminded: the people who may decide that kind of approval (their
// ROLE's grant — per-person overrides are not read, as for the vendor review
// queue: a notice to one person too many is harmless, the decision is still
// gated). Of those, the ones on the work order (an assigned seat: Assignee,
// TL, ATL, AM…) when there are any; else every one of them who is not a super
// admin; else the super admins. The reminder is an `app_notice` (always
// shown) and an `approval_reminder_sent` audit row on the work order, which is
// also the cool-down: one reminder per approval per hour, whoever sends it.

import {
  APPROVAL_REMINDER_ACTION,
  APPROVAL_REMINDER_NOTICE_KIND,
  APPROVAL_REMINDER_NOTE_MAX,
  OVER_QUOTE_DECIDER_ROLES,
  PURCHASING_PERM,
  approvalReminderTitle,
  approvalSectionOf,
  approvalSectionPermKey,
  isAssignedTo,
  mayRemindApprovals,
  nextReminderAt,
  nteRequestsLink,
  reminderTooSoonSentence,
  type ApprovalReminderResult,
  type ApprovalTaskType,
  type PendingApproval,
  type PendingApprovalKind,
  type PendingApprovalsResponse,
} from '@theone/shared';
import { query } from '../db.js';
import { ApiError, conflict, forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { notify } from './notices.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface Raw {
  kind: PendingApprovalKind;
  id: string;
  label: string;
  type: string | null;
  requested_by: string | null;
  waiting_since: Date;
}

const QUOTE_STATUS_LABEL: Record<string, string> = {
  pending_correction: 'waiting for correction',
  pending_approval: 'waiting for approval',
};

/** Everything on the work order still waiting for a manager. Intake
    acceptances are left out: Incoming is its own queue, not a manager's yes. */
async function pendingRaw(taskId: string): Promise<Raw[]> {
  const [tasks, quotes, payments, ntes, purchases] = await Promise.all([
    query<{ id: string; type: string; title: string; who: string | null; at: Date }>(
      `SELECT a.id::text AS id, a.type, a.title, p.display_name AS who, a.created_at AS at
         FROM approval_task a LEFT JOIN principal p ON p.id = a.created_by
        WHERE a.task_id = $1 AND a.status = 'open' AND a.type <> 'wo_acceptance'
        ORDER BY a.created_at`,
      [taskId],
    ),
    query<{ id: string; number: string | null; status: string; who: string | null; at: Date }>(
      `SELECT q.id::text AS id, q.number, q.status, p.display_name AS who,
              COALESCE(q.submitted_at, q.updated_at) AS at
         FROM quote q LEFT JOIN principal p ON p.id = COALESCE(q.submitted_by, q.created_by)
        WHERE q.task_id = $1 AND q.status IN ('pending_correction', 'pending_approval')`,
      [taskId],
    ),
    query<{ id: string; purpose: string; amount: string; who: string | null; at: Date }>(
      `SELECT r.id::text AS id, r.purpose, r.amount::text AS amount, p.display_name AS who, r.created_at AS at
         FROM payment_request r LEFT JOIN principal p ON p.id = r.requested_by
        WHERE r.task_id = $1 AND r.status = 'requested' AND r.deleted_at IS NULL
        ORDER BY r.created_at`,
      [taskId],
    ),
    query<{ id: string; requested_nte: string; who: string | null; at: Date }>(
      `SELECT r.id::text AS id, r.requested_nte::text AS requested_nte, p.display_name AS who, r.created_at AS at
         FROM wo_nte_request r LEFT JOIN principal p ON p.id = r.requested_by
        WHERE r.task_id = $1 AND r.status = 'open'`,
      [taskId],
    ),
    query<{ id: string; pr_number: string; title: string; who: string | null; at: Date }>(
      `SELECT r.id::text AS id, r.pr_number, r.title, p.display_name AS who,
              COALESCE(r.submitted_at, r.created_at) AS at
         FROM purchase_request r LEFT JOIN principal p ON p.id = r.requested_by
        WHERE r.task_id = $1 AND r.status = 'submitted'
        ORDER BY r.created_at`,
      [taskId],
    ),
  ]);
  return [
    ...tasks.rows.map((r) => ({ kind: 'task' as const, id: r.id, label: r.title, type: r.type, requested_by: r.who, waiting_since: r.at })),
    ...quotes.rows.map((r) => ({
      kind: 'quote' as const,
      id: r.id,
      label: `Quote${r.number ? ` ${r.number}` : ''} ${QUOTE_STATUS_LABEL[r.status] ?? 'waiting'}`,
      type: r.status,
      requested_by: r.who,
      waiting_since: r.at,
    })),
    ...payments.rows.map((r) => ({
      kind: 'payment' as const,
      id: r.id,
      label: `Payment request ${r.purpose} · ${usd(Number(r.amount))}`,
      type: null,
      requested_by: r.who,
      waiting_since: r.at,
    })),
    ...ntes.rows.map((r) => ({
      kind: 'nte_request' as const,
      id: r.id,
      label: `NTE increase to ${usd(Number(r.requested_nte))}`,
      type: null,
      requested_by: r.who,
      waiting_since: r.at,
    })),
    ...purchases.rows.map((r) => ({
      kind: 'purchase' as const,
      id: r.id,
      label: `Purchase request ${r.pr_number} · ${r.title}`,
      type: null,
      requested_by: r.who,
      waiting_since: r.at,
    })),
  ];
}

/** The last reminder per approval on this work order. */
async function lastReminders(taskId: string): Promise<Map<string, string>> {
  const res = await query<{ item: string; at: string }>(
    `SELECT substr(field, 10) AS item,
            to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
       FROM activity_log
      WHERE entity_type = 'task' AND entity_id = $1 AND action = $2 AND field LIKE 'reminder:%'
      GROUP BY field`,
    [taskId, APPROVAL_REMINDER_ACTION],
  );
  return new Map(res.rows.map((r) => [r.item, r.at]));
}

function shape(r: Raw, last: Map<string, string>): PendingApproval {
  const reminded = last.get(r.id) ?? null;
  return {
    kind: r.kind,
    id: r.id,
    label: r.label,
    requested_by: r.requested_by,
    waiting_since: r.waiting_since.toISOString(),
    reminded_at: reminded,
    next_reminder_at: nextReminderAt(reminded),
  };
}

export async function listPendingApprovals(taskId: string, actor: ActingPrincipal): Promise<PendingApprovalsResponse> {
  const [raw, last] = await Promise.all([pendingRaw(taskId), lastReminders(taskId)]);
  return {
    items: raw.map((r) => shape(r, last)),
    can_remind: mayRemindApprovals(actor.role, actor.isSuperAdmin),
  };
}

/** The permission paths (most specific first) whose `approve` decides it. */
function deciderPaths(r: Raw): string[] {
  switch (r.kind) {
    case 'task':
      return [approvalSectionPermKey(approvalSectionOf(r.type as ApprovalTaskType)), 'approvals'];
    case 'quote':
      return ['quotes'];
    case 'payment':
      return ['payments'];
    case 'nte_request':
      return [approvalSectionPermKey('nte'), 'approvals'];
    case 'purchase':
      return [PURCHASING_PERM.requests, 'purchasing'];
  }
}

/** Where the manager decides it. */
function decideLink(r: Raw, woNumber: string): string {
  const wo = `/work-orders/${encodeURIComponent(woNumber)}`;
  if (r.kind === 'nte_request') return nteRequestsLink(woNumber);
  if (r.kind === 'quote') return `${wo}?tab=quotes`;
  // A status request is decided on the work order's header chip.
  if (r.kind === 'task' && r.type === 'status_change') return wo;
  return '/approvals';
}

async function reminderRecipients(r: Raw, bag: Record<string, unknown>): Promise<string[]> {
  const paths = deciderPaths(r);
  const grant = `COALESCE(${paths.map((_, i) => `(r.permissions -> $${i + 1} ->> 'approve')`).join(', ')}) = 'true'`;
  const res = await query<{ id: string; name: string; role: string | null; is_super_admin: boolean }>(
    `SELECT p.id::text AS id, p.display_name AS name, p.role, p.is_super_admin
       FROM principal p LEFT JOIN role r ON r.code = p.role
      WHERE p.kind = 'human' AND p.status <> 'disabled'
        AND (p.is_super_admin OR ${grant})`,
    paths,
  );
  let people = res.rows;
  // Over-the-quote holds are ATL and above only, whatever the grant says.
  if (r.kind === 'task' && r.type === 'over_quote') {
    people = people.filter((p) => p.is_super_admin || (p.role != null && (OVER_QUOTE_DECIDER_ROLES as readonly string[]).includes(p.role)));
  }
  const onJob = people.filter((p) => isAssignedTo(bag, p.name));
  if (onJob.length > 0) return onJob.map((p) => p.id);
  const managers = people.filter((p) => !p.is_super_admin);
  return (managers.length > 0 ? managers : people).map((p) => p.id);
}

export async function sendApprovalReminder(
  taskId: string,
  input: { kind: PendingApprovalKind; id: string; note?: string | null },
  actor: ActingPrincipal,
): Promise<ApprovalReminderResult> {
  if (!mayRemindApprovals(actor.role, actor.isSuperAdmin)) {
    throw forbidden('Reminders are sent by the dispatchers and the OP Admin');
  }
  const raw = (await pendingRaw(taskId)).find((r) => r.kind === input.kind && r.id === input.id);
  if (!raw) throw notFound('That approval is no longer waiting — it may have been decided already');
  const last = await lastReminders(taskId);
  const next = nextReminderAt(last.get(raw.id) ?? null);
  if (next) throw conflict(reminderTooSoonSentence(next), { code: 'REMINDER_TOO_SOON', next_reminder_at: next });

  const t = await query<{ wo_number: string; fields: Record<string, unknown> | null }>(
    `SELECT wo_number, fields FROM task WHERE id = $1`,
    [taskId],
  );
  const wo = t.rows[0];
  if (!wo) throw notFound('Work order not found');
  const bag = wo.fields ?? {};
  const to = (await reminderRecipients(raw, bag)).filter((id) => id !== actor.id);
  if (to.length === 0) throw new ApiError('CONFLICT', 'Nobody can decide this approval yet — ask an admin who should', { code: 'REMINDER_NO_DECIDER' });

  const note = (input.note ?? '').trim().slice(0, APPROVAL_REMINDER_NOTE_MAX) || null;
  const sentAt = new Date().toISOString();
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, $3, $4, 'null'::jsonb, $5::jsonb)`,
    [
      actor.id,
      taskId,
      APPROVAL_REMINDER_ACTION,
      `reminder:${raw.id}`,
      JSON.stringify({ kind: raw.kind, item: raw.id, label: raw.label, note, recipients: to.length }),
    ],
  );
  await notify(to, {
    kind: APPROVAL_REMINDER_NOTICE_KIND,
    title: approvalReminderTitle(actor.name, raw.label, wo.wo_number),
    body: note,
    link: decideLink(raw, wo.wo_number),
    taskId,
    actorId: actor.id,
    dedupeKey: `reminder:${raw.id}:${sentAt}`,
  });
  last.set(raw.id, sentAt);
  return { sent_to: to.length, item: shape(raw, last) };
}
