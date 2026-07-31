// Route: GET /activity?wo=:id — a WO's activity newest-first (§5).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, getActivityForTask } from '../services/activity.js';

const activityQuerySchema = z.object({
  wo: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export default async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/activity', async (req) => {
    const { wo, limit } = parse(activityQuerySchema, req.query);
    const taskId = await resolveTaskId(wo);
    if (!taskId) throw notFound('Work order not found');
    return getActivityForTask(taskId, limit);
  });
}
