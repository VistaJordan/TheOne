/* 0045 — invoices, vocabulary half. The database half (services/invoices.ts)
 * issues the numbers and moves the statuses; these pin the arithmetic and the
 * rules that would otherwise only be discovered by a client receiving the
 * wrong bill.
 *
 * Money is the one place rounding cannot be left to chance: a total that is
 * a hundredth out is a total somebody has to explain.
 */

import { describe, it, expect } from 'vitest';
import {
  INVOICE_STATUSES,
  formatInvoiceNumber,
  invoiceTotals,
  isEditable,
  lineAmount,
  nextActions,
} from '../packages/shared/src/invoices';

describe('a line of money', () => {
  it('multiplies and rounds to the cent', () => {
    expect(lineAmount(3, 125)).toBe(375);
    expect(lineAmount(1.5, 99.99)).toBe(149.99); // 149.985 → 149.99
    expect(lineAmount(0, 500)).toBe(0);
  });

  it('does not accumulate binary-floating-point dust', () => {
    // 0.1 × 3 is 0.30000000000000004 in IEEE 754; an invoice may not say that.
    expect(lineAmount(3, 0.1)).toBe(0.3);
  });
});

describe('what the client owes', () => {
  const lines = [
    { quantity: 2, unit_price: 150 },
    { quantity: 1, unit_price: 85.5 },
  ];

  it('adds the lines into the subtotal', () => {
    expect(invoiceTotals(lines, 0, 0).subtotal).toBe(385.5);
  });

  it('takes the discount off and puts the tax on', () => {
    const { total } = invoiceTotals(lines, 31.79, 50);
    expect(total).toBe(367.29);
  });

  it('treats a missing tax or discount as nothing, not as NaN', () => {
    const { total } = invoiceTotals(lines, 0, 0);
    expect(total).toBe(385.5);
    expect(Number.isNaN(total)).toBe(false);
  });

  it('is zero for an invoice with no lines', () => {
    expect(invoiceTotals([], 0, 0)).toEqual({ subtotal: 0, total: 0 });
  });
});

describe('the number', () => {
  it('belongs to the billing entity and the year', () => {
    expect(formatInvoiceNumber('SFM', 2026, 7)).toBe('SFM-2026-0007');
    expect(formatInvoiceNumber('BKR', 2026, 1)).toBe('BKR-2026-0001');
  });

  it('keeps counting past four digits rather than truncating', () => {
    expect(formatInvoiceNumber('SFM', 2026, 12345)).toBe('SFM-2026-12345');
  });

  it('falls back to INV when the entity is unknown or unusable', () => {
    expect(formatInvoiceNumber(null, 2026, 3)).toBe('INV-2026-0003');
    expect(formatInvoiceNumber('   ', 2026, 3)).toBe('INV-2026-0003');
    expect(formatInvoiceNumber('7-Eleven', 2026, 3)).toBe('7ELEVEN-2026-0003');
  });
});

describe('what may happen next', () => {
  it('lets a draft be sent or thrown away', () => {
    expect(nextActions('draft')).toEqual(['send', 'void']);
    expect(isEditable('draft')).toBe(true);
  });

  it('fixes an invoice the moment it is sent', () => {
    // The client is holding it: it can only be paid or voided, never edited.
    expect(isEditable('sent')).toBe(false);
    expect(nextActions('sent')).toEqual(['mark_paid', 'void']);
  });

  it('leaves a paid invoice alone', () => {
    expect(nextActions('paid')).toEqual([]);
    expect(isEditable('paid')).toBe(false);
  });

  it('lets a voided one be reopened, since the number is already spent', () => {
    expect(nextActions('void')).toEqual(['reopen']);
  });

  it('covers every status the column allows', () => {
    for (const s of INVOICE_STATUSES) expect(() => nextActions(s)).not.toThrow();
  });
});
