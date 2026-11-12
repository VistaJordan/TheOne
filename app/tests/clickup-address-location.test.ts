/* 0132 · ClickUp's "17. Address" is a map location field: the sync sends
 * Google's coordinates for our address (else the ZIP centre) with the
 * address as written. Pure halves only: no database, no network. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clickUpFits, CLICKUP_WRITABLE_TYPES } from '../packages/shared/src/integrations';
import { pickGooglePoint } from '../apps/api/src/lib/googleGeocode';
import { addressKey } from '../apps/api/src/services/addressGeo';

describe('a written address fits a ClickUp location field', () => {
  it('is writable, and only text goes there', () => {
    expect(CLICKUP_WRITABLE_TYPES).toContain('location');
    expect(clickUpFits('text', 'location')).toBe(true);
    expect(clickUpFits('select', 'location')).toBe(false);
    expect(clickUpFits('money', 'location')).toBe(false);
  });
});

describe("Google's answer", () => {
  const at = (lat: number, lng: number, extra: object = {}) => [{ geometry: { location: { lat, lng } }, ...extra }];
  it('takes the first result', () => {
    expect(pickGooglePoint(at(26.2, -80.2), 'FL')).toEqual({ lat: 26.2, lng: -80.2 });
  });
  it('trusts a partial match only in the state the address names', () => {
    const fl = at(26.2, -80.2, { partial_match: true, address_components: [{ short_name: 'FL', types: ['administrative_area_level_1'] }] });
    expect(pickGooglePoint(fl, 'FL')).toEqual({ lat: 26.2, lng: -80.2 });
    expect(pickGooglePoint(fl, 'GA')).toBeNull();
    expect(pickGooglePoint(fl, null)).toBeNull();
  });
  it('has nothing to say with no result', () => {
    expect(pickGooglePoint([], 'FL')).toBeNull();
    expect(pickGooglePoint(undefined, 'FL')).toBeNull();
  });
});

describe('one lookup per address', () => {
  it('ignores case and spacing', () => {
    expect(addressKey('  5900 Rock Island Rd,  Tamarac, FL 33319 ')).toBe(addressKey('5900 ROCK ISLAND RD, TAMARAC, FL 33319'));
  });
});

describe('the sync', () => {
  const src = readFileSync(resolve(__dirname, '../apps/api/src/services/clickup.ts'), 'utf8');
  it('sends the point with the address as written', () => {
    expect(src).toMatch(/location:\s*\{\s*lat:\s*place\.point\.lat,\s*lng:\s*place\.point\.lng\s*\},\s*formatted_address:\s*address/);
  });
  it('places the addresses before it works out what to send', () => {
    expect(src).toContain('wants(t, map, cfg, idByName, await placesFor(t, map, cfg))');
  });
  it('keeps the Google key out of the demo', () => {
    const cfg = readFileSync(resolve(__dirname, '../apps/api/src/config.ts'), 'utf8');
    expect(cfg).toContain("'GOOGLE_MAPS_API_KEY'");
  });
});
