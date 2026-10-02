// 0063 — the pure rules the create form gained: which sub-categories a trade
// offers, what a site fills in, and where the new fields sit on the form.
import { describe, expect, it } from 'vitest';
import {
  WO_CREATE_DEFAULT_KEYS,
  WO_CREATE_SECTIONS,
  WO_SITE_AUTOFILL,
  subcategoriesFor,
  woCreateMissing,
} from '@theone/shared';

const map = { hvac: ['No cooling', 'No heating'], plumbing: ['Leak', 'Clog / backup'], roofing: ['Leak'] };

describe('sub-categories follow the trade', () => {
  it('offers the picked trade\'s list, whatever its capitals or spacing', () => {
    expect(subcategoriesFor(map, 'HVAC')).toEqual(['No cooling', 'No heating']);
    expect(subcategoriesFor(map, '  plumbing ')).toEqual(['Leak', 'Clog / backup']);
  });

  it('offers nothing for a trade with no list, and everything once when no trade is picked', () => {
    expect(subcategoriesFor(map, 'Locksmith')).toEqual([]);
    expect(subcategoriesFor(map, '')).toEqual(['Clog / backup', 'Leak', 'No cooling', 'No heating']);
    expect(subcategoriesFor(map, null)).toHaveLength(4);
    expect(subcategoriesFor(undefined, 'HVAC')).toEqual([]);
  });
});

describe('the form as it ships', () => {
  it('has the four 0063 fields on it, under "What is wrong"', () => {
    const what = WO_CREATE_SECTIONS.find((s) => s.id === 'what')!;
    for (const k of ['Sub Category', 'Problem Type', 'Supplier Type', 'Work Permit Needed']) {
      expect(WO_CREATE_DEFAULT_KEYS).toContain(k);
      expect(what.keys).toContain(k);
    }
  });

  it('a site fills only fields that exist on the form', () => {
    for (const { key } of WO_SITE_AUTOFILL) expect(WO_CREATE_DEFAULT_KEYS).toContain(key);
  });

  it('a required tick box is missing until it is ticked', () => {
    const form = { fields: [{ key: 'Work Permit Needed', label: 'Work Permit Needed', type: 'checkbox', options: [], mode: 'required' as const, section: 'what' }] };
    expect(woCreateMissing(form, {}, 'WO-1')).toEqual(['Work Permit Needed']);
    expect(woCreateMissing(form, { 'Work Permit Needed': true }, 'WO-1')).toEqual([]);
  });
});
