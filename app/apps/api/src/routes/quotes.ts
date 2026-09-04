// Routes: the quote builder (S4).
//   GET    /quotes                          (list page — every quote)
// The rest are nested under a work order —
//   GET    /work-orders/:id/quote
//   POST   /work-orders/:id/quote          (create draft, senior_om+)
//   PUT    /work-orders/:id/quote          (full update,  senior_om+)
//   POST   /work-orders/:id/quote/submit   (draft → pending_approval, senior_om+)
//   POST   /work-orders/:id/quote/approve  (→ approved,               atl+)
//   POST   /work-orders/:id/quote/send     (→ sent + client comment,  atl+)
//   POST   /work-orders/:id/quote/reject   (→ draft + internal note,  atl+)
//
// Two invariants every handler here follows:
//  1. The acting principal is resolved ONCE, up front, and passed down — role
//     checks live in the service so no route can forget one, and PGlite's single
//     connection is never asked for a principal mid-transaction.
//  2. Money is validated on the RAW body before Zod sees it (validation.ts).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, actingPrincipalFromRequest } from '../services/activity.js';
import {
  getQuote,
  listQuotes,
  createQuote,
  updateQuote,
  submitQuote,
  approveQuote,
  sendQuote,
  rejectQuote,
  assertCanCreate,
} from '../services/quotes.js';
import { requirePerm } from '../services/permissions.js';
import { assertRawMoney, zMoney } from '../validation.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

const lineSchema = z.object({
  line_type: z.enum(['service', 'labor', 'part', 'material']),
  description: z.string().trim().min(1).max(500),
  qty: zMoney('Quantity', 0),
  rate: zMoney('Rate', 0),
  /** Stored VERBATIM — the Day column's semantics are TBD, no math is done on it. */
  day_value: z.string().trim().max(40).nullable().optional(),
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

const updateSchema = z
  .object({
    sales_tax: zMoney('Sales tax', 0).optional(),
    total_cost: z.union([zMoney('Total cost', 0), z.null()]).optional(),
    specs: z.string().max(8000).nullable().optional(),
    note_to_customer: z.string().max(8000).nullable().optional(),
    /** null clears the pin and hands the summary back to the auto-generator. */
    summary_pinned: z.string().max(20000).nullable().optional(),
    sections: z.array(sectionSchema).max(20).optional(),
  })
  .strict();

const rejectSchema = z.object({ note: z.string().trim().min(1).max(2000) });


/** :id (uuid or WO number) → task uuid, 404 when the work order does not exist. */
async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParamsSchema, req.params);
  const taskId = await resolveTaskId(id);
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

export default async function quoteRoutes(app: FastifyInstance): Promise<void> {
  /** GET /quotes — the sidebar list page. Needs quotes:view (0015). */
  app.get('/quotes', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), 'quotes', 'view', 'You cannot view quotes');
    return listQuotes();
  });

  app.get('/work-orders/:id/quote', async (req) => {
    const taskId = await taskIdOf(req);
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, 'quotes', 'view', 'You cannot view quotes');
    const quote = await getQuote(taskId, actor);
    if (!quote) throw notFound('No quote on this work order');
    return { quote };
  });

  app.post('/work-orders/:id/quote', async (req, reply) => {
    const taskId = await taskIdOf(req);
    const actor = actingPrincipalFromRequest(req);
    // Creating is its own grant: an OM may be allowed to revise a draft
    // somebody else opened without being allowed to open one.
    assertCanCreate(actor);
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

  app.post('/work-orders/:id/quote/submit', async (req) => {
    const taskId = await taskIdOf(req);
    const actor = actingPrincipalFromRequest(req);
    return { quote: await submitQuote(taskId, actor) };
  });

  app.post('/work-orders/:id/quote/approve', async (req) => {
    const taskId = await taskIdOf(req);
    const actor = actingPrincipalFromRequest(req);
    return { quote: await approveQuote(taskId, actor) };
  });

  app.post('/work-orders/:id/quote/send', async (req) => {
    const taskId = await taskIdOf(req);
    const actor = actingPrincipalFromRequest(req);
    return { quote: await sendQuote(taskId, actor) };
  });

  app.post('/work-orders/:id/quote/reject', async (req) => {
    const taskId = await taskIdOf(req);
    const { note } = parse(rejectSchema, req.body);
    const actor = actingPrincipalFromRequest(req);
    return { quote: await rejectQuote(taskId, note, actor) };
  });
}
