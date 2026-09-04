// Routes: GET /statuses      — all statuses ordered by position (§5).
//         GET /status-groups — the phase groups (status_group_def) in order.
//         GET /lists         — the routing lists a work order can be homed in.
//
// All are reference data the write paths need to offer a CHOICE rather than
// ask for a uuid: a bulk re-route has to show list names and send list ids.

import type { FastifyInstance } from 'fastify';
import { listStatuses } from '../services/workOrders.js';
import { listStatusGroups } from '../services/statusAdmin.js';
import { query } from '../db.js';

export default async function statusesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/statuses', async () => listStatuses());

  app.get('/status-groups', async () => ({ items: await listStatusGroups() }));

  app.get('/lists', async () => {
    const res = await query<{ id: string; name: string; wo_count: number }>(
      `SELECT c.id, c.name,
              (SELECT COUNT(*)::int FROM task t
                WHERE t.home_list_id = c.id AND t.deleted_at IS NULL) AS wo_count
         FROM container c
        WHERE c.kind = 'list'
        ORDER BY c.name ASC`,
    );
    return { items: res.rows };
  });
}
