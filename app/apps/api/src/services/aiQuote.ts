// 0054 · The AI quote draft: Claude reads a call's transcript and the work
// order, and writes a quote in the builder's own shape.
//
// The draft never touches the real quote until a person presses Submit quote
// on the review page. Submitting runs the ordinary createQuote / updateQuote
// path (services/quotes.ts), so the quote, its number, its permissions and its
// quote_updated audit row are exactly what typing it in by hand produces. The
// draft row is the AI's output and the reviewer's edits in between.
//
// Prices are never invented: the model uses what the call said, the client
// contract's rates for the work order (contractForTask), or leaves the rate at
// 0 and says so in missing_info — the review page puts that list at the top.
//
// Later: similar past quotes from the quote library (vector search) will be
// added to the user message as pricing references. The prompt already tells
// the model how to use them, so only buildUserMessage changes.

import Anthropic from '@anthropic-ai/sdk';
import { quoteDraftHasContent } from '@theone/shared';
import type {
  AiQuoteDraft,
  AiQuoteDraftResponse,
  AiQuoteDraftStatus,
  QuoteDraftBody,
} from '@theone/shared';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import type { Queryable } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { contractForTask } from './contracts.js';
import { integrationOn, requireIntegration } from './integrations.js';
import {
  assertCanCreate,
  assertCanEdit,
  createQuote,
  updateQuote,
} from './quotes.js';
import type { Quote } from '@theone/shared';
import { getCall } from './woCalls.js';
import { DRAFT_SCHEMA, SYSTEM_PROMPT, buildUserMessage, modelOutput, toDraftBody } from '../lib/aiQuotePrompt.js';
import type { ModelOutput, TaskContextRow } from '../lib/aiQuotePrompt.js';

// ── Read ─────────────────────────────────────────────────────────────────────

type DraftRow = {
  id: string;
  call_id: string;
  task_id: string;
  status: AiQuoteDraftStatus;
  draft: QuoteDraftBody;
  assumptions: string[];
  missing_info: string[];
  model: string | null;
  created_by_id: string;
  created_by_name: string | null;
  created_by_kind: 'human' | 'service';
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
};

async function loadDraft(callId: string): Promise<AiQuoteDraft | null> {
  const res = await query<DraftRow>(
    `SELECT d.id::text AS id, d.call_id::text AS call_id, d.task_id::text AS task_id, d.status,
            d.draft, d.assumptions, d.missing_info, d.model,
            p.id::text AS created_by_id, p.display_name AS created_by_name, p.kind AS created_by_kind,
            d.created_at, d.updated_at, d.submitted_at
       FROM quote_ai_draft d JOIN principal p ON p.id = d.created_by
      WHERE d.call_id = $1`,
    [callId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    call_id: r.call_id,
    task_id: r.task_id,
    status: r.status,
    draft: r.draft,
    assumptions: r.assumptions ?? [],
    missing_info: r.missing_info ?? [],
    model: r.model,
    created_by: { id: r.created_by_id, name: r.created_by_name ?? 'Unknown', kind: r.created_by_kind },
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
    submitted_at: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
  };
}

async function quoteState(taskId: string): Promise<AiQuoteDraftResponse['quote']> {
  const res = await query<{ status: Quote['status']; has_content: boolean }>(
    `SELECT q.status,
            EXISTS (SELECT 1 FROM quote_section s
                      LEFT JOIN quote_line l ON l.section_id = s.id
                     WHERE s.quote_id = q.id
                       AND (l.id IS NOT NULL OR EXISTS (
                             SELECT 1 FROM jsonb_array_elements_text(s.scope_lines) x
                              WHERE btrim(x) <> ''))) AS has_content
       FROM quote q WHERE q.task_id = $1`,
    [taskId],
  );
  return res.rows[0] ?? null;
}

export async function getDraftForCall(taskId: string, callId: string): Promise<AiQuoteDraftResponse> {
  const call = await getCall(taskId, callId);
  return {
    call,
    draft: await loadDraft(callId),
    quote: await quoteState(taskId),
    ai_configured: config.anthropicApiKey !== null && integrationOn('claude'),
  };
}

// ── Generate ─────────────────────────────────────────────────────────────────

async function taskContext(taskId: string): Promise<TaskContextRow> {
  const res = await query<TaskContextRow>(
    `SELECT wo_number, title, description, client, trade, billing_entity, nte::text AS nte,
            city, state, priority,
            fields->>'Store' AS store, fields->>'17. Address' AS address,
            fields->>'22. FM' AS fm, fields->>'35. WO Description' AS wo_description
       FROM task WHERE id = $1`,
    [taskId],
  );
  if (!res.rows[0]) throw notFound('Work order not found');
  return res.rows[0];
}

async function askClaude(userMessage: string): Promise<{ out: ModelOutput; model: string; usage: unknown }> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey!, timeout: 240_000, maxRetries: 1 });
  let res;
  try {
    res = await client.beta.messages.create({
      model: config.quoteAiModel,
      max_tokens: 16000,
      // A safety decline on the primary model re-runs on the server's default
      // fallback in the same call rather than failing the draft.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
      output_config: { format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new ApiError('INTERNAL', 'The Claude API refused the key in ANTHROPIC_API_KEY');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new ApiError('CONFLICT', 'The AI is busy right now — try again in a minute');
    }
    if (err instanceof Anthropic.APIError) {
      throw new ApiError('INTERNAL', `The AI could not draft the quote (${err.status ?? 'no status'}): ${err.message}`);
    }
    throw new ApiError('INTERNAL', `The AI could not be reached: ${(err as Error).message}`);
  }

  if (res.stop_reason === 'refusal') {
    throw new ApiError('INTERNAL', 'The AI declined to draft a quote from this call');
  }
  if (res.stop_reason === 'max_tokens') {
    throw new ApiError('INTERNAL', 'The AI ran out of room before finishing the draft');
  }
  const textBlock = res.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new ApiError('INTERNAL', 'The AI returned no draft');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new ApiError('INTERNAL', 'The AI returned a draft that is not valid JSON');
  }
  const checked = modelOutput.safeParse(parsed);
  if (!checked.success) {
    throw new ApiError('INTERNAL', 'The AI returned a draft in the wrong shape', checked.error.flatten());
  }
  return { out: checked.data, model: res.model, usage: res.usage };
}

/** Draft (or redraft) the quote for a call. Takes as long as the model does —
    typically 20–60 s — so the route runs it inside the request. */
export async function generateDraft(taskId: string, callId: string, actor: ActingPrincipal): Promise<AiQuoteDraftResponse> {
  assertCanEdit(actor);
  requireIntegration('claude'); // 0074 · Admin › Integrations
  if (!config.anthropicApiKey) {
    throw conflict('AI quote drafting is not configured (ANTHROPIC_API_KEY is unset)');
  }
  const call = await getCall(taskId, callId);
  if (!call.transcript || call.transcript.length === 0) {
    throw conflict('This call has no transcript yet — wait for Quo, or paste it');
  }
  const existing = await loadDraft(callId);
  if (existing?.status === 'submitted') {
    throw conflict('This draft was already submitted to the quote — edit the quote itself');
  }

  const [ctx, rates] = await Promise.all([taskContext(taskId), contractForTask(taskId)]);
  const { out, model, usage } = await askClaude(buildUserMessage(ctx, rates, call));
  const body = toDraftBody(out);
  const assumptions = out.assumptions.map((s) => s.trim()).filter(Boolean).slice(0, 30);
  const missing = out.missing_info.map((s) => s.trim()).filter(Boolean).slice(0, 30);

  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO quote_ai_draft (task_id, call_id, status, draft, assumptions, missing_info, model, usage, created_by)
       VALUES ($1, $2, 'ready', $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8)
       ON CONFLICT (call_id) DO UPDATE
          SET status = 'ready', draft = EXCLUDED.draft, assumptions = EXCLUDED.assumptions,
              missing_info = EXCLUDED.missing_info, model = EXCLUDED.model, usage = EXCLUDED.usage,
              created_by = EXCLUDED.created_by, created_at = now()`,
      [taskId, callId, JSON.stringify(body), JSON.stringify(assumptions), JSON.stringify(missing), model, JSON.stringify(usage), actor.id],
    );
    await logDraft(tx, actor.id, taskId, existing ? 'quote_ai_redrafted' : 'quote_ai_drafted', {
      call_id: callId,
      model,
      options: body.sections.length - 1,
      lines: body.sections.reduce((n, s) => n + s.lines.length, 0),
      missing_info: missing.length,
    });
  });
  return getDraftForCall(taskId, callId);
}

// ── Edit, submit, discard ────────────────────────────────────────────────────

async function readyDraft(taskId: string, callId: string): Promise<AiQuoteDraft> {
  await getCall(taskId, callId); // 404 for a call on another work order
  const draft = await loadDraft(callId);
  if (!draft) throw notFound('No AI draft for this call yet');
  if (draft.status !== 'ready') {
    throw conflict(`This draft was already ${draft.status}`, { status: draft.status });
  }
  return draft;
}

/** The reviewer's edits, saved as they type. Not logged: nothing real changes
    until Submit quote, and that row carries the whole submitted quote. */
export async function saveDraft(taskId: string, callId: string, body: QuoteDraftBody, actor: ActingPrincipal): Promise<void> {
  assertCanEdit(actor);
  await readyDraft(taskId, callId);
  await query(`UPDATE quote_ai_draft SET draft = $2::jsonb WHERE call_id = $1`, [callId, JSON.stringify(body)]);
}

/**
 * Submit quote: the reviewed draft becomes the work order's quote through the
 * ordinary builder save. Creates the quote when there is none. A quote that
 * already has content is only overwritten when the reviewer confirmed it
 * (`replace`); an approved or sent quote is never touched.
 */
export async function submitDraft(
  taskId: string,
  callId: string,
  body: QuoteDraftBody,
  replace: boolean,
  actor: ActingPrincipal,
): Promise<Quote> {
  assertCanEdit(actor);
  await readyDraft(taskId, callId);
  if (!quoteDraftHasContent(body)) {
    throw badRequest('The draft has no line items or scope lines to put on a quote');
  }

  const state = await quoteState(taskId);
  if (state && state.status !== 'draft' && state.status !== 'pending_approval') {
    throw conflict(
      `The quote on this work order is ${state.status === 'approved' ? 'approved' : 'sent'} — reject it back to draft before replacing it`,
      { code: 'QUOTE_LOCKED', status: state.status },
    );
  }
  if (state?.has_content && !replace) {
    throw conflict('This work order already has a quote with content — confirm to replace it', {
      code: 'QUOTE_HAS_CONTENT',
    });
  }
  if (!state) {
    assertCanCreate(actor);
    await createQuote(taskId, actor);
  }
  const quote = await updateQuote(
    taskId,
    { sections: body.sections, specs: body.specs, note_to_customer: body.note_to_customer },
    actor,
  );

  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE quote_ai_draft SET status = 'submitted', draft = $2::jsonb, submitted_by = $3, submitted_at = now()
        WHERE call_id = $1`,
      [callId, JSON.stringify(body), actor.id],
    );
    await logDraft(tx, actor.id, taskId, 'quote_ai_submitted', {
      call_id: callId,
      quote_id: quote.id,
      quote_number: quote.number,
      replaced: Boolean(state?.has_content),
    });
  });
  return quote;
}

export async function discardDraft(taskId: string, callId: string, actor: ActingPrincipal): Promise<void> {
  assertCanEdit(actor);
  await readyDraft(taskId, callId);
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE quote_ai_draft SET status = 'discarded' WHERE call_id = $1`, [callId]);
    await logDraft(tx, actor.id, taskId, 'quote_ai_discarded', { call_id: callId });
  });
}

async function logDraft(
  tx: Queryable,
  actorId: string,
  taskId: string,
  action: 'quote_ai_drafted' | 'quote_ai_redrafted' | 'quote_ai_submitted' | 'quote_ai_discarded',
  after: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, $3, NULL, NULL, $4::jsonb)`,
    [actorId, taskId, action, JSON.stringify(after)],
  );
}

