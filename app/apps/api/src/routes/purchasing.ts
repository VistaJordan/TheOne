// 0067 · Financials, the rest.
//
//   GET    /purchasing/meta
//   GET    /tax-rates                              the active rates, to pick from
//   GET    /print-templates/:kind                  the default template of a document
//
//   GET    /purchasing/requests ?status&search     · POST · PATCH /:id
//   POST   /purchasing/requests/:id/act            { action, note }
//   GET    /purchasing/rfqs ?status&search         · POST · PATCH /:id
//   POST   /purchasing/rfqs/:id/act                { action }
//   POST   /purchasing/rfqs/:id/quotes             record / replace a vendor's quote
//   DELETE /purchasing/rfqs/:id/quotes/:quoteId
//   POST   /purchasing/rfqs/:id/award              { quote_id } → a draft purchase order
//   GET    /purchasing/orders ?status&search       · POST · GET /:id · PATCH /:id
//   POST   /purchasing/orders/:id/act              { action }
//   POST   /purchasing/orders/:id/receive          { lines: [{ line_id, received_qty }] }
//
//   GET    /purchasing/budgets ?year
//   POST   /purchasing/cost-centers · PATCH /:id
//   PUT    /purchasing/cost-centers/:id/budget     { year, amount }
//   POST   /purchasing/afes · PATCH /:id
//
//   GET    /work-orders/:id/purchasing
//   PUT    /work-orders/:id/filing                 { cost_center_id, afe_id }
//
//   GET    /admin/finance-setup
//   POST   /admin/finance-setup/tax-rates · PATCH /:id
//   POST   /admin/finance-setup/templates · PATCH /:id · DELETE /:id

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DOC_TEMPLATE_KINDS } from '@theone/shared';
import { notFound, parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import {
  actOnOrder,
  actOnRequest,
  actOnRfq,
  awardQuote,
  budgetsView,
  deleteDocTemplate,
  deleteVendorQuote,
  financeSetup,
  getOrder,
  listOrders,
  listRequests,
  listRfqs,
  listTaxRates,
  printTemplate,
  purchasingMeta,
  searchVendors,
  receiveOrder,
  saveAfe,
  saveBudget,
  saveCostCenter,
  saveDocTemplate,
  saveOrder,
  saveRequest,
  saveRfq,
  saveTaxRate,
  saveVendorQuote,
  setWoFiling,
  woPurchasing,
} from '../services/purchasing.js';

const text = (max: number) => z.string().max(max).nullable().optional();
const day = z.string().max(10).nullable().optional();
const id = z.string().uuid().nullable().optional();
const money = z.number().min(0).max(100_000_000);
const line = z.object({ description: z.string().max(300), qty: z.number().positive().max(1_000_000).optional(), unit: z.string().max(40).optional(), unit_cost: money.nullable().optional() }).strict();
const lines = z.array(line).max(200).optional();
const listQuery = z.object({ status: z.string().max(30).optional(), search: z.string().max(120).optional() });

export default async function purchasingRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (req: FastifyRequest) => actingPrincipalFromRequest(req);
  const p = (req: FastifyRequest, key = 'id'): string => (parse(z.object({ [key]: z.string().min(1).max(64) }), req.params) as Record<string, string>)[key];

  app.get('/purchasing/meta', async (req) => purchasingMeta(actorOf(req)));
  app.get('/purchasing/vendor-search', async (req) => searchVendors(actorOf(req), parse(z.object({ q: z.string().max(120).default('') }), req.query).q));
  app.get('/tax-rates', async (req) => listTaxRates(actorOf(req)));
  app.get('/print-templates/:kind', async (req) => {
    actorOf(req);
    return printTemplate(parse(z.object({ kind: z.enum(DOC_TEMPLATE_KINDS) }), req.params).kind);
  });

  // ── Requests ───────────────────────────────────────────────────────────────
  const prBody = z.object({ task_ref: text(64), title: z.string().max(200).optional(), reason: text(2000), needed_by: day, vendor_id: id, vendor_name: text(200), cost_center_id: id, lines }).strict();
  app.get('/purchasing/requests', async (req) => listRequests(actorOf(req), parse(listQuery, req.query)));
  app.post('/purchasing/requests', async (req) => ({ request: await saveRequest(null, parse(prBody, req.body), actorOf(req)) }));
  app.patch('/purchasing/requests/:id', async (req) => ({ request: await saveRequest(p(req), parse(prBody, req.body), actorOf(req)) }));
  app.post('/purchasing/requests/:id/act', async (req) => {
    const body = parse(z.object({ action: z.enum(['submit', 'approve', 'reject', 'cancel', 'reopen']), note: text(500) }).strict(), req.body);
    return { request: await actOnRequest(p(req), body.action, body.note ?? null, actorOf(req)) };
  });

  // ── Requests for quotation ─────────────────────────────────────────────────
  const rfqBody = z.object({ task_ref: text(64), request_id: id, title: z.string().max(200).optional(), description: text(2000), due_on: day, lines, vendor_ids: z.array(z.string().uuid()).max(30).optional() }).strict();
  app.get('/purchasing/rfqs', async (req) => listRfqs(actorOf(req), parse(listQuery, req.query)));
  app.post('/purchasing/rfqs', async (req) => ({ rfq: await saveRfq(null, parse(rfqBody, req.body), actorOf(req)) }));
  app.patch('/purchasing/rfqs/:id', async (req) => ({ rfq: await saveRfq(p(req), parse(rfqBody, req.body), actorOf(req)) }));
  app.post('/purchasing/rfqs/:id/act', async (req) => {
    const body = parse(z.object({ action: z.enum(['send', 'close', 'reopen', 'cancel']) }).strict(), req.body);
    return { rfq: await actOnRfq(p(req), body.action, actorOf(req)) };
  });
  app.post('/purchasing/rfqs/:id/quotes', async (req) => {
    const body = parse(
      z.object({ vendor_id: z.string().uuid(), quote_ref: text(80), prices: z.record(money).optional(), total: money.nullable().optional(), lead_days: z.number().int().min(0).max(3650).nullable().optional(), valid_until: day, note: text(1000) }).strict(),
      req.body,
    );
    return { rfq: await saveVendorQuote(p(req), body, actorOf(req)) };
  });
  app.delete('/purchasing/rfqs/:id/quotes/:quoteId', async (req) => ({ rfq: await deleteVendorQuote(p(req), p(req, 'quoteId'), actorOf(req)) }));
  app.post('/purchasing/rfqs/:id/award', async (req) => {
    const body = parse(z.object({ quote_id: z.string().uuid() }).strict(), req.body);
    return awardQuote(p(req), body.quote_id, actorOf(req));
  });

  // ── Orders ─────────────────────────────────────────────────────────────────
  const poBody = z
    .object({ task_ref: text(64), vendor_id: id, vendor_name: text(200), request_id: id, rfq_id: id, cost_center_id: id, afe_id: id, order_date: day, expected_on: day, ship_to: text(500), note: text(2000), tax_rate_id: id, lines })
    .strict();
  app.get('/purchasing/orders', async (req) => listOrders(actorOf(req), parse(listQuery, req.query)));
  app.post('/purchasing/orders', async (req) => ({ order: await saveOrder(null, parse(poBody, req.body), actorOf(req)) }));
  app.get('/purchasing/orders/:id', async (req) => ({ order: await getOrder(p(req), actorOf(req)) }));
  app.patch('/purchasing/orders/:id', async (req) => ({ order: await saveOrder(p(req), parse(poBody, req.body), actorOf(req)) }));
  app.post('/purchasing/orders/:id/act', async (req) => {
    const body = parse(z.object({ action: z.enum(['issue', 'close', 'cancel', 'reopen']) }).strict(), req.body);
    return { order: await actOnOrder(p(req), body.action, actorOf(req)) };
  });
  app.post('/purchasing/orders/:id/receive', async (req) => {
    const body = parse(z.object({ lines: z.array(z.object({ line_id: z.string().uuid(), received_qty: z.number().min(0).max(1_000_000) })).min(1).max(200) }).strict(), req.body);
    return { order: await receiveOrder(p(req), body.lines, actorOf(req)) };
  });

  // ── Budgets ────────────────────────────────────────────────────────────────
  app.get('/purchasing/budgets', async (req) => budgetsView(actorOf(req), parse(z.object({ year: z.coerce.number().int().optional() }), req.query).year));
  const ccBody = z.object({ code: z.string().max(40).optional(), name: z.string().max(200).optional(), client: text(200), description: text(1000), is_active: z.boolean().optional() }).strict();
  app.post('/purchasing/cost-centers', async (req) => saveCostCenter(null, parse(ccBody, req.body), actorOf(req)));
  app.patch('/purchasing/cost-centers/:id', async (req) => saveCostCenter(p(req), parse(ccBody, req.body), actorOf(req)));
  app.put('/purchasing/cost-centers/:id/budget', async (req) => {
    const body = parse(z.object({ year: z.number().int().min(2000).max(2100), amount: money.nullable() }).strict(), req.body);
    return saveBudget(p(req), body.year, body.amount, actorOf(req));
  });
  const afeBody = z.object({ afe_number: z.string().max(40).optional(), title: z.string().max(200).optional(), cost_center_id: id, amount: money.optional(), status: z.enum(['open', 'closed']).optional(), valid_from: day, valid_to: day, note: text(1000) }).strict();
  app.post('/purchasing/afes', async (req) => saveAfe(null, parse(afeBody, req.body), actorOf(req)));
  app.patch('/purchasing/afes/:id', async (req) => saveAfe(p(req), parse(afeBody, req.body), actorOf(req)));

  // ── On a work order ────────────────────────────────────────────────────────
  const task = async (req: FastifyRequest) => {
    const actor = actorOf(req);
    const taskId = await resolveTaskId(p(req), actor);
    if (!taskId) throw notFound('Work order not found');
    return { taskId, actor };
  };
  app.get('/work-orders/:id/purchasing', async (req) => {
    const { taskId, actor } = await task(req);
    return woPurchasing(taskId, actor);
  });
  app.put('/work-orders/:id/filing', async (req) => {
    const { taskId, actor } = await task(req);
    return setWoFiling(taskId, parse(z.object({ cost_center_id: id, afe_id: id }).strict(), req.body), actor);
  });

  // ── Admin › Settings ───────────────────────────────────────────────────────
  app.get('/admin/finance-setup', async (req) => financeSetup(actorOf(req)));
  const rateBody = z.object({ name: z.string().max(120).optional(), rate: z.number().min(0).max(100).optional(), state: text(40), is_default: z.boolean().optional(), is_active: z.boolean().optional() }).strict();
  app.post('/admin/finance-setup/tax-rates', async (req) => saveTaxRate(null, parse(rateBody, req.body), actorOf(req)));
  app.patch('/admin/finance-setup/tax-rates/:id', async (req) => saveTaxRate(p(req), parse(rateBody, req.body), actorOf(req)));
  const tplBody = z
    .object({ kind: z.enum(DOC_TEMPLATE_KINDS).optional(), name: z.string().max(120).optional(), company_name: text(200), company_details: text(1000), terms: text(6000), footer: text(1000), is_default: z.boolean().optional(), is_active: z.boolean().optional() })
    .strict();
  app.post('/admin/finance-setup/templates', async (req) => saveDocTemplate(null, parse(tplBody, req.body), actorOf(req)));
  app.patch('/admin/finance-setup/templates/:id', async (req) => saveDocTemplate(p(req), parse(tplBody, req.body), actorOf(req)));
  app.delete('/admin/finance-setup/templates/:id', async (req) => deleteDocTemplate(p(req), actorOf(req)));
}
