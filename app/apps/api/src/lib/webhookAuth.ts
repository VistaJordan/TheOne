// Rule 7.3.2 · the shared-secret check the webhook receivers run. Pure and
// dependency-free so it can be unit-tested (tests/escalations.test.ts) without
// touching the database or the config module.
//
// The secret travels in `x-webhook-secret` or as `Authorization: Bearer …`.
// Both are compared in constant time over SHA-256 digests, so neither the
// length of the secret nor how many leading characters matched leaks through
// response timing.

import { createHash, timingSafeEqual } from 'node:crypto';

export type WebhookAuthOutcome = 'ok' | 'unconfigured' | 'missing' | 'mismatch';

/** The secret a request presented, if any. Header values may arrive as arrays
    when repeated; the first one counts. */
export function presentedSecret(headers: Record<string, unknown>): string | null {
  const direct = first(headers['x-webhook-secret']);
  if (direct) return direct;
  const auth = first(headers['authorization']);
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  return null;
}

export function checkWebhookSecret(presented: string | null, expected: string | null): WebhookAuthOutcome {
  if (!expected) return 'unconfigured';
  if (!presented) return 'missing';
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b) ? 'ok' : 'mismatch';
}

function first(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim() || null;
  return null;
}
