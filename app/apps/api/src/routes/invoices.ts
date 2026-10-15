// Routes: invoices (0045) — the bill to the client.
//
//   GET    /invoices                 the queue, scoped like every other read
//   GET    /invoices/:id             one invoice with its lines
//   GET    /work-orders/:id/invoice  the invoice on a work order, or null
//   POST   /invoices                 raise one from a work order
//   PATCH  /invoices/:id             edit a draft (lines, tax, discount, note)
//   POST   /invoices/:id/send        to the client — needs `invoicing:approve`
//   POST   /invoices/:id/paid        settle it: the payment reference and the date it arrived (0083, M7)
//   POST   /invoices/:id/void        cancel it; the number stays used
//   POST   /invoices/:id/reopen      a voided one back to draft
//
// (Registered under the /api prefix in app.ts.)

import type { FastifyInstance } from 'fastify';
import { MONEY_MAX } from '@theone/shared';
import { z } from 'zod';
import { INVOICE_LINE_KINDS } from '@theone/shared';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import {
  createInvoice,
  getInvoice,
  getInvoiceForTask,
  listInvoices,
  markInvoicePaid,
  reopenInvoice,
  sendInvoice,
  updateInvoice,
  voidInvoice,
} from '../services/invoices.js';
import { assertRecordInScope, assertTaskInScope } from '../services/recordScope.js';

const idParams = z.object({ id: z.string().uuid() });
const woParams = z.object({ id: z.string().min(1) });

const lineSchema = z.object({
  // Free text in the column so a new kind of line never needs a migration;
  // the known ones are offered as an enum for anything the UI sends.
  kind: z.union([z.enum(INVOICE_LINE_KINDS), z.string().trim().min(1).max(40)]).optional(),
  description: z.string().trim().min(1).max(400),
  quantity: z.number().min(0).max(100_000).optional(),
  unit_price: z.number().min(-MONEY_MAX).max(MONEY_MAX).optional(),
});

const updateSchema = z
  .object({
    note: z.string().trim().max(2000).nullable().optional(),
    tax: z.number().min(0).max(MONEY_MAX).optional(),
    discount: z.number().min(0).max(MONEY_MAX).optional(),
    due_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    lines: z.array(lineSchema).max(200).optional(),
  })
  .strict();

const createSchema = z.object({ task_id: z.string().uuid() }).strict();
const paidSchema = z
  .object({
    reference: z.string().trim().min(1).max(120),
    paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export default async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/invoices', async (req) => listInvoices(actingPrincipalFromRequest(req)));

  app.get('/invoices/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await assertRecordInScope('invoice', id, actingPrincipalFromRequest(req)); // #13
    return { invoice: await getInvoice(id, actingPrincipalFromRequest(req)) };
  });

  // The work order's own tab asks by WO number or id, like every other
  // per-work-order route, and goes through the same scope check.
  app.get('/work-orders/:id/invoice', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    const { id } = parse(woParams, req.params);
    const taskId = await resolveTaskId(id, actor);
    if (!taskId) return { invoice: null };
    return { invoice: await getInvoiceForTask(taskId, actor) };
  });

  app.post('/invoices', async (req, reply) => {
    const actor = actingPrincipalFromRequest(req);
    const { task_id } = parse(createSchema, req.body);
    await assertTaskInScope(task_id, actor); // #13
    const invoice = await createInvoice(task_id, actor);
    return reply.status(201).send({ invoice });
  });

  app.patch('/invoices/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await assertRecordInScope('invoice', id, actingPrincipalFromRequest(req)); // #13
    const body = parse(updateSchema, req.body);
    return { invoice: await updateInvoice(id, body, actingPrincipalFromRequest(req)) };
  });

  app.post('/invoices/:id/send', async (req) => {
    const { id } = parse(idParams, req.params);
    await assertRecordInScope('invoice', id, actingPrincipalFromRequest(req)); // #13
    return { invoice: await sendInvoice(id, actingPrincipalFromRequest(req)) };
  });

  app.post('/invoices/:id/paid', async (req) => {
    const { id } = parse(idParams, req.params);
    await assertRecordInScope('invoice', id, actingPrincipalFromRequest(req)); // #13
    const { reference, paid_on } = parse(paidSchema, req.body ?? {});
    return { invoice: await markInvoicePaid(id, actingPrincipalFromRequest(req), reference, paid_on) };
  });

  app.post('/invoices/:id/void', async (req) => {
    const { id } = parse(idParams, req.params);
    await assertRecordInScope('invoice', id, actingPrincipalFromRequest(req)); // #13
    return { invoice: await voidInvoice(id, actingPrincipalFromRequest(req)) };
  });

  app.post('/invoices/:id/reopen', async (req) => {
    const { id } = parse(idParams, req.params);
    await assertRecordInScope('invoice', id, actingPrincipalFromRequest(req)); // #13
    return { invoice: await reopenInvoice(id, actingPrincipalFromRequest(req)) };
  });
}
