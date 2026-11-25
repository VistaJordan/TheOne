// UAT #27 follow-up (2026-11-25): the client text prints the incurred work's
// sales tax in dollars under Total incurred, and each option its own share, so
// the two add up to the option's grand total.
import { describe, expect, it } from 'vitest';
import { buildAutoSummary, computeQuoteTotals } from '../apps/api/src/services/quotes';

describe('sales tax under Incurred in the client text', () => {
  it('prints the incurred tax and the option share', () => {
    const line = (amount: number) => ({ line_type: 'labor', description: 'Labor tech 1', qty: 1, rate: amount, ot: false, day: 1, amount, tax_pct: 0, markup_pct: 0 });
    const sections = [
      { id: 'i', kind: 'incurred', label: 'Incurred', name: null, scope_lines: [], approved_at: null, locked: false, include_in_summary: true, narrative_reported: null, subtotal: 200, lines: [line(200)] },
      { id: 'o', kind: 'option', label: 'Option A', name: null, scope_lines: [], approved_at: null, locked: false, include_in_summary: true, narrative_reported: null, subtotal: 100, lines: [line(100)] },
    ];
    const totals = computeQuoteTotals({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sections: sections as any,
      sales_tax_pct: 10,
      total_rule: 'incurred_plus_option',
      approved_section_id: null,
      nte: null,
      total_cost: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const ctx = { client: null, store: null, city: null, state: null, ext_name: null, trade: null, title: null, note_to_customer: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = buildAutoSummary(ctx as any, sections as any, totals);
    const incurredAt = text.indexOf('Total incurred');
    const proposedAt = text.indexOf('PROPOSED');
    const between = text.slice(incurredAt, proposedAt);
    expect(between).toMatch(/Sales tax \(10%\)[^\n]*\$20\.00/);
    expect(text.slice(proposedAt)).toMatch(/Sales tax \(10%\)[^\n]*\$10\.00/);
    expect(totals.grand_total).toBe(330);
  });
});
