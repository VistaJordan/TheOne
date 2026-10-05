// 0068 · The assistant — the wire shapes, the permission row, and the two pure
// helpers both sides need (what a reply's links may point at, and how a large
// look-up result is cut down before the model reads it).

import type { PermNode } from './permissions';

export const ASSISTANT_PERM_KEY = 'assistant';

export function assistantPermNodes(): PermNode[] {
  return [
    {
      key: ASSISTANT_PERM_KEY,
      label: 'Assistant',
      actions: ['view', 'edit'],
      note: 'View = ask it questions. It looks everything up as the person asking, so it never shows a work order or a field their role hides. Edit = teach it (the notes it reads before every answer) and review the answers people marked wrong.',
    },
  ];
}

export const ASSISTANT_QUESTION_MAX = 4000;
export const ASSISTANT_NOTE_TITLE_MAX = 120;
export const ASSISTANT_NOTE_BODY_MAX = 2000;

export type AssistantMessageStatus = 'ok' | 'cut_short' | 'declined' | 'error';

/** One thing the assistant looked up on the way to an answer. */
export interface AssistantLookup {
  tool: string;
  /** A short human line: "Work orders · status group open · 42 found". */
  summary: string;
  ok: boolean;
  ms: number;
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  body: string;
  status: AssistantMessageStatus;
  lookups: AssistantLookup[];
  feedback: 1 | -1 | null;
  feedback_note: string | null;
  created_at: string;
}

export interface AssistantConversationSummary {
  id: string;
  title: string;
  updated_at: string;
}

export interface AssistantConversation extends AssistantConversationSummary {
  messages: AssistantMessage[];
}

export interface AssistantStatus {
  /** False until ANTHROPIC_API_KEY is set on the server. */
  configured: boolean;
  /** Questions this person may still ask today. */
  remaining_today: number;
  daily_limit: number;
  can_teach: boolean;
}

export interface AssistantAskInput {
  conversation_id?: string | null;
  question: string;
  /** Where the person is in the app, so "this work order" means something. */
  page?: string | null;
}

export interface AssistantAskResponse {
  conversation: AssistantConversationSummary;
  question: AssistantMessage;
  answer: AssistantMessage;
  remaining_today: number;
}

export interface AssistantNote {
  id: string;
  title: string;
  body: string;
  is_active: boolean;
  updated_at: string;
  updated_by_name: string | null;
}

export interface AssistantNoteInput {
  title: string;
  body: string;
  is_active?: boolean;
}

/** An answer somebody marked, with the question it answered. */
export interface AssistantFeedbackItem {
  message_id: string;
  conversation_id: string;
  asked_by: string;
  question: string;
  answer: string;
  lookups: AssistantLookup[];
  feedback: 1 | -1;
  feedback_note: string | null;
  feedback_at: string;
  reviewed: boolean;
}

export interface AssistantFeedbackResponse {
  items: AssistantFeedbackItem[];
  up: number;
  down: number;
}

// ── Links in a reply ─────────────────────────────────────────────────────────

/** A reply may link into the app and nowhere else: a path that starts with one
    slash. Anything else is drawn as plain text. */
export function assistantLinkOk(href: string): boolean {
  return /^\/(?!\/)[A-Za-z0-9\-._~%/?=&#+,:@]*$/.test(href);
}

// ── Cutting a look-up result down ────────────────────────────────────────────

export interface CompactOptions {
  /** Longest string kept whole. */
  maxString?: number;
  /** Most entries kept from any array below the top level. */
  maxArray?: number;
  /** Deepest level kept. */
  maxDepth?: number;
}

/**
 * A copy of `value` without what tells the model nothing: nulls, empty strings
 * and empty lists go, a long string keeps its start, a long nested list keeps
 * its first entries and says how many it dropped.
 */
export function compactForModel(value: unknown, opts: CompactOptions = {}, depth = 0): unknown {
  const maxString = opts.maxString ?? 600;
  const maxArray = opts.maxArray ?? 20;
  const maxDepth = opts.maxDepth ?? 6;
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return undefined;
    return s.length > maxString ? `${s.slice(0, maxString)}… [${s.length - maxString} more characters]` : s;
  }
  if (typeof value !== 'object') return value;
  if (depth >= maxDepth) return '[deeper detail left out]';
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const cap = depth === 0 ? value.length : maxArray;
    const kept = value
      .slice(0, cap)
      .map((v) => compactForModel(v, opts, depth + 1))
      .filter((v) => v !== undefined);
    if (value.length > cap) kept.push(`[${value.length - cap} more not shown]`);
    return kept.length === 0 ? undefined : kept;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const c = compactForModel(v, opts, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The compacted value as JSON, never longer than `maxChars`: a result that is
    still too large is cut and says so, so the model asks a narrower question
    instead of trusting half a list. */
export function lookupResultText(value: unknown, maxChars = 60_000, opts: CompactOptions = {}): string {
  const text = JSON.stringify(compactForModel(value, opts) ?? {});
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[CUT: this result was too large and ends here. Ask for less: a narrower search, fewer columns, a smaller limit or one part at a time.]`;
}

/** The rows of a list response, whatever the list calls them. */
export function rowsOf(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    for (const k of ['items', 'rows', 'tasks', 'events', 'points']) {
      if (Array.isArray(rec[k])) return rec[k] as unknown[];
    }
    const arrays = Object.values(rec).filter(Array.isArray) as unknown[][];
    if (arrays.length === 1) return arrays[0];
  }
  return null;
}

export interface RowFilter {
  /** Keep rows whose text contains every word, in any field. */
  search?: string | null;
  /** Keep rows whose top-level field equals the value (case-insensitive). */
  where?: Record<string, string | number | boolean> | null;
  /** Count the kept rows by this top-level field. */
  count_by?: string | null;
  limit?: number;
  offset?: number;
}

export interface FilteredRows {
  total: number;
  matched: number;
  shown: number;
  counts?: Record<string, number>;
  rows: unknown[];
}

const cell = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Narrow a list that the API returns whole, so the model can ask "payments
    still requested" without reading every payment. */
export function filterRows(rows: unknown[], f: RowFilter): FilteredRows {
  let kept = rows;
  const where = f.where ?? null;
  if (where) {
    kept = kept.filter((r) => {
      if (!r || typeof r !== 'object') return false;
      const rec = r as Record<string, unknown>;
      return Object.entries(where).every(([k, v]) => cell(rec[k]).toLowerCase() === String(v).toLowerCase());
    });
  }
  const words = (f.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    kept = kept.filter((r) => {
      const hay = JSON.stringify(r).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  let counts: Record<string, number> | undefined;
  if (f.count_by) {
    counts = {};
    for (const r of kept) {
      const key = r && typeof r === 'object' ? cell((r as Record<string, unknown>)[f.count_by]) || '(empty)' : '(empty)';
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  const offset = Math.max(0, f.offset ?? 0);
  const limit = Math.min(Math.max(1, f.limit ?? 25), 100);
  const page = kept.slice(offset, offset + limit);
  return { total: rows.length, matched: kept.length, shown: page.length, counts, rows: page };
}
