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
  /** Null for an imported transcript (0077): nobody dialled anything. */
  phone: string | null;
  purpose: WoCallPurpose;
  status: WoCallStatus;
  quo_call_id: string | null;
  direction: 'incoming' | 'outgoing' | null;
  answered_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  transcript: WoCallTranscriptLine[] | null;
  /** quo = the webhook; pasted = typed onto a call placed from the work
   *  order; imported = a conversation held anywhere else, imported from the
   *  quote (0077) — there is no call behind it. */
  transcript_source: WoCallTranscriptSource | null;
  summary: WoCallSummary | null;
  created_at: string;
  /** The AI quote draft made from this call, if any. */
  draft: { id: string; status: AiQuoteDraftStatus } | null;
}

export type WoCallTranscriptSource = 'quo' | 'pasted' | 'imported';

/** POST /work-orders/:id/transcripts — a transcript imported from the quote. */
export interface ImportTranscriptInput {
  text: string;
  /** Who the conversation was with, when the importer says. */
  contact_name?: string | null;
  contact_role?: WoCallContactRole;
  /** The file it came from, for the audit trail; null when pasted. */
  file_name?: string | null;
}

/** File types the Import transcript picker offers: plain text and the
 *  caption formats Teams, Zoom and Meet export. Read in the browser. */
export const TRANSCRIPT_FILE_ACCEPT = '.txt,.vtt,.srt,.md,text/plain,text/vtt';

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
  quote: { status: 'draft' | 'pending_approval' | 'approved' | 'sent' | 'client_approved' | 'client_declined'; has_content: boolean } | null;
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

/** A caption cue's timing line: '00:00:01.000 --> 00:00:04.200 align:start'. */
const CUE_TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}.*$/;
/** WebVTT voice tag: '<v Jane Doe>Hello' (Teams, Zoom). */
const VOICE_RE = /^<v(?:\.[^\s>]*)?\s+([^>]+)>(.*)$/;
/** A Teams cue id above the timing: '6d1c…-0/12-0'. */
const CUE_ID_RE = /^[\w-]+\/[\w-]+$/;

/**
 * An imported transcript file → lines. A WebVTT or SRT export (Teams, Zoom,
 * Meet) is stripped of its header, cue numbers, cue ids and timings; its
 * <v Name> voice tags become speakers, and consecutive cues by the same
 * speaker are joined into one line. Anything else reads like a pasted
 * transcript ("Name: what they said").
 */
export function parseTranscriptFile(text: string): WoCallTranscriptLine[] {
  const raw = text.replace(/^﻿/, '');
  const rows = raw.split(/\r?\n/);
  const isCaptions = /^WEBVTT/.test(raw.trimStart()) || rows.some((l) => CUE_TIME_RE.test(l.trim()));
  if (!isCaptions) return parsePastedTranscript(raw);

  const kept: string[] = [];
  let skipBlock = false;
  for (const row of rows) {
    const line = row.trim();
    if (line === '') {
      skipBlock = false;
      continue;
    }
    if (skipBlock) continue;
    // The header and its metadata blocks run to the next blank line.
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(line)) {
      skipBlock = true;
      continue;
    }
    if (/^\d+$/.test(line) || CUE_TIME_RE.test(line) || CUE_ID_RE.test(line)) continue;
    const v = VOICE_RE.exec(line);
    const body = (v ? v[2] : line).replace(/<\/?[^>]+>/g, '').trim();
    if (body === '') continue;
    kept.push(v ? `${v[1].trim()}: ${body}` : body);
  }
  const merged: WoCallTranscriptLine[] = [];
  for (const l of parsePastedTranscript(kept.join('\n'))) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speaker === l.speaker) merged[merged.length - 1] = { ...prev, line: `${prev.line} ${l.line}` };
    else merged.push(l);
  }
  return merged;
}

/** True when the draft has something a quote could be made of: a line item or
 *  a non-blank scope line in any section (the rule 11.2.1 definition). */
export function quoteDraftHasContent(body: QuoteDraftBody): boolean {
  return body.sections.some(
    (s) => s.lines.length > 0 || s.scope_lines.some((l) => l.trim() !== ''),
  );
}

// ── Transcript from a Quo call the person already had (Import transcript ›
//    From a Quo call) ───────────────────────────────────────────────────────
//
// The call was not placed from the work order, so no wo_call row and no
// webhook match exists for it. The person types the other party's number;
// the API finds THEIR Quo line(s) by the email they signed in with (Quo is
// on the same Byblos Vista accounts), lists the recent calls between those
// lines and that number, and on the pick fetches the transcript from Quo and
// stores it as a wo_call row keyed by Quo's call id — so the same call is
// never stored twice.

/** How far back the lookup reads and how many calls it offers. */
export const QUO_CALL_LOOKUP_DAYS = 90;
export const QUO_CALL_LOOKUP_MAX = 25;

export type QuoCallDirection = 'incoming' | 'outgoing';

/** One recent call between the person's Quo line and the number they typed. */
export interface QuoCallOption {
  quo_call_id: string;
  /** The Quo line it was on ('PN…' id, its number and display name). */
  line: { id: string; number: string | null; name: string | null };
  direction: QuoCallDirection;
  /** Quo's call status as reported ('completed', 'missed', 'no-answer', …). */
  status: string;
  created_at: string;
  answered_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  /** False when the call was never answered: Quo cannot have a transcript. */
  answered: boolean;
  /** The row already holding this call, when one does. Same work order =
      the pick just opens it; another = it cannot be used here. */
  already_on: { call_id: string; task_id: string; wo_number: string; same_work_order: boolean } | null;
}

/** GET /work-orders/:id/quo-calls?phone= */
export interface QuoCallsLookup {
  /** False when Quo's API is not set up or switched off; `reason` says which. */
  configured: boolean;
  reason: string | null;
  /** The person's own Quo lines the calls were read from. */
  lines: { id: string; number: string | null; name: string | null }[];
  /** The number as it was understood (E.164), null when it could not be. */
  phone: string | null;
  calls: QuoCallOption[];
}

/** POST /work-orders/:id/quo-calls/:quoCallId/import */
export interface ImportQuoCallInput {
  phone: string;
  contact_name?: string | null;
  contact_role?: WoCallContactRole;
}

/** The shape of a call as Quo's `GET /v1/calls` returns it (the part read). */
export interface QuoApiCall {
  id: string;
  phoneNumberId: string;
  userId?: string | null;
  direction: 'incoming' | 'outgoing';
  status: string;
  participants?: string[];
  createdAt: string;
  answeredAt?: string | null;
  completedAt?: string | null;
  duration?: number | null;
}

/** A line as Quo's `GET /v1/phone-numbers` returns it (the part read). */
export interface QuoApiPhoneNumber {
  id: string;
  number?: string | null;
  formattedNumber?: string | null;
  name?: string | null;
  users?: { id: string; email?: string | null }[];
}

/** One dialogue segment as Quo's transcript endpoint and webhook send it. */
export interface QuoDialogueSegment {
  content?: unknown;
  start?: unknown;
  identifier?: unknown;
}

/** The Quo lines a person may read calls from: every line whose members
 *  include a Quo user with that email (case-insensitive). */
export function quoLinesForEmail(numbers: QuoApiPhoneNumber[], email: string | null | undefined): QuoApiPhoneNumber[] {
  const want = (email ?? '').trim().toLowerCase();
  if (want === '') return [];
  return numbers.filter((n) => (n.users ?? []).some((u) => (u.email ?? '').trim().toLowerCase() === want));
}

/** Quo's dialogue → transcript lines. Segments spoken from `theirPhone` are
 *  the contact's, everything else ours; empty segments drop; ordered by
 *  start. Shared by the webhook and the lookup so both store the same shape. */
export function quoDialogueToLines(
  dialogue: QuoDialogueSegment[],
  theirPhone: string | null,
  theirs: string,
  ours: string,
): WoCallTranscriptLine[] {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  return dialogue
    .map((d) => ({
      speaker: theirPhone !== null && normalizePhone(str(d.identifier)) === theirPhone ? theirs : ours,
      line: str(d.content),
      start: typeof d.start === 'number' ? Math.round(d.start * 10) / 10 : null,
    }))
    .filter((l) => l.line !== '')
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

/** A Quo call → the option the dialog lists. `answered` is read off
 *  answeredAt first, then Quo's status, because an unanswered call has no
 *  transcript to fetch. */
export function quoCallOption(
  call: QuoApiCall,
  line: { id: string; number: string | null; name: string | null },
  alreadyOn: QuoCallOption['already_on'],
): QuoCallOption {
  const answeredAt = typeof call.answeredAt === 'string' && call.answeredAt !== '' ? call.answeredAt : null;
  const completedAt = typeof call.completedAt === 'string' && call.completedAt !== '' ? call.completedAt : null;
  const answered = answeredAt !== null || call.status === 'completed' || call.status === 'answered';
  let duration = typeof call.duration === 'number' && Number.isFinite(call.duration) ? Math.max(0, Math.round(call.duration)) : null;
  if (duration === null && answeredAt && completedAt) {
    const ms = new Date(completedAt).getTime() - new Date(answeredAt).getTime();
    if (Number.isFinite(ms)) duration = Math.max(0, Math.round(ms / 1000));
  }
  return {
    quo_call_id: call.id,
    line,
    direction: call.direction === 'incoming' ? 'incoming' : 'outgoing',
    status: call.status,
    created_at: call.createdAt,
    answered_at: answeredAt,
    completed_at: completedAt,
    duration_seconds: duration,
    answered,
    already_on: alreadyOn,
  };
}

/** Newest first, capped — the order the dialog shows. */
export function sortQuoCallOptions(calls: QuoCallOption[], max = QUO_CALL_LOOKUP_MAX): QuoCallOption[] {
  return [...calls]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, max);
}
