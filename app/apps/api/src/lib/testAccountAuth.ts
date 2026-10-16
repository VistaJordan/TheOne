// UAT follow-up T1 — the pure half of the test sign-in: the password check and
// the failed-attempt limiter. No database, no environment (config.ts reads
// TEST_ACCOUNTS_* and hands the values in).

import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time: both sides are hashed to 32 bytes first, so neither the
    comparison nor its length leaks how much of the guess was right. */
export function testPasswordMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Failed tries per key (the caller's IP) inside a sliding window. In memory,
 * per process: on Vercel each warm instance keeps its own count, so the real
 * ceiling is `max` per instance per window — fine for a test door that is off
 * in production unless someone switches it on, not a substitute for a shared
 * store if it ever guards something real. Old entries are pruned on every call
 * so the map cannot grow without bound.
 */
export class AttemptLimiter {
  private readonly fails = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length) this.fails.set(key, kept);
    else this.fails.delete(key);
    return kept;
  }

  /** True once `max` failures sit inside the window. */
  blocked(key: string, now = Date.now()): boolean {
    if (this.fails.size > 1000) for (const k of [...this.fails.keys()]) this.recent(k, now);
    return this.recent(key, now).length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    this.fails.set(key, [...this.recent(key, now), now]);
  }

  reset(): void {
    this.fails.clear();
  }
}

/** UAT T1 · a short fingerprint of the test password, stored on each test
    session (`session.test_password_fp`, migration 0087) so rotating the
    password ends every session issued under the old one. 16 hex characters
    of a sha256 — enough to tell two passwords apart, too little to be worth
    attacking (the hash of a low-entropy password is guessable either way,
    which is why the column holds only a prefix and the password must not be
    a dictionary word on a public deployment). */
export function testPasswordFingerprint(password: string): string {
  return createHash('sha256').update(`theone-test-session:${password}`, 'utf8').digest('hex').slice(0, 16);
}

/** May a loaded session stand? Anyone who is not a test account: yes. A test
    account: only while the feature is on (`currentPassword` set) and the
    session carries the fingerprint of that very password. */
export function testSessionAllowed(
  isTestAccount: boolean,
  sessionFp: string | null | undefined,
  currentPassword: string | null | undefined,
): boolean {
  if (!isTestAccount) return true;
  if (!currentPassword || !sessionFp) return false;
  return sessionFp === testPasswordFingerprint(currentPassword);
}
