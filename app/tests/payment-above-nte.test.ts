/* Elise, 2026-11-03 — a payment above the NTE is approved by the AM, with a reason.
 *
 *   - An OM / Senior OM / OM Under Probation's request that takes Cost past
 *     the client NTE is filed with their reason (0107, unchanged).
 *   - An Account Manager (or a super admin) approves it on the payment
 *     itself, whatever the amount band, and must say why (409
 *     NTE_APPROVAL_REASON until a reason is sent). Anyone else is 403
 *     NTE_PAYMENT_APPROVER.
 *   - That approval approves (or files approved) the NTE override for the
 *     projected cost in the same transaction, so Pay and rule 1.5.2 see it
 *     covered. The approved quote still holds it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NTE_PAYMENT_APPROVER_ROLES,
  mayApproveOverNtePayment,
  paymentAboveNte,
  paymentLockReason,
} from '../packages/shared/src/moneyGuards';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('who approves a payment above the NTE', () => {
  it('the Account Manager, and a super admin', () => {
    expect(NTE_PAYMENT_APPROVER_ROLES).toEqual(['am']);
    expect(mayApproveOverNtePayment('am', false)).toBe(true);
    expect(mayApproveOverNtePayment('om', true)).toBe(true);
    for (const r of ['om', 'om_probation', 'senior_om', 'tl', 'atl', 'oa', 'ap', null]) {
      expect(mayApproveOverNtePayment(r, false)).toBe(false);
    }
  });
});

describe('paymentAboveNte', () => {
  it('Cost + amount past the NTE, whatever an override covers', () => {
    expect(paymentAboveNte(400, 700, 1000)).toBe(true);
    expect(paymentAboveNte(400, 600, 1000)).toBe(false);
    expect(paymentAboveNte(null, 1200, 1000)).toBe(true);
    expect(paymentAboveNte(400, 5000, null)).toBe(false);
  });
});

describe('the Approve lock above the NTE leaves the NTE out', () => {
  const row = {
    status: 'requested', overQuoteOpen: false, nteOverrideOpen: false,
    cost: 400, amount: 700, nte: 1000, nteCovers: null, quote: null, quoteCovers: null,
  };
  it('the NTE projection alone locks nothing for the AM', () => {
    expect(paymentLockReason(row)).toMatch(/over the client NTE/);
    expect(paymentLockReason({ ...row, ignoreNte: true })).toBeNull();
  });
  it('the approved quote still holds it', () => {
    expect(paymentLockReason({ ...row, ignoreNte: true, overQuoteOpen: true })).toMatch(/approved quote/);
  });
});

describe('wiring', () => {
  const payments = read('apps/api/src/services/payments.ts');
  const body = payments.slice(payments.indexOf('export async function approvePaymentRequest('));
  it('above the NTE: AM only, a reason, no band, the NTE decided in the same transaction', () => {
    // In nteFacts since 2026-11-09, shared with the decline.
    expect(payments).toContain('paymentAboveNte(cost, amount, nte)');
    expect(body).toContain('await nteFacts(row)');
    expect(body).toContain('NTE_PAYMENT_APPROVER_CODE');
    expect(body).toContain('NTE_APPROVAL_REASON_CODE');
    expect(body).toContain("assertPaymentNotHeld(row, actor, 'Approving this payment', true)");
    expect(body).toContain('await approveOverNte(tx, row, projected, reason, actor)');
    // The band is asked only on the within-NTE branch, before the AM's.
    expect(body.indexOf('assertTierAllows(')).toBeLessThan(body.indexOf('mayApproveOverNtePayment('));
  });
  it('the route passes the reason; the web asks for it', () => {
    expect(read('apps/api/src/routes/payments.ts')).toContain('body?.nte_reason');
    expect(read('apps/web/src/components/payments/PaymentActions.tsx')).toContain("sheet === 'nte'");
    expect(read('apps/web/src/pages/ApprovalsPage.tsx')).toContain('Approve this payment above the NTE?');
  });
});

describe('approving the NTE hold in the inbox approves its payment (2026-11-03)', () => {
  const src = read('apps/api/src/services/approvals.ts');
  const body = src.slice(src.indexOf('export async function approveApprovalTask'));
  it('an open nte_override naming a still-requested payment goes through the payment approve', () => {
    expect(body).toContain("task.type !== 'nte_override' || task.status !== 'open'");
    expect(body).toContain('payment_request_id');
    expect(body).toMatch(/paymentStillRequested\(paymentId\)\)\) \{\s+const \{ approvePaymentRequest \} = await import\('\.\/payments\.js'\);\s+await approvePaymentRequest\(paymentId, actor, note\);/);
    // Before the plain decision, which would clear the hold alone.
    expect(body.indexOf('approvePaymentRequest(paymentId')).toBeLessThan(body.indexOf("return decide(id, 'approved'"));
  });
  it('the inbox asks the AM why before approving such a hold', () => {
    const page = read('apps/web/src/pages/ApprovalsPage.tsx');
    expect(page).toContain('function nteHoldForPayment(');
    expect(page).toContain('!nteHoldForPayment(r)');
    expect(page).toContain('this approves the payment request and the NTE override');
  });
});
