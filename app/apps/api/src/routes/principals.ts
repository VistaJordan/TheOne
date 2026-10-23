// Routes:
//   GET /principals               humans who are not disabled, ordered by name (S4.1)
//   GET /principals/availability  ?client=<name> — who is free to take a work
//                                 order: every person with ALL their active
//                                 work orders split by status, flagged when
//                                 Admin › Users lists them on that client.
//
// Both sit behind the session guard like every /api route. The first carries
// no permission check beyond that — it is the list every picker and the
// "Viewing as" switcher draw from. The second shows other people's loads, so
// it asks for `work_orders` view: the right to see the list is the right to
// see how it is shared out.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AssigneeAvailabilityResponse, PrincipalsResponse } from '@theone/shared';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import { requirePerm } from '../services/permissions.js';
import { assigneeAvailability, listPrincipals } from '../services/principals.js';
import { query } from '../db.js';

const availabilityQuery = z.object({
  client: z.string().trim().max(300).optional(),
});

export default async function principalsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/principals', async (): Promise<PrincipalsResponse> => ({
    items: await listPrincipals(),
  }));

  // L4 (UAT Wave D): who to ask — the active super admins on file, by name
  // only, for the locked admin page. Any signed-in person may read it.
  app.get('/principals/super-admins', async (): Promise<{ names: string[] }> => {
    const res = await query<{ name: string }>(
      `SELECT display_name AS name FROM principal
        WHERE kind = 'human' AND is_super_admin AND status <> 'disabled'
        ORDER BY lower(display_name)`,
    );
    return { names: res.rows.map((r) => r.name) };
  });

  app.get('/principals/availability', async (req: FastifyRequest): Promise<AssigneeAvailabilityResponse> => {
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, 'work_orders', 'view', 'You cannot see who is available');
    const { client } = parse(availabilityQuery, req.query ?? {});
    return assigneeAvailability(client ?? null);
  });
}
