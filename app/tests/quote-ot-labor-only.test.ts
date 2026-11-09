// Overtime is for labor only (Elise, 2026-11-09): a trip, a part, a material,
// a fee or a discount never bills at the OT multiplier, whatever its `ot`
// flag says — the builder hides the tick, the save stores false, and every
// price reads lineBillsOt.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lineBillsOt, lineTakesOt } from '../packages/shared/src/quoteDefaults';
import { computeLineAmount } from '../apps/api/src/services/quotes';
import { lineAmount } from '../apps/web/src/lib/quoteTotals';
import type { DraftLine } from '../apps/web/src/lib/quoteDraft';

const root = join(__dirname, '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');

describe('OT is labor only', () => {
  it('only the labor type takes overtime', () => {
    expect(lineTakesOt('labor')).toBe(true);
    for (const t of ['service', 'part', 'material', 'fee', 'discount', '', null, undefined]) {
      expect(lineTakesOt(t)).toBe(false);
    }
    expect(lineBillsOt({ line_type: 'labor', ot: true })).toBe(true);
    expect(lineBillsOt({ line_type: 'labor', ot: false })).toBe(false);
    expect(lineBillsOt({ line_type: 'service', ot: true })).toBe(false);
    expect(lineBillsOt({ line_type: 'material', ot: true })).toBe(false);
  });

  it('the server prices an OT trip or material at its plain rate', () => {
    expect(computeLineAmount({ qty: 2, rate: 100, ot: true, line_type: 'labor' }, 1.5)).toBe(300);
    expect(computeLineAmount({ qty: 1, rate: 75, ot: true, line_type: 'service' }, 1.5)).toBe(75);
    expect(computeLineAmount({ qty: 1, rate: 80, ot: true, line_type: 'material' }, 1.5)).toBe(80);
    expect(computeLineAmount({ qty: 1, rate: 80, ot: true, line_type: 'part' }, 1.5)).toBe(80);
  });

  it('the builder prices the same way', () => {
    const line = (line_type: DraftLine['line_type']) =>
      ({ line_type, qty: '1', rate: '100', ot: true } as unknown as DraftLine);
    expect(lineAmount(line('labor'), 1.5)).toBe(150);
    expect(lineAmount(line('service'), 1.5)).toBe(100);
    expect(lineAmount(line('material'), 1.5)).toBe(100);
  });

  it('the tick is drawn on labor lines only, cleared on a type change, saved through the rule', () => {
    const table = src('apps/web/src/components/quote/LineItemsTable.tsx');
    expect(table).toMatch(/lineTakesOt\(line\.line_type\) && \(/);
    expect(table).toMatch(/const ot = lineTakesOt\(line_type\) \? line\.ot : false;/);
    expect(src('apps/web/src/lib/quoteDraft.ts')).toMatch(/ot: lineBillsOt\(line\)/);
    const api = src('apps/api/src/services/quotes.ts');
    expect(api).toMatch(/lineBillsOt\(line\) \? otMultiplier : 1/);
    expect(api).toMatch(/^\s+lineBillsOt\(line\),$/m);
    expect(src('apps/api/src/services/invoices.ts')).toMatch(/ot: lineBillsOt\(r\)/);
  });
});
