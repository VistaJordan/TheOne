/* 0047 — vendor bills, vocabulary half. The database half (services/
 * vendorBills.ts) records and moves them; these pin the verbs each status
 * allows and the arithmetic, which is the client invoice's on purpose.
 */

import { describe, it, expect } from 'vitest';
import {
  VENDOR_BILL_STATUSES,
  vendorBillEditable,
  vendorBillLineAmount,
  vendorBillNextActions,
  vendorBillTotals,
} from '../packages/shared/src/vendorBills';

describe('what may be done to a bill', () => {
  it('can be approved, disputed or voided while received', () => {
    expect(vendorBillNextActions('received')).toEqual(['approve', 'dispute', 'void']);
  });

  it('can only be paid, disputed or voided once approved', () => {
    expect(vendorBillNextActions('approved')).toEqual(['mark_paid', 'dispute', 'void']);
  });

  it('comes back from a dispute, or is voided', () => {
    expect(vendorBillNextActions('disputed')).toEqual(['resolve', 'void']);
  });

  it('is finished once paid or void', () => {
    expect(vendorBillNextActions('paid')).toEqual([]);
    expect(vendorBillNextActions('void')).toEqual([]);
  });

  it('has an answer for every status', () => {
    for (const s of VENDOR_BILL_STATUSES) expect(Array.isArray(vendorBillNextActions(s))).toBe(true);
  });
});

describe('when its figures may change', () => {
  it('only before it is agreed', () => {
    expect(vendorBillEditable('received')).toBe(true);
    expect(vendorBillEditable('disputed')).toBe(true);
    expect(vendorBillEditable('approved')).toBe(false);
    expect(vendorBillEditable('paid')).toBe(false);
    expect(vendorBillEditable('void')).toBe(false);
  });
});

describe('its money', () => {
  it('is the same integer-cent arithmetic as the client invoice', () => {
    expect(vendorBillLineAmount(1.5, 99.99)).toBe(149.99);
    expect(vendorBillLineAmount(3, 0.1)).toBe(0.3);
  });

  it('adds the lines and puts the tax on', () => {
    const { subtotal, total } = vendorBillTotals(
      [
        { quantity: 2, unit_price: 150 },
        { quantity: 1, unit_price: 85.5 },
      ],
      31.79,
    );
    expect(subtotal).toBe(385.5);
    expect(total).toBe(417.29);
  });
});
