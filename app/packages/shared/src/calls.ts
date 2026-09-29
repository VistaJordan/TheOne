// Calls placed from a work order through Quo, and the AI quote drafted from a
// call's transcript (migration 0054).
//
// Quo's API cannot start a call, so the Call button records the intent (a
// wo_call row) and hands the number to the Quo app with a tel: link. Quo's
// webhooks bring the finished call, its transcript and its summary back to
// that row. Pure vocabulary and rules live here so the API and the browser
// agree; the SQL, the webhook and the Claude call live under apps/api.

import type { FeedActor, QuoteLineType } from './index';

/** view = the call log and transcripts; create = place a call / paste a
 *  transcript. Drafting and submitting a quote still need quotes create/edit. */
export const CALL_PERM_KEY = 'work_orders/calls';

export type WoCallPurpose = 'call' | 'quote';
export type WoCallContactRole = 'tech' | 'vendor' | 'client' | 'other';
/** Stored states, plus `expired`: a `dialing` row Quo never reported back on
 *  within CALL_EXPIRE_HOURS (derived on read, never stored). */
export type WoCallStatus = 'dialing' | 'completed' | 'missed' | 'transcribed' | 'expired';

export const WO_CALL_CONTACT_LABELS: Record<WoCallContactRole, string> = {
  tech: 'Technician',
  vendor: 'Vendor',
  client: 'Client',
  other: 'Other',
};

/** A Quo call is matched to the newest `dialing` row for its number placed at
 *  most this long BEFORE Quo says the call started … */
export const CALL_MATCH_BEFORE_MINUTES = 30;
/** … or this long after (clock skew between us and Quo). */
export const CALL_MATCH_AFTER_MINUTES = 5;
/** A `dialing` row this old with nothing from Quo reads as `expired`. */
export const CALL_EXPIRE_HOURS = 3;

export interface WoCallTranscriptLine {
  speaker: string;
  line: string;
  /** Seconds from the start of the call; null for a pasted transcript. */
  start: number | null;
}

export interface WoCallSummary {
  summary: string[];
  next_steps: string[];
}

export interface WoCall {
  id: string;
  task_id: string;
  placed_by: FeedActor;
  contact_name: string | null;
  contact_role: WoCallContactRole;
  phone: string;
  purpose: WoCallPurpose;
  status: WoCallStatus;
  quo_call_id: string | null;
  direction: 'incoming' | 'outgoing' | null;
  answered_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  transcript: WoCallTranscriptLine[] | null;
  transcript_source: 'quo' | 'pasted' | null;
  summary: WoCallSummary | null;
  created_at: string;
  /** The AI quote draft made from this call, if any. */
  draft: { id: string; status: AiQuoteDraftStatus } | null;
}

export interface WoCallsResponse {
  calls: WoCall[];
}

export interface PlaceCallResponse {
  call: WoCall;
  /** 'tel:+14095550143' — what the browser hands to the Quo app. */
  dial: string;
}

// ── AI quote draft ───────────────────────────────────────────────────────────

export type AiQuoteDraftStatus = 'ready' | 'submitted' | 'discarded';

/** The quote builder's PUT body (PUT /work-orders/:id/quote), which is what a
 *  draft holds and what Submit quote sends through the ordinary save. */
export interface QuoteDraftLine {
  line_type: QuoteLineType;
  description: string;
  qty: number;
  rate: number;
  day_value: string | null;
  ot: boolean;
  uom: string | null;
  tax_pct: number;
  markup_pct: number;
}

export interface QuoteDraftSection {
  kind: 'incurred' | 'option';
  name: string | null;
  narrative_reported: string | null;
  scope_lines: string[];
  include_in_summary: boolean;
  lines: QuoteDraftLine[];
}

export interface QuoteDraftBody {
  sections: QuoteDraftSection[];
  specs: string | null;
  note_to_customer: string | null;
}

export interface AiQuoteDraft {
  id: string;
  call_id: string;
  task_id: string;
  status: AiQuoteDraftStatus;
  draft: QuoteDraftBody;
  /** What the AI decided without being told ("Used the contract's $95/h"). */
  assumptions: string[];
  /** What the call did not say and a person must fill in. */
  missing_info: string[];
  model: string | null;
  created_by: FeedActor;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

/** GET /work-orders/:id/calls/:callId/quote-draft */
export interface AiQuoteDraftResponse {
  call: WoCall;
  draft: AiQuoteDraft | null;
  /** The work order's real quote, when one exists — Submit quote fills it. */
  quote: { status: 'draft' | 'pending_approval' | 'approved' | 'sent'; has_content: boolean } | null;
  /** False when ANTHROPIC_API_KEY is unset: the page says so instead of failing. */
  ai_configured: boolean;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** '(409) 555-0143' → '+14095550143'. Ten digits are a US number; anything
 *  already starting with + keeps its country code. Null when there are too
 *  few digits to dial. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** The state a call reads as now: a `dialing` row older than
 *  CALL_EXPIRE_HOURS reads `expired`. */
export function displayCallStatus(
  stored: Exclude<WoCallStatus, 'expired'>,
  createdAt: string | Date,
  now: Date = new Date(),
): WoCallStatus {
  if (stored !== 'dialing') return stored;
  const t = typeof createdAt === 'string' ? Date.parse(createdAt) : createdAt.getTime();
  if (Number.isNaN(t)) return stored;
  return now.getTime() - t > CALL_EXPIRE_HOURS * 3_600_000 ? 'expired' : 'dialing';
}

const SPEAKER_RE = /^([^:]{1,48}):\s*(.*)$/;
/** A leading timestamp a copied transcript may carry: '[00:12]', '00:12 ', '1:02:03 -'. */
const STAMP_RE = /^\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?\s*[-–]?\s*/;

/**
 * A transcript pasted by hand → lines. "Name: what they said" starts a new
 * speaker; a line without a speaker continues the previous one. Leading
 * timestamps are dropped. Blank lines are ignored.
 */
export function parsePastedTranscript(text: string): WoCallTranscriptLine[] {
  const out: WoCallTranscriptLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(STAMP_RE, '').trim();
    if (line === '') continue;
    const m = SPEAKER_RE.exec(line);
    // "Note: …" inside a sentence would also match; only treat it as a
    // speaker when the label is short and has no sentence punctuation.
    if (m && m[2].trim() !== '' && !/[.?!]/.test(m[1])) {
      out.push({ speaker: m[1].trim(), line: m[2].trim(), start: null });
    } else if (out.length > 0) {
      out[out.length - 1] = { ...out[out.length - 1], line: `${out[out.length - 1].line} ${line}` };
    } else {
      out.push({ speaker: 'Speaker', line, start: null });
    }
  }
  return out;
}

/** True when the draft has something a quote could be made of: a line item or
 *  a non-blank scope line in any section (the rule 11.2.1 definition). */
export function quoteDraftHasContent(body: QuoteDraftBody): boolean {
  return body.sections.some(
    (s) => s.lines.length > 0 || s.scope_lines.some((l) => l.trim() !== ''),
  );
}
