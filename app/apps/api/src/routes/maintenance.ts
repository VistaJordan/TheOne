// 0065 · Maintenance modules.
//
//   GET    /maintenance/services            · POST · PATCH /:id · DELETE /:id
//   GET    /maintenance/job-plans           · POST · PATCH /:id · DELETE /:id
//   GET    /maintenance/time                ?from&to&tech — the time tracker
//   GET    /maintenance/permits             ?state&search
//   GET    /maintenance/assignment          ?who&search&trade
//   POST   /maintenance/assignment/assign   { ids, principal_id }
//
//   GET    /work-orders/:id/maintenance
//   POST   /work-orders/:id/job-plans       { plan_id }
//   POST   /work-orders/:id/services        · PATCH /:lineId · DELETE /:lineId
//   POST   /work-orders/:id/time            · PATCH /:entryId · DELETE /:entryId
//   POST   /work-orders/:id/permits         · PATCH /:permitId · DELETE /:permitId
//   POST   /work-orders/:id/permits/:permitId/act   { action, note }

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TIME_KINDS } from '@theone/shared';
import { notFound, parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import {
  actOnPermit,
  addTimeEntry,
  addWoService,
  applyJobPlan,
  assignWorkOrders,
  assignmentBoard,
  createPermit,
  deleteJobPlan,
  deletePermit,
  deleteService,
  deleteTimeEntry,
  getWoMaintenance,
  listJobPlans,
  listPermits,
  listServices,
  removeWoService,
  saveJobPlan,
  saveService,
  timeTracker,
  updatePermit,
  updateTimeEntry,
  updateWoService,
} from '../services/maintenance.js';

const idParams = z.object({ id: z.string().min(1).max(64) });
const text = (max: number) => z.string().max(max).nullable().optional();
const amount = z.number().min(0).max(10_000_000).nullable().optional();

const serviceBody = z
  .object({
    code: text(40),
    name: z.string().max(200).optional(),
    trade: text(120),
    description: text(2000),
    unit: z.string().max(40).optional(),
    unit_price: amount,
    unit_cost: amount,
    est_minutes: z.number().int().min(0).max(100_000).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

const planBody = z
  .object({
    name: z.string().max(200).optional(),
    trade: text(120),
    description: text(2000),
    est_minutes: z.number().int().min(0).max(100_000).nullable().optional(),
    is_active: z.boolean().optional(),
    steps: z.array(z.string().max(300)).max(100).optional(),
    services: z.array(z.object({ service_id: z.string().uuid(), qty: z.number().positive().max(100_000) })).max(100).optional(),
  })
  .strict();

const timeBody = z
  .object({
    tech_name: z.string().max(160).optional(),
    vendor_id: z.string().uuid().nullable().optional(),
    kind: z.enum(TIME_KINDS).optional(),
    started_at: z.string().max(40).optional(),
    ended_at: z.string().max(40).nullable().optional(),
    billable: z.boolean().optional(),
    hourly_rate: z.number().min(0).max(10_000).nullable().optional(),
    note: text(500),
    stop: z.boolean().optional(),
  })
  .strict();

const permitBody = z
  .object({
    permit_type: z.string().max(80).optional(),
    holder: text(200),
    valid_from: text(10),
    valid_to: text(10),
    hazards: text(2000),
    precautions: z.array(z.object({ text: z.string().max(200), done: z.boolean() })).max(40).optional(),
  })
  .strict();

export default async function maintenanceRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (req: FastifyRequest) => actingPrincipalFromRequest(req);
  /** The work order, resolved through the viewer's scope (403 outside it). */
  const task = async (req: FastifyRequest) => {
    const { id } = parse(idParams, req.params);
    const actor = actorOf(req);
    const taskId = await resolveTaskId(id, actor);
    if (!taskId) throw notFound('Work order not found');
    return { taskId, actor };
  };
  const sub = <K extends string>(req: FastifyRequest, key: K): string =>
    (parse(z.object({ [key]: z.string().min(1).max(64) } as Record<K, z.ZodString>), req.params) as Record<K, string>)[key];

  // ── Catalogue ──────────────────────────────────────────────────────────────
  app.get('/maintenance/services', async (req) => listServices(actorOf(req)));
  app.post('/maintenance/services', async (req) => saveService(null, parse(serviceBody, req.body), actorOf(req)));
  app.patch('/maintenance/services/:id', async (req) => saveService(parse(idParams, req.params).id, parse(serviceBody, req.body), actorOf(req)));
  app.delete('/maintenance/services/:id', async (req) => deleteService(parse(idParams, req.params).id, actorOf(req)));

  app.get('/maintenance/job-plans', async (req) => listJobPlans(actorOf(req)));
  app.post('/maintenance/job-plans', async (req) => saveJobPlan(null, parse(planBody, req.body), actorOf(req)));
  app.patch('/maintenance/job-plans/:id', async (req) => saveJobPlan(parse(idParams, req.params).id, parse(planBody, req.body), actorOf(req)));
  app.delete('/maintenance/job-plans/:id', async (req) => deleteJobPlan(parse(idParams, req.params).id, actorOf(req)));

  // ── Across work orders ─────────────────────────────────────────────────────
  app.get('/maintenance/time', async (req) => {
    const q = parse(z.object({ from: z.string().max(10).optional(), to: z.string().max(10).optional(), tech: z.string().max(160).optional() }), req.query);
    return timeTracker(actorOf(req), q);
  });
  app.get('/maintenance/permits', async (req) => {
    const q = parse(z.object({ state: z.string().max(20).optional(), search: z.string().max(120).optional() }), req.query);
    return listPermits(actorOf(req), q);
  });
  app.get('/maintenance/assignment', async (req) => {
    const q = parse(z.object({ who: z.string().max(200).optional(), search: z.string().max(120).optional(), trade: z.string().max(120).optional() }), req.query);
    return assignmentBoard(actorOf(req), q);
  });
  app.post('/maintenance/assignment/assign', async (req) => {
    const body = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(200), principal_id: z.string().uuid().nullable() }).strict(), req.body);
    return assignWorkOrders(body.ids, body.principal_id, actorOf(req));
  });

  // ── On one work order ──────────────────────────────────────────────────────
  app.get('/work-orders/:id/maintenance', async (req) => {
    const { taskId, actor } = await task(req);
    return getWoMaintenance(taskId, actor);
  });
  app.post('/work-orders/:id/job-plans', async (req) => {
    const { taskId, actor } = await task(req);
    const { plan_id } = parse(z.object({ plan_id: z.string().uuid() }).strict(), req.body);
    return applyJobPlan(taskId, plan_id, actor);
  });

  const lineBody = z
    .object({ service_id: z.string().uuid().nullable().optional(), name: z.string().max(200).optional(), unit: z.string().max(40).optional(), qty: z.number().positive().max(100_000).optional(), unit_price: amount, unit_cost: amount, note: text(500) })
    .strict();
  app.post('/work-orders/:id/services', async (req) => {
    const { taskId, actor } = await task(req);
    return addWoService(taskId, parse(lineBody, req.body), actor);
  });
  app.patch('/work-orders/:id/services/:lineId', async (req) => {
    const { taskId, actor } = await task(req);
    const body = parse(z.object({ qty: z.number().positive().max(100_000).optional(), unit_price: amount, unit_cost: amount, note: text(500) }).strict(), req.body);
    return updateWoService(taskId, sub(req, 'lineId'), body, actor);
  });
  app.delete('/work-orders/:id/services/:lineId', async (req) => {
    const { taskId, actor } = await task(req);
    return removeWoService(taskId, sub(req, 'lineId'), actor);
  });

  app.post('/work-orders/:id/time', async (req) => {
    const { taskId, actor } = await task(req);
    return addTimeEntry(taskId, parse(timeBody, req.body), actor);
  });
  app.patch('/work-orders/:id/time/:entryId', async (req) => {
    const { taskId, actor } = await task(req);
    return updateTimeEntry(taskId, sub(req, 'entryId'), parse(timeBody, req.body), actor);
  });
  app.delete('/work-orders/:id/time/:entryId', async (req) => {
    const { taskId, actor } = await task(req);
    return deleteTimeEntry(taskId, sub(req, 'entryId'), actor);
  });

  app.post('/work-orders/:id/permits', async (req) => {
    const { taskId, actor } = await task(req);
    return createPermit(taskId, parse(permitBody, req.body), actor);
  });
  app.patch('/work-orders/:id/permits/:permitId', async (req) => {
    const { taskId, actor } = await task(req);
    return updatePermit(taskId, sub(req, 'permitId'), parse(permitBody, req.body), actor);
  });
  app.delete('/work-orders/:id/permits/:permitId', async (req) => {
    const { taskId, actor } = await task(req);
    return deletePermit(taskId, sub(req, 'permitId'), actor);
  });
  app.post('/work-orders/:id/permits/:permitId/act', async (req) => {
    const { taskId, actor } = await task(req);
    const body = parse(z.object({ action: z.enum(['request', 'approve', 'reject', 'close', 'reopen']), note: text(500) }).strict(), req.body);
    return actOnPermit(taskId, sub(req, 'permitId'), body.action, body.note ?? null, actor);
  });
}
