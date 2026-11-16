// After hours (Elise, 2026-11-16).
//
// Notifications and approvals about a work order show only to the people
// assigned to it. After hours is the switch on the Notifications and the
// Approvals pages that shows every work order the person may open — for the
// one covering the phones at night. Every press is an audit row:
//
//   after_hours_opened / after_hours_closed
//     entity_type 'after_hours', entity_id = the person whose pages it widens
//     after = { name, page }
//
// The switch lives in those rows, not in the browser: a read asks for the
// wide view (`after_hours=1`) and gets it only while the person's latest row
// for that page is an "opened" less than AFTER_HOURS_HOURS old. So the wide
// view cannot be had without leaving a row, and it lapses on its own.
// While viewing as someone the row is re-signed to the real person (0088) and
// names the viewed one in `viewing_as_id`.

import { AFTER_HOURS_HOURS, AFTER_HOURS_PAGES, type AfterHoursPage, type AfterHoursState } from '@theone/shared';
import { query } from '../db.js';
import { logAdminEvent } from './adminAudit.js';
import type { ActingPrincipal } from './activity.js';

const ENTITY = 'after_hours';

export async function afterHoursState(personId: string): Promise<AfterHoursState> {
  const res = await query<{ page: string; action: string }>(
    `SELECT DISTINCT ON (a.after ->> 'page') a.after ->> 'page' AS page, a.action
       FROM activity_log a
      WHERE a.entity_type = '${ENTITY}' AND a.entity_id = $1
        AND a.created_at > now() - make_interval(hours => ${AFTER_HOURS_HOURS})
      ORDER BY a.after ->> 'page', a.created_at DESC, a.id DESC`,
    [personId],
  );
  const on = new Set(res.rows.filter((r) => r.action === 'after_hours_opened').map((r) => r.page));
  return { notifications: on.has('notifications'), approvals: on.has('approvals') };
}

/** Is the wide view on for this page right now? */
export async function afterHoursOn(personId: string, page: AfterHoursPage): Promise<boolean> {
  return (await afterHoursState(personId))[page];
}

/** A press of the switch: logs it, answers the new state. Pressing "on" while
    already on logs again (it restarts the clock); "off" while off logs nothing. */
export async function setAfterHours(actor: ActingPrincipal, page: AfterHoursPage, on: boolean): Promise<AfterHoursState> {
  if (!AFTER_HOURS_PAGES.includes(page)) return afterHoursState(actor.id);
  const now = await afterHoursState(actor.id);
  if (on || now[page]) {
    await logAdminEvent({
      actorId: actor.id,
      entity: ENTITY,
      entityId: actor.id,
      action: on ? 'after_hours_opened' : 'after_hours_closed',
      after: { name: actor.name, page },
    });
  }
  return { ...now, [page]: on };
}

export interface AfterHoursLogRow {
  at: string;
  action: 'after_hours_opened' | 'after_hours_closed';
  page: string;
  person: { id: string; name: string };
  /** Who actually pressed it when it differs (viewing as). */
  by: { id: string; name: string } | null;
}

/** Everyone's presses, newest first — the log the pages link to. */
export async function afterHoursLog(limit = 200): Promise<AfterHoursLogRow[]> {
  const res = await query<{
    at: Date;
    action: AfterHoursLogRow['action'];
    page: string | null;
    person_id: string;
    person_name: string | null;
    by_id: string | null;
    by_name: string | null;
  }>(
    `SELECT a.created_at AS at, a.action, a.after ->> 'page' AS page,
            a.entity_id AS person_id, COALESCE(p.display_name, a.after ->> 'name') AS person_name,
            r.id::text AS by_id, r.display_name AS by_name
       FROM activity_log a
       LEFT JOIN principal p ON p.id::text = a.entity_id
       LEFT JOIN principal r ON r.id = a.actor_principal_id
      WHERE a.entity_type = '${ENTITY}'
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    at: r.at.toISOString(),
    action: r.action,
    page: r.page ?? '',
    person: { id: r.person_id, name: r.person_name ?? 'Unknown' },
    by: r.by_id && r.by_id !== r.person_id ? { id: r.by_id, name: r.by_name ?? 'Unknown' } : null,
  }));
}

/** The Approvals page reads the quotes, payments, purchase and NTE-increase
    queues with `?assigned=1` — the work orders the person is on (an assigned
    seat) — and without it while After hours is on. The routes copy the actor
    with `assignedOnly`, which `woScopeSql` reads. */
export function withAssignedOnly(actor: ActingPrincipal, rawQuery: unknown): ActingPrincipal {
  const q = (rawQuery ?? {}) as Record<string, unknown>;
  return q.assigned === '1' ? { ...actor, assignedOnly: true } : actor;
}
