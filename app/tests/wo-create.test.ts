/* 0041 — "Add work order", vocabulary half. The database half
 * (services/woCreate.ts) does the INSERT and the duplicate refusal; these pin
 * what "the same number" means and what the person reads when the form is not
 * ready yet.
 *
 * The normalizer matters more than it looks: it is the rule that decides
 * whether two people typing the same job two ways create one work order or
 * two, and it is mirrored in SQL so the browser's live check and the API's
 * refusal never disagree.
 */

import { describe, it, expect } from 'vitest';
import {
  WO_CREATE_DEFAULT_KEYS,
  WO_CREATE_MODES,
  WO_CREATE_SECTIONS,
  describeMissing,
  isWoCreateMode,
  normalizeWoNumber,
  woCreateMissing,
  woCreateValueFilled,
  type WoCreateForm,
} from '../packages/shared/src/woCreate';

const FORM: WoCreateForm = {
  fields: [
    { key: 'Trade', label: 'Trade', type: 'dropdown', options: ['HVAC'], mode: 'required', section: 'what' },
    { key: 'Store', label: 'Store', type: 'short_text', options: [], mode: 'required', section: 'where' },
    { key: 'City', label: 'City', type: 'short_text', options: [], mode: 'optional', section: 'where' },
  ],
};

describe('the WO # is one number however it is typed', () => {
  it('ignores case, spaces and punctuation', () => {
    const forms = ['WO-39403', 'wo 39403', 'WO#39403', '39403', ' wo_39403 '];
    const seen = new Set(forms.map(normalizeWoNumber));
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe('39403');
  });

  it('keeps letters that are part of the number', () => {
    // WOT0452814 is a client's own format: only the leading "WO" goes.
    expect(normalizeWoNumber('WOT0452814')).toBe('T0452814');
    expect(normalizeWoNumber('SFM-2026-14')).toBe('SFM202614');
  });

  it('tells two genuinely different numbers apart', () => {
    expect(normalizeWoNumber('WO-39403')).not.toBe(normalizeWoNumber('WO-39404'));
  });
});

describe('what the form still needs', () => {
  it('asks for the WO # before anything else', () => {
    expect(woCreateMissing(FORM, { Trade: 'HVAC', Store: '7-11 #221' }, '  ')).toEqual(['WO #']);
  });

  it('lists only the required fields that are empty, in form order', () => {
    expect(woCreateMissing(FORM, {}, 'WO-1')).toEqual(['Trade', 'Store']);
    expect(woCreateMissing(FORM, { Trade: 'HVAC' }, 'WO-1')).toEqual(['Store']);
  });

  it('never asks for an optional field', () => {
    const missing = woCreateMissing(FORM, { Trade: 'HVAC', Store: '7-11 #221' }, 'WO-1');
    expect(missing).toEqual([]);
  });

  it('counts false as an answer but blank and empty lists as not', () => {
    expect(woCreateValueFilled(false)).toBe(true);
    expect(woCreateValueFilled(0)).toBe(true);
    expect(woCreateValueFilled('   ')).toBe(false);
    expect(woCreateValueFilled([])).toBe(false);
    expect(woCreateValueFilled(null)).toBe(false);
  });

  it('reads as a sentence', () => {
    expect(describeMissing(['Trade'])).toBe('Trade');
    expect(describeMissing(['Trade', 'Store'])).toBe('Trade and Store');
    expect(describeMissing(['Trade', 'Store', 'FM'])).toBe('Trade, Store and FM');
    expect(describeMissing([])).toBe('');
  });
});

describe('the settings a field can carry', () => {
  it('is exactly the three the column accepts', () => {
    expect([...WO_CREATE_MODES]).toEqual(['off', 'optional', 'required']);
    expect(isWoCreateMode('required')).toBe(true);
    expect(isWoCreateMode('Required')).toBe(false);
    expect(isWoCreateMode('mandatory')).toBe(false);
  });

  it('gives every field the migration switches on a section to sit in', () => {
    const placed = new Set(WO_CREATE_SECTIONS.flatMap((s) => [...s.keys]));
    for (const key of WO_CREATE_DEFAULT_KEYS) expect(placed.has(key)).toBe(true);
  });
});
