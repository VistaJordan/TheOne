// Routes: vendor bills (0047) — the bill from the vendor.
//
//   GET    /vendor-bills                       the queue, scoped like every other read
//   GET    /vendor-bills/:id
//   GET    /work-orders/:id/vendor-bills       the bills on one work order
//   POST   /vendor-bills                       record one
//   PATCH  /vendor-bills/:id                   edit while received / disputed
//   POST   /vendor-bills/:id/approve           payments:approve + the amount's tier
//   POST   /vendor-bills/:id/paid              payments/process:edit
//   POST   /vendor-bills/:id/dispute           with a note (internal comment)
//   POST   /vendor-bills/:id/resolve           disputed → received
//   POST   /vendor-bills/:id/void
//
// (Registered under the /api prefix in app.ts.)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import {
  approveVendorBill,
  createVendorBill,
  disputeVendorBill,
  getVendorBill,
  listVendorBills,
  listVendorBillsForTask,
  markVendorBillPaid,
  resolveVendorBill,
  updateVendorBill,
  voidVendorBill,
} from '../services/vendorBills.js';

const idParams = z.object({ id: z.string().uuid() });
const woParams = z.object({ id: z.string().min(1) });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const lineSchema = z.object({
  kind: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().min(1).max(400),
  quantity: z.number().min(0).max(100_000).optional(),
  unit_price: z.number().min(-1_000_000).max(1_000_000).optional(),
});

const createSchema = z
  .object({
    task_id: z.string().uuid(),
    vendor_id: z.string().uuid().nullable().optional(),
    vendor_name: z.string().trim().min(1).max(200),
    bill_number: z.string().trim().max(80).nullable().optional(),
    received_on: day.optional(),
    due_on: day.nullable().optional(),
    tax: z.number().min(0).max(1_000_000).optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    lines: z.array(lineSchema).min(1).max(200),
    contract_id: z.string().uuid().nullable().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    vendor_name: z.string().trim().min(1).max(200).optional(),
    bill_number: z.string().trim().max(80).nullable().optional(),
    received_on: day.optional(),
    due_on: day.nullable().optional(),
    tax: z.number().min(0).max(1_000_000).optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    lines: z.array(lineSchema).max(200).optional(),
  })
  .strict();

const noteSchema = z.object({ note: z.string().trim().min(1).max(2000) }).strict();
const paidSchema = z
  .object({
    reference: z.string().trim().max(120).nullable().optional(),
    payment_request_id: z.string().uuid().nullable().optional(),
  })
  .strict();

export default async function vendorBillRoutes(app: FastifyInstance): Promise<void> {
  app.get('/vendor-bills', async (req) => listVendorBills(actingPrincipalFromRequest(req)));

  app.get('/vendor-bills/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { bill: await getVendorBill(id, actingPrincipalFromRequest(req)) };
  });

  app.get('/work-orders/:id/vendor-bills', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    const { id } = parse(woParams, req.params);
    const taskId = await resolveTaskId(id, actor);
    if (!taskId) return { items: [] };
    return { items: await listVendorBillsForTask(taskId, actor) };
  });

  app.post('/vendor-bills', async (req, reply) => {
    const body = parse(createSchema, req.body);
    const bill = await createVendorBill(body, actingPrincipalFromRequest(req));
    return reply.status(201).send({ bill });
  });

  app.patch('/vendor-bills/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(updateSchema, req.body);
    return { bill: await updateVendorBill(id, body, actingPrincipalFromRequest(req)) };
  });

  app.post('/vendor-bills/:id/approve', async (req) => {
    const { id } = parse(idParams, req.params);
    return { bill: await approveVendorBill(id, actingPrincipalFromRequest(req)) };
  });

  app.post('/vendor-bills/:id/paid', async (req) => {
    const { id } = parse(idParams, req.params);
    const { reference, payment_request_id } = parse(paidSchema, req.body ?? {});
    return { bill: await markVendorBillPaid(id, actingPrincipalFromRequest(req), reference, payment_request_id) };
  });

  app.post('/vendor-bills/:id/dispute', async (req) => {
    const { id } = parse(idParams, req.params);
    const { note } = parse(noteSchema, req.body);
    return { bill: await disputeVendorBill(id, note, actingPrincipalFromRequest(req)) };
  });

  app.post('/vendor-bills/:id/resolve', async (req) => {
    const { id } = parse(idParams, req.params);
    return { bill: await resolveVendorBill(id, actingPrincipalFromRequest(req)) };
  });

  app.post('/vendor-bills/:id/void', async (req) => {
    const { id } = parse(idParams, req.params);
    return { bill: await voidVendorBill(id, actingPrincipalFromRequest(req)) };
  });
}
