/* 0046 — contracts and labor rates, vocabulary half. The database half
 * (services/contracts.ts) fetches the candidates; these pin WHICH contract
 * wins and WHAT its rates come to, because a wrong answer here is a wrong
 * price on a quote a client has already seen.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OT_MULTIPLIER,
  billableHours,
  contractInForce,
  contractScore,
  otMultiplierFrom,
  pickContract,
  resolveRates,
  type Contract,
  type ContractRate,
} from '../packages/shared/src/contracts';

const rate = (rate_type: ContractRate['rate_type'], amount: number, trade: string | null = null): ContractRate => ({
  id: `${rate_type}-${trade ?? 'any'}`,
  rate_type,
  trade,
  amount,
  position: 0,
});

const contract = (over: Partial<Contract>): Contract => ({
  id: over.id ?? 'c',
  name: over.name ?? 'Card',
  client: null,
  billing_entity: null,
  kind: 'tm',
  account_code: null,
  starts_on: '2026-01-01',
  ends_on: null,
  active: true,
  sites_covered: [],
  trades_covered: [],
  notes: null,
  created_by: null,
  created_at: '',
  updated_at: '',
  rates: [],
  in_force: true,
  ...over,
});

const TODAY = '2026-09-21';

describe('whether a contract is in force', () => {
  it('needs to be active and to include today', () => {
    expect(contractInForce({ active: true, starts_on: '2026-01-01', ends_on: null }, TODAY)).toBe(true);
    expect(contractInForce({ active: false, starts_on: '2026-01-01', ends_on: null }, TODAY)).toBe(false);
    expect(contractInForce({ active: true, starts_on: '2026-10-01', ends_on: null }, TODAY)).toBe(false);
    expect(contractInForce({ active: true, starts_on: '2026-01-01', ends_on: '2026-06-30' }, TODAY)).toBe(false);
    expect(contractInForce({ active: true, starts_on: '2026-01-01', ends_on: TODAY }, TODAY)).toBe(true);
  });
});

describe('which contract covers a work order', () => {
  const subject = { client: "Wendy's", billing_entity: 'SFM', trade: 'HVAC', site: '1234' };
  const house = contract({ id: 'house', name: 'House rates' });
  const byClient = contract({ id: 'client', name: "Wendy's", client: "wendy's" });
  const byClientEntity = contract({ id: 'ce', name: "Wendy's via SFM", client: "Wendy's", billing_entity: 'sfm' });
  const otherClient = contract({ id: 'other', name: 'Arby', client: 'Arby' });

  it('matches the client case-insensitively and prefers the more specific card', () => {
    expect(pickContract([house, byClient, otherClient], subject, TODAY)?.id).toBe('client');
    expect(pickContract([house, byClient, byClientEntity], subject, TODAY)?.id).toBe('ce');
    expect(pickContract([house], subject, TODAY)?.id).toBe('house');
  });

  it('refuses a card whose trade or site list does not include the work order', () => {
    const plumbingOnly = contract({ id: 'pl', client: "Wendy's", trades_covered: ['Plumbing'] });
    const storeList = contract({ id: 'st', client: "Wendy's", sites_covered: ['9999'] });
    expect(contractScore(plumbingOnly, subject, TODAY)).toBe(-1);
    expect(contractScore(storeList, subject, TODAY)).toBe(-1);
    expect(pickContract([plumbingOnly, storeList], subject, TODAY)).toBeNull();
  });

  it('ranks a named trade or site above "all"', () => {
    const hvac = contract({ id: 'hvac', client: "Wendy's", trades_covered: ['hvac'] });
    expect(pickContract([byClient, hvac], subject, TODAY)?.id).toBe('hvac');
  });

  it('breaks a tie in favour of the newer agreement', () => {
    const older = contract({ id: 'old', client: "Wendy's", starts_on: '2025-01-01' });
    const newer = contract({ id: 'new', client: "Wendy's", starts_on: '2026-06-01' });
    expect(pickContract([older, newer], subject, TODAY)?.id).toBe('new');
  });

  it('ignores an expired or inactive card', () => {
    const expired = contract({ id: 'exp', client: "Wendy's", ends_on: '2026-01-31' });
    const off = contract({ id: 'off', client: "Wendy's", active: false });
    expect(pickContract([expired, off, house], subject, TODAY)?.id).toBe('house');
  });
});

describe('what the rates come to', () => {
  it('takes the trade-specific row over the general one', () => {
    const r = resolveRates(
      [rate('standard', 55), rate('standard', 95, 'HVAC'), rate('overtime', 82.5), rate('trip_charge', 45)],
      'hvac',
    );
    expect(r.standard).toBe(95);
    expect(r.overtime).toBe(82.5);
    expect(r.trip_charge).toBe(45);
    expect(r.markup_pct).toBeNull();
  });

  it('derives the overtime multiplier from the two hourly rates', () => {
    expect(otMultiplierFrom(55, 82.5)).toBe(1.5);
    expect(otMultiplierFrom(60, 120)).toBe(2);
    expect(otMultiplierFrom(90, 120)).toBe(1.333);
  });

  it('falls back to the house ×1.5 when a rate is missing or nonsense', () => {
    expect(otMultiplierFrom(null, 82.5)).toBe(DEFAULT_OT_MULTIPLIER);
    expect(otMultiplierFrom(55, null)).toBe(DEFAULT_OT_MULTIPLIER);
    expect(otMultiplierFrom(0, 82.5)).toBe(DEFAULT_OT_MULTIPLIER);
    expect(resolveRates([], 'HVAC').ot_multiplier).toBe(DEFAULT_OT_MULTIPLIER);
  });
});

describe('hours on site', () => {
  it('rounds to the quarter hour and never goes negative', () => {
    expect(billableHours('2026-09-21T08:00:00Z', '2026-09-21T10:20:00Z')).toBe(2.25);
    expect(billableHours('2026-09-21T08:00:00Z', '2026-09-21T08:05:00Z')).toBe(0);
    expect(billableHours('2026-09-21T10:00:00Z', '2026-09-21T08:00:00Z')).toBe(0);
  });

  it('is nothing until the visit is checked out', () => {
    expect(billableHours('2026-09-21T08:00:00Z', null)).toBe(0);
    expect(billableHours(null, null)).toBe(0);
  });
});
