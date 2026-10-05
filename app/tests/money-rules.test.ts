// Cost follows the accepted payment requests; Total Invoiced follows the
// quote when the work order is invoiced. The pure halves of both rules.
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_PAYMENT_STATUSES,
  costDecision,
  costFromPayments,
  invoicedFromQuote,
  isAcceptedPaymentStatus,
  isInvoicedStatusName,
} from '@theone/shared';

describe('which payment requests count toward Cost', () => {
  it('approved, sent to Yoda and paid count; requested and rejected do not', () => {
    expect([...ACCEPTED_PAYMENT_STATUSES]).toEqual(['approved', 'sent_to_yoda', 'paid']);
    expect(isAcceptedPaymentStatus('requested')).toBe(false);
    expect(isAcceptedPaymentStatus('rejected')).toBe(false);
  });

  it('adds the accepted ones up to the cent', () => {
    const rows = [
      { status: 'approved', amount: '200.10' },
      { status: 'paid', amount: 150.2 },
      { status: 'sent_to_yoda', amount: '0.05' },
      { status: 'requested', amount: 999 },
      { status: 'rejected', amount: 999 },
    ];
    expect(costFromPayments(rows)).toEqual({ accepted: 3, cost: 350.35 });
  });

  it('has no figure when nothing is accepted', () => {
    expect(costFromPayments([{ status: 'requested', amount: 80 }])).toEqual({ accepted: 0, cost: null });
    expect(costFromPayments([])).toEqual({ accepted: 0, cost: null });
  });
});

describe('what happens to Cost after a payment decision', () => {
  it('becomes the sum while at least one request is accepted', () => {
    expect(costDecision([{ status: 'approved', amount: 200 }, { status: 'approved', amount: 150 }], false)).toEqual({ action: 'set', cost: 350 });
    // A second one rejected after approval: the first still stands.
    expect(costDecision([{ status: 'approved', amount: 200 }, { status: 'rejected', amount: 150 }], true)).toEqual({ action: 'set', cost: 200 });
  });

  it('is cleared when the last accepted request is taken back', () => {
    expect(costDecision([{ status: 'rejected', amount: 200 }], true)).toEqual({ action: 'clear' });
  });

  it('is left as typed when no request was ever accepted', () => {
    // Rejecting a request that was only ever "requested" must not wipe a cost
    // somebody typed (or an imported one).
    expect(costDecision([{ status: 'rejected', amount: 200 }], false)).toEqual({ action: 'keep' });
    expect(costDecision([], false)).toEqual({ action: 'keep' });
  });
});

describe('when Total Invoiced is stamped, and with what', () => {
  it('on Invoiced and Invoiced Not Paid, whatever the capitals', () => {
    expect(isInvoicedStatusName('Invoiced')).toBe(true);
    expect(isInvoicedStatusName('invoiced not paid')).toBe(true);
    expect(isInvoicedStatusName(' Invoiced ')).toBe(true);
    expect(isInvoicedStatusName('Ready to Invoice')).toBe(false);
    expect(isInvoicedStatusName('Done / Incurred')).toBe(false);
    expect(isInvoicedStatusName(null)).toBe(false);
  });

  it('takes the quote total to the cent, and nothing when there is no real total', () => {
    expect(invoicedFromQuote(1234.567)).toBe(1234.57);
    expect(invoicedFromQuote(0)).toBeNull();
    expect(invoicedFromQuote(null)).toBeNull();
    expect(invoicedFromQuote(Number.NaN)).toBeNull();
  });
});
