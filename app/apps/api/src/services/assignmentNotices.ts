// "Assigned to you" in the bell (Elise, 2026-10-30).
//
// Whoever lands in a work order's Assignee seat is told, whichever path put
// them there — the field editor, bulk edit, Accept, Add work order, a draft's
// Submit, the Assignment Manager, a rule, the PM raise, the import. Every one
// of those reports to `dispatchAutomations` after its commit, which calls
// `notifyAssignment`, so no path can forget it (the sign-off sheet's pattern).
//
// Only a name ADDED to the seat is told (`addedAssignees`); the person who did
// the assigning is never told about their own act (`notify` skips the actor),
// so assigning yourself raises nothing. The notice is keyed by the audit row
// that made the assignment, so the 'created' and 'changed' events of one
// Add work order cannot tell the same person twice. Never throws.

import { ASSIGNEE_FIELD_KEY, WO_ASSIGNED_NOTICE_KIND, addedAssignees, assigneeNames, assignedNoticeTitle } from '@theone/shared';
import { query } from '../db.js';
import type { AutomationEvent } from './automations.js';
import { notify } from './notices.js';

const SEAT = ASSIGNEE_FIELD_KEY; // 'fields.Assignee'
const BAG_KEY = SEAT.slice('fields.'.length);

export async function notifyAssignment(event: AutomationEvent): Promise<void> {
  try {
    let names: string[];
    if (event.kind === 'created') {
      const t = await query<{ assignee: string | null }>(`SELECT fields->>$2 AS assignee FROM task WHERE id = $1`, [
        event.taskId,
        BAG_KEY,
      ]);
      names = assigneeNames(t.rows[0]?.assignee);
    } else {
      const seat = (event.changes ?? []).find((c) => c.field === SEAT);
      names = seat ? addedAssignees(seat.before, seat.after) : [];
    }
    if (names.length === 0) return;

    // The act behind it: the newest audit row that set the seat (or created
    // the work order with it filled).
    const act = await query<{ id: string; actor_id: string; actor_name: string; actor_kind: string; wo_number: string; title: string | null }>(
      `SELECT a.id::text AS id, p.id::text AS actor_id, p.display_name AS actor_name, p.kind::text AS actor_kind,
              t.wo_number, t.title
         FROM task t
         JOIN activity_log a ON a.entity_type = 'task' AND a.entity_id = t.id::text
                            AND (a.field = $2 OR a.action = 'created')
         JOIN principal p ON p.id = a.actor_principal_id
        WHERE t.id = $1
        ORDER BY a.id DESC
        LIMIT 1`,
      [event.taskId, SEAT],
    );
    const row = act.rows[0];
    if (!row) return;

    const people = await query<{ id: string }>(
      `SELECT id::text AS id FROM principal
        WHERE kind = 'human' AND status <> 'disabled'
          AND lower(btrim(display_name)) = ANY($1::text[])`,
      [names.map((n) => n.trim().toLowerCase())],
    );
    if (people.rows.length === 0) return;

    await notify(
      people.rows.map((p) => p.id),
      {
        kind: WO_ASSIGNED_NOTICE_KIND,
        title: assignedNoticeTitle(row.wo_number, row.actor_kind === 'human' ? row.actor_name : null),
        body: row.title,
        link: `/work-orders/${encodeURIComponent(row.wo_number)}`,
        actorId: row.actor_id,
        dedupeKey: `${WO_ASSIGNED_NOTICE_KIND}:${event.taskId}:${row.id}`,
      },
    );
  } catch (err) {
    console.error('[assignmentNotices] could not raise the notice', (err as Error).message);
  }
}
