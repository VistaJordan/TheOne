// Routes: technician payment requests at Yoda parity (on the 0015 permission tree).
//   GET    /work-orders/:id/payment-requests        (list + totals — payments:view)
//   POST   /work-orders/:id/payment-requests        (201 requested — payments:create; WO status gated)
//   GET    /payments                                (the Payments tab / AP queue — payments:view, 0026 scoped)
//   GET    /payment-requests/:pid                   (one row; full payout address for a processor)
//   PATCH  /payment-requests/:pid                   (edit while requested — requester | processor)
//   POST   /payment-requests/:pid/approve|reject    (payments:approve)
//   POST   /payment-requests/:pid/pay|convert-method (payments/process:edit)
//   POST   /payment-requests/:pid/delete            (owner | processor; processed rows → pending_delete)
//   POST   /payment-requests/:pid/confirm-delete|reject-delete        (payments/process:delete)
//   GET    /vendors?q=&trade=   POST /vendors   GET /vendors/:vid   PATCH /vendors/:vid/compliance
//   GET    /vendors/:vid/ytd?billing_entity=
//
// The acting principal is resolved once, up front, and the permission checks
// live in the service so no route can forget one. Money goes through the same
// hardened validation as the quote's line items.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, actingPrincipalFromRequest } from '../services/activity.js';
import {
  listPaymentRequests,
  listAllPaymentRequests,
  createPaymentRequest,
  getPaymentRequest,
  updatePaymentRequest,
  approvePaymentRequest,
  payPaymentRequest,
  rejectPaymentRequest,
  convertPaymentMethod,
  deletePaymentRequest,
  confirmDeletePaymentRequest,
  rejectDeletePaymentRequest,
  vendorYtd,
} from '../services/payments.js';
import { listVendors, getVendor, createVendor, updateVendorCompliance } from '../services/vendors.js';
import { requirePerm } from '../services/permissions.js';
import { assertRawMoney, zMoney } from '../validation.js';

const idParamsSchema = z.object({ id: z.string().min(1) });
const pidParamsSchema = z.object({ pid: z.string().uuid() });
const vidParamsSchema = z.object({ vid: z.string().uuid() });

const methodSchema = z.enum(['zelle', 'ach', 'credit', 'check', 'cashapp']);

/** Yoda PaymentAddress — one shape per method (D8). */
const addressSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('zelle'), zelle_handle: z.string().trim().min(3).max(120) }),
  z.object({
    method: z.literal('ach'),
    bank_name: z.string().trim().max(120).nullable().optional().transform((v) => v ?? null),
    routing_number: z.string().trim().regex(/^\d{9}$/, 'Routing number is 9 digits'),
    account_number: z.string().trim().regex(/^\d{4,17}$/, 'Account number is 4–17 digits'),
    account_type: z.enum(['checking', 'savings']).nullable().optional().transform((v) => v ?? null),
  }),
  z.object({ method: z.literal('cashapp'), cashtag: z.string().trim().regex(/^\$?[A-Za-z][A-Za-z0-9_-]{0,24}$/, 'Enter a $cashtag') }),
  z.object({
    method: z.literal('check'),
    payable_to: z.string().trim().min(1).max(200),
    mailing_address: z.string().trim().min(5).max(400),
  }),
  z.object({ method: z.literal('credit'), note: z.string().trim().max(400).nullable().optional().transform((v) => v ?? null) }),
]);

// The payee is a vendor OR a manual name+phone — the either/or is enforced in
// the service, where the 400 can explain itself.
const createSchema = z
  .object({
    vendor_id: z.string().uuid().nullable().optional(),
    payee_name: z.string().trim().max(200).nullable().optional(),
    payee_phone: z.string().trim().max(40).nullable().optional(),
    purpose: z.string().trim().min(1).max(500),
    amount: zMoney('Amount', 0.01),
    method: methodSchema,
    payment_address: addressSchema.nullable().optional(),
    note: z.string().max(4000).nullable().optional(),
    recipient_name: z.string().trim().max(200).nullable().optional(),
    recipient_phone: z.string().trim().max(40).nullable().optional(),
    recipient_is_store: z.boolean().optional(),
    attachment_id: z.string().uuid().nullable().optional(),
    override_blacklist: z.boolean().optional(),
  })
  .strict();

const editSchema = z
  .object({
    purpose: z.string().trim().min(1).max(500).optional(),
    amount: zMoney('Amount', 0.01).optional(),
    method: methodSchema.optional(),
    payment_address: addressSchema.nullable().optional(),
    note: z.string().max(4000).nullable().optional(),
    recipient_name: z.string().trim().max(200).nullable().optional(),
    recipient_phone: z.string().trim().max(40).nullable().optional(),
    recipient_is_store: z.boolean().optional(),
  })
  .strict();

// 0016 called the field `note`; the parity UI sends `reason`. Accept either.
const reasonSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000).optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((v) => Boolean(v.reason ?? v.note), { message: 'A reason is required' })
  .transform((v) => ({ reason: (v.reason ?? v.note) as string }));
const convertSchema = z.object({ method: methodSchema });

const queueSchema = z.object({
  status: z.enum(['requested', 'approved', 'sent_to_yoda', 'paid', 'rejected']).optional(),
  billing_entity: z.string().trim().max(120).optional(),
  vendor_id: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
  pending_delete: z.enum(['true', 'false']).optional(),
  needs_w9: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(100),
});

const vendorsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  trade: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const vendorCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    phone: z.string().trim().max(40).nullable().optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
    trades: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(40).nullable().optional(),
  })
  .strict();
const vendorComplianceSchema = z
  .object({
    is_w9_present: z.boolean().optional(),
    is_blacklisted: z.boolean().optional(),
    blacklist_reason: z.string().trim().max(1000).nullable().optional(),
    insurance_expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
  })
  .strict();
const ytdQuerySchema = z.object({ billing_entity: z.string().trim().max(120).optional() });

async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParamsSchema, req.params);
  const taskId = await resolveTaskId(id, actingPrincipalFromRequest(req));
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  // ── Per work order ─────────────────────────────────────────────────────────
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

  // ── The Payments tab / AP queue + single row ───────────────────────────────
  /** GET /payments — the sidebar tab. Needs payments:view (0015); 0026 scopes the rows. */
  app.get('/payments', async (req) => {
    const viewer = actingPrincipalFromRequest(req);
    requirePerm(viewer, 'payments', 'view', 'You cannot view payment requests');
    const q = parse(queueSchema, req.query);
    return listAllPaymentRequests(
      {
        status: q.status ?? null,
        billing_entity: q.billing_entity ?? null,
        vendor_id: q.vendor_id ?? null,
        q: q.q ?? null,
        pending_delete: q.pending_delete === undefined ? null : q.pending_delete === 'true',
        needs_w9: q.needs_w9 === undefined ? null : q.needs_w9 === 'true',
        page: q.page,
        page_size: q.page_size,
      },
      viewer,
    );
  });

  app.get('/payment-requests/:pid', async (req) => {
    const { pid } = parse(pidParamsSchema, req.params);
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, 'payments', 'view', 'You cannot view payment requests');
    return { item: await getPaymentRequest(pid, actor) };
  });

  app.patch('/payment-requests/:pid', async (req) => {
    const { pid } = parse(pidParamsSchema, req.params);
    assertRawMoney(req.rawBody);
    const input = parse(editSchema, req.body);
    return { item: await updatePaymentRequest(pid, input, actingPrincipalFromRequest(req)) };
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  app.post('/payment-requests/:pid/approve', async (req) => {
    const { pid } = parse(pidParamsSchema, req.params);
    return { item: await approvePaymentRequest(pid, actingPrincipalFromRequest(req)) };
  });

  app.post('/payment-requests/:pid/pay', async (req) => {
    const { pid } = parse(pidParamsSchema, req.params);
    return { item: await payPaymentRequest(pid, actingPrincipalFromRequest(req)) };
  });

  // 0016's verb for the same move; kept so the Payments tab's older callers keep working.
  app.post('/payment-requests/:pid/mark-paid', async (req) => {
    const { pid } = parse(pidParamsSchema, req.params);
    return { item: await payPaymentRequest(pid, actingPrincipalFromRequest(req)) };
  });

  app.post('/payment-requests/:pid/reject', async (req) => {
    const { pid } = parse(pidParamsSchema, req.params);
    const { reason } = parse(reasonSchema, req.body);
    return { item: await rejectPaymentRequest(pid, reason, actingPrincipalFromRequest(req)) };
  });

  app.post('/payment-requests/:pid/convert-method', async (req) => {
    const { pid } = parse(pidParamsSchema, req.params);
    const { method } = parse(convertSchema, req.body);
    return { item: await convertPaymentMethod(pid, method, actingPrincipalFromRequest(req)) };
  });

  // ── Delete (soft, two-person on processed rows) ────────────────────────────
  app.post('/payment-requests/:pid/delete', async (req, reply) => {
    const { pid } = parse(pidParamsSchema, req.params);
    const { reason } = parse(reasonSchema, req.body);
    const item = await deletePaymentRequest(pid, reason, actingPrincipalFromRequest(req));
    if (item === null) return reply.status(200).send({ item: null, deleted: true });
    return { item, deleted: false };
  });

  app.post('/payment-requests/:pid/confirm-delete', async (req) => {
    const { pid } = parse(pidParamsSchema, req.params);
    await confirmDeletePaymentRequest(pid, actingPrincipalFromRequest(req));
    return { item: null, deleted: true };
  });

  app.post('/payment-requests/:pid/reject-delete', async (req) => {
    const { pid } = parse(pidParamsSchema, req.params);
    return { item: await rejectDeletePaymentRequest(pid, actingPrincipalFromRequest(req)) };
  });

  // ── Vendors (technicians) — vendors:view / vendors:create / payments/process:edit ──
  app.get('/vendors', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), 'vendors', 'view', 'You cannot view vendors');
    const q = parse(vendorsQuerySchema, req.query);
    return listVendors(q.q ?? null, q.trade ?? null, q.limit);
  });

  app.post('/vendors', async (req, reply) => {
    // Anyone who may request a payment may add the technician it goes to.
    requirePerm(actingPrincipalFromRequest(req), 'payments', 'create', 'You cannot add vendors');
    const input = parse(vendorCreateSchema, req.body);
    return reply.status(201).send({ item: await createVendor(input) });
  });

  app.get('/vendors/:vid', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), 'vendors', 'view', 'You cannot view vendors');
    const { vid } = parse(vidParamsSchema, req.params);
    return { item: await getVendor(vid) };
  });

  app.patch('/vendors/:vid/compliance', async (req) => {
    const { vid } = parse(vidParamsSchema, req.params);
    const input = parse(vendorComplianceSchema, req.body);
    return { item: await updateVendorCompliance(vid, input, actingPrincipalFromRequest(req)) };
  });

  app.get('/vendors/:vid/ytd', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), 'payments', 'view', 'You cannot view payment requests');
    const { vid } = parse(vidParamsSchema, req.params);
    const { billing_entity } = parse(ytdQuerySchema, req.query);
    return vendorYtd(vid, billing_entity ?? null);
  });
}
