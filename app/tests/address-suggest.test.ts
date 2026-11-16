/* 0140 — address suggestions from Google Maps. The pure half: Google's
 * answers reduced to what the box shows, what is worth asking, the place id
 * check, and the pins that keep the feature honest — the key never reaches
 * the browser, the three Address boxes use the one component, the switch
 * gates both lookups, and every request to Google is counted. No network,
 * no database. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ADDRESS_SUGGEST_DAILY_CAP_MAX,
  ADDRESS_SUGGEST_MAX,
  GOOGLE_PLACE_ID_RE,
  GOOGLE_USAGE_KINDS,
  addressSuggestWorthAsking,
  googleUsageSentence,
  placeFromGoogle,
  suggestionsFromGoogle,
} from '../packages/shared/src/addressSuggest';
import { addressPartValues, parseAddressParts } from '../packages/shared/src/addressParts';
import { INTEGRATION_BY_KEY } from '../packages/shared/src/integrations';
import { googlePlacesDailyCap } from '../apps/api/src/services/addressSuggest';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('what is worth asking Google', () => {
  it('starts at four characters and stops at a pasted paragraph', () => {
    expect(addressSuggestWorthAsking('789')).toBe(false);
    expect(addressSuggestWorthAsking('  78 ')).toBe(false);
    expect(addressSuggestWorthAsking('7898')).toBe(true);
    expect(addressSuggestWorthAsking('x'.repeat(201))).toBe(false);
  });
});

describe("Google's predictions", () => {
  const prediction = (id: string | undefined, main?: string, secondary?: string, text?: string) => ({
    placePrediction: {
      placeId: id,
      text: text ? { text } : undefined,
      structuredFormat: main ? { mainText: { text: main }, secondaryText: secondary ? { text: secondary } : undefined } : undefined,
    },
  });
  it('become main + secondary lines, in order', () => {
    expect(
      suggestionsFromGoogle({ suggestions: [prediction('ChIJabcdefghij', '7898 Bradley Long Dr', 'Sherrills Ford, NC, USA')] }),
    ).toEqual([{ place_id: 'ChIJabcdefghij', main: '7898 Bradley Long Dr', secondary: 'Sherrills Ford, NC, USA' }]);
  });
  it('fall back to the whole text when Google sends no structured form', () => {
    expect(suggestionsFromGoogle({ suggestions: [prediction('ChIJabcdefghij', undefined, undefined, '1 Main St, Austin, TX, USA')] })).toEqual([
      { place_id: 'ChIJabcdefghij', main: '1 Main St, Austin, TX, USA', secondary: '' },
    ]);
  });
  it('drop a prediction with no id or no text, and anything that is not a place', () => {
    expect(suggestionsFromGoogle({ suggestions: [prediction(undefined, 'x'), prediction('ChIJabcdefghij'), {}] })).toEqual([]);
    expect(suggestionsFromGoogle(null)).toEqual([]);
    expect(suggestionsFromGoogle({})).toEqual([]);
  });
  it('are cut to the list length', () => {
    const many = Array.from({ length: 9 }, (_, i) => prediction(`ChIJabcdefghi${i}`, `${i} Main St`, 'Austin, TX, USA'));
    expect(suggestionsFromGoogle({ suggestions: many })).toHaveLength(ADDRESS_SUGGEST_MAX);
  });
});

describe('the picked place', () => {
  it("is Google's formatted address, which fills the parts like a typed one", () => {
    const place = placeFromGoogle({ formattedAddress: ' 7898 Bradley Long Dr, Sherrills Ford, NC 28673, USA ', location: { latitude: 35.6, longitude: -80.9 } });
    expect(place).toEqual({ address: '7898 Bradley Long Dr, Sherrills Ford, NC 28673, USA', lat: 35.6, lng: -80.9 });
    const parts = parseAddressParts(place!.address);
    expect(parts.city).toBe('Sherrills Ford');
    expect(parts.state).toBe('NC');
    expect(parts.zip).toBe('28673');
    expect(Object.keys(addressPartValues(parts)).length).toBeGreaterThanOrEqual(3);
  });
  it('is nothing without an address; a missing point is null', () => {
    expect(placeFromGoogle({})).toBeNull();
    expect(placeFromGoogle(null)).toBeNull();
    expect(placeFromGoogle({ formattedAddress: '1 Main St, Austin, TX 78701, USA' })).toEqual({ address: '1 Main St, Austin, TX 78701, USA', lat: null, lng: null });
  });
  it('a place id is checked before it goes in a URL', () => {
    expect(GOOGLE_PLACE_ID_RE.test('ChIJN1t_tDeuEmsRUsoyG83frY4')).toBe(true);
    expect(GOOGLE_PLACE_ID_RE.test('../v1/places')).toBe(false);
    expect(GOOGLE_PLACE_ID_RE.test('abc?key=1')).toBe(false);
    expect(GOOGLE_PLACE_ID_RE.test('short')).toBe(false);
  });
});

describe('the daily cap', () => {
  it('with nothing saved: defaults to 3,000 and reads GOOGLE_PLACES_DAILY_CAP (0 = none, nonsense = the default)', () => {
    const before = process.env.GOOGLE_PLACES_DAILY_CAP;
    try {
      delete process.env.GOOGLE_PLACES_DAILY_CAP;
      expect(googlePlacesDailyCap()).toBe(3000);
      process.env.GOOGLE_PLACES_DAILY_CAP = '500';
      expect(googlePlacesDailyCap()).toBe(500);
      process.env.GOOGLE_PLACES_DAILY_CAP = '0';
      expect(googlePlacesDailyCap()).toBe(0);
      process.env.GOOGLE_PLACES_DAILY_CAP = 'lots';
      expect(googlePlacesDailyCap()).toBe(3000);
    } finally {
      if (before === undefined) delete process.env.GOOGLE_PLACES_DAILY_CAP;
      else process.env.GOOGLE_PLACES_DAILY_CAP = before;
    }
  });
});

describe('the daily limit is set from the admin page (0141)', () => {
  const svc = read('apps/api/src/services/addressSuggest.ts');
  it('the saved number wins over the environment, and is what the suggestions ask', () => {
    expect(svc).toContain("if (validCap(v)) return { cap: v, source: 'admin' };");
    expect(svc).toContain('const { cap } = await dailyCapInForce();');
  });
  it('changing it needs admin/integrations edit, is bounded and is logged', () => {
    expect(svc).toMatch(/export async function setDailyCap[\s\S]{0,200}requirePerm\(user, INTEGRATIONS_PERM_KEY, 'edit'/);
    expect(svc).toContain("action: 'google_maps_limit_changed'");
    expect(ADDRESS_SUGGEST_DAILY_CAP_MAX).toBe(100000);
    expect(read('apps/api/src/routes/address.ts')).toContain('z.number().int().min(0).max(ADDRESS_SUGGEST_DAILY_CAP_MAX)');
    expect(read('apps/web/src/lib/auditFormat.ts')).toContain('google_maps_limit_changed');
  });
  it('the setting survives a re-seed: no FK, not truncated', () => {
    const sql = read('packages/db/migrations/0141_google_setting.sql');
    expect(sql).not.toMatch(/REFERENCES/i);
    expect(read('packages/db/src/seed.ts')).not.toContain('google_setting');
  });
});

describe('use, counted', () => {
  it('the three kinds are the ones the table allows', () => {
    const sql = read('packages/db/migrations/0140_google_usage.sql');
    for (const k of GOOGLE_USAGE_KINDS) expect(sql).toContain(`'${k}'`);
  });
  it('reads as one line on the Integrations row', () => {
    expect(googleUsageSentence({ autocomplete: 1204, place_details: 1, geocode: 0 })).toBe(
      'This month: 1 address picked, 1,204 suggestion requests, 0 addresses placed for ClickUp.',
    );
  });
  it('every request to Google is counted where it is made', () => {
    const svc = read('apps/api/src/services/addressSuggest.ts');
    expect(svc).toMatch(/countGoogleUse\('autocomplete'\);\s+try \{\s+return \{ available: true, suggestions: await placesAutocomplete/);
    expect(svc).toMatch(/countGoogleUse\('place_details'\);\s+try \{\s+return \{ place: await placeDetails/);
    expect(read('apps/api/src/services/addressGeo.ts')).toContain("countGoogleUse('geocode')");
  });
});

describe('the switch and the key', () => {
  it('Google Maps is a connector with a switch, on by default, never locked', () => {
    const d = INTEGRATION_BY_KEY.google_maps;
    expect(d.built).toBe(true);
    expect(d.locked).toBeUndefined();
    expect(d.default_on).toBeUndefined();
  });
  it('off or no key = Google is not asked, by either lookup', () => {
    const svc = read('apps/api/src/services/addressSuggest.ts');
    expect(svc).toContain("if (!integrationOn('google_maps')) return { available: false, reason: 'switched_off', suggestions: [] };");
    expect(svc).toContain("if (!integrationOn('google_maps') || !googleKey()) return { place: null };");
    expect(read('apps/api/src/services/addressGeo.ts')).toContain("if (!integrationOn('google_maps')) throw new GeocodeUnavailable(");
  });
  it('the key stays on the server: the web never names it nor calls Google', () => {
    for (const f of ['apps/web/src/components/AddressInput.tsx', 'apps/web/src/api/client.ts']) {
      const src = read(f);
      expect(src, f).not.toContain('GOOGLE_MAPS_API_KEY');
      expect(src, f).not.toContain('googleapis.com');
    }
  });
  it('Places is read only: one POST (the autocomplete query), no PUT / PATCH / DELETE', () => {
    const src = read('apps/api/src/lib/googlePlaces.ts');
    expect(src).not.toMatch(/method:\s*'(PUT|PATCH|DELETE)'/);
    expect(src.match(/method:\s*'POST'/g)?.length ?? 0).toBe(1);
    expect(src).toContain("includedRegionCodes: ['us']");
  });
});

describe('the three Address boxes', () => {
  it('Add work order, the draft form and the field editor draw AddressInput for the Address', () => {
    expect(read('apps/web/src/components/wo/list/CreateWorkOrderDialog.tsx')).toMatch(/if \(f\.key === ADDRESS_KEY\) \{\s+return <AddressInput/);
    expect(read('apps/web/src/pages/IntakePage.tsx')).toMatch(/if \(f\.key === ADDRESS_KEY\) \{\s+return <AddressInput/);
    expect(read('apps/web/src/components/wo/fieldEdit.tsx')).toMatch(/field\.key === ADDRESS_FIELD_KEY\) \{[\s\S]{0,300}<AddressInput/);
  });
  it('the box stays a text box: typing is the value, a pick only replaces it', () => {
    const src = read('apps/web/src/components/AddressInput.tsx');
    expect(src).toContain('onChange(e.target.value)');
    expect(src).toContain('type="text"');
  });
});
