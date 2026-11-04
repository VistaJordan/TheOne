/* A payment request is filed once per Submit (migration 0122, Elise
 * 2026-11-04). Pressing Submit payment request twice, or a retry, used to
 * file the request twice (J and J1). The form sends a one-time submit_key;
 * the API answers a repeat with the request already filed, checked again
 * under the task lock, with a unique index behind it. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const migration = read('packages/db/migrations/0122_payment_submit_key.sql');
const service = read('apps/api/src/services/payments.ts');
const routes = read('apps/api/src/routes/payments.ts');
const page = read('apps/web/src/pages/RequestPaymentPage.tsx');

describe('payment request submitted once', () => {
  it('stores the key with a unique index per requester', () => {
    expect(migration).toContain('ADD COLUMN submit_key uuid');
    expect(migration).toMatch(/CREATE UNIQUE INDEX[\s\S]*\(requested_by, submit_key\)[\s\S]*WHERE submit_key IS NOT NULL/);
  });

  it('the route accepts the key as a uuid', () => {
    expect(routes).toContain('submit_key: z.string().uuid().nullable().optional()');
  });

  it('answers a repeat before filing, and again under the task lock', () => {
    const fn = service.slice(service.indexOf('export async function createPaymentRequest'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    const lock = body.indexOf('FOR NO KEY UPDATE');
    const first = body.indexOf('filedUnderKey({ query }');
    const second = body.indexOf('filedUnderKey(tx');
    const insert = body.indexOf('INSERT INTO payment_request');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(lock);
    expect(second).toBeGreaterThan(lock);
    expect(second).toBeLessThan(insert);
    expect(body).toContain('submit_key)');
    // A repeat raises no holds and starts no clock a second time.
    expect(body.indexOf('if (replayed) return')).toBeLessThan(body.indexOf('raiseOverageHolds'));
  });

  it('the form sends one key per request and ignores a click while sending', () => {
    expect(page).toContain('submit_key: submitKey.current');
    expect(page).toMatch(/resetForAnother = \(\) => \{\s*submitKey\.current = crypto\.randomUUID\(\)/);
    expect(page).toMatch(/if \(sending\.current\) return;/);
    // The only mutate is the one inside send(), behind the guard.
    expect(page.match(/submitMutation\.mutate\(/g)).toHaveLength(1);
  });
});
