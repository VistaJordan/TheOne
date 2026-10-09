// Routes: the quote builder (S4 → Yoda parity, on the 0015 permission tree).
//   GET    /quotes                          (list page — quotes:view, 0026 scoped)
//   GET    /rates   PUT /rates              (Yoda labor rates — read quotes:view, write admin/settings:edit)
// The rest are nested under a work order —
//   GET    /work-orders/:id/quote                 (quotes:view)
//   GET    /work-orders/:id/quote/sales-tax       (quotes:view)
//   POST   /work-orders/:id/quote                 (create draft,  quotes:create)
//   PUT    /work-orders/:id/quote                 (full update,   quotes:edit)
//   POST   /work-orders/:id/quote/submit          (draft → pending_approval, quotes:edit)
//   POST   /work-orders/:id/quote/approve|send|reject|cancel-submission   (quotes:approve)
//   POST   /work-orders/:id/quote/client-approve|client-decline  (quotes:approve, or a dispatcher in Approval)
//   POST   /work-orders/:id/quote/new-round       (quotes:edit)
//
// Two invariants every handler here follows:
//  1. The acting principal is resolved ONCE, up front, and passed down — the
//     permission checks live in the service so no route can forget one, and
//     PGlite's single connection is never asked for a principal mid-transaction.
//  2. Money is validated on the RAW body before Zod sees it (validation.ts).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, actingPrincipalFromRequest, type ActingPrincipal } from '../services/activity.js';
import {
  getQuote,
  listQuotes,
  createQuote,
  updateQuote,
  submitQuote,
  approveQuote,
  sendQuote,
  rejectQuote,
  cancelSubmission,
  clientApproveQuote,
  clientDeclineQuote,
  startNewRound,
  quoteSalesTax,
} from '../services/quotes.js';
import { listLaborRates, upsertLaborRate } from '../services/rates.js';
import { requirePerm } from '../services/permissions.js';
import { assertRawMoney, zMoney } from '../validation.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

const lineSchema = z.object({
  line_type: z.enum(['service', 'labor', 'part', 'material', 'fee', 'discount']),
  description: z.string().trim().min(1).max(500),
  qty: zMoney('Quantity', 0),
  rate: zMoney('Rate', 0),
  /** Legacy verbatim Day text — kept for older clients; `day` is the real column. */
  day_value: z.string().trim().max(40).nullable().optional(),
  day: z.number().int().min(1).max(60).nullable().optional(),
  ot: z.boolean().optional(),
});

const sectionSchema = z.object({
  kind: z.enum(['incurred', 'option']),
  name: z.string().trim().max(200).nullable().optional(),
  narrative_reported: z.string().max(8000).nullable().optional(),
  scope_lines: z.array(z.string().trim().min(1).max(1000)).max(50).optional(),
  include_in_summary: z.boolean().optional(),
  lines: z.array(lineSchema).max(100).optional(),
});

const pctSchema = z
  .union([z.number(), z.string()])
  .transform((v) => Number(String(v).trim()))
  .refine((n) => Number.isFinite(n) && n >= 0 && n <= 30, 'Sales tax must be a percentage between 0 and 30');

const updateSchema = z
  .object({
    sales_tax_pct: pctSchema.optional(),
    total_rule: z.enum(['incurred_plus_option', 'options_only']).optional(),
    total_cost: z.union([zMoney('Total cost', 0), z.null()]).optional(),
    is_cost_tbd: z.boolean().optional(),
    bill_to: z.string().trim().max(400).nullable().optional(),
    specs: z.string().max(8000).nullable().optional(),
    note_to_customer: z.string().max(8000).nullable().optional(),
    /** null clears the pin and hands the summary back to the auto-generator. */
    summary_pinned: z.string().max(20000).nullable().optional(),
    sections: z.array(sectionSchema).max(20).optional(),
  })
  .strict();

const rejectSchema = z.object({ note: z.string().trim().min(1).max(2000) });
const clientApproveSchema = z.object({
  section_id: z.string().uuid(),
  note: z.string().trim().max(2000).nullable().optional(),
  on_site: z.boolean().optional(),
});
const clientDeclineSchema = z.object({
  note: z.string().trim().min(1).max(2000),
  section_id: z.string().uuid().nullable().optional(),
});
const rateSchema = z
  .object({
    billing_entity: z.string().trim().max(120).nullable().optional(),
    fm: z.string().trim().max(200).nullable().optional(),
    trade: z.string().trim().max(120).nullable().optional(),
    tech_rate: z.union([zMoney('Tech rate', 0), z.null()]).optional(),
    helper_rate: z.union([zMoney('Helper rate', 0), z.null()]).optional(),
    trip_rate: z.union([zMoney('Trip rate', 0), z.null()]).optional(),
    afterhours_rate: z.union([zMoney('After-hours rate', 0), z.null()]).optional(),
    holiday_rate: z.union([zMoney('Holiday rate', 0), z.null()]).optional(),
    is_sales_tax_required: z.boolean().optional(),
  })
  .strict();

/** :id (uuid or WO number) → task uuid, 404 when the work order does not exist
    or sits outside the viewer's scope (0026). */
async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParamsSchema, req.params);
  const taskId = await resolveTaskId(id, actingPrincipalFromRequest(req));
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

export default async function quoteRoutes(app: FastifyInstance): Promise<void> {
  /** GET /quotes — the sidebar list page. Needs quotes:view (0015). */
  app.get('/quotes', async (req) => {
    const viewer = actingPrincipalFromRequest(req);
    requirePerm(viewer, 'quotes', 'view', 'You cannot view quotes');
    return listQuotes(undefined, viewer);
  });

  /** Labor rates (Yoda /QuoteRate). Read with quotes:view; upsert is an admin setting. */
  app.get('/rates', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), 'quotes', 'view', 'You cannot view labor rates');
    return { items: await listLaborRates() };
  });
  app.put('/rates', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, 'admin/settings', 'edit', 'Editing labor rates requires the settings grant');
    assertRawMoney(req.rawBody);
    const input = parse(rateSchema, req.body);
    return { item: await upsertLaborRate(input) };
  });

  app.get('/work-orders/:id/quote', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, 'quotes', 'view', 'You cannot view quotes');
    const taskId = await taskIdOf(req);
    const quote = await getQuote(taskId, actor);
    if (!quote) throw notFound('No quote on this work order');
    return { quote };
  });

  /** The derived sales-tax rate for this WO (Yoda QuoteSalesTax/SalesTaxPercentage). */
  app.get('/work-orders/:id/quote/sales-tax', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), 'quotes', 'view', 'You cannot view quotes');
    const taskId = await taskIdOf(req);
    return quoteSalesTax(taskId);
  });

  app.post('/work-orders/:id/quote', async (req, reply) => {
    const taskId = await taskIdOf(req);
    const actor = actingPrincipalFromRequest(req);
    const quote = await createQuote(taskId, actor);
    return reply.status(201).send({ quote });
  });

  app.put('/work-orders/:id/quote', async (req) => {
    const taskId = await taskIdOf(req);
    assertRawMoney(req.rawBody);
    const input = parse(updateSchema, req.body);
    const actor = actingPrincipalFromRequest(req);
    return { quote: await updateQuote(taskId, input, actor) };
  });

  const lifecycle = (suffix: string, fn: (taskId: string, actor: ActingPrincipal) => Promise<unknown>) =>
    app.post(`/work-orders/:id/quote/${suffix}`, async (req) => {
      const taskId = await taskIdOf(req);
      const actor = actingPrincipalFromRequest(req);
      return { quote: await fn(taskId, actor) };
    });

  lifecycle('submit', submitQuote);
  lifecycle('approve', approveQuote);
  lifecycle('send', sendQuote);
  lifecycle('cancel-submission', cancelSubmission);
  lifecycle('new-round', startNewRound);

  app.post('/work-orders/:id/quote/reject', async (req) => {
    const taskId = await taskIdOf(req);
    const { note } = parse(rejectSchema, req.body);
    const actor = actingPrincipalFromRequest(req);
    return { quote: await rejectQuote(taskId, note, actor) };
  });

  app.post('/work-orders/:id/quote/client-approve', async (req) => {
    const taskId = await taskIdOf(req);
    const input = parse(clientApproveSchema, req.body);
    const actor = actingPrincipalFromRequest(req);
    return { quote: await clientApproveQuote(taskId, input, actor) };
  });

  app.post('/work-orders/:id/quote/client-decline', async (req) => {
    const taskId = await taskIdOf(req);
    const input = parse(clientDeclineSchema, req.body);
    const actor = actingPrincipalFromRequest(req);
    return { quote: await clientDeclineQuote(taskId, input, actor) };
  });
}
