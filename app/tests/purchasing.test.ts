// 0067 — the arithmetic and the small rules of purchasing: totals and tax,
// how quotes compare, what a receipt does to an order, where a budget stands.
import { describe, expect, it } from 'vitest';
import { budgetPosition, compareQuotes, poStatusAfterReceipt, purchaseRequestProblem, purchaseTotals, quoteTotalFromLines, taxOn } from '@theone/shared';

describe('totals and tax', () => {
  it('adds the lines, then the tax on the subtotal, to the cent', () => {
    expect(purchaseTotals([{ qty: 40, unit_cost: 9.5 }, { qty: 12, unit_cost: 16 }], 8.25)).toEqual({ subtotal: 572, tax: 47.19, total: 619.19 });
    expect(purchaseTotals([{ qty: 3, unit_cost: null }], 8.25)).toEqual({ subtotal: 0, tax: 0, total: 0 });
    expect(purchaseTotals([], 0)).toEqual({ subtotal: 0, tax: 0, total: 0 });
  });

  it('tax is a percent of the amount', () => {
    expect(taxOn(100, 8.25)).toBe(8.25);
    expect(taxOn(450, 8.25)).toBe(37.13);
    expect(taxOn(100, 0)).toBe(0);
  });
});

describe('a purchase request', () => {
  it('needs a title and at least one item with a quantity', () => {
    expect(purchaseRequestProblem('Compressor', [{ description: 'Compressor', qty: 1 }])).toBeNull();
    expect(purchaseRequestProblem(' ', [{ description: 'x', qty: 1 }])).toMatch(/what is being bought/);
    expect(purchaseRequestProblem('x', [{ description: '  ', qty: 1 }])).toMatch(/at least one item/);
    expect(purchaseRequestProblem('x', [{ description: 'x', qty: 0 }])).toMatch(/quantity/);
  });
});

describe('quotes side by side', () => {
  const lines = [{ id: 'a', qty: 1 }, { id: 'b', qty: 5 }];
  const q1 = { id: 'q1', total: 495, lead_days: 5, prices: { a: 420, b: 15 } };
  const q2 = { id: 'q2', total: 482.5, lead_days: 2, prices: { a: 395, b: 17.5 } };
  const q3 = { id: 'q3', total: 450, lead_days: null, prices: {} };

  it('marks the lowest total, the fastest, and the lowest price on each line', () => {
    expect(compareQuotes(lines, [q1, q2])).toEqual({ lowest_total: 'q2', fastest: 'q2', lowest_by_line: { a: 'q2', b: 'q1' } });
  });

  it('a quote with only a total still competes on the total', () => {
    const out = compareQuotes(lines, [q1, q2, q3]);
    expect(out.lowest_total).toBe('q3');
    expect(out.fastest).toBe('q2');
    expect(out.lowest_by_line).toEqual({ a: 'q2', b: 'q1' });
  });

  it('has nothing to say with no quotes', () => {
    expect(compareQuotes(lines, [])).toEqual({ lowest_total: null, fastest: null, lowest_by_line: {} });
  });

  it('a quote’s total comes from its lines only when every line is priced', () => {
    expect(quoteTotalFromLines(lines, { a: 420, b: 15 })).toBe(495);
    expect(quoteTotalFromLines(lines, { a: 420 })).toBeNull();
    expect(quoteTotalFromLines([], {})).toBeNull();
  });
});

describe('receiving an order', () => {
  it('reads as issued, partly received or received', () => {
    expect(poStatusAfterReceipt([{ qty: 10, received_qty: 0 }])).toBe('issued');
    expect(poStatusAfterReceipt([{ qty: 10, received_qty: 4 }, { qty: 2, received_qty: 2 }])).toBe('partially_received');
    expect(poStatusAfterReceipt([{ qty: 10, received_qty: 10 }, { qty: 2, received_qty: 2 }])).toBe('received');
    expect(poStatusAfterReceipt([])).toBe('issued');
  });
});

describe('where a budget stands', () => {
  it('counts what is committed against it too', () => {
    expect(budgetPosition(2500, 560, 619.19)).toEqual({ remaining: 1320.81, used_pct: 47, over: false });
    expect(budgetPosition(1000, 800, 300)).toEqual({ remaining: -100, used_pct: 110, over: true });
  });

  it('says nothing when no budget is set', () => {
    expect(budgetPosition(null, 800, 300)).toEqual({ remaining: null, used_pct: null, over: false });
  });
});
