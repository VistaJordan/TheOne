// 0070 · The little of Quo's REST API we call: send one text, fetch one media
// file. Quo (formerly OpenPhone) authenticates with the API key as the bare
// `Authorization` header value — not a Bearer token. The host is
// config.quoApiBase (QUO_API_BASE, default https://api.quo.com/v1).
//
// Everything is best-effort and loud: a failure throws an ApiError the route
// turns into a 502 the card can show, and nothing is retried here — the
// person presses Share again.

import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { integrationOn, requireIntegration } from '../services/integrations.js';

/** Credentials present AND the switch in Admin › Integrations is on. */
export function quoApiReady(): boolean {
  return Boolean(config.quoApiKey && config.quoFromNumber) && integrationOn('quo');
}

export interface QuoSentMessage { id: string | null }

/** POST /messages — one text from the configured line to one recipient. */
export async function sendQuoText(to: string, content: string): Promise<QuoSentMessage> {
  requireIntegration('quo');
  if (!config.quoApiKey || !config.quoFromNumber) {
    throw new ApiError('CONFLICT', 'Sending through Quo is not configured (QUO_API_KEY / QUO_FROM_NUMBER)', {
      code: 'QUO_API_MISSING',
    });
  }
  let res: Response;
  try {
    res = await fetch(`${config.quoApiBase}/messages`, {
      method: 'POST',
      headers: { Authorization: config.quoApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.quoFromNumber, to: [to], content }),
    });
  } catch (err) {
    throw new ApiError('CONFLICT', `Quo could not be reached: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    // Quo's errors are JSON with a message; the status alone is the useful
    // part when they are not (402 subscription, 403 A2P daily limit…).
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string; error?: string };
      detail = j.message ?? j.error ?? detail;
    } catch { /* not JSON */ }
    throw new ApiError('CONFLICT', `Quo refused the text (${res.status}): ${detail}`);
  }
  try {
    const j = JSON.parse(text) as { data?: { id?: string }; id?: string };
    return { id: j.data?.id ?? j.id ?? null };
  } catch {
    return { id: null };
  }
}

export interface FetchedMedia { bytes: Buffer; contentType: string }

/** A media URL from a webhook payload. Tried bare first (they are usually
    signed URLs), then with the API key, then given up on. */
export async function fetchQuoMedia(url: string, maxBytes: number): Promise<FetchedMedia | null> {
  const attempts: Record<string, string>[] = [{}];
  if (config.quoApiKey) attempts.push({ Authorization: config.quoApiKey });
  for (const headers of attempts) {
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) return null;
    const contentType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
    return { bytes: buf, contentType };
  }
  return null;
}

// ── Reading Quo (Import transcript › From a Quo call) ────────────────────────
//
// The API key alone is enough to READ: the from-number only matters for
// sending. Each call is bounded (QUO_READ_TIMEOUT_MS) and a failure is an
// ApiError the dialog can print; nothing is retried.

const QUO_READ_TIMEOUT_MS = 15_000;

/** The key is set AND the switch in Admin › Integrations is on. */
export function quoReadReady(): boolean {
  return Boolean(config.quoApiKey) && integrationOn('quo');
}

async function quoGet<T>(path: string, params: Record<string, string | string[] | undefined> = {}): Promise<T> {
  requireIntegration('quo');
  if (!config.quoApiKey) {
    throw new ApiError('CONFLICT', 'Reading calls from Quo is not configured (QUO_API_KEY)', { code: 'QUO_API_MISSING' });
  }
  const url = new URL(`${config.quoApiBase}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
    else url.searchParams.set(k, v);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: config.quoApiKey },
      signal: AbortSignal.timeout(QUO_READ_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError('CONFLICT', `Quo could not be reached: ${(err as Error).message}`, { code: 'QUO_UNREACHABLE' });
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string; error?: string };
      detail = j.message ?? j.error ?? detail;
    } catch { /* not JSON */ }
    throw new ApiError('CONFLICT', `Quo refused the request (${res.status}): ${detail}`, { code: 'QUO_REFUSED', status: res.status });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('CONFLICT', 'Quo answered with something that is not JSON', { code: 'QUO_REFUSED' });
  }
}

export interface QuoPhoneNumberRow {
  id: string;
  number?: string | null;
  formattedNumber?: string | null;
  name?: string | null;
  users?: { id: string; email?: string | null }[];
}

/** GET /phone-numbers — every line in the workspace with its members. */
export async function listQuoPhoneNumbers(): Promise<QuoPhoneNumberRow[]> {
  const j = await quoGet<{ data?: QuoPhoneNumberRow[] }>('/phone-numbers');
  return Array.isArray(j.data) ? j.data : [];
}

export interface QuoCallRow {
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

/** GET /calls — the calls between ONE Quo line and ONE other number, newest
    first as Quo returns them. Quo wants exactly one participant. */
export async function listQuoCalls(input: {
  phoneNumberId: string;
  participant: string;
  createdAfter: Date;
  maxResults: number;
}): Promise<QuoCallRow[]> {
  const j = await quoGet<{ data?: QuoCallRow[] }>('/calls', {
    phoneNumberId: input.phoneNumberId,
    participants: [input.participant],
    createdAfter: input.createdAfter.toISOString(),
    maxResults: String(Math.min(100, Math.max(1, input.maxResults))),
  });
  return Array.isArray(j.data) ? j.data : [];
}

/** GET /calls/{id} — one call, to check it is what the pick says it is.
    Null when Quo has no such call (its 404). */
export async function getQuoCall(callId: string): Promise<QuoCallRow | null> {
  let j: { data?: QuoCallRow };
  try {
    j = await quoGet<{ data?: QuoCallRow }>(`/calls/${encodeURIComponent(callId)}`);
  } catch (err) {
    const d = err instanceof ApiError ? (err.details as { status?: number } | null) : null;
    if (d && d.status === 404) return null;
    throw err;
  }
  return j.data && typeof j.data === 'object' ? j.data : null;
}

export interface QuoTranscriptRow {
  callId: string;
  status: 'absent' | 'in-progress' | 'completed' | 'failed' | string;
  duration?: number | null;
  dialogue?: { content?: unknown; start?: unknown; identifier?: unknown }[] | null;
}

/** GET /call-transcripts/{callId}. Quo answers 404 for a call it never
    transcribed; that reads as `absent` here rather than an error. */
export async function getQuoTranscript(callId: string): Promise<QuoTranscriptRow> {
  try {
    const j = await quoGet<{ data?: QuoTranscriptRow }>(`/call-transcripts/${encodeURIComponent(callId)}`);
    return j.data ?? { callId, status: 'absent', dialogue: null };
  } catch (err) {
    const d = err instanceof ApiError ? (err.details as { status?: number } | null) : null;
    if (d && d.status === 404) return { callId, status: 'absent', dialogue: null };
    throw err;
  }
}
