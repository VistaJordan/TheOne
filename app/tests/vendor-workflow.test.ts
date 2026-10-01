// 0058 — the pure rules of the vendor relations workflow.
import { describe, expect, it } from 'vitest';
import {
  autoMapImportColumns,
  buildImportRow,
  expiryBand,
  missingFields,
  requiredFieldKeys,
  rollUpCoiApproval,
} from '@theone/shared';

const lists = {
  statuses: [{ key: 'ACTIVE', label: 'Active' }, { key: 'INTERESTED', label: 'Interested' }],
  brand_sources: [{ key: 'SEAMLESS_FM', label: 'Seamless FM' }, { key: 'BYBLOS_VISTA', label: 'Byblos Vista' }],
};

describe('import: matching columns', () => {
  it('recognises the usual headers whatever their case and punctuation', () => {
    const m = autoMapImportColumns(['Company Name', 'Phone #', 'ST', 'E-mail', 'Zip Code', 'Trade', 'Favourite colour']);
    expect(m['Company Name']).toBe('name');
    expect(m.ST).toBe('state');
    expect(m['Zip Code']).toBe('zip');
    expect(m.Trade).toBe('primary_trade');
    expect(m['Favourite colour']).toBeUndefined();
  });

  it('lets several columns be phones but gives any other field to the first column only', () => {
    const m = autoMapImportColumns(['Phone', 'Mobile', 'City', 'Town']);
    expect(m.Phone).toBe('phones');
    expect(m.Mobile).toBe('phones');
    expect(m.City).toBe('city');
    expect(m.Town).toBeUndefined();
  });
});

describe('import: reading one row', () => {
  const mapping = { Company: 'name', Phone: 'phones', ST: 'state', Rate: 'regular_hourly_rate', Statewide: 'statewide', W9: 'w9_received', Brand: 'brand_source', License: 'licenseNumber' };

  it('turns cells into the vendor body', () => {
    const { input, errors } = buildImportRow(
      { Company: 'Lone Star HVAC', Phone: '(214) 555-0150; 214-555-0151', ST: 'Texas', Rate: '$1,095.50', Statewide: 'Yes', W9: 'pending', Brand: 'seamless fm', License: 'TX-99' },
      mapping, lists, 'vendor',
    );
    expect(errors).toEqual([]);
    expect(input.name).toBe('Lone Star HVAC');
    expect(input.phones).toHaveLength(2);
    expect(input.state).toBe('TX');
    expect(input.regular_hourly_rate).toBe(1095.5);
    expect(input.statewide).toBe(true);
    expect(input.w9_received).toBe('PENDING');
    expect(input.brand_source).toBe('SEAMLESS_FM');
    expect((input.details as Record<string, unknown>).licenseNumber).toBe('TX-99');
  });

  it('reports a cell it cannot read and leaves the field out, never guessing', () => {
    const { input, errors } = buildImportRow({ Company: 'A', Phone: 'ask Bob', ST: 'Ontario', Rate: 'call us', Statewide: 'maybe', W9: '', Brand: '', License: '' }, mapping, lists, 'vendor');
    expect(errors).toHaveLength(4);
    expect(input.state).toBeUndefined();
    expect(input.regular_hourly_rate).toBeUndefined();
    expect(input.statewide).toBeUndefined();
    expect(input.phones).toBeUndefined();
  });
});

describe('required fields', () => {
  it('an admin override wins over the default, either way', () => {
    const base = requiredFieldKeys({});
    expect(base.length).toBeGreaterThan(0);
    const off = requiredFieldKeys({ [base[0]]: false });
    expect(off).not.toContain(base[0]);
  });

  it('a complete record has nothing missing; an empty one names each required field', () => {
    const keys = requiredFieldKeys({});
    const empty = missingFields({ name: 'A' }, keys);
    expect(empty.length).toBeGreaterThan(0);
    expect(empty.every((p) => keys.includes(p.key))).toBe(true);
    expect(missingFields({ name: 'A' }, [])).toEqual([]);
  });
});

describe('COI roll-up', () => {
  it('is YES only when every company is approved, NO while any is sent back', () => {
    expect(rollUpCoiApproval([])).toBe('PENDING');
    expect(rollUpCoiApproval([{ approved: 'YES' }, { approved: 'YES' }])).toBe('YES');
    expect(rollUpCoiApproval([{ approved: 'YES' }, { approved: 'PENDING' }])).toBe('PENDING');
    expect(rollUpCoiApproval([{ approved: 'YES' }, { approved: 'NO' }])).toBe('NO');
  });
});

describe('expiry bands', () => {
  it('sorts a date into past, two weeks, a month, later', () => {
    expect(expiryBand('2026-09-30', '2026-10-01')).toBe('expired');
    expect(expiryBand('2026-10-01', '2026-10-01')).toBe('two_weeks');
    expect(expiryBand('2026-10-15', '2026-10-01')).toBe('two_weeks');
    expect(expiryBand('2026-10-16', '2026-10-01')).toBe('month');
    expect(expiryBand('2026-10-31', '2026-10-01')).toBe('month');
    expect(expiryBand('2026-11-01', '2026-10-01')).toBe('later');
  });
});
