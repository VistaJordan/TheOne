/* Elise, 2026-10-28 — a payment that goes over is asked for its reason.
 *
 *   - A payment request that takes Cost past the NTE or past the approved
 *     quote is still filed, but the API answers 409 PAYMENT_OVERAGE_REASON
 *     until the requester gives a reason (the form's popup). The hold is
 *     raised as the request is filed, with the reason, so the manager sees it
 *     in Approvals before anyone clicks Approve — not afterwards.
 *   - Such a request is never auto-approved (0090's under-$500 rule).
 *   - Paying more than the approved quote is decided by ATL and above
 *     (ATL, TL, AM, Admin, a super admin) — never OP Admin.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OVER_QUOTE_DECIDER_ROLES,
  OVERAGE_REASON_MIN,
  PAYMENT_OVERAGE_REASON_CODE,
  mayDecideOverQuote,
  paymentOverage,
  paymentOverageSentence,
} from '../packages/shared/src/moneyGuards';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const base = { cost: 400, amount: 100, nte: 1000, nteCovers: null, quote: null, quoteCovers: null };

describe('paymentOverage', () => {
  it('nothing over = null', () => {
    expect(paymentOverage(base)).toBeNull();
    expect(paymentOverage({ ...base, nte: null })).toBeNull();
  });

  it('past the NTE names the NTE and how far over', () => {
    const o = paymentOverage({ ...base, amount: 700 });
    expect(o?.projected).toBe(1100);
    expect(o?.nte).toEqual({ nte: 1000, over_by: 100 });
    expect(o?.quote).toBeNull();
  });

  it('an approved override that covers the projection lets it through', () => {
    expect(paymentOverage({ ...base, amount: 700, nteCovers: 1100 })).toBeNull();
    expect(paymentOverage({ ...base, amount: 701, nteCovers: 1100 })?.nte).not.toBeNull();
  });

  it('past the approved quote (price or cost side) names the quote', () => {
    const o = paymentOverage({ ...base, nte: null, quote: { total: 800, cost: 450 } });
    expect(o?.quote?.reason).toMatch(/approved quote's cost/);
    expect(o?.quote?.cost).toBe(450);
    expect(paymentOverage({ ...base, nte: null, quote: { total: 800, cost: 450 }, quoteCovers: 500 })).toBeNull();
  });

  it('both at once', () => {
    const o = paymentOverage({ ...base, amount: 700, quote: { total: 900, cost: 600 } });
    expect(o?.nte).not.toBeNull();
    expect(o?.quote).not.toBeNull();
    expect(paymentOverageSentence(o!)).toMatch(/over the client NTE.*it also/);
  });
});

describe('who decides paying over the quote', () => {
  it('ATL and above, never OP Admin or the dispatchers', () => {
    expect([...OVER_QUOTE_DECIDER_ROLES].sort()).toEqual(['admin', 'am', 'atl', 'tl']);
    for (const r of ['atl', 'tl', 'am', 'admin']) expect(mayDecideOverQuote(r, false)).toBe(true);
    for (const r of ['oa', 'om', 'om_probation', 'senior_om', 'ap', 'ar', null]) expect(mayDecideOverQuote(r, false)).toBe(false);
    expect(mayDecideOverQuote('oa', true)).toBe(true);
  });
});

describe('the wiring (source pins)', () => {
  const payments = read('apps/api/src/services/payments.ts');
  const create = payments.slice(
    payments.indexOf('export async function createPaymentRequest('),
    payments.indexOf('export interface PaymentEditInput'),
  );

  it('createPaymentRequest asks for the reason before writing, and raises the hold after', () => {
    expect(create.indexOf('requireOverageReason(')).toBeGreaterThan(-1);
    expect(create.indexOf('requireOverageReason(')).toBeLessThan(create.indexOf('withTransaction('));
    expect(create).toContain('overage_reason)');
    expect(create.indexOf('raiseOverageHolds(')).toBeGreaterThan(create.indexOf('withTransaction('));
  });

  it('the 409 carries the code the form listens for', () => {
    expect(PAYMENT_OVERAGE_REASON_CODE).toBe('PAYMENT_OVERAGE_REASON');
    expect(OVERAGE_REASON_MIN).toBeGreaterThan(0);
    expect(payments).toContain('code: PAYMENT_OVERAGE_REASON_CODE');
    const page = read('apps/web/src/pages/RequestPaymentPage.tsx');
    expect(page).toContain('PAYMENT_OVERAGE_REASON_CODE');
    expect(page).toContain('<OverageReasonDialog');
  });

  it('a re-priced request is asked again', () => {
    const edit = payments.slice(payments.indexOf('export async function updatePaymentRequest('));
    expect(edit.slice(0, edit.indexOf('const LABEL'))).toContain('requireOverageReason(');
  });

  it('approve, reject and claim of an over-quote hold check the level', () => {
    const approvals = read('apps/api/src/services/approvals.ts');
    for (const fn of ['approveApprovalTask(', 'rejectApprovalTask(', 'claimApprovalTask(']) {
      const body = approvals.slice(approvals.indexOf(`export async function ${fn}`));
      expect(body.slice(0, body.indexOf('\n}\n'))).toContain('requireOverQuoteLevel(');
    }
  });

  it('migration 0107 adds the column', () => {
    expect(read('packages/db/migrations/0107_payment_overage_reason.sql')).toContain('ADD COLUMN IF NOT EXISTS overage_reason text');
  });
});
