/* Rules 7.3.1–7.3.3 — the Escalation Tracker, the two halves that are pure:
 * the webhook's shared-secret check (7.3.2) and the inbox order that pins an
 * escalated work order to the top of the manager's to-do list (7.3.3). The
 * database half (services/escalations.ts) is exercised against the live site. */

import { describe, it, expect } from 'vitest';
import { checkWebhookSecret, presentedSecret } from '../apps/api/src/lib/webhookAuth';
import { compareInboxRows, type InboxOrderable } from '../apps/web/src/lib/inboxOrder';

describe('presentedSecret — where the email tool may put the secret', () => {
  it('reads x-webhook-secret first', () => {
    expect(presentedSecret({ 'x-webhook-secret': ' s3cret ' })).toBe('s3cret');
  });
  it('falls back to Authorization: Bearer', () => {
    expect(presentedSecret({ authorization: 'Bearer abc' })).toBe('abc');
    expect(presentedSecret({ authorization: 'bearer   abc  ' })).toBe('abc');
  });
  it('ignores other Authorization schemes and empty headers', () => {
    expect(presentedSecret({ authorization: 'Basic abc' })).toBeNull();
    expect(presentedSecret({ 'x-webhook-secret': '' })).toBeNull();
    expect(presentedSecret({})).toBeNull();
  });
  it('takes the first value of a repeated header', () => {
    expect(presentedSecret({ 'x-webhook-secret': ['one', 'two'] })).toBe('one');
  });
});

describe('checkWebhookSecret — the door is bolted until a key is cut', () => {
  it('is unconfigured with no secret in the environment, whatever is presented', () => {
    expect(checkWebhookSecret('anything', null)).toBe('unconfigured');
    expect(checkWebhookSecret(null, null)).toBe('unconfigured');
    expect(checkWebhookSecret(null, '')).toBe('unconfigured');
  });
  it('wants a secret once one is configured', () => {
    expect(checkWebhookSecret(null, 'k')).toBe('missing');
  });
  it('matches only the exact secret, whatever the lengths', () => {
    expect(checkWebhookSecret('k', 'k')).toBe('ok');
    expect(checkWebhookSecret('K', 'k')).toBe('mismatch');
    expect(checkWebhookSecret('kk', 'k')).toBe('mismatch');
    expect(checkWebhookSecret('k', 'a-much-longer-secret')).toBe('mismatch');
  });
});

describe('compareInboxRows — escalated first, then oldest first (7.2.2 + 7.3.3)', () => {
  const row = (escalated: boolean, raised_at: string): InboxOrderable => ({ escalated, raised_at });
  const oldPlain = row(false, '2026-09-01T00:00:00Z');
  const newPlain = row(false, '2026-09-10T00:00:00Z');
  const oldEsc = row(true, '2026-09-02T00:00:00Z');
  const newEsc = row(true, '2026-09-11T00:00:00Z');

  it('pins escalated rows above everything else in the waiting lanes', () => {
    const sorted = [newPlain, newEsc, oldPlain, oldEsc].sort((a, b) => compareInboxRows('open', a, b));
    expect(sorted).toEqual([oldEsc, newEsc, oldPlain, newPlain]);
  });
  it('does the same in the For-me and My-requests lanes', () => {
    for (const lane of ['mine', 'requests'] as const) {
      const sorted = [newPlain, oldPlain, newEsc].sort((a, b) => compareInboxRows(lane, a, b));
      expect(sorted).toEqual([newEsc, oldPlain, newPlain]);
    }
  });
  it('leaves the Done lane newest first and unpinned', () => {
    const sorted = [oldEsc, newPlain, oldPlain, newEsc].sort((a, b) => compareInboxRows('done', a, b));
    expect(sorted).toEqual([newEsc, newPlain, oldEsc, oldPlain]);
  });
});
