// Only an SFM work order's quote carries tax (Elise, 2026-11-04): every other
// billing entity's quote has no sales tax and no per-line tax, in the total or
// on the screen, the printed quote, the text summary or the invoice prefill.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUOTE_TAX_ENTITY, quoteTaxApplies } from '../packages/shared/src/quoteTax';
import { computeQuoteTotals, type TotalsInput } from '../apps/api/src/services/quotes';
import { sumLines } from '../apps/web/src/lib/quoteTotals';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const input: TotalsInput = {
  sections: [
    { id: 'i', kind: 'incurred', label: 'Incurred', name: null, include_in_summary: false, lines: [{ qty: 1, rate: 100, ot: false }] },
    { id: 'a', kind: 'option', label: 'Option A', name: null, include_in_summary: true, lines: [{ qty: 1, rate: 400, ot: false, tax_pct: 5 }] },
  ],
  sales_tax_pct: 8,
  total_rule: 'incurred_plus_option',
  total_cost: null,
  nte: null,
};

describe('quoteTaxApplies', () => {
  it('is true for SFM only, whatever the spelling', () => {
    expect(QUOTE_TAX_ENTITY).toBe('SFM');
    expect(quoteTaxApplies('SFM')).toBe(true);
    expect(quoteTaxApplies(' sfm ')).toBe(true);
    for (const e of ['BKR', 'AF', 'TPM', 'RF', 'EDS', '', null, undefined]) expect(quoteTaxApplies(e)).toBe(false);
  });
});

describe('computeQuoteTotals with tax_applies', () => {
  it('adds the sales tax and the line tax by default (SFM)', () => {
    const t = computeQuoteTotals(input);
    expect(t.sales_tax).toBe(40); // (100 + 400) × 8%
    expect(t.line_tax).toBe(20); // 400 × 5%
    expect(t.grand_total).toBe(560);
  });

  it('adds no tax at all when the quote carries none (not SFM)', () => {
    const t = computeQuoteTotals({ ...input, tax_applies: false });
    expect(t.sales_tax).toBe(0);
    expect(t.sales_tax_pct).toBe(0);
    expect(t.line_tax).toBe(0);
    expect(t.option_totals[0].tax).toBe(0);
    expect(t.grand_total).toBe(500);
  });

  it('the builder drops line tax the same way', () => {
    const line = { key: 'l', line_type: 'part', description: 'x', qty: '1', rate: '400', day_value: '1', ot: false, uom: '', tax_pct: '5' };
    expect(sumLines([line as never], 1.5, true).tax).toBe(20);
    expect(sumLines([line as never], 1.5, false).tax).toBe(0);
  });
});

describe('every reader asks the rule', () => {
  it('the API quote, its snapshot, the sales-tax lookup and the invoice prefill', () => {
    const quotes = read('apps/api/src/services/quotes.ts');
    expect(quotes).toContain('tax_applies: quoteTaxApplies(q.billing_entity)');
    expect(quotes).toContain('tax_applies: quoteTaxApplies(head?.billing_entity)');
    expect(quotes).toContain("source: 'entity_not_taxed'");
    expect(quotes).toContain('tax_applies: taxApplies');
    expect(read('apps/api/src/services/invoices.ts')).toContain('quoteTaxApplies(res.rows[0]?.billing_entity)');
  });

  it('the builder passes it to the totals, the rail and the line tables', () => {
    const page = read('apps/web/src/pages/QuoteBuilderPage.tsx');
    expect(page).toContain('computeQuoteTotals(draft, draft.is_cost_tbd ? null : totalCost, otMult, taxApplies)');
    expect(page).toContain('taxApplies={taxApplies}');
    expect(page).toContain('showTax={taxApplies}');
  });
});
