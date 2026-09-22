// Routes: planned maintenance (0051).
//
//   GET    /planned-maintenance              every schedule (raises what is due first)
//   GET    /planned-maintenance/:id          one, with its occurrences
//   POST   /planned-maintenance              create
//   PUT    /planned-maintenance/:id          replace
//   DELETE /planned-maintenance/:id
//   POST   /planned-maintenance/:id/raise    raise the next due date now
//   POST   /planned-maintenance/:id/skip     skip the next due date
//   POST   /planned-maintenance/run          raise everything due (edit grant)
//
// The cron's entry is /webhooks/planned-maintenance-run (routes/webhooks.ts,
// CRON_SECRET) — no session there. (Registered under /api in app.ts.)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PM_PERM_KEY, PM_UNITS } from '@theone/shared';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import { requirePerm } from '../services/permissions.js';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  raiseDueWorkOrders,
  raiseNext,
  skipNext,
  updateSchedule,
} from '../services/plannedMaintenance.js';

const idParams = z.object({ id: z.string().uuid() });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().max(max).nullable().optional();

const scheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    client: text(200),
    billing_entity: text(60),
    store: text(120),
    site_name: text(200),
    address: text(300),
    city: text(120),
    state: text(60),
    trade: text(120),
    description: text(4000),
    nte: z.number().min(0).max(1_000_000_000).nullable().optional(),
    assignee: text(200),
    every: z.number().int().min(1).max(365),
    unit: z.enum(PM_UNITS),
    starts_on: day,
    ends_on: day.nullable().optional(),
    lead_days: z.number().int().min(0).max(365).optional(),
    active: z.boolean().optional(),
  })
  .strict();

export default async function plannedMaintenanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/planned-maintenance', async (req) => listSchedules(actingPrincipalFromRequest(req)));

  app.post('/planned-maintenance/run', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, PM_PERM_KEY, 'edit', 'You cannot raise planned maintenance');
    return raiseDueWorkOrders();
  });

  app.get('/planned-maintenance/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return getSchedule(id, actingPrincipalFromRequest(req));
  });

  app.post('/planned-maintenance', async (req, reply) => {
    const body = parse(scheduleSchema, req.body);
    const schedule = await createSchedule(body, actingPrincipalFromRequest(req));
    return reply.status(201).send({ schedule });
  });

  app.put('/planned-maintenance/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(scheduleSchema, req.body);
    return { schedule: await updateSchedule(id, body, actingPrincipalFromRequest(req)) };
  });

  app.delete('/planned-maintenance/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deleteSchedule(id, actingPrincipalFromRequest(req));
    return reply.status(204).send();
  });

  app.post('/planned-maintenance/:id/raise', async (req) => {
    const { id } = parse(idParams, req.params);
    return raiseNext(id, actingPrincipalFromRequest(req));
  });

  app.post('/planned-maintenance/:id/skip', async (req) => {
    const { id } = parse(idParams, req.params);
    return { schedule: await skipNext(id, actingPrincipalFromRequest(req)) };
  });
}
