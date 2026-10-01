// 0059 — the pure rules of the Vendors list's advanced filter and column picker.
import { describe, expect, it } from 'vitest';
import {
  SOURCE_FIELDS,
  VENDOR_COLUMNS,
  VENDOR_DEFAULT_COLUMNS,
  VENDOR_FILTER_FIELDS,
  VENDOR_FILTER_MAX_RULES,
  VENDOR_FILTER_OPS,
  WIDGET_SOURCES,
  cleanVendorFilter,
  parseVendorFilter,
  resolveVendorColumns,
  serializeVendorFilter,
} from '@theone/shared';

describe('advanced filter: what survives cleaning', () => {
  it('keeps complete rules on known fields and drops everything else', () => {
    const f = cleanVendorFilter({
      join: 'or',
      rules: [
        { field: 'state', op: 'is', value: ' TX ' },
        { field: 'nope', op: 'is', value: 'x' }, // unknown field
        { field: 'name', op: 'gt', value: 'x' }, // operator the type does not take
        { field: 'name', op: 'contains', value: '' }, // half-typed
        { field: 'blacklisted', op: 'yes' }, // takes no value
        { field: 'regular_hourly_rate', op: 'gte', value: 'cheap' }, // not a number
        { field: 'created_at', op: 'after', value: '10/01/2026' }, // not a day
        { field: 'created_at', op: 'after', value: '2026-10-01' },
      ],
    });
    expect(f).toEqual({
      join: 'or',
      rules: [
        { field: 'state', op: 'is', value: 'TX' },
        { field: 'blacklisted', op: 'yes' },
        { field: 'created_at', op: 'after', value: '2026-10-01' },
      ],
    });
  });

  it('joins by AND unless told OR, and is nothing at all without a usable rule', () => {
    expect(cleanVendorFilter({ rules: [{ field: 'city', op: 'empty' }] })?.join).toBe('and');
    expect(cleanVendorFilter({ join: 'or', rules: [] })).toBeNull();
    expect(cleanVendorFilter({ join: 'or', rules: [{ field: 'city', op: 'is' }] })).toBeNull();
    expect(cleanVendorFilter(null)).toBeNull();
    expect(cleanVendorFilter('state = TX')).toBeNull();
  });

  it('caps the number of rules', () => {
    const rules = Array.from({ length: VENDOR_FILTER_MAX_RULES + 5 }, () => ({ field: 'city', op: 'not_empty' }));
    expect(cleanVendorFilter({ join: 'and', rules })?.rules).toHaveLength(VENDOR_FILTER_MAX_RULES);
  });

  it('round-trips through the query parameter; junk in the URL is no filter', () => {
    const f = { join: 'and' as const, rules: [{ field: 'primary_trade', op: 'is' as const, value: 'HVAC' }] };
    expect(parseVendorFilter(serializeVendorFilter(f))).toEqual(f);
    expect(parseVendorFilter('not json')).toBeNull();
    expect(parseVendorFilter('')).toBeNull();
    expect(serializeVendorFilter({ join: 'and', rules: [] })).toBeNull();
  });

  it('every field has operators, and no two fields share a key', () => {
    const keys = VENDOR_FILTER_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of VENDOR_FILTER_FIELDS) expect(VENDOR_FILTER_OPS[f.type].length).toBeGreaterThan(0);
  });
});

describe('column picker', () => {
  it('draws the default set until a choice is stored', () => {
    expect(resolveVendorColumns(null)).toEqual([...VENDOR_DEFAULT_COLUMNS]);
    expect(resolveVendorColumns('status')).toEqual([...VENDOR_DEFAULT_COLUMNS]);
    expect(resolveVendorColumns([])).toEqual([...VENDOR_DEFAULT_COLUMNS]);
  });

  it('keeps catalogue order and ignores columns that no longer exist', () => {
    expect(resolveVendorColumns(['added', 'gone', 'zip', 'status'])).toEqual(['status', 'zip', 'added']);
    expect(resolveVendorColumns(['gone'])).toEqual([...VENDOR_DEFAULT_COLUMNS]);
  });

  it('no two columns share a key', () => {
    const keys = VENDOR_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('vendors as a dashboard source', () => {
  it('is a source with something to count by, total and run along', () => {
    expect(WIDGET_SOURCES).toContain('vendors');
    const types = new Set(SOURCE_FIELDS.vendors.map((f) => f.type));
    expect(types).toEqual(new Set(['text', 'number', 'date']));
  });
});
