// 0054 · Calls placed from a work order through Quo.
//
// Quo's API cannot start a call, so placing one here writes a wo_call row
// (the intent: who, which number, just a call or a call to draft a quote from)
// and the browser then opens the number in the Quo app with a tel: link.
// Quo's webhooks bring the result back (routes/webhooks.ts → handleQuoEvent):
//
//   call.completed             → matched to the newest `dialing` row for the
//                                number Quo dialled (CALL_MATCH_* window)
//   call.transcript.completed  → the dialogue, by Quo call id (or, if the
//                                transcript beats call.completed, by number)
//   call.summary.completed     → Quo's summary and next steps
//
// A call on a monitored Quo line that nobody placed from a work order is not
// ours and is dropped without a trace: the webhook sees every call on the line.
//
// Every write is logged to activity_log against the work order: call_placed
// (the person), call_completed / call_transcribed (the 'Quo' service
// principal, or the person when they pasted the transcript).

import {
  CALL_EXPIRE_HOURS,
  CALL_MATCH_AFTER_MINUTES,
  CALL_MATCH_BEFORE_MINUTES,
  displayCallStatus,
  normalizePhone,
} from '@theone/shared';
import type {
  AiQuoteDraftStatus,
  WoCall,
  WoCallContactRole,
  WoCallPurpose,
  WoCallSummary,
  WoCallTranscriptLine,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import type { Queryable } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { serviceActorId } from './serviceActors.js';

type StoredStatus = 'dialing' | 'completed' | 'missed' | 'transcribed';

type CallRow = {
  id: string;
  task_id: string;
  placed_by_id: string;
  placed_by_name: string | null;
  placed_by_kind: 'human' | 'service';
  contact_name: string | null;
  contact_role: WoCallContactRole;
  phone: string;
  purpose: WoCallPurpose;
  status: StoredStatus;
  quo_call_id: string | null;
  direction: 'incoming' | 'outgoing' | null;
  answered_at: Date | null;
  completed_at: Date | null;
  duration_seconds: number | null;
  transcript: WoCallTranscriptLine[] | null;
  transcript_source: 'quo' | 'pasted' | null;
  summary: WoCallSummary | null;
  created_at: Date;
  draft_id: string | null;
  draft_status: AiQuoteDraftStatus | null;
};

const CALL_SELECT = `
  SELECT c.id::text AS id, c.task_id::text AS task_id,
         p.id::text AS placed_by_id, p.display_name AS placed_by_name, p.kind AS placed_by_kind,
         c.contact_name, c.contact_role, c.phone, c.purpose, c.status, c.quo_call_id,
         c.direction, c.answered_at, c.completed_at, c.duration_seconds,
         c.transcript, c.transcript_source, c.summary, c.created_at,
         d.id::text AS draft_id, d.status AS draft_status
    FROM wo_call c
    JOIN principal p ON p.id = c.placed_by
    LEFT JOIN quote_ai_draft d ON d.call_id = c.id`;

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function mapCall(r: CallRow): WoCall {
  return {
    id: r.id,
    task_id: r.task_id,
    placed_by: { id: r.placed_by_id, name: r.placed_by_name ?? 'Unknown', kind: r.placed_by_kind },
    contact_name: r.contact_name,
    contact_role: r.contact_role,
    phone: r.phone,
    purpose: r.purpose,
    status: displayCallStatus(r.status, new Date(r.created_at)),
    quo_call_id: r.quo_call_id,
    direction: r.direction,
    answered_at: iso(r.answered_at),
    completed_at: iso(r.completed_at),
    duration_seconds: r.duration_seconds,
    transcript: r.transcript,
    transcript_source: r.transcript_source,
    summary: r.summary,
    created_at: iso(r.created_at)!,
    draft: r.draft_id ? { id: r.draft_id, status: r.draft_status! } : null,
  };
}

export async function listCalls(taskId: string): Promise<WoCall[]> {
  const res = await query<CallRow>(`${CALL_SELECT} WHERE c.task_id = $1 ORDER BY c.created_at DESC`, [taskId]);
  return res.rows.map(mapCall);
}

/** One call on one work order; 404 when the id belongs to another work order. */
export async function getCall(taskId: string, callId: string): Promise<WoCall> {
  if (!UUID_RE.test(callId)) throw notFound('Call not found');
  const res = await query<CallRow>(`${CALL_SELECT} WHERE c.id = $1 AND c.task_id = $2`, [callId, taskId]);
  if (!res.rows[0]) throw notFound('Call not found');
  return mapCall(res.rows[0]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlaceCallInput {
  phone: string;
  contact_name: string | null;
  contact_role: WoCallContactRole;
  purpose: WoCallPurpose;
}

/** Record the intent; the browser dials. Returns the row and the tel: link. */
export async function placeCall(
  taskId: string,
  input: PlaceCallInput,
  actor: ActingPrincipal,
): Promise<{ call: WoCall; dial: string }> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw badRequest('That is not a phone number we can dial', { field: 'phone' });

  const id = await withTransaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO wo_call (task_id, placed_by, contact_name, contact_role, phone, purpose)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
      [taskId, actor.id, input.contact_name, input.contact_role, phone, input.purpose],
    );
    const callId = ins.rows[0].id;
    await logCall(tx, actor.id, taskId, 'call_placed', {
      call_id: callId,
      phone,
      contact_name: input.contact_name,
      contact_role: input.contact_role,
      purpose: input.purpose,
    });
    return callId;
  });
  return { call: await getCall(taskId, id), dial: `tel:${phone}` };
}

/** A transcript typed or pasted by hand — for a call the webhook never saw. */
export async function pasteTranscript(
  taskId: string,
  callId: string,
  lines: WoCallTranscriptLine[],
  actor: ActingPrincipal,
): Promise<WoCall> {
  const call = await getCall(taskId, callId);
  if (call.transcript_source === 'quo') {
    throw badRequest('Quo already sent the transcript for this call');
  }
  if (lines.length === 0) throw badRequest('The transcript is empty', { field: 'text' });
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE wo_call SET transcript = $2::jsonb, transcript_source = 'pasted', status = 'transcribed'
        WHERE id = $1`,
      [callId, JSON.stringify(lines)],
    );
    await logCall(tx, actor.id, taskId, 'call_transcribed', {
      call_id: callId,
      source: 'pasted',
      lines: lines.length,
    });
  });
  return getCall(taskId, callId);
}

// ── The Quo webhook ──────────────────────────────────────────────────────────

/** The parts of a Quo event we read. Everything is optional: an event we do
    not understand is acknowledged and ignored rather than retried for 3 days. */
export interface QuoEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

export type QuoEventOutcome =
  | { handled: false; reason: string }
  | { handled: true; call_id: string; task_id: string; change: string }
  // 0070: a text with a file — a signed sign-off sheet coming back.
  | { handled: true; signoff: 'filed' | 'held'; task_ids: string[]; files: number };

export async function handleQuoEvent(event: QuoEvent): Promise<QuoEventOutcome> {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case 'call.completed':
      return onCallCompleted(obj);
    case 'call.transcript.completed':
      return onTranscript(obj);
    case 'call.summary.completed':
      return onSummary(obj);
    case 'message.received': {
      // 0070: the signed sign-off sheet a technician texts back.
      const { onInboundMessage } = await import('./signoff.js');
      return onInboundMessage(event.data as Parameters<typeof onInboundMessage>[0]);
    }
    default:
      return { handled: false, reason: `ignored event type ${event.type ?? '(none)'}` };
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const date = (v: unknown): Date | null => {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

function quoActorId(): Promise<string> {
  return serviceActorId('Quo', 'QU');
}

/** The newest unmatched call placed from a work order to one of `phones`,
    in the window around `startedAt`. */
async function findDialing(phones: string[], startedAt: Date): Promise<{ id: string; task_id: string } | null> {
  if (phones.length === 0) return null;
  const res = await query<{ id: string; task_id: string }>(
    `SELECT id::text AS id, task_id::text AS task_id FROM wo_call
      WHERE quo_call_id IS NULL
        AND phone = ANY($1::text[])
        AND created_at >= $2::timestamptz - make_interval(mins => $3::int)
        AND created_at <= $2::timestamptz + make_interval(mins => $4::int)
      ORDER BY created_at DESC LIMIT 1`,
    [phones, startedAt.toISOString(), CALL_MATCH_BEFORE_MINUTES, CALL_MATCH_AFTER_MINUTES],
  );
  return res.rows[0] ?? null;
}

async function byQuoId(quoCallId: string): Promise<{ id: string; task_id: string; phone: string; contact_name: string | null; placed_by_name: string | null; status: StoredStatus } | null> {
  const res = await query<{ id: string; task_id: string; phone: string; contact_name: string | null; placed_by_name: string | null; status: StoredStatus }>(
    `SELECT c.id::text AS id, c.task_id::text AS task_id, c.phone, c.contact_name,
            p.display_name AS placed_by_name, c.status
       FROM wo_call c JOIN principal p ON p.id = c.placed_by
      WHERE c.quo_call_id = $1`,
    [quoCallId],
  );
  return res.rows[0] ?? null;
}

async function onCallCompleted(obj: Record<string, unknown>): Promise<QuoEventOutcome> {
  const quoId = text(obj.id);
  if (!quoId) return { handled: false, reason: 'call has no id' };
  const direction = obj.direction === 'incoming' ? 'incoming' : obj.direction === 'outgoing' ? 'outgoing' : null;
  // The other party: who we dialled on an outgoing call, who rang us on an
  // incoming one (a call placed from a work order is always outgoing, but a
  // Quo setup that rings the desk phone first can report either).
  const counterparty = normalizePhone(text(direction === 'incoming' ? obj.from : obj.to));
  const startedAt = date(obj.createdAt) ?? new Date();
  const answeredAt = date(obj.answeredAt);
  const completedAt = date(obj.completedAt);
  const duration =
    answeredAt && completedAt ? Math.max(0, Math.round((completedAt.getTime() - answeredAt.getTime()) / 1000)) : null;

  const known = await byQuoId(quoId);
  const target = known ?? (counterparty ? await findDialing([counterparty], startedAt) : null);
  if (!target) return { handled: false, reason: 'no call placed from a work order matches' };

  const actorId = await quoActorId();
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE wo_call
          SET quo_call_id = $2, quo_user_id = $3, direction = $4,
              answered_at = $5, completed_at = $6,
              duration_seconds = COALESCE($7, duration_seconds),
              -- a transcript that arrived first keeps the call 'transcribed'
              status = CASE WHEN status = 'transcribed' THEN 'transcribed'
                            WHEN $5::timestamptz IS NULL THEN 'missed' ELSE 'completed' END
        WHERE id = $1`,
      [target.id, quoId, text(obj.userId), direction, answeredAt, completedAt, duration],
    );
    await logCall(tx, actorId, target.task_id, 'call_completed', {
      call_id: target.id,
      quo_call_id: quoId,
      answered: answeredAt !== null,
      duration_seconds: duration,
    });
  });
  return { handled: true, call_id: target.id, task_id: target.task_id, change: answeredAt ? 'completed' : 'missed' };
}

async function onTranscript(obj: Record<string, unknown>): Promise<QuoEventOutcome> {
  const quoId = text(obj.callId);
  if (!quoId) return { handled: false, reason: 'transcript has no callId' };
  const dialogue = Array.isArray(obj.dialogue) ? (obj.dialogue as Record<string, unknown>[]) : [];

  let target = await byQuoId(quoId);
  if (!target) {
    // The transcript can beat call.completed; fall back to the numbers heard
    // on the call, within the expiry window.
    const phones = [...new Set(dialogue.map((d) => normalizePhone(text(d.identifier))).filter((p): p is string => !!p))];
    const recent = await findRecentDialing(phones);
    if (!recent) return { handled: false, reason: 'no call placed from a work order matches' };
    await query(`UPDATE wo_call SET quo_call_id = $2 WHERE id = $1 AND quo_call_id IS NULL`, [recent.id, quoId]);
    target = await byQuoId(quoId);
    if (!target) return { handled: false, reason: 'match was taken by another event' };
  }

  const theirs = target.contact_name ?? 'Contact';
  const ours = target.placed_by_name ?? 'Seamless FM';
  const lines: WoCallTranscriptLine[] = dialogue
    .map((d) => ({
      speaker: normalizePhone(text(d.identifier)) === target!.phone ? theirs : ours,
      line: text(d.content) ?? '',
      start: typeof d.start === 'number' ? Math.round(d.start * 10) / 10 : null,
    }))
    .filter((l) => l.line !== '')
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const duration = typeof obj.duration === 'number' ? Math.round(obj.duration) : null;

  const actorId = await quoActorId();
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE wo_call
          SET transcript = $2::jsonb, transcript_source = 'quo', status = 'transcribed',
              duration_seconds = COALESCE(duration_seconds, $3)
        WHERE id = $1`,
      [target!.id, JSON.stringify(lines), duration],
    );
    await logCall(tx, actorId, target!.task_id, 'call_transcribed', {
      call_id: target!.id,
      source: 'quo',
      lines: lines.length,
    });
  });
  return { handled: true, call_id: target.id, task_id: target.task_id, change: 'transcribed' };
}

/** A dialing row for one of `phones` placed within the expiry window. */
async function findRecentDialing(phones: string[]): Promise<{ id: string; task_id: string } | null> {
  if (phones.length === 0) return null;
  const res = await query<{ id: string; task_id: string }>(
    `SELECT id::text AS id, task_id::text AS task_id FROM wo_call
      WHERE quo_call_id IS NULL AND phone = ANY($1::text[])
        AND created_at >= now() - make_interval(hours => $2::int)
      ORDER BY created_at DESC LIMIT 1`,
    [phones, CALL_EXPIRE_HOURS],
  );
  return res.rows[0] ?? null;
}

async function onSummary(obj: Record<string, unknown>): Promise<QuoEventOutcome> {
  const quoId = text(obj.callId);
  if (!quoId) return { handled: false, reason: 'summary has no callId' };
  const target = await byQuoId(quoId);
  if (!target) return { handled: false, reason: 'no call placed from a work order matches' };
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((s) => text(s)).filter((s): s is string => s !== null) : [];
  const summary: WoCallSummary = { summary: list(obj.summary), next_steps: list(obj.nextSteps) };
  // Not logged separately: the summary is Quo's reading of a call whose
  // arrival is already on the trail, and it changes nothing we decide on.
  await query(`UPDATE wo_call SET summary = $2::jsonb WHERE id = $1`, [target.id, JSON.stringify(summary)]);
  return { handled: true, call_id: target.id, task_id: target.task_id, change: 'summary' };
}

// ── Audit ────────────────────────────────────────────────────────────────────

async function logCall(
  tx: Queryable,
  actorId: string,
  taskId: string,
  action: 'call_placed' | 'call_completed' | 'call_transcribed',
  after: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, $3, NULL, NULL, $4::jsonb)`,
    [actorId, taskId, action, JSON.stringify(after)],
  );
}
