// 0064 — the pure rules behind the work-order record: which form layout a
// client and trade get, what it does to the form, where a check-in stands
// against a site's boundary, and where a site event stands on a given day.
import { describe, expect, it } from 'vitest';
import {
  applyFormLayout,
  distanceFeet,
  formatFeet,
  geofenceCheck,
  minutesBetween,
  pickFormLayout,
  siteEventPhase,
  type WoCreateForm,
  type WoFormLayout,
} from '@theone/shared';

const layout = (over: Partial<WoFormLayout>): WoFormLayout => ({
  id: over.name ?? 'x', name: 'x', client: null, trade: null, fields: {}, is_active: true, ...over,
});

describe('which layout a form uses', () => {
  const both = layout({ name: 'both', client: '7-Eleven', trade: 'Refrigeration' });
  const client = layout({ name: 'client', client: '7-Eleven' });
  const trade = layout({ name: 'trade', trade: 'Refrigeration' });

  it('prefers client and trade, then the client alone, then the trade alone', () => {
    expect(pickFormLayout([trade, client, both], '7-Eleven', 'Refrigeration')?.name).toBe('both');
    expect(pickFormLayout([trade, client], '7-Eleven', 'Refrigeration')?.name).toBe('client');
    expect(pickFormLayout([trade, both], 'Wawa', 'Refrigeration')?.name).toBe('trade');
  });

  it('ignores capitals and spacing, and a layout that names the wrong trade', () => {
    expect(pickFormLayout([both], ' 7-eleven ', 'REFRIGERATION')?.name).toBe('both');
    expect(pickFormLayout([both], '7-Eleven', 'Plumbing')).toBeNull();
    expect(pickFormLayout([both], '7-Eleven', null)).toBeNull();
  });

  it('never uses a switched-off layout or one that names nothing', () => {
    expect(pickFormLayout([layout({ ...both, is_active: false })], '7-Eleven', 'Refrigeration')).toBeNull();
    expect(pickFormLayout([layout({ name: 'empty' })], '7-Eleven', 'Refrigeration')).toBeNull();
    expect(pickFormLayout([], '7-Eleven', 'Refrigeration')).toBeNull();
  });
});

describe('what a layout does to the form', () => {
  const field = (key: string, mode: 'optional' | 'required') => ({ key, label: key, mode }) as unknown as WoCreateForm['fields'][number];
  const form: WoCreateForm = { fields: [field('Client', 'required'), field('Trade', 'optional'), field('Problem Type', 'optional'), field('Sub Category', 'optional')] };

  it('leaves the form alone without a layout', () => {
    expect(applyFormLayout(form, null)).toBe(form);
  });

  it('drops a field turned off, changes the mode of one it names, keeps the rest', () => {
    const out = applyFormLayout(form, layout({ fields: { 'Problem Type': 'off', 'Sub Category': 'required' } }));
    expect(out.fields.map((f) => f.key)).toEqual(['Client', 'Trade', 'Sub Category']);
    expect(out.fields.find((f) => f.key === 'Sub Category')?.mode).toBe('required');
    expect(out.fields.find((f) => f.key === 'Trade')?.mode).toBe('optional');
    expect(form.fields).toHaveLength(4);
  });

  it('cannot hide the fields that decide the layout', () => {
    const out = applyFormLayout(form, layout({ fields: { Client: 'off', Trade: 'off' } }));
    expect(out.fields.map((f) => f.key)).toContain('Client');
    expect(out.fields.map((f) => f.key)).toContain('Trade');
  });
});

describe('a check-in against the site boundary', () => {
  const pin = { lat: 29.3013, lng: -94.7977 };

  it('measures distance in feet', () => {
    expect(distanceFeet(pin, pin)).toBe(0);
    // one thousandth of a degree of latitude is about 365 ft
    const d = distanceFeet(pin, { lat: pin.lat + 0.001, lng: pin.lng });
    expect(d).toBeGreaterThan(355);
    expect(d).toBeLessThan(375);
  });

  it('is inside up to and including the boundary, outside past it', () => {
    const near = { lat: pin.lat + 0.001, lng: pin.lng };
    const feet = distanceFeet(near, pin);
    expect(geofenceCheck(near, { ...pin, boundary_radius_ft: 500 }).result).toBe('inside');
    expect(geofenceCheck(near, { ...pin, boundary_radius_ft: feet })).toEqual({ result: 'inside', feet, limit: feet });
    expect(geofenceCheck(near, { ...pin, boundary_radius_ft: feet - 1 }).result).toBe('outside');
  });

  it('says so when there is nothing to check against', () => {
    expect(geofenceCheck(pin, null)).toEqual({ result: 'no_site', feet: null, limit: null });
    expect(geofenceCheck(pin, { lat: null, lng: null, boundary_radius_ft: 300 }).result).toBe('no_site');
    const open = geofenceCheck(pin, { ...pin, boundary_radius_ft: null });
    expect(open.result).toBe('no_boundary');
    expect(open.feet).toBe(0);
  });

  it('writes short distances in feet and long ones in miles', () => {
    expect(formatFeet(320)).toBe('320 ft');
    expect(formatFeet(5280)).toBe('1.0 mi');
    expect(formatFeet(null)).toBe('—');
  });
});

describe('where a site event stands', () => {
  it('runs from its first day to its last, both included', () => {
    expect(siteEventPhase('2026-10-02', '2026-10-07', '2026-10-01')).toBe('upcoming');
    expect(siteEventPhase('2026-10-02', '2026-10-07', '2026-10-02')).toBe('running');
    expect(siteEventPhase('2026-10-02', '2026-10-07', '2026-10-07')).toBe('running');
    expect(siteEventPhase('2026-10-02', '2026-10-07', '2026-10-08')).toBe('ended');
  });

  it('runs until somebody ends it when it has no end date', () => {
    expect(siteEventPhase('2026-10-02', null, '2030-01-01')).toBe('running');
  });
});

describe('time between two stamps', () => {
  it('counts whole minutes and refuses a missing or backwards pair', () => {
    expect(minutesBetween('2026-06-27T07:00:00Z', '2026-06-27T08:35:00Z')).toBe(95);
    expect(minutesBetween(null, '2026-06-27T08:35:00Z')).toBeNull();
  });
});
