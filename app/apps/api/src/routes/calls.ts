// Routes: calls placed from a work order through Quo, and the AI quote drafted
// from a call (migration 0054). All nested under a work order; :id is its uuid
// or WO number and resolves through the work-order scope like every other
// per-work-order route.
//
//   GET    /work-orders/:id/calls                              the call log
//   POST   /work-orders/:id/calls                              record + get the tel: link
//   POST   /work-orders/:id/calls/:callId/transcript           paste a transcript by hand
//   GET    /work-orders/:id/calls/:callId/quote-draft          call + draft + quote state
//   POST   /work-orders/:id/calls/:callId/quote-draft          (re)draft with Claude
//   PUT    /work-orders/:id/calls/:callId/quote-draft          save the reviewer's edits
//   POST   /work-orders/:id/calls/:callId/quote-draft/submit   → the work order's quote
//   POST   /work-orders/:id/calls/:callId/quote-draft/discard
//
// The Quo webhook that fills a call in is in routes/webhooks.ts.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CALL_PERM_KEY, parsePastedTranscript } from '@theone/shared';
import { notFound, parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import { requirePerm } from '../services/permissions.js';
import { getCall, listCalls, pasteTranscript, placeCall } from '../services/woCalls.js';
import { discardDraft, generateDraft, getDraftForCall, saveDraft, submitDraft } from '../services/aiQuote.js';
import { assertRawMoney } from '../validation.js';
import { sectionSchema } from './quotes.js';

const idParams = z.object({ id: z.string().min(1) });
const callParams = z.object({ id: z.string().min(1), callId: z.string().min(1) });

const placeSchema = z
  .object({
    phone: z.string().trim().min(1).max(40),
    contact_name: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
    contact_role: z.enum(['tech', 'vendor', 'client', 'other']).default('other'),
    purpose: z.enum(['call', 'quote']).default('call'),
  })
  .strict();

const transcriptSchema = z.object({ text: z.string().max(200_000) }).strict();

/** The builder's section tree plus the two free-text fields the AI fills. */
const draftBodySchema = z
  .object({
    sections: z.array(sectionSchema).min(1).max(20),
    specs: z.string().max(8000).nullable(),
    note_to_customer: z.string().max(8000).nullable(),
  })
  .strict();

const submitSchema = z.object({ draft: draftBodySchema, replace: z.boolean().default(false) }).strict();
const saveSchema = z.object({ draft: draftBodySchema }).strict();

async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParams, req.params);
  const taskId = await resolveTaskId(id, actingPrincipalFromRequest(req));
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

/** The parsed body always carries every line field; fill the optional ones so
    it matches the shared QuoteDraftBody exactly. */
function normalizeBody(b: z.infer<typeof draftBodySchema>) {
  return {
    specs: b.specs,
    note_to_customer: b.note_to_customer,
    sections: b.sections.map((s) => ({
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
        day_value: l.day_value ?? null,
        ot: l.ot ?? false,
        uom: l.uom ?? null,
        tax_pct: l.tax_pct ?? 0,
        markup_pct: l.markup_pct ?? 0,
      })),
    })),
  };
}

export default async function callRoutes(app: FastifyInstance): Promise<void> {
  app.get('/work-orders/:id/calls', async (req) => {
    const taskId = await taskIdOf(req);
    requirePerm(actingPrincipalFromRequest(req), CALL_PERM_KEY, 'view', 'You cannot view calls on this work order');
    return { calls: await listCalls(taskId) };
  });

  app.post('/work-orders/:id/calls', async (req, reply) => {
    const taskId = await taskIdOf(req);
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, CALL_PERM_KEY, 'create', 'You cannot place calls from a work order');
    const input = parse(placeSchema, req.body);
    const result = await placeCall(taskId, input, actor);
    return reply.status(201).send(result);
  });

  app.post('/work-orders/:id/calls/:callId/transcript', async (req) => {
    const taskId = await taskIdOf(req);
    const { callId } = parse(callParams, req.params);
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, CALL_PERM_KEY, 'create', 'You cannot add a transcript to this call');
    const { text } = parse(transcriptSchema, req.body);
    return { call: await pasteTranscript(taskId, callId, parsePastedTranscript(text), actor) };
  });

  app.get('/work-orders/:id/calls/:callId/quote-draft', async (req) => {
    const taskId = await taskIdOf(req);
    const { callId } = parse(callParams, req.params);
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, CALL_PERM_KEY, 'view', 'You cannot view calls on this work order');
    requirePerm(actor, 'quotes', 'view', 'You cannot view quotes');
    return getDraftForCall(taskId, callId);
  });

  app.post('/work-orders/:id/calls/:callId/quote-draft', async (req) => {
    const taskId = await taskIdOf(req);
    const { callId } = parse(callParams, req.params);
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, CALL_PERM_KEY, 'view', 'You cannot view calls on this work order');
    return generateDraft(taskId, callId, actor);
  });

  app.put('/work-orders/:id/calls/:callId/quote-draft', async (req) => {
    const taskId = await taskIdOf(req);
    const { callId } = parse(callParams, req.params);
    assertRawMoney(req.rawBody);
    const { draft } = parse(saveSchema, req.body);
    await saveDraft(taskId, callId, normalizeBody(draft), actingPrincipalFromRequest(req));
    return { ok: true };
  });

  app.post('/work-orders/:id/calls/:callId/quote-draft/submit', async (req) => {
    const taskId = await taskIdOf(req);
    const { callId } = parse(callParams, req.params);
    assertRawMoney(req.rawBody);
    const { draft, replace } = parse(submitSchema, req.body);
    const quote = await submitDraft(taskId, callId, normalizeBody(draft), replace, actingPrincipalFromRequest(req));
    return { quote };
  });

  app.post('/work-orders/:id/calls/:callId/quote-draft/discard', async (req) => {
    const taskId = await taskIdOf(req);
    const { callId } = parse(callParams, req.params);
    await discardDraft(taskId, callId, actingPrincipalFromRequest(req));
    return { call: await getCall(taskId, callId) };
  });
}
