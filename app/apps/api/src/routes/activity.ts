// Route: GET /activity?wo=:id — a WO's activity newest-first (§5).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, getActivityForTask, actingPrincipalFromRequest } from '../services/activity.js';
import { activityValuesVisible, allowFor, requirePerm } from '../services/permissions.js';

const activityQuerySchema = z.object({
  wo: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export default async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/activity', async (req) => {
    const { wo, limit } = parse(activityQuerySchema, req.query);
    // The same gate the work order itself has (view + row scope, 0026).
    const viewer = actingPrincipalFromRequest(req);
    requirePerm(viewer, 'work_orders', 'view', 'You cannot view work orders');
    const taskId = await resolveTaskId(wo, viewer);
    if (!taskId) throw notFound('Work order not found');
    // M28 · rows on a field this viewer cannot see are left out.
    const allow = allowFor(viewer);
    return (await getActivityForTask(taskId, limit)).filter((e) => activityValuesVisible(allow, e.field));
  });
}
