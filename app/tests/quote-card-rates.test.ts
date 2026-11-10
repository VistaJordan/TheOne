// 2026-11-10 (Elise) · labor and trip rates on the quote follow Prices: a
// Labor or Trip line with no rate takes the rate card's figure; a typed one
// is never touched.
import { describe, expect, it } from 'vitest';
import { blankLine, cardRateFor, fillCardRates, tripLine } from '../apps/web/src/lib/quoteDraft';

const card = { tech_rate: 95, helper_rate: 60, trip_rate: 85, afterhours_rate: 140, holiday_rate: 190 };

describe('rate card on quote lines', () => {
  it('labor takes the tech hour, or the named kind', () => {
    expect(cardRateFor({ line_type: 'labor', description: 'Labor tech 1' }, card)).toBe(95);
    expect(cardRateFor({ line_type: 'labor', description: 'Helper — labor' }, card)).toBe(60);
    expect(cardRateFor({ line_type: 'labor', description: 'After-hours labor' }, card)).toBe(140);
    expect(cardRateFor({ line_type: 'labor', description: 'Holiday labor' }, card)).toBe(190);
  });
  it('a Trip line takes the trip charge; other lines nothing', () => {
    expect(cardRateFor({ line_type: 'service', description: 'Trip' }, card)).toBe(85);
    expect(cardRateFor({ line_type: 'service', description: 'Trip charge' }, card)).toBe(85);
    expect(cardRateFor({ line_type: 'material', description: 'Filter' }, card)).toBeNull();
    expect(cardRateFor({ line_type: 'labor', description: '' }, null)).toBeNull();
  });
  it('fills blank and $0 rates only, and returns the same array when nothing changes', () => {
    const lines = [tripLine(0), { ...blankLine(), line_type: 'labor' as const, description: 'Labor tech 1', rate: '0.00' }, { ...blankLine(), line_type: 'labor' as const, description: 'Labor tech 2', rate: '120.00' }];
    const out = fillCardRates(lines, card);
    expect(out.map((l) => l.rate)).toEqual(['85.00', '95.00', '120.00']);
    expect(fillCardRates(out, card)).toBe(out);
    expect(fillCardRates(lines, null)).toBe(lines);
  });
});
