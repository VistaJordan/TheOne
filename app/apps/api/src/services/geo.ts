// 0056 · Placing a ZIP or a city on the map from our own reference tables
// (geo_zip, geo_city). No outside geocoding service: nothing leaves the
// building and nothing rate-limits us. Centre points — good to a few miles,
// which is what a 100-mile search needs.
//
// Lookup order: a 5-digit ZIP wins; otherwise the city within its state
// (Census places and towns), and when the Census does not know the name, the
// middle of the ZIPs the post office files under that city.

import { cityKey, normalizeState, zip5 } from '@theone/shared';
import { query } from '../db.js';

export interface GeoPoint {
  lat: number;
  lng: number;
  /** 'Toledo, OH 43623' — what the point stands for. */
  label: string;
  from: 'zip' | 'city';
  city: string | null;
  state: string | null;
}

export interface PlaceInput {
  zip?: string | null;
  city?: string | null;
  state?: string | null;
}

export async function geoLookup(place: PlaceInput): Promise<GeoPoint | null> {
  const zip = zip5(place.zip);
  if (zip) {
    const z = await query<{ city: string; state: string; lat: number; lng: number }>(
      `SELECT city, state, lat, lng FROM geo_zip WHERE zip = $1`,
      [zip],
    );
    if (z.rows[0]) {
      const r = z.rows[0];
      return { lat: r.lat, lng: r.lng, label: `${r.city}, ${r.state} ${zip}`, from: 'zip', city: r.city, state: r.state };
    }
  }
  const state = normalizeState(place.state);
  const key = cityKey(place.city);
  if (!state || key === '') return null;
  const c = await query<{ name: string; lat: number; lng: number }>(
    `SELECT name, lat, lng FROM geo_city WHERE state = $1 AND name_key = $2`,
    [state, key],
  );
  if (c.rows[0]) {
    const r = c.rows[0];
    return { lat: r.lat, lng: r.lng, label: `${r.name}, ${state}`, from: 'city', city: r.name, state };
  }
  return null;
}

export interface CitySuggestion {
  city: string;
  state: string;
}

/** City names starting with what was typed, for the vendor form. Narrowed to
    a state when one is already chosen. */
export async function suggestCities(q: string, state?: string | null): Promise<CitySuggestion[]> {
  const key = cityKey(q);
  if (key.length < 2) return [];
  const st = normalizeState(state);
  const res = await query<{ name: string; state: string }>(
    `SELECT name, state FROM geo_city
      WHERE name_key LIKE $1 AND ($2::text IS NULL OR state = $2)
      ORDER BY length(name_key), name, state
      LIMIT 12`,
    [`${key.replace(/[\\%_]/g, '')}%`, st],
  );
  return res.rows.map((r) => ({ city: r.name, state: r.state }));
}

/** Where a work order is: its ZIP when it has one (the Zip Code field, else
    the tail of the address), otherwise its city and state. */
export async function workOrderPlace(taskId: string): Promise<{ point: GeoPoint | null; state: string | null }> {
  const res = await query<{ city: string | null; state: string | null; zip: string | null; address: string | null; site_zip: string | null }>(
    `SELECT t.city, t.state, t.fields->>'Zip Code' AS zip, t.fields->>'17. Address' AS address, s.zip AS site_zip
       FROM task t LEFT JOIN site s ON s.id = t.site_id
      WHERE t.id = $1`,
    [taskId],
  );
  const r = res.rows[0];
  if (!r) return { point: null, state: null };
  // '4702 Monroe St, Toledo, OH 43623, USA' → 43623
  const fromAddress = /\b(\d{5})(?:-\d{4})?(?:,?\s*(?:USA|United States))?\s*$/i.exec((r.address ?? '').trim())?.[1] ?? null;
  const point = await geoLookup({ zip: r.zip ?? r.site_zip ?? fromAddress, city: r.city, state: r.state });
  return { point, state: normalizeState(r.state) ?? point?.state ?? null };
}
