// Routes: visits (0021) — check-in / check-out as a log.
//   GET    /work-orders/:id/visits      the log, oldest first (+ the FM's default method)
//   POST   /work-orders/:id/visits      log a visit (type required)
//   PATCH  /visits/:id                  move the status / correct a stamp / edit the tech
//   DELETE /visits/:id                  remove a visit (mirrors resync to the one before)
//   GET    /visits/:id/history          every recorded change of one visit
//
// Reads need the CICO section's view grant, writes its edit grant (plus
// work_orders edit) — the same gate the old fields sat behind. The checks
// live in the service (requireVisitView / requireVisitEdit) so no route can
// forget one. Every write also needs the work order the visit belongs to,
// resolved BEFORE the service opens its transaction.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, actingPrincipalFromRequest } from '../services/activity.js';
import { requirePerm } from '../services/permissions.js';
import {
  createVisit,
  deleteVisit,
  getVisitHistory,
  listVisits,
  requireVisitView,
  taskIdOfVisit,
  updateVisit,
} from '../services/visits.js';

const idParamsSchema = z.object({ id: z.string().min(1) });
const uuidParamsSchema = z.object({ id: z.string().uuid() });

const visitBodySchema = z.object({
  visit_type: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['planned', 'checked_in', 'checked_out']).optional(),
  return_trip_needed: z.boolean().optional(),
  tech_name: z.string().max(200).nullable().optional(),
  tech_phone: z.string().max(60).nullable().optional(),
  method: z.string().max(60).nullable().optional(),
  method_detail: z.string().max(300).nullable().optional(),
  checked_in_at: z.string().max(40).nullable().optional(),
  checked_out_at: z.string().max(40).nullable().optional(),
});

async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParamsSchema, req.params);
  const taskId = await resolveTaskId(id);
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

export default async function visitRoutes(app: FastifyInstance): Promise<void> {
  app.get('/work-orders/:id/visits', async (req) => {
    requireVisitView(actingPrincipalFromRequest(req));
    return listVisits(await taskIdOf(req));
  });

  app.post('/work-orders/:id/visits', async (req, reply) => {
    const actor = actingPrincipalFromRequest(req);
    const taskId = await taskIdOf(req);
    const body = parse(visitBodySchema, req.body ?? {});
    const res = await createVisit(taskId, body, actor);
    return reply.code(201).send(res);
  });

  app.patch('/visits/:id', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    const { id } = parse(uuidParamsSchema, req.params);
    if (!(await taskIdOfVisit(id))) throw notFound('Visit not found');
    const body = parse(visitBodySchema, req.body ?? {});
    return updateVisit(id, body, actor);
  });

  app.delete('/visits/:id', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    const { id } = parse(uuidParamsSchema, req.params);
    if (!(await taskIdOfVisit(id))) throw notFound('Visit not found');
    return deleteVisit(id, actor);
  });

  app.get('/visits/:id/history', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requireVisitView(actor);
    requirePerm(actor, 'work_orders/history', 'view', 'You cannot view field history');
    const { id } = parse(uuidParamsSchema, req.params);
    if (!(await taskIdOfVisit(id))) throw notFound('Visit not found');
    return { items: await getVisitHistory(id) };
  });
}
