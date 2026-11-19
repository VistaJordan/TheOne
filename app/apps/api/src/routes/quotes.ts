// Routes: the quote builder (S4 → Yoda parity, on the 0015 permission tree).
//   GET    /quotes                          (list page — quotes:view, 0026 scoped)
//   GET    /rates   PUT /rates              (Yoda labor rates — read quotes:view, write admin/settings:edit)
//   GET|POST /quote-templates · PATCH|DELETE /quote-templates/:templateId
//                                           (0145 · quotes:edit; sharing = quotes:approve)
// The rest are nested under a work order —
//   GET    /work-orders/:id/quote                 (quotes:view)
//   GET    /work-orders/:id/quote/sales-tax       (quotes:view)
//   POST   /work-orders/:id/quote                 (create draft,  quotes:create)
//   PUT    /work-orders/:id/quote                 (full update,   quotes:edit)
//   POST   /work-orders/:id/quote/submit          (draft → pending_correction for a dispatcher, else → pending_approval; quotes:edit — 0092)
//   POST   /work-orders/:id/quote/approve|send|reject|cancel-submission   (quotes:approve)
//   POST   /work-orders/:id/quote/client-approve|client-decline  (quotes:approve, or a dispatcher in Approval)
//   POST   /work-orders/:id/quote/restore-options  (quotes:edit; what a BFI decline removed)
//   POST   /work-orders/:id/quote/new-round       (quotes:edit)
//
// Two invariants every handler here follows:
//  1. The acting principal is resolved ONCE, up front, and passed down — the
//     permission checks live in the service so no route can forget one, and
//     the lookup, a read that needs no lock, runs on the pool before any
//     transaction opens.
//  2. Money is validated on the RAW body before Zod sees it (validation.ts).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, actingPrincipalFromRequest, type ActingPrincipal } from '../services/activity.js';
import {
  getQuote,
  getQuoteHistory,
  listQuotes,
  createQuote,
  updateQuote,
  submitQuote,
  approveQuote,
  sendQuote,
  rejectQuote,
  cancelSubmission,
  retractQuote,
  clientApproveQuote,
  clientDeclineQuote,
  restoreBfiOptions,
  startNewRound,
  quoteSalesTax,
} from '../services/quotes.js';
import { listLaborRates, upsertLaborRate } from '../services/rates.js';
import {
  deleteQuoteTemplate,
  listQuoteTemplates,
  saveQuoteTemplate,
  updateQuoteTemplate,
} from '../services/quoteTemplates.js';
import { requirePerm } from '../services/permissions.js';
import { withAssignedOnly } from '../services/afterHours.js';
import { assertRawMoney, zMoney } from '../validation.js';
import { PERCENT_MAX, QUOTE_TEMPLATE_DESCRIPTION_MAX, QUOTE_TEMPLATE_NAME_MAX, type QuoteDraftBody } from '@theone/shared';

const idParamsSchema = z.object({ id: z.string().min(1) });

const lineSchema = z.object({
  line_type: z.enum(['service', 'labor', 'part', 'material', 'fee', 'discount', 'trip']),
  description: z.string().trim().min(1).max(500),
  qty: zMoney('Quantity', 0),
  rate: zMoney('Rate', 0),
  /** Legacy verbatim Day text — kept for older clients; `day` is the real column. */
  day_value: z.string().trim().max(40).nullable().optional(),
  day: z.number().int().min(1).max(60).nullable().optional(),
  ot: z.boolean().optional(),
  /** 0048 · unit of measure, and the line's own tax and markup percentages. */
  uom: z.string().trim().max(20).nullable().optional(),
  tax_pct: z.number().min(0).max(100).optional(),
  markup_pct: z.number().min(0).max(PERCENT_MAX).optional(),
});

/** Exported for the AI quote draft (routes/calls.ts), which saves the same shape. */
export const sectionSchema = z.object({
  kind: z.enum(['incurred', 'option']),
  name: z.string().trim().max(200).nullable().optional(),
  narrative_reported: z.string().max(8000).nullable().optional(),
  // Blank lines are allowed and stored (2026-10-22): the five-line default
  // opens with three blanks and a reload must show the list as it was left.
  // Everything that prints the list skips them (visibleScopeLines).
  scope_lines: z.array(z.string().trim().max(1000)).max(50).optional(),
  // 0146 · each section's own specs (internal) and note to the customer.
  specs: z.string().max(8000).nullable().optional(),
  note_to_customer: z.string().max(8000).nullable().optional(),
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

    specs: z.string().max(8000).nullable().optional(),
    note_to_customer: z.string().max(8000).nullable().optional(),
    /** null clears the pin and hands the summary back to the auto-generator. */
    summary_pinned: z.string().max(20000).nullable().optional(),
    sections: z.array(sectionSchema).max(20).optional(),
    /** 0048 · the document fields. */
    document_type: z.enum(['quote', 'proposal', 'estimate']).optional(),
    currency: z.string().trim().min(3).max(3).optional(),
    bill_to: z.string().trim().max(1000).nullable().optional(),
    ship_to: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

const rejectSchema = z.object({ note: z.string().trim().min(1).max(2000) });
const clientApproveSchema = z.object({
  section_id: z.string().uuid(),
  note: z.string().trim().max(2000).nullable().optional(),
  on_site: z.boolean().optional(),
  // M6 (0085): a note or a file on the work order is required (checked in the service).
  attachment_id: z.string().uuid().nullable().optional(),
});
const clientDeclineSchema = z.object({
  note: z.string().trim().min(1).max(2000),
  section_id: z.string().uuid().nullable().optional(),
  kind: z.enum(['challenged', 'bfi']).optional(),
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

/** 0145 · a quote template: the builder's save shape (the AI draft's body),
    checked with the same section schema PUT /quote uses. */
const templateContentSchema = z
  .object({
    sections: z.array(sectionSchema).min(1).max(20),
    specs: z.string().max(8000).nullable(),
    note_to_customer: z.string().max(8000).nullable(),
  })
  .strict();
const templateCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(QUOTE_TEMPLATE_NAME_MAX),
    description: z.string().trim().max(QUOTE_TEMPLATE_DESCRIPTION_MAX).nullable().optional(),
    trade: z.string().trim().max(80).nullable().optional(),
    shared: z.boolean().optional(),
    content: templateContentSchema,
  })
  .strict();
const templatePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(QUOTE_TEMPLATE_NAME_MAX).optional(),
    description: z.string().trim().max(QUOTE_TEMPLATE_DESCRIPTION_MAX).nullable().optional(),
    trade: z.string().trim().max(80).nullable().optional(),
    shared: z.boolean().optional(),
  })
  .strict();
const templateIdSchema = z.object({ templateId: z.string().min(1).max(64) });

/** The parsed content → the stored QuoteDraftBody, every field present (the
    AI draft's shape: the Day as text, "Day N"). */
function templateContent(c: z.infer<typeof templateContentSchema>): QuoteDraftBody {
  return {
    sections: c.sections.map((s) => ({
      kind: s.kind,
      name: s.name ?? null,
      narrative_reported: s.narrative_reported ?? null,
      scope_lines: s.scope_lines ?? [],
      include_in_summary: s.include_in_summary ?? true,
      lines: (s.lines ?? []).map((l) => ({
        line_type: l.line_type,
        description: l.description,
        qty: l.qty,
        rate: l.rate,
        day_value: l.day != null ? `Day ${l.day}` : (l.day_value ?? null),
        ot: l.ot ?? false,
        uom: l.uom ?? null,
        tax_pct: l.tax_pct ?? 0,
        markup_pct: l.markup_pct ?? 0,
      })),
    })),
    specs: c.specs,
    note_to_customer: c.note_to_customer,
  };
}

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
    return listQuotes(undefined, withAssignedOnly(viewer, req.query));
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
    return { item: await upsertLaborRate(input, actor.id) };
  });

  // 0145 · quote templates: the viewer's own and the shared ones (quotes:edit);
  // sharing with everyone is a quote approver's (checked in the service).
  app.get('/quote-templates', async (req) => listQuoteTemplates(actingPrincipalFromRequest(req)));
  app.post('/quote-templates', async (req, reply) => {
    assertRawMoney(req.rawBody);
    const input = parse(templateCreateSchema, req.body);
    const saved = await saveQuoteTemplate({ ...input, content: templateContent(input.content) }, actingPrincipalFromRequest(req));
    return reply.status(201).send(saved);
  });
  app.patch('/quote-templates/:templateId', async (req) => {
    const { templateId } = parse(templateIdSchema, req.params);
    return updateQuoteTemplate(templateId, parse(templatePatchSchema, req.body), actingPrincipalFromRequest(req));
  });
  app.delete('/quote-templates/:templateId', async (req) => {
    const { templateId } = parse(templateIdSchema, req.params);
    return deleteQuoteTemplate(templateId, actingPrincipalFromRequest(req));
  });

  app.get('/work-orders/:id/quote', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, 'quotes', 'view', 'You cannot view quotes');
    const taskId = await taskIdOf(req);
    const quote = await getQuote(taskId, actor);
    if (!quote) throw notFound('No quote on this work order');
    return { quote };
  });

  /** Quote history (2026-11-19): every saved version, newest first. */
  app.get('/work-orders/:id/quote/history', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, 'quotes', 'view', 'You cannot view quotes');
    const taskId = await taskIdOf(req);
    return { items: await getQuoteHistory(taskId, actor) };
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
  // 2026-11-10 · the submitter takes a quote back to draft before it is approved.
  lifecycle('retract', retractQuote);
  lifecycle('new-round', startNewRound);

  /** 2026-11-19 · a dispatcher asks a manager for another rate on price-list lines. */
  app.post('/work-orders/:id/quote/rate-change', async (req, reply) => {
    const taskId = await taskIdOf(req);
    const actor = actingPrincipalFromRequest(req);
    const body = parse(
      z.object({
        lines: z.array(z.object({ line_id: z.string().min(1), requested_rate: z.number() })).min(1).max(50),
        reason: z.string().max(2000),
      }),
      req.body,
    );
    const { requestRateChange } = await import('../services/quoteRateChange.js');
    const out = await requestRateChange(taskId, body, actor);
    return reply.status(out.created ? 201 : 200).send(out);
  });

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

  // 0109: bring back the options a bill-for-incurred decline took off.
  app.post('/work-orders/:id/quote/restore-options', async (req) => {
    const taskId = await taskIdOf(req);
    const actor = actingPrincipalFromRequest(req);
    return { quote: await restoreBfiOptions(taskId, actor) };
  });
}
