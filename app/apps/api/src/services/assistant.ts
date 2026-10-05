// 0068 · The assistant: a question in, an answer looked up live.
//
// One question is one request. Claude is given the briefing, the reference
// (statuses, the fields this person may see, the taught notes) and three
// look-up tools; it calls them until it can answer. Each look-up is the app's
// own GET route, fetched through `app.inject` with the asker's session cookie,
// so the route's permission checks, the work-order scope (0026), the site
// restriction (0062) and the field redaction (0015) decide what comes back —
// viewing-as included. This file adds no access path of its own and writes
// nothing but the conversation.
//
// A conversation belongs to the person who signed in (not who they are viewing
// as). Earlier turns are replayed as their text only: the look-ups behind an
// old answer are not kept in the model's view, so a follow-up re-reads what it
// needs and never works from stale rows.
//
// What makes it better over time lives here too: the thumb on each answer,
// the taught notes read before every answer, and the review list of marked
// answers. All three are plain rows.

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import { ASSISTANT_PERM_KEY } from '@theone/shared';
import type {
  AssistantAskInput,
  AssistantAskResponse,
  AssistantConversation,
  AssistantConversationSummary,
  AssistantFeedbackResponse,
  AssistantLookup,
  AssistantMessage,
  AssistantMessageStatus,
  AssistantNote,
  AssistantNoteInput,
  AssistantStatus,
} from '@theone/shared';
import { config } from '../config.js';
import { query } from '../db.js';
import { conflict, notFound } from '../errors.js';
import type { SessionPrincipal } from './auth.js';
import { logAdminEvent } from './adminAudit.js';
import { allowFor, requirePerm } from './permissions.js';
import { STATIC_INSTRUCTIONS, buildQuestion, buildReference, chicagoToday, describeAbilities } from '../lib/assistantPrompt.js';
import type { RefField, RefNote, RefStatus } from '../lib/assistantPrompt.js';
import { ASSISTANT_TOOLS, LookupInputError, planLookup, shapeResult } from '../lib/assistantTools.js';
import type { FetchedPart } from '../lib/assistantTools.js';

/** Who is asking: the person signed in, who they are viewing as, and the
    cookie that makes a look-up theirs. */
export interface Asker {
  user: SessionPrincipal;
  actingAs: SessionPrincipal;
  cookie: string;
}

const MAX_STEPS = 12;
/** Under the function's 300 s limit, with room to save the answer. */
const DEADLINE_MS = 240_000;
/** Earlier messages replayed to the model. */
const HISTORY_MESSAGES = 16;

export function requireAsk(a: Asker): void {
  requirePerm(a.actingAs, ASSISTANT_PERM_KEY, 'view', 'The assistant is not available to you');
}

export function requireTeach(a: Asker): void {
  requirePerm(a.actingAs, ASSISTANT_PERM_KEY, 'edit', 'You cannot teach the assistant or review its answers');
}

// ── Status and the daily allowance ───────────────────────────────────────────

async function askedToday(userId: string): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM assistant_message m
       JOIN assistant_conversation c ON c.id = m.conversation_id
      WHERE c.principal_id = $1 AND m.role = 'user'
        AND (m.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date`,
    [userId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function assistantStatus(a: Asker): Promise<AssistantStatus> {
  requireAsk(a);
  const used = await askedToday(a.user.id);
  return {
    configured: config.anthropicApiKey !== null,
    daily_limit: config.assistant.dailyLimit,
    remaining_today: Math.max(0, config.assistant.dailyLimit - used),
    can_teach: allowFor(a.actingAs)(ASSISTANT_PERM_KEY, 'edit'),
  };
}

// ── Conversations ────────────────────────────────────────────────────────────

type MessageRow = {
  id: string;
  role: 'user' | 'assistant';
  body: string;
  status: AssistantMessageStatus;
  lookups: AssistantLookup[] | null;
  feedback: number | null;
  feedback_note: string | null;
  created_at: Date;
};

const MESSAGE_COLUMNS = `m.id::text AS id, m.role, m.body, m.status, m.lookups, m.feedback, m.feedback_note, m.created_at`;

function toMessage(r: MessageRow): AssistantMessage {
  return {
    id: r.id,
    role: r.role,
    body: r.body,
    status: r.status,
    lookups: r.lookups ?? [],
    feedback: r.feedback === 1 ? 1 : r.feedback === -1 ? -1 : null,
    feedback_note: r.feedback_note,
    created_at: new Date(r.created_at).toISOString(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listConversations(a: Asker): Promise<{ items: AssistantConversationSummary[] }> {
  requireAsk(a);
  const res = await query<{ id: string; title: string; updated_at: Date }>(
    `SELECT id::text AS id, title, updated_at FROM assistant_conversation
      WHERE principal_id = $1 ORDER BY updated_at DESC LIMIT 40`,
    [a.user.id],
  );
  return { items: res.rows.map((r) => ({ id: r.id, title: r.title, updated_at: new Date(r.updated_at).toISOString() })) };
}

async function ownConversation(a: Asker, id: string): Promise<AssistantConversationSummary> {
  if (!UUID.test(id)) throw notFound('Conversation not found');
  const res = await query<{ id: string; title: string; updated_at: Date }>(
    `SELECT id::text AS id, title, updated_at FROM assistant_conversation WHERE id = $1 AND principal_id = $2`,
    [id, a.user.id],
  );
  const r = res.rows[0];
  if (!r) throw notFound('Conversation not found');
  return { id: r.id, title: r.title, updated_at: new Date(r.updated_at).toISOString() };
}

async function messagesOf(conversationId: string): Promise<AssistantMessage[]> {
  const res = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM assistant_message m WHERE m.conversation_id = $1 ORDER BY m.created_at ASC, m.role DESC`,
    [conversationId],
  );
  return res.rows.map(toMessage);
}

export async function getConversation(a: Asker, id: string): Promise<AssistantConversation> {
  requireAsk(a);
  const c = await ownConversation(a, id);
  return { ...c, messages: await messagesOf(c.id) };
}

export async function deleteConversation(a: Asker, id: string): Promise<void> {
  requireAsk(a);
  const c = await ownConversation(a, id);
  await query(`DELETE FROM assistant_conversation WHERE id = $1`, [c.id]);
}

// ── Look-ups, as the asker ───────────────────────────────────────────────────

async function fetchAsAsker(app: FastifyInstance, cookie: string, url: string): Promise<{ status: number; body: unknown }> {
  const res = await app.inject({ method: 'GET', url: `/api${url}`, headers: { cookie } });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { status: res.statusCode, body };
}

async function runLookup(app: FastifyInstance, cookie: string, tool: string, input: unknown): Promise<{ text: string; lookup: AssistantLookup }> {
  const started = Date.now();
  try {
    const plan = planLookup(tool, input);
    const parts: FetchedPart[] = await Promise.all(
      plan.requests.map(async (r) => ({ label: r.label, ...(await fetchAsAsker(app, cookie, r.url)) })),
    );
    const shaped = shapeResult(plan, parts);
    return {
      text: shaped.text,
      lookup: { tool, summary: `${plan.describe} · ${shaped.outcome}`, ok: shaped.ok, ms: Date.now() - started },
    };
  } catch (err) {
    const message = err instanceof LookupInputError ? err.message : `The look-up failed: ${(err as Error).message}`;
    return { text: message, lookup: { tool, summary: message.slice(0, 200), ok: false, ms: Date.now() - started } };
  }
}

/** The reference block: read through the same routes, so a field this person
    may not see is not even named to the model. */
async function loadReference(app: FastifyInstance, cookie: string): Promise<string> {
  const [statuses, groups, fields, notes] = await Promise.all([
    fetchAsAsker(app, cookie, '/statuses'),
    fetchAsAsker(app, cookie, '/status-groups'),
    fetchAsAsker(app, cookie, '/wo-fields'),
    query<RefNote>(`SELECT title, body FROM assistant_note WHERE is_active ORDER BY created_at ASC`),
  ]);
  const statusRows = statuses.status === 200 && Array.isArray(statuses.body) ? (statuses.body as RefStatus[]) : [];
  const groupRows = groups.status === 200 ? ((groups.body as { items?: { code: string; label: string }[] }).items ?? []) : [];
  const cat = fields.status === 200 ? (fields.body as { fields?: RefField[]; ops_by_type?: Record<string, string[]> }) : {};
  return buildReference(statusRows, groupRows, cat.fields ?? [], cat.ops_by_type ?? {}, notes.rows);
}

// ── The model loop ───────────────────────────────────────────────────────────

type Block = Anthropic.Beta.BetaContentBlock;
type Param = Anthropic.Beta.BetaMessageParam;

/**
 * What of an assistant turn is sent back. When the request fell back to
 * another model part-way (a `fallback` block), the thinking and tool calls the
 * first model produced before that point are left out, as the API requires;
 * everything after it is echoed as it came.
 */
function echoable(content: Block[]): Block[] {
  let boundary = -1;
  content.forEach((b, i) => {
    if ((b.type as string) === 'fallback') boundary = i;
  });
  if (boundary < 0) return content;
  return content.filter(
    (b, i) => i >= boundary || (b.type !== 'thinking' && b.type !== 'redacted_thinking' && b.type !== 'tool_use'),
  );
}

interface Outcome {
  body: string;
  status: AssistantMessageStatus;
  lookups: AssistantLookup[];
  model: string | null;
  usage: Record<string, number>;
}

const textOf = (content: Block[]): string =>
  content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();

async function answer(app: FastifyInstance, a: Asker, messages: Param[]): Promise<Outcome> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey!, timeout: 120_000, maxRetries: 1 });
  const reference = await loadReference(app, a.cookie);
  const lookups: AssistantLookup[] = [];
  const usage: Record<string, number> = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const started = Date.now();
  let model: string | null = null;

  const done = (body: string, status: AssistantMessageStatus): Outcome => ({ body, status, lookups, model, usage });

  for (let step = 0; step < MAX_STEPS; step++) {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await client.beta.messages.create({
        model: config.assistant.model,
        max_tokens: 16000,
        // A safety decline on the primary model re-runs on the server's default
        // fallback in the same call rather than failing the answer.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: config.assistant.effort },
        system: [
          { type: 'text', text: STATIC_INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: reference, cache_control: { type: 'ephemeral' } },
        ],
        tools: ASSISTANT_TOOLS,
        messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        return done('The assistant could not sign in to Claude: the key in ANTHROPIC_API_KEY was refused. An administrator needs to check it.', 'error');
      }
      if (err instanceof Anthropic.RateLimitError) {
        return done('The assistant is busy right now. Try again in a minute.', 'error');
      }
      if (err instanceof Anthropic.APIError) {
        return done(`The assistant could not answer (${err.status ?? 'no status'}): ${err.message}`, 'error');
      }
      return done(`The assistant could not be reached: ${(err as Error).message}`, 'error');
    }

    model = res.model;
    for (const k of Object.keys(usage)) usage[k] += Number((res.usage as unknown as Record<string, unknown>)[k] ?? 0);

    if (res.stop_reason === 'refusal') {
      return done('The assistant declined to answer that. Try asking it another way.', 'declined');
    }
    if (res.stop_reason === 'max_tokens') {
      const partial = textOf(res.content);
      return done(partial ? `${partial}\n\n(This answer was cut short. Ask for a narrower slice.)` : 'The answer ran too long to finish. Ask for a narrower slice.', 'cut_short');
    }

    const kept = echoable(res.content);
    const calls = kept.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || calls.length === 0) {
      const body = textOf(res.content);
      return done(body || 'The assistant returned no answer. Try asking again.', body ? 'ok' : 'error');
    }

    messages.push({ role: 'assistant', content: kept as Anthropic.Beta.BetaContentBlockParam[] });
    const outOfTime = Date.now() - started > DEADLINE_MS;
    const ran = await Promise.all(calls.map((c) => (outOfTime ? null : runLookup(app, a.cookie, c.name, c.input))));
    const results = calls.map((c, i): Anthropic.Beta.BetaToolResultBlockParam => {
      const r = ran[i];
      if (!r) {
        return { type: 'tool_result', tool_use_id: c.id, content: 'No time left for more look-ups. Answer now from what you have, and say what you could not check.', is_error: true };
      }
      lookups.push(r.lookup);
      return { type: 'tool_result', tool_use_id: c.id, content: r.text, is_error: !r.lookup.ok };
    });
    // Every result of the turn goes back in ONE user message.
    messages.push({ role: 'user', content: results });
  }

  return done('This question needed more look-ups than one answer allows. Ask for one part of it at a time.', 'cut_short');
}

// ── Ask ──────────────────────────────────────────────────────────────────────

const titleOf = (question: string): string => {
  const one = question.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
};

export async function ask(app: FastifyInstance, a: Asker, input: AssistantAskInput): Promise<AssistantAskResponse> {
  requireAsk(a);
  if (!config.anthropicApiKey) {
    throw conflict('The assistant is not switched on yet (ANTHROPIC_API_KEY is unset)', { code: 'ASSISTANT_OFF' });
  }
  const used = await askedToday(a.user.id);
  if (used >= config.assistant.dailyLimit) {
    throw conflict(`You have asked ${config.assistant.dailyLimit} questions today, which is the daily limit. It resets at midnight.`, {
      code: 'ASSISTANT_DAILY_LIMIT',
    });
  }

  let conversation: AssistantConversationSummary;
  let earlier: AssistantMessage[] = [];
  if (input.conversation_id) {
    conversation = await ownConversation(a, input.conversation_id);
    earlier = await messagesOf(conversation.id);
  } else {
    const res = await query<{ id: string; title: string; updated_at: Date }>(
      `INSERT INTO assistant_conversation (principal_id, title) VALUES ($1, $2)
       RETURNING id::text AS id, title, updated_at`,
      [a.user.id, titleOf(input.question)],
    );
    const r = res.rows[0];
    conversation = { id: r.id, title: r.title, updated_at: new Date(r.updated_at).toISOString() };
  }

  const asked = await query<MessageRow>(
    `INSERT INTO assistant_message AS m (conversation_id, role, body) VALUES ($1, 'user', $2) RETURNING ${MESSAGE_COLUMNS}`,
    [conversation.id, input.question],
  );
  const question = toMessage(asked.rows[0]);

  // Earlier turns as text. A question whose answer failed is left out with it,
  // so the model never sees two questions in a row with no answer between.
  const history: Param[] = [];
  const usable = earlier.slice(-HISTORY_MESSAGES);
  for (let i = 0; i < usable.length - 1; i++) {
    const q = usable[i];
    const r = usable[i + 1];
    if (q.role === 'user' && r.role === 'assistant' && (r.status === 'ok' || r.status === 'cut_short')) {
      history.push({ role: 'user', content: q.body }, { role: 'assistant', content: r.body });
      i += 1;
    }
  }
  const page = input.page && /^\/[A-Za-z0-9\-._~%/?=&#]*$/.test(input.page) ? input.page.slice(0, 300) : null;
  history.push({
    role: 'user',
    content: buildQuestion(input.question, {
      ...chicagoToday(),
      askerName: a.actingAs.name,
      askerRole: a.actingAs.roleLabel ?? a.actingAs.role,
      page,
      abilities: describeAbilities(a.user, a.actingAs),
    }),
  });

  const out = await answer(app, a, history);

  const saved = await query<MessageRow>(
    `INSERT INTO assistant_message AS m (conversation_id, role, body, status, lookups, model, usage)
     VALUES ($1, 'assistant', $2, $3, $4::jsonb, $5, $6::jsonb) RETURNING ${MESSAGE_COLUMNS}`,
    [conversation.id, out.body, out.status, JSON.stringify(out.lookups), out.model, JSON.stringify(out.usage)],
  );
  const touched = await query<{ updated_at: Date }>(
    `UPDATE assistant_conversation SET updated_at = now() WHERE id = $1 RETURNING updated_at`,
    [conversation.id],
  );
  conversation.updated_at = new Date(touched.rows[0].updated_at).toISOString();

  // Rule 1.2.1: asking is a button. The row says who asked and what was read
  // on their behalf; the question and answer themselves stay in the
  // conversation, which only its owner and the reviewers of marked answers see.
  await logAdminEvent({
    actorId: a.actingAs.id,
    entity: 'assistant',
    entityId: conversation.id,
    action: 'assistant_asked',
    after: {
      name: conversation.title,
      status: out.status,
      model: out.model,
      lookups: out.lookups.map((l) => l.summary),
    },
  });

  return {
    conversation,
    question,
    answer: toMessage(saved.rows[0]),
    remaining_today: Math.max(0, config.assistant.dailyLimit - used - 1),
  };
}

// ── The thumb ────────────────────────────────────────────────────────────────

export async function setFeedback(a: Asker, messageId: string, rating: 1 | -1 | 0, note: string | null): Promise<AssistantMessage> {
  requireAsk(a);
  if (!UUID.test(messageId)) throw notFound('Answer not found');
  const res = await query<MessageRow>(
    `UPDATE assistant_message AS m
        SET feedback = $3, feedback_note = $4, feedback_at = CASE WHEN $3::smallint IS NULL THEN NULL ELSE now() END,
            reviewed_by = NULL, reviewed_at = NULL
       FROM assistant_conversation c
      WHERE m.id = $1 AND m.role = 'assistant' AND c.id = m.conversation_id AND c.principal_id = $2
      RETURNING ${MESSAGE_COLUMNS}`,
    [messageId, a.user.id, rating === 0 ? null : rating, rating === -1 ? note : null],
  );
  if (!res.rows[0]) throw notFound('Answer not found');
  return toMessage(res.rows[0]);
}

// ── Teaching and review ──────────────────────────────────────────────────────

type NoteRow = { id: string; title: string; body: string; is_active: boolean; updated_at: Date; updated_by_name: string | null };

const NOTE_SELECT = `SELECT n.id::text AS id, n.title, n.body, n.is_active, n.updated_at, p.display_name AS updated_by_name
                       FROM assistant_note n LEFT JOIN principal p ON p.id = n.updated_by`;

const toNote = (r: NoteRow): AssistantNote => ({
  id: r.id,
  title: r.title,
  body: r.body,
  is_active: r.is_active,
  updated_at: new Date(r.updated_at).toISOString(),
  updated_by_name: r.updated_by_name,
});

export async function listNotes(a: Asker): Promise<{ items: AssistantNote[] }> {
  requireTeach(a);
  const res = await query<NoteRow>(`${NOTE_SELECT} ORDER BY n.created_at ASC`);
  return { items: res.rows.map(toNote) };
}

async function noteById(id: string): Promise<AssistantNote> {
  if (!UUID.test(id)) throw notFound('Note not found');
  const res = await query<NoteRow>(`${NOTE_SELECT} WHERE n.id = $1`, [id]);
  if (!res.rows[0]) throw notFound('Note not found');
  return toNote(res.rows[0]);
}

const noteSnapshot = (n: AssistantNote) => ({ name: n.title, body: n.body, is_active: n.is_active });

export async function createNote(a: Asker, input: AssistantNoteInput): Promise<AssistantNote> {
  requireTeach(a);
  const res = await query<{ id: string }>(
    `INSERT INTO assistant_note (title, body, is_active, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id::text AS id`,
    [input.title, input.body, input.is_active ?? true, a.actingAs.id],
  );
  const note = await noteById(res.rows[0].id);
  await logAdminEvent({ actorId: a.actingAs.id, entity: 'assistant_note', entityId: note.id, action: 'assistant_note_created', after: noteSnapshot(note) });
  return note;
}

export async function updateNote(a: Asker, id: string, input: AssistantNoteInput): Promise<AssistantNote> {
  requireTeach(a);
  const before = await noteById(id);
  await query(
    `UPDATE assistant_note SET title = $2, body = $3, is_active = $4, updated_by = $5, updated_at = now() WHERE id = $1`,
    [id, input.title, input.body, input.is_active ?? before.is_active, a.actingAs.id],
  );
  const note = await noteById(id);
  if (JSON.stringify(noteSnapshot(before)) !== JSON.stringify(noteSnapshot(note))) {
    await logAdminEvent({ actorId: a.actingAs.id, entity: 'assistant_note', entityId: id, action: 'assistant_note_updated', before: noteSnapshot(before), after: noteSnapshot(note) });
  }
  return note;
}

export async function deleteNote(a: Asker, id: string): Promise<void> {
  requireTeach(a);
  const before = await noteById(id);
  await query(`DELETE FROM assistant_note WHERE id = $1`, [id]);
  await logAdminEvent({ actorId: a.actingAs.id, entity: 'assistant_note', entityId: id, action: 'assistant_note_deleted', before: noteSnapshot(before) });
}

/** The answers people marked, newest first, each with the question it
    answered — what a reviewer reads to decide what to teach next. */
export async function listFeedback(a: Asker): Promise<AssistantFeedbackResponse> {
  requireTeach(a);
  const res = await query<{
    message_id: string;
    conversation_id: string;
    asked_by: string | null;
    question: string | null;
    answer: string;
    lookups: AssistantLookup[] | null;
    feedback: number;
    feedback_note: string | null;
    feedback_at: Date;
    reviewed: boolean;
  }>(
    `SELECT m.id::text AS message_id, m.conversation_id::text AS conversation_id, p.display_name AS asked_by,
            (SELECT q.body FROM assistant_message q
              WHERE q.conversation_id = m.conversation_id AND q.role = 'user' AND q.created_at <= m.created_at
              ORDER BY q.created_at DESC LIMIT 1) AS question,
            m.body AS answer, m.lookups, m.feedback, m.feedback_note, m.feedback_at,
            (m.reviewed_at IS NOT NULL) AS reviewed
       FROM assistant_message m
       JOIN assistant_conversation c ON c.id = m.conversation_id
       LEFT JOIN principal p ON p.id = c.principal_id
      WHERE m.feedback IS NOT NULL
      ORDER BY (m.feedback = -1 AND m.reviewed_at IS NULL) DESC, m.feedback_at DESC
      LIMIT 100`,
  );
  const totals = await query<{ up: string; down: string }>(
    `SELECT count(*) FILTER (WHERE feedback = 1)::text AS up, count(*) FILTER (WHERE feedback = -1)::text AS down
       FROM assistant_message WHERE feedback IS NOT NULL`,
  );
  return {
    up: Number(totals.rows[0]?.up ?? 0),
    down: Number(totals.rows[0]?.down ?? 0),
    items: res.rows.map((r) => ({
      message_id: r.message_id,
      conversation_id: r.conversation_id,
      asked_by: r.asked_by ?? 'Unknown',
      question: r.question ?? '',
      answer: r.answer,
      lookups: r.lookups ?? [],
      feedback: r.feedback === 1 ? 1 : -1,
      feedback_note: r.feedback_note,
      feedback_at: new Date(r.feedback_at).toISOString(),
      reviewed: r.reviewed,
    })),
  };
}

export async function markReviewed(a: Asker, messageId: string, reviewed: boolean): Promise<void> {
  requireTeach(a);
  if (!UUID.test(messageId)) throw notFound('Answer not found');
  const res = await query<{ id: string }>(
    `UPDATE assistant_message
        SET reviewed_by = CASE WHEN $2::boolean THEN $3::uuid ELSE NULL END,
            reviewed_at = CASE WHEN $2::boolean THEN now() ELSE NULL END
      WHERE id = $1 AND feedback IS NOT NULL
      RETURNING id::text AS id`,
    [messageId, reviewed, a.actingAs.id],
  );
  if (!res.rows[0]) throw notFound('Answer not found');
}
