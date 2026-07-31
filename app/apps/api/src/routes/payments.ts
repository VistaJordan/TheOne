// Routes: technician payment requests (S4).
//   GET  /work-orders/:id/payment-requests   (list + totals)
//   POST /work-orders/:id/payment-requests   (201 requested — ANY role)
//
// No role gate: the AP queue is the control point, and the approval routing is
// explicitly undecided (product/quotes-payments.md §4.3). The amount goes through
// the same hardened money validation as the quote's line items.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, resolveActingPrincipal } from '../services/activity.js';
import { listPaymentRequests, createPaymentRequest } from '../services/payments.js';
import { assertRawMoney, zMoney } from '../validation.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

// The payee is a vendor OR a manual name+phone — the either/or is enforced in
// the service, where the 400 can explain itself.
const createSchema = z
  .object({
    vendor_id: z.string().uuid().nullable().optional(),
    payee_name: z.string().trim().max(200).nullable().optional(),
    payee_phone: z.string().trim().max(40).nullable().optional(),
    purpose: z.string().trim().min(1).max(500),
    amount: zMoney('Amount', 0.01),
    method: z.string().trim().min(1).max(60),
    note: z.string().max(4000).nullable().optional(),
    recipient_name: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

function actorHeader(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParamsSchema, req.params);
  const taskId = await resolveTaskId(id);
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/work-orders/:id/payment-requests', async (req) => {
    const taskId = await taskIdOf(req);
    return listPaymentRequests(taskId);
  });

  app.post('/work-orders/:id/payment-requests', async (req, reply) => {
    const taskId = await taskIdOf(req);
    assertRawMoney(req.rawBody);
    const input = parse(createSchema, req.body);
    const actor = await resolveActingPrincipal(actorHeader(req.headers['x-actor-id']));
    const item = await createPaymentRequest(taskId, input, actor);
    return reply.status(201).send({ item });
  });
}
