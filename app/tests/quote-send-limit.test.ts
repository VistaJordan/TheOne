/**
 * Elise, 2026-11-16 (migration 0143): an ATL sends quotes to the client up to
 * $5,000, adjustable per person in Admin › Users. Above the limit the ATL
 * still reviews the quote, submits it for approval, and a Team Lead (anyone
 * with no limit) sends it. Approve and Send refuse with 403 QUOTE_SEND_LIMIT.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QUOTE_SEND_LIMIT_CODE,
  QUOTE_SEND_LIMIT_DEFAULT_BY_ROLE,
  quoteOverSendLimit,
  quoteSendLimitFor,
  quoteSendLimitSentence,
  roleQuoteSendLimit,
} from '@theone/shared';

const root = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

describe('who is limited, and to how much', () => {
  it('an ATL defaults to $5,000; TL, AM and Admin have no limit', () => {
    expect(QUOTE_SEND_LIMIT_DEFAULT_BY_ROLE.atl).toBe(5000);
    expect(roleQuoteSendLimit('atl')).toBe(5000);
    for (const role of ['tl', 'am', 'admin', 'om', null]) expect(roleQuoteSendLimit(role)).toBeNull();
  });

  it("a person's own figure wins over the role's default", () => {
    expect(quoteSendLimitFor('atl', null)).toBe(5000);
    expect(quoteSendLimitFor('atl', 8000)).toBe(8000);
    expect(quoteSendLimitFor('atl', 0)).toBe(0);
    expect(quoteSendLimitFor('tl', 2500)).toBe(2500);
  });

  it('a super admin is never limited', () => {
    expect(quoteSendLimitFor('atl', 1000, true)).toBeNull();
  });
});

describe('over the limit', () => {
  it('compares to the cent, the limit itself is allowed', () => {
    expect(quoteOverSendLimit(5000, 5000)).toBe(false);
    expect(quoteOverSendLimit(5000.01, 5000)).toBe(true);
    expect(quoteOverSendLimit(99999, null)).toBe(false);
    expect(quoteOverSendLimit(null, 5000)).toBe(false);
  });

  it('the sentence names both figures and who sends it, and no rule number', () => {
    const s = quoteSendLimitSentence(7250, 5000);
    expect(s).toContain('$7,250.00');
    expect(s).toContain('$5,000.00');
    expect(s).toContain('Team Lead');
    expect(s).not.toMatch(/rule \d/i);
  });
});

describe('where it is enforced', () => {
  const quotes = read('apps', 'api', 'src', 'services', 'quotes.ts');

  it('Approve and Send both ask the limit', () => {
    const approve = quotes.slice(quotes.indexOf('export async function approveQuote'), quotes.indexOf('const QUOTE_APPROVABLE_FROM'));
    const send = quotes.slice(quotes.indexOf('export async function sendQuote'));
    expect(approve).toContain('await assertWithinSendLimit(taskId, actor);');
    expect(send.slice(0, 600)).toContain('await assertWithinSendLimit(taskId, actor);');
    expect(quotes).toContain('code: QUOTE_SEND_LIMIT_CODE');
    expect(QUOTE_SEND_LIMIT_CODE).toBe('QUOTE_SEND_LIMIT');
  });

  it('the quote payload carries the limit for the builder', () => {
    expect(quotes).toContain('send_limit: sendLimit,');
    expect(quotes).toContain('over_send_limit: quoteOverSendLimit(grandTotal, sendLimit),');
  });

  it('the builder locks Send and offers Submit for approval above the limit', () => {
    const builder = read('apps', 'web', 'src', 'pages', 'QuoteBuilderPage.tsx');
    expect(builder).toContain('const canSend = canApprove && !overSendLimit;');
    expect(builder).toContain("gated('Send to client', 'send', canSend, sendLockTip, 'quote.send'");
  });

  it('Admin › Users sets it per person, never on oneself, logged', () => {
    const route = read('apps', 'api', 'src', 'routes', 'admin.ts');
    const users = read('apps', 'api', 'src', 'services', 'users.ts');
    expect(route).toContain("app.put('/admin/users/:id/quote-send-limit'");
    expect(users).toContain("assertNotSelfEdit(id, actorId, 'quote_send_limit');");
    expect(users).toContain("action: 'user_quote_send_limit_changed'");
    const mig = read('packages', 'db', 'migrations', '0143_quote_send_limit.sql');
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS quote_send_limit numeric\(12,2\)/);
  });
});
