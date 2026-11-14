// "Your request was approved / rejected" in Notifications (Elise, 2026-11-14).
//
// When a manager decides an approval task — a status change request, a snooze
// request, a money hold — the person who asked AND the dispatcher(s) in the
// work order's Assignee seat are told, so the dispatcher can follow every
// request on their work orders without opening each one. Acceptances
// (`wo_acceptance`) are left out: an accept already raises "Assigned to you",
// and a rejected one has nobody in the seat.
//
// Called by `decide` (approvals.ts) after its commit. `notify` skips the
// manager who decided and anyone disabled; the dedupe key makes it one notice
// per person per decision. Never throws.

import {
  APPROVAL_TASK_LABEL,
  ASSIGNEE_FIELD_KEY,
  REQUEST_DECIDED_NOTICE_KIND,
  assigneeNames,
  requestDecidedNoticeTitle,
  type ApprovalTask,
} from '@theone/shared';
import { query } from '../db.js';
import { notify } from './notices.js';

const BAG_KEY = ASSIGNEE_FIELD_KEY.slice('fields.'.length); // 'Assignee'

export async function notifyRequestDecided(
  task: ApprovalTask,
  to: 'approved' | 'rejected',
  note: string | null,
  actor: { id: string },
): Promise<void> {
  if (task.type === 'wo_acceptance') return;
  try {
    const wo = await query<{ wo_number: string; assignee: string | null }>(
      `SELECT wo_number, fields->>$2 AS assignee FROM task WHERE id = $1`,
      [task.task_id, BAG_KEY],
    );
    const row = wo.rows[0];
    if (!row) return;

    const names = assigneeNames(row.assignee).map((n) => n.trim().toLowerCase());
    const seat = names.length
      ? await query<{ id: string }>(
          `SELECT id::text AS id FROM principal
            WHERE kind = 'human' AND status <> 'disabled'
              AND lower(btrim(display_name)) = ANY($1::text[])`,
          [names],
        )
      : { rows: [] as { id: string }[] };

    const requester = task.created_by?.kind === 'human' ? task.created_by.id : null;
    const who = task.decided_by?.display_name || null;
    await notify([requester, ...seat.rows.map((r) => r.id)], {
      kind: REQUEST_DECIDED_NOTICE_KIND,
      title: requestDecidedNoticeTitle(APPROVAL_TASK_LABEL[task.type], to, row.wo_number, who),
      body: [task.title, note?.trim() || null].filter(Boolean).join(' — ') || null,
      link: `/work-orders/${encodeURIComponent(row.wo_number)}`,
      actorId: actor.id,
      dedupeKey: `${REQUEST_DECIDED_NOTICE_KIND}:${task.id}`,
    });
  } catch (err) {
    console.error('[requestNotices] could not raise the notice', (err as Error).message);
  }
}
