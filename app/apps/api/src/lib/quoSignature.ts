// 0054 · Verifying that a webhook really came from Quo. Pure and dependency-
// free so tests/quo-calls.test.ts can exercise it without the database.
//
// Quo signs every event with the webhook's signing key (base64). Two header
// styles exist, depending on how the webhook was created:
//
//   legacy (Settings › Webhooks, /v1 API)
//     openphone-signature: hmac;1;<timestamp>;<base64 HMAC-SHA256>
//     signed text = `${timestamp}.${body}`
//
//   Standard Webhooks (versioned API, Quo-Api-Version 2026-03-30+)
//     webhook-id, webhook-timestamp (unix seconds), webhook-signature:
//     space-separated `v1,<base64 HMAC-SHA256>` entries
//     signed text = `${id}.${timestamp}.${body}`, key may carry 'whsec_'
//
// The legacy docs say the body is signed with whitespace removed, so the raw
// body and its compact re-serialisation are both tried. Comparisons are
// constant-time.

import { createHmac, timingSafeEqual } from 'node:crypto';

export type QuoSignatureOutcome = 'ok' | 'unconfigured' | 'missing' | 'mismatch' | 'stale';

/** Standard Webhooks' recommended replay window. */
const TOLERANCE_SECONDS = 5 * 60;

export function verifyQuoSignature(
  headers: Record<string, unknown>,
  rawBody: string,
  secret: string | null,
  nowMs: number = Date.now(),
): QuoSignatureOutcome {
  if (!secret) return 'unconfigured';
  const key = decodeKey(secret);
  const bodies = candidateBodies(rawBody);

  const legacy = header(headers, 'openphone-signature');
  if (legacy) {
    const parts = legacy.split(';');
    if (parts.length !== 4 || parts[0] !== 'hmac') return 'mismatch';
    const [, , timestamp, signature] = parts;
    return bodies.some((b) => equalB64(hmac(key, `${timestamp}.${b}`), signature)) ? 'ok' : 'mismatch';
  }

  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signatures) return 'missing';
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_SECONDS) return 'stale';
  const presented = signatures
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice(3));
  if (presented.length === 0) return 'mismatch';
  for (const b of bodies) {
    const expected = hmac(key, `${id}.${timestamp}.${b}`);
    if (presented.some((p) => equalB64(expected, p))) return 'ok';
  }
  return 'mismatch';
}

/** Sign like Quo does — used by the tests to produce valid headers. */
export function signQuoLegacy(secret: string, timestamp: string, body: string): string {
  return `hmac;1;${timestamp};${hmac(decodeKey(secret), `${timestamp}.${body}`)}`;
}

export function signQuoStandard(secret: string, id: string, timestamp: string, body: string): string {
  return `v1,${hmac(decodeKey(secret), `${id}.${timestamp}.${body}`)}`;
}

function decodeKey(secret: string): Buffer {
  const bare = secret.trim().replace(/^whsec_/, '');
  const decoded = Buffer.from(bare, 'base64');
  // A key that is not base64 at all decodes to nothing useful; fall back to
  // its bytes so a hand-typed secret still works end to end.
  return decoded.length > 0 && decoded.toString('base64').replace(/=+$/, '') === bare.replace(/=+$/, '')
    ? decoded
    : Buffer.from(bare, 'utf8');
}

function candidateBodies(raw: string): string[] {
  const out = [raw];
  try {
    const compact = JSON.stringify(JSON.parse(raw));
    if (compact !== raw) out.push(compact);
  } catch {
    /* not JSON — the raw text is the only candidate */
  }
  return out;
}

function hmac(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64');
}

function equalB64(a: string, b: string): boolean {
  const x = Buffer.from(a, 'base64');
  const y = Buffer.from(b.trim(), 'base64');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function header(headers: Record<string, unknown>, name: string): string | null {
  const v = headers[name];
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim() || null;
  return null;
}
