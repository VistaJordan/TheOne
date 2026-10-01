/* 0057 — vendors and technicians, the technician map, hiring. The pure halves:
 * the keys two records are "the same" by (phone, city), where a ZIP is read
 * from, distance, which insurance dates count, the hire warning, how a
 * preferred-vendor rule fits a work order, the order the map lists results
 * in, what a role's grants let a person see on the map, and the map's own
 * geometry helpers. The database half (services/vendors.ts, vendorMap.ts,
 * geo.ts) is exercised against a live database. */

import { describe, it, expect } from 'vitest';
import {
  cityKey,
  compareMapVendors,
  complianceWarning,
  currentExpiries,
  haversineMiles,
  normalizeState,
  phoneDigits,
  preferredRuleScore,
  resolveVendorMapScope,
  sameVendorName,
  zip5,
  type MapVendor,
} from '../packages/shared/src/vendors';
import { boundsOf, circleRing, spreadOverlaps, tradeSlot } from '../apps/web/src/lib/mapPoints';

describe('phoneDigits — the key two records share a phone by', () => {
  it('reduces any spelling of a US number to the same digits', () => {
    expect(phoneDigits('(409) 555-0143')).toBe('14095550143');
    expect(phoneDigits('409.555.0143')).toBe('14095550143');
    expect(phoneDigits('+1 409 555 0143')).toBe('14095550143');
  });
  it('refuses what is not a phone', () => {
    expect(phoneDigits('ext 12')).toBeNull();
    expect(phoneDigits('')).toBeNull();
    expect(phoneDigits(null)).toBeNull();
  });
});

describe('cityKey — must match geo_city.name_key', () => {
  it('drops case and punctuation and abbreviates saint / mount / fort', () => {
    expect(cityKey('St. Louis')).toBe('st louis');
    expect(cityKey('Saint Louis')).toBe('st louis');
    expect(cityKey('Fort Worth')).toBe('ft worth');
    expect(cityKey('Mount Vernon')).toBe('mt vernon');
    expect(cityKey("  O'Fallon ")).toBe('ofallon');
    expect(cityKey('Winston-Salem')).toBe('winston salem');
  });
  it('is empty for nothing', () => {
    expect(cityKey(null)).toBe('');
    expect(cityKey('   ')).toBe('');
  });
});

describe('zip5 and normalizeState', () => {
  it('reads a ZIP off the end of what was typed', () => {
    expect(zip5('43623')).toBe('43623');
    expect(zip5('43623-1234')).toBe('43623');
    expect(zip5('4702 Monroe St, Toledo, OH 43623')).toBe('43623');
    expect(zip5('Suite 12345 Main St')).toBeNull();
    expect(zip5('4362')).toBeNull();
  });
  it('takes a state as a code or a name', () => {
    expect(normalizeState('tx')).toBe('TX');
    expect(normalizeState(' Texas ')).toBe('TX');
    expect(normalizeState('District of Columbia')).toBe('DC');
    expect(normalizeState('Ontario')).toBeNull();
    expect(normalizeState('')).toBeNull();
  });
});

describe('haversineMiles', () => {
  it('measures Houston to Dallas at about 225 miles', () => {
    const d = haversineMiles({ lat: 29.7604, lng: -95.3698 }, { lat: 32.7767, lng: -96.797 });
    expect(d).toBeGreaterThan(220);
    expect(d).toBeLessThan(230);
  });
  it('is zero for the same point', () => {
    expect(haversineMiles({ lat: 30, lng: -90 }, { lat: 30, lng: -90 })).toBe(0);
  });
});

describe('currentExpiries — only the latest date of each kind counts', () => {
  const rows = [
    { entity: 'SEAMLESS_FM', insurance_type: 'COI', expires_on: '2026-01-01' },
    { entity: 'SEAMLESS_FM', insurance_type: 'coi ', expires_on: '2027-06-01' },
    { entity: 'BKR_NATIONAL', insurance_type: 'COI', expires_on: '2026-03-01' },
    { entity: null, insurance_type: 'License', expires_on: '2028-01-01' },
  ];
  it('keeps one per (company, type), the latest', () => {
    const cur = currentExpiries(rows);
    expect(cur).toHaveLength(3);
    expect(cur.find((r) => r.entity === 'SEAMLESS_FM')!.expires_on).toBe('2027-06-01');
  });
});

describe('complianceWarning — warns, never blocks', () => {
  const vendor = { kind: 'vendor' as const, coi_received: 'YES' as const };
  it('says nothing when the paperwork is in order', () => {
    expect(complianceWarning(vendor, [{ entity: null, insurance_type: 'COI', expires_on: '2027-01-01' }], '2026-10-01')).toBeNull();
  });
  it('a renewed policy silences its old date', () => {
    const dates = [
      { entity: null, insurance_type: 'COI', expires_on: '2026-01-01' },
      { entity: null, insurance_type: 'COI', expires_on: '2027-01-01' },
    ];
    expect(complianceWarning(vendor, dates, '2026-10-01')).toBeNull();
  });
  it('names the expired insurance', () => {
    expect(complianceWarning(vendor, [{ entity: null, insurance_type: 'COI', expires_on: '2026-09-30' }], '2026-10-01')).toBe(
      'COI expired on 2026-09-30',
    );
  });
  it('says when no COI is on file', () => {
    expect(complianceWarning({ kind: 'vendor', coi_received: 'PENDING' }, [], '2026-10-01')).toBe('No certificate of insurance on file');
  });
  it('never warns about a technician', () => {
    expect(complianceWarning({ kind: 'tech', coi_received: 'PENDING' }, [], '2026-10-01')).toBeNull();
  });
});

describe('preferredRuleScore — the most specific rule that fits wins', () => {
  const wo = { client: '7-Eleven', trade: 'Refrigeration', state: 'TX' };
  it('client + trade beats client alone beats trade alone', () => {
    const both = preferredRuleScore({ client: '7-eleven', trade: 'refrigeration', state: null }, wo);
    const client = preferredRuleScore({ client: '7-Eleven', trade: null, state: null }, wo);
    const trade = preferredRuleScore({ client: null, trade: 'Refrigeration', state: null }, wo);
    expect(both).toBeGreaterThan(client);
    expect(client).toBeGreaterThan(trade);
    expect(trade).toBeGreaterThan(0);
  });
  it('does not fit another client, trade or state', () => {
    expect(preferredRuleScore({ client: 'MOD Pizza', trade: null, state: null }, wo)).toBe(0);
    expect(preferredRuleScore({ client: null, trade: 'HVAC', state: null }, wo)).toBe(0);
    expect(preferredRuleScore({ client: '7-Eleven', trade: null, state: 'CA' }, wo)).toBe(0);
  });
  it('a state on the rule narrows it and adds weight', () => {
    expect(preferredRuleScore({ client: '7-Eleven', trade: null, state: 'Texas' }, wo)).toBeGreaterThan(
      preferredRuleScore({ client: '7-Eleven', trade: null, state: null }, wo),
    );
  });
});

describe('compareMapVendors — the order of the result list', () => {
  const v = (over: Partial<MapVendor>): MapVendor =>
    ({ name: 'x', blacklisted: false, preferred_rank: null, mine: false, distance_miles: 50, ...over }) as MapVendor;
  it('preferred first by rank, then mine, then nearest; blacklisted last', () => {
    const list = [
      v({ name: 'far', distance_miles: 90 }),
      v({ name: 'black', distance_miles: 1, blacklisted: true }),
      v({ name: 'mine', distance_miles: 80, mine: true }),
      v({ name: 'pref2', distance_miles: 70, preferred_rank: 2 }),
      v({ name: 'near', distance_miles: 5 }),
      v({ name: 'pref1', distance_miles: 99, preferred_rank: 1 }),
    ].sort(compareMapVendors);
    expect(list.map((x) => x.name)).toEqual(['pref1', 'pref2', 'mine', 'near', 'far', 'black']);
  });
});

describe('resolveVendorMapScope — what a role sees on the map', () => {
  const dispatcher = {
    role: {
      vendor_map: { view: true, create: true },
      'vendor_map/techs': { view: false },
      'vendor_map/statewide': { view: false },
      'vendor_map/nationwide': { view: false },
      'vendor_map/subcontractors': { view: false },
    },
    overrides: {},
  };
  it('a dispatcher: VR vendors and their own technicians, may add and hire', () => {
    const s = resolveVendorMapScope(dispatcher);
    expect(s).toEqual({ open: true, hire: true, allTechs: false, vr: true, statewide: false, nationwide: false, subcontractors: false, add: true });
  });
  it('one person can be widened without touching the role', () => {
    const s = resolveVendorMapScope({ ...dispatcher, overrides: { 'vendor_map/techs': { view: true } } });
    expect(s.allTechs).toBe(true);
    expect(s.statewide).toBe(false);
  });
  it('a role without the map sees nothing; a super admin sees everything', () => {
    expect(resolveVendorMapScope({ role: { vendor_map: { view: false, create: false } }, overrides: {} }).open).toBe(false);
    const all = resolveVendorMapScope({ role: {}, overrides: {} }, true);
    expect(Object.values(all).every(Boolean)).toBe(true);
  });
});

describe('sameVendorName', () => {
  it('ignores case and spacing', () => {
    expect(sameVendorName('Bayou  Mechanical LLC', 'bayou mechanical llc ')).toBe(true);
    expect(sameVendorName('Bayou Mechanical', 'Bayou Mechanical LLC')).toBe(false);
    expect(sameVendorName('', '')).toBe(false);
  });
});

describe('map geometry', () => {
  it('fans a stack of vendors in one city apart, keeping the first in place', () => {
    const pts = [
      { id: 'a', lat: 29.76, lng: -95.37 },
      { id: 'b', lat: 29.76, lng: -95.37 },
      { id: 'c', lat: 29.76, lng: -95.37 },
      { id: 'd', lat: 32.78, lng: -96.8 },
    ];
    const out = spreadOverlaps(pts);
    expect(out).toHaveLength(4);
    const a = out.find((p) => p.id === 'a')!;
    const b = out.find((p) => p.id === 'b')!;
    const c = out.find((p) => p.id === 'c')!;
    expect(a.lat).toBe(29.76);
    expect(b.lat !== a.lat || b.lng !== a.lng).toBe(true);
    expect(c.lat !== b.lat || c.lng !== b.lng).toBe(true);
    // a few hundred metres, not miles
    expect(Math.abs(b.lat - a.lat)).toBeLessThan(0.02);
    expect(out.find((p) => p.id === 'd')).toEqual(pts[3]);
    // the same input gives the same output
    expect(spreadOverlaps(pts)).toEqual(out);
  });
  it('draws a closed ring of the right size', () => {
    const ring = circleRing({ lat: 30, lng: -95 }, 100, 36);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const north = Math.max(...ring.map(([, lat]) => lat));
    expect(haversineMiles({ lat: 30, lng: -95 }, { lat: north, lng: -95 })).toBeGreaterThan(97);
    expect(haversineMiles({ lat: 30, lng: -95 }, { lat: north, lng: -95 })).toBeLessThan(103);
  });
  it('bounds a set of points, and nothing for none', () => {
    expect(boundsOf([{ lat: 1, lng: 2 }, { lat: 3, lng: -4 }])).toEqual([[-4, 1], [2, 3]]);
    expect(boundsOf([])).toBeNull();
  });
  it('gives a trade its palette slot by list order', () => {
    const trades = ['Appliance', 'Electric', 'HVAC'];
    expect(tradeSlot('electric', trades)).toBe(2);
    expect(tradeSlot('Roofing', trades)).toBe(0);
    expect(tradeSlot(null, trades)).toBe(0);
  });
});
