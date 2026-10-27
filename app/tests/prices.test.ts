// The price list (migration 0101): the pure lookup, the editor's checks, the
// fee wording, and pins on the migration and the gates.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatMarkup,
  formatPriceFee,
  priceCardProblems,
  resolvePrice,
  type PriceCard,
  type PriceCardInput,
} from '../packages/shared/src/prices';

const card = (over: Partial<PriceCard>): PriceCard => ({
  id: Math.random().toString(36).slice(2),
  billing_entity: 'BKR',
  client: null,
  client_on_file: true,
  trip_rate: null,
  materials_markup: null,
  note: null,
  position: 0,
  rates: [],
  fees: [],
  updated_at: '2026-10-27',
  ...over,
});
const rate = (label: string, trades: string[], tech: number, trip: number | null = null) => ({
  id: label, label, trades, tech_rate: tech, helper_rate: null, afterhours_rate: tech * 1.5, holiday_rate: tech * 2, trip_rate: trip,
});

const standard = card({ trip_rate: 50, materials_markup: 1.3, rates: [rate('Handyman', ['Handyman'], 80), rate('Plumber - Electrician', ['Plumbing', 'Electric'], 90)] });
const emcor = card({ client: 'EMCOR', trip_rate: 75, rates: [rate('Plumber - Electrician', ['Plumbing', 'Electric'], 75)] });
const modPizza = card({ client: 'MOD Pizza', billing_entity: 'BKR' });
const allSystems = card({ client: 'All Systems', rates: [rate('HVAC-R', ['HVAC', 'Refrigeration'], 110, 90)] });
const cards = [standard, emcor, modPizza, allSystems, card({ billing_entity: 'TPM', trip_rate: 67 })];

describe('resolvePrice', () => {
  it("uses the client's card for a trade it lists", () => {
    const p = resolvePrice(cards, 'bkr', ' emcor ', 'plumbing')!;
    expect(p.card).toBe(emcor);
    expect(p.rate?.tech_rate).toBe(75);
    expect(p.trip_rate).toBe(75);
  });
  it('falls back to the Standard card for a trade the client card does not list, keeping its own trip', () => {
    const p = resolvePrice(cards, 'BKR', 'EMCOR', 'Handyman')!;
    expect(p.rate?.tech_rate).toBe(80);
    expect(p.trip_rate).toBe(75);
    expect(p.materials_markup).toBe(1.3);
  });
  it('a client card with no rates or trip takes everything from Standard', () => {
    const p = resolvePrice(cards, 'BKR', 'MOD Pizza', 'Electric')!;
    expect(p.card).toBe(modPizza);
    expect(p.rate?.tech_rate).toBe(90);
    expect(p.trip_rate).toBe(50);
  });
  it("a row's own trip beats the card's", () => {
    expect(resolvePrice(cards, 'BKR', 'All Systems', 'HVAC')!.trip_rate).toBe(90);
  });
  it('an unknown client reads the Standard card; an unknown entity has no price', () => {
    expect(resolvePrice(cards, 'BKR', 'Nobody', 'Plumbing')!.card).toBe(standard);
    expect(resolvePrice(cards, 'SFM', 'EMCOR', 'Plumbing')).toBeNull();
    expect(resolvePrice(cards, null, 'EMCOR', 'Plumbing')).toBeNull();
  });
  it('a trade nobody prices still gives the trip', () => {
    const p = resolvePrice(cards, 'TPM', null, 'Roofing')!;
    expect(p.rate).toBeNull();
    expect(p.trip_rate).toBe(67);
  });
});

describe('priceCardProblems', () => {
  const input = (over: Partial<PriceCardInput>): PriceCardInput => ({
    billing_entity: 'AF', client: null, trip_rate: 65, materials_markup: 1.3, note: null, rates: [], fees: [], ...over,
  });
  const row = (label: string, trades: string[]) => ({ label, trades, tech_rate: 80, helper_rate: null, afterhours_rate: null, holiday_rate: null, trip_rate: null });
  it('accepts a sound card', () => {
    expect(priceCardProblems(input({ rates: [row('Handyman', ['Handyman'])], fees: [{ name: 'Jetter', amount: null, note: '$350-550' }] }))).toEqual([]);
  });
  it('refuses a trade priced twice, a row with no trade, a fee with no price', () => {
    expect(priceCardProblems(input({ rates: [row('A', ['Plumbing']), row('B', ['Plumbing', 'Electric'])] }))[0]).toMatch(/Plumbing is priced twice/);
    expect(priceCardProblems(input({ rates: [row('A', [])] }))[0]).toMatch(/pick the trade/);
    expect(priceCardProblems(input({ fees: [{ name: 'Snake', amount: null, note: null }] }))[0]).toMatch(/price or a note/);
    expect(priceCardProblems(input({ billing_entity: ' ' }))[0]).toMatch(/entity/);
  });
});

describe('wording', () => {
  it('prints a fee as the sheet did', () => {
    expect(formatPriceFee({ amount: 250, note: null })).toBe('$250.00');
    expect(formatPriceFee({ amount: null, note: '$350-550' })).toBe('$350-550');
    expect(formatPriceFee({ amount: 0, note: 'No fee' })).toBe('No fee');
    expect(formatMarkup(1.3)).toBe('Up to ×1.3');
  });
});

describe('migration 0101 and the gates', () => {
  const root = resolve(__dirname, '..');
  const sql = readFileSync(resolve(root, 'packages/db/migrations/0101_price_list.sql'), 'utf8');
  it('loads the five price tabs and grants change to admin only', () => {
    expect(sql.match(/INSERT INTO price_card /g)).toHaveLength(46);
    expect(sql.match(/INSERT INTO price_rate /g)).toHaveLength(197);
    expect(sql.match(/INSERT INTO price_fee /g)).toHaveLength(118);
    for (const e of ['SFM', 'BKR', 'TPM', 'AF', 'RF']) expect(sql).toContain(`'${e}', NULL,`);
    expect(sql).toMatch(/'view', true, 'create', true, 'edit', true, 'delete', true\)\)\s+WHERE code = 'admin'/);
    expect(sql).toMatch(/jsonb_build_object\('view', true\)\)\s+WHERE code <> 'admin'/);
    // No foreign key to principal: the seed truncates principal and the list must survive.
    expect(sql).not.toMatch(/REFERENCES principal/);
  });
  it('every write route asks its own grant, and the quote rate reads the list', () => {
    const svc = readFileSync(resolve(root, 'apps/api/src/services/prices.ts'), 'utf8');
    expect(svc).toMatch(/PRICES_PERM_KEY, 'create'/);
    expect(svc).toMatch(/PRICES_PERM_KEY, 'edit'/);
    expect(svc).toMatch(/PRICES_PERM_KEY, 'delete'/);
    expect(svc).toMatch(/PRICES_PERM_KEY, 'view'/);
    expect(readFileSync(resolve(root, 'apps/api/src/services/rates.ts'), 'utf8')).toMatch(/priceFor\(/);
    expect(readFileSync(resolve(root, 'packages/db/src/seed.ts'), 'utf8')).not.toMatch(/price_card|price_rate|price_fee/);
    // Deployed before 0101 runs: quotes keep their old rate card, the page says why.
    expect(svc).toMatch(/if \(notMigrated\(e\)\) return null;/);
    expect(svc).toMatch(/PRICES_NOT_MIGRATED/);
  });
});
