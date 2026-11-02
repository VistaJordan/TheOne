// "Paying twice" (UAT, 2026-11-02): a vendor paid by payment requests must not
// be paid again by a bill for the same work, and the other way round.
// #20 (0083) already refused negative bills and repeated bill numbers and held
// a bill above what the approved quote still owes; this closes the two gaps —
// no approved quote cost, and bills paid before the payment request.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  billNeedsHoldWithoutQuote,
  billOverOwed,
  overNte,
  overQuoteReason,
  paymentOverage,
  projectedCost,
  vendorMoneyOut,
  vendorOwed,
} from '../packages/shared/src/moneyGuards';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('a bill after the vendor was paid', () => {
  it('with an approved quote: $1,200 paid against a $1,200 cost leaves nothing owed', () => {
    const owed = vendorOwed(1200, 1200, 0);
    expect(owed).toBe(0);
    expect(billOverOwed(1200, owed, null)).toBe(true);
  });
  it('with no approved quote: any vendor money already out holds the bill', () => {
    expect(billNeedsHoldWithoutQuote(1200, 1200, null)).toBe(true);
    expect(billNeedsHoldWithoutQuote(1200, 300, null)).toBe(true);
    // Nothing paid out yet: the first bill goes through as before.
    expect(billNeedsHoldWithoutQuote(1200, 0, null)).toBe(false);
    // A manager approved the hold for this much: the retry goes through.
    expect(billNeedsHoldWithoutQuote(1200, 1200, 1200)).toBe(false);
    expect(billNeedsHoldWithoutQuote(1500, 1200, 1200)).toBe(true);
  });
  it('the service no longer returns early when there is no quote cost', () => {
    const svc = read('apps/api/src/services/vendorBills.ts');
    expect(svc).not.toMatch(/if \(quoteCost === null\) return;/);
    expect(svc).toMatch(/billNeedsHoldWithoutQuote\(cur\.total, out, cover\?\.covers\)/);
  });
});

describe('a payment request after a bill was paid', () => {
  it('approved and paid bills count beside Cost', () => {
    expect(vendorMoneyOut(null, 1200)).toBe(1200);
    expect(vendorMoneyOut(100.1, 0.2)).toBe(100.3);
    const projected = projectedCost(vendorMoneyOut(0, 1200), 1200);
    expect(projected).toBe(2400);
    expect(overNte(projected, 1500, null)).toBe(true);
    expect(overQuoteReason(projected, { total: 1800, cost: 1200 }, null)).toMatch(/negative margin/);
    expect(paymentOverage({ cost: vendorMoneyOut(0, 1200), amount: 1200, nte: 1500, nteCovers: null, quote: null, quoteCovers: null })).not.toBeNull();
  });
  it('request time, Approve / Pay and the row lock all read the bills', () => {
    const svc = read('apps/api/src/services/payments.ts');
    // The row SQL carries the bills; the lock reason and the request-time check add them.
    expect(svc).toMatch(/AS wo_bills/);
    expect(svc).toMatch(/cost: vendorMoneyOut\(moneyNum\(r\.wo_cost\), moneyNum\(r\.wo_bills\)\)/);
    expect(svc).toMatch(/cost: vendorMoneyOut\(moneyNum\(t\.rows\[0\]\.cost\), moneyNum\(t\.rows\[0\]\.bills\)\)/);
    expect(svc).toMatch(/projectedCost\(vendorMoneyOut\(moneyNum\(row\.wo_cost\), bills\), amount\)/);
    for (const m of svc.matchAll(/FROM vendor_bill b?\s*(?:\n\s*)?WHERE [^`]*?status IN \(([^)]*)\)/g)) {
      expect(m[1]).toBe("'approved', 'paid'");
    }
  });
});
