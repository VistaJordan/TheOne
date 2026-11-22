/* OP Admin's interim rights (Elise, 2026-11-19).
 *
 * OP Admin (`oa`) requests status changes and check-ins / check-outs like a
 * dispatcher — but only once our status changes reach the client, i.e. once
 * **OBI → Ecotrak** (`ecotrak_outbound`) is switched on in Admin ›
 * Integrations. Until then, on a work order where they are named in the
 * **OP Admin** people field (`OA_SEAT_KEY`), they move the status and check in
 * / out DIRECTLY, and approve or reject the dispatchers' status and
 * check-in / check-out requests there. Everywhere else, and everywhere once
 * the switch is on, they are in request mode as their role says.
 *
 * Asked by the status route, createVisit / updateVisit, the Approvals
 * decision (approve / reject a status_change) and the inbox's per-row
 * `can_decide`; the detail payload carries `oa_interim` so the screens agree. */

import { OA_INTERIM_INTEGRATION, OA_ROLE_CODE, OA_SEAT_KEY, seatNamesInclude } from '@theone/shared';
import { query } from '../db.js';
import type { ActingPrincipal } from './activity.js';
import { integrationOnNow } from './integrations.js';

/** Could this person have interim rights at all right now (role + switch)? */
export async function oaInterimPossible(actor: ActingPrincipal): Promise<boolean> {
  if (actor.isSuperAdmin || actor.role !== OA_ROLE_CODE) return false;
  return !(await integrationOnNow(OA_INTERIM_INTEGRATION));
}

/** True while this OP Admin holds the interim rights on this work order. */
export async function oaInterimFor(actor: ActingPrincipal, taskId: string | null | undefined): Promise<boolean> {
  if (!taskId || !(await oaInterimPossible(actor))) return false;
  const r = await query<{ v: string | null }>(`SELECT fields ->> $2 AS v FROM task WHERE id = $1`, [taskId, OA_SEAT_KEY]);
  return seatNamesInclude(r.rows[0]?.v ?? null, actor.name);
}

/** The work orders among `taskIds` this OP Admin holds the interim rights on. */
export async function oaInterimTasks(actor: ActingPrincipal, taskIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (taskIds.length === 0 || !(await oaInterimPossible(actor))) return out;
  const r = await query<{ id: string; v: string | null }>(
    `SELECT id::text AS id, fields ->> $2 AS v FROM task WHERE id::text = ANY($1::text[])`,
    [taskIds, OA_SEAT_KEY],
  );
  for (const row of r.rows) if (seatNamesInclude(row.v, actor.name)) out.add(row.id);
  return out;
}
