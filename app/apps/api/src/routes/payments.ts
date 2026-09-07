// Routes: technician payment requests (S4, decisions 0016).
//   GET  /work-orders/:id/payment-requests        (list + totals — payments:view)
//   POST /work-orders/:id/payment-requests        (201 requested — payments:create)
//   GET  /payments                                (the Payments tab — payments:view)
//   POST /payment-requests/:id/approve            (requested → approved — payments:approve)
//   POST /payment-requests/:id/reject             (→ rejected + internal note — payments:approve)
//   POST /payment-requests/:id/send-to-yoda       (approved → sent_to_yoda — payments/process:edit)
//   POST /payment-requests/:id/mark-paid          (→ paid — payments/process:edit)
//
// The acting principal is resolved once, up front, and the permission checks
// live in the service so no route can forget one. The amount goes through the
// same hardened money validation as the quote's line items.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, actingPrincipalFromRequest } from '../services/activity.js';
import {
  listPaymentRequests,
  listAllPaymentRequests,
  createPaymentRequest,
  approvePaymentRequest,
  rejectPaymentRequest,
  sendPaymentRequestToYoda,
  markPaymentRequestPaid,
} from '../services/payments.js';
import { requirePerm } from '../services/permissions.js';
import { assertRawMoney, zMoney } from '../validation.js';

const idParamsSchema = z.object({ id: z.string().min(1) });
const uuidParamsSchema = z.object({ id: z.string().uuid() });

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

const rejectSchema = z.object({ note: z.string().trim().min(1).max(2000) });
const sendSchema = z.object({ yoda_ref: z.string().trim().max(200).nullable().optional() });

async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParamsSchema, req.params);
  const taskId = await resolveTaskId(id);
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/work-orders/:id/payment-requests', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), 'payments', 'view', 'You cannot view payment requests');
    const taskId = await taskIdOf(req);
    return listPaymentRequests(taskId);
  });

  app.post('/work-orders/:id/payment-requests', async (req, reply) => {
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, 'payments', 'create', 'You cannot request payments');
    const taskId = await taskIdOf(req);
    assertRawMoney(req.rawBody);
    const input = parse(createSchema, req.body);
    const item = await createPaymentRequest(taskId, input, actor);
    return reply.status(201).send({ item });
  });

  /** GET /payments — the sidebar tab. Needs payments:view (0015). */
  app.get('/payments', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), 'payments', 'view', 'You cannot view payment requests');
    return listAllPaymentRequests();
  });

  app.post('/payment-requests/:id/approve', async (req) => {
    const { id } = parse(uuidParamsSchema, req.params);
    const actor = actingPrincipalFromRequest(req);
    return { item: await approvePaymentRequest(id, actor) };
  });

  app.post('/payment-requests/:id/reject', async (req) => {
    const { id } = parse(uuidParamsSchema, req.params);
    const { note } = parse(rejectSchema, req.body);
    const actor = actingPrincipalFromRequest(req);
    return { item: await rejectPaymentRequest(id, note, actor) };
  });

  app.post('/payment-requests/:id/send-to-yoda', async (req) => {
    const { id } = parse(uuidParamsSchema, req.params);
    const { yoda_ref } = parse(sendSchema, req.body ?? {});
    const actor = actingPrincipalFromRequest(req);
    return { item: await sendPaymentRequestToYoda(id, yoda_ref?.trim() || null, actor) };
  });

  app.post('/payment-requests/:id/mark-paid', async (req) => {
    const { id } = parse(uuidParamsSchema, req.params);
    const actor = actingPrincipalFromRequest(req);
    return { item: await markPaymentRequestPaid(id, actor) };
  });
}
