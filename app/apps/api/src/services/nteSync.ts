// The Client NTE follows the client's portal once its sync is on (Elise,
// 2026-11-16; the rule and its sentence live in packages/shared/src/nteSync.ts).
//
// A work order "follows Ecotrak" when it has a `cmms_wo_link` on an Ecotrak
// connection AND "Ecotrak → OBI" is switched on in Admin › Integrations (read
// from the table, `integrationOnNow`, so a flip takes effect at once). Then
// the Ecotrak ingest — which writes task.fields / task.nte with its own SQL,
// never through these guards — is the only writer of the NTE:
//
//   assertNteNotSynced   refused in updateWorkOrderFields (the field editor,
//                        automations, the NTE request approval) and bulk edit
//                        (409 NTE_SYNCED, the work orders named);
//   nteSyncedTaskIds     asked by setNteFromApproval (quotes.ts), which then
//                        leaves the NTE alone, and by the NTE increase
//                        request / decision (woRecord.ts);
//   isNteSynced          the detail's `nte_synced`, which draws the field
//                        read-only and hides Request NTE increase.
//
// Not asked: the CSV import (a data load, as for the money keys) and the
// create paths (a new work order has no portal link).

import { ApiError } from '../errors.js';
import { query } from '../db.js';
import type { Queryable } from '../db.js';
import { NTE_SYNCED_CODE, NTE_SYNCED_MESSAGE, nteFollowsPortal } from '@theone/shared';
import { integrationOnNow } from './integrations.js';
import { K_NTE } from './money.js';

/** The ids among `taskIds` whose NTE is Ecotrak's alone right now. */
export async function nteSyncedTaskIds(taskIds: string[], q: Queryable = { query }): Promise<Set<string>> {
  const out = new Set<string>();
  if (taskIds.length === 0) return out;
  const on = await integrationOnNow('ecotrak');
  if (!nteFollowsPortal(true, on)) return out;
  const r = await q.query<{ task_id: string }>(
    `SELECT DISTINCT l.task_id::text AS task_id
       FROM cmms_wo_link l
       JOIN cmms_connection c ON c.id = l.connection_id
      WHERE c.provider = 'ecotrak' AND l.task_id::text = ANY($1::text[])`,
    [taskIds],
  );
  for (const row of r.rows) out.add(row.task_id);
  return out;
}

export async function isNteSynced(taskId: string, q: Queryable = { query }): Promise<boolean> {
  return (await nteSyncedTaskIds([taskId], q)).has(taskId);
}

/**
 * 409 NTE_SYNCED when a write names the Client NTE (`jsonKeys` holds the bag
 * key, or `coreNte` says the promoted `nte` column is in the patch) on a work
 * order whose NTE follows Ecotrak. A selection names the work orders in the way.
 */
export async function assertNteNotSynced(
  taskIds: string[],
  jsonKeys: string[],
  q: Queryable = { query },
  coreNte = false,
): Promise<void> {
  if (!coreNte && !jsonKeys.includes(K_NTE)) return;
  const synced = await nteSyncedTaskIds(taskIds, q);
  if (synced.size === 0) return;
  if (taskIds.length === 1) {
    throw new ApiError('CONFLICT', NTE_SYNCED_MESSAGE, { code: NTE_SYNCED_CODE });
  }
  const r = await q.query<{ wo_number: string }>(
    `SELECT wo_number FROM task WHERE id::text = ANY($1::text[]) ORDER BY wo_number`,
    [[...synced]],
  );
  const names = r.rows.map((x) => x.wo_number);
  throw new ApiError(
    'CONFLICT',
    `${NTE_SYNCED_MESSAGE} In this selection: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' and more' : ''}.`,
    { code: NTE_SYNCED_CODE, work_orders: names },
  );
}
