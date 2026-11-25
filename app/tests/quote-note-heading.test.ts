// UAT (Elise, 2026-11-25): a section's note to the customer is headed
// "Note to customer:" in the client text and on the printed quote, as the
// specs are headed "Specs:".
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAutoSummary, computeQuoteTotals } from '../apps/api/src/services/quotes';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('note to customer heading', () => {
  it('heads each section note in the client text', () => {
    const line = (amount: number) => ({ line_type: 'labor', description: 'Labor tech 1', qty: 1, rate: amount, ot: false, day: 1, amount, tax_pct: 0, markup_pct: 0 });
    const base = { name: null, scope_lines: [], approved_at: null, locked: false, include_in_summary: true, narrative_reported: null, specs: null };
    const sections = [
      { ...base, id: 'i', kind: 'incurred', label: 'Incurred', subtotal: 200, lines: [line(200)], note_to_customer: 'Incurred note here' },
      { ...base, id: 'o', kind: 'option', label: 'Option A', subtotal: 100, lines: [line(100)], note_to_customer: 'Option note here' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totals = computeQuoteTotals({ sections: sections as any, sales_tax_pct: 0, total_rule: 'incurred_plus_option', approved_section_id: null, nte: null, total_cost: null } as any);
    const ctx = { client: null, store: null, city: null, state: null, ext_name: null, trade: null, title: null, note_to_customer: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = buildAutoSummary(ctx as any, sections as any, totals);
    expect(text).toMatch(/Note to customer:\nIncurred note here/);
    expect(text).toMatch(/Note to customer:\nOption note here/);
  });

  it('heads the note on the printed quote', () => {
    const src = read('apps/web/src/pages/QuotePrintPage.tsx');
    expect(src).toContain('<b>Note to customer:</b> {section.note_to_customer}');
    expect(src).toContain('<b>Note to customer:</b> {incurred.note_to_customer}');
    expect(src).toContain('<h3>Note to customer</h3>');
  });
});
