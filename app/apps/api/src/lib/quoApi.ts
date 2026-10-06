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

export function quoApiReady(): boolean {
  return Boolean(config.quoApiKey && config.quoFromNumber);
}

export interface QuoSentMessage { id: string | null }

/** POST /messages — one text from the configured line to one recipient. */
export async function sendQuoText(to: string, content: string): Promise<QuoSentMessage> {
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
