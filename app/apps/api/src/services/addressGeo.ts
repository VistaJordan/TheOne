// 0132 · A work order's address on the map, for ClickUp's "17. Address".
// Google first (lib/googleGeocode.ts), else the centre of the address's ZIP
// from our own table (geo.ts). Every answer is kept in geocode_cache, so an
// address is asked once; one neither could place is asked again after 30
// days. Never throws: null = nothing to send yet (try again on a later run).

import { query } from '../db.js';
import { GeocodeUnavailable, googleGeocode } from '../lib/googleGeocode.js';
import { geoLookup } from './geo.js';

export interface PlacedAddress {
  lat: number;
  lng: number;
  source: 'google' | 'zip';
}

/** The cache key: case and spacing do not make a different address. */
export const addressKey = (address: string): string => address.trim().toLowerCase().replace(/\s+/g, ' ');

const RETRY_NONE_DAYS = 30;

/** 'placed' with the point, 'unplaceable' when neither Google nor the ZIP
    knows it, or 'later' when Google could not be asked right now. */
export type PlaceOutcome = { kind: 'placed'; point: PlacedAddress } | { kind: 'unplaceable' } | { kind: 'later'; reason: string };

export async function placeAddress(address: string, state: string | null, zip: string | null): Promise<PlaceOutcome> {
  const key = addressKey(address);
  if (!key) return { kind: 'unplaceable' };
  try {
    const hit = await query<{ lat: number | null; lng: number | null; source: string; stale: boolean }>(
      `SELECT lat, lng, source, looked_up_at < now() - make_interval(days => $2) AS stale FROM geocode_cache WHERE address_key = $1`,
      [key, RETRY_NONE_DAYS],
    );
    const c = hit.rows[0];
    if (c && c.source !== 'none' && c.lat !== null && c.lng !== null) {
      return { kind: 'placed', point: { lat: c.lat, lng: c.lng, source: c.source as 'google' | 'zip' } };
    }
    if (c && c.source === 'none' && !c.stale) return { kind: 'unplaceable' };

    let point: PlacedAddress | null = null;
    let googleDown: string | null = null;
    try {
      const g = await googleGeocode(address, state);
      if (g) point = { ...g, source: 'google' };
    } catch (e) {
      if (!(e instanceof GeocodeUnavailable)) throw e;
      googleDown = e.message;
    }
    if (!point && googleDown) {
      // Google could not be asked: send nothing now and ask again next run,
      // rather than pinning the ZIP centre for good.
      return { kind: 'later', reason: googleDown };
    }
    if (!point) {
      const z = zip ? await geoLookup({ zip }) : null;
      if (z && z.from === 'zip') point = { lat: z.lat, lng: z.lng, source: 'zip' };
    }
    await query(
      `INSERT INTO geocode_cache (address_key, address, lat, lng, source, looked_up_at)
            VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (address_key) DO UPDATE
             SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, source = EXCLUDED.source, looked_up_at = now()`,
      [key, address.trim(), point?.lat ?? null, point?.lng ?? null, point?.source ?? 'none'],
    );
    return point ? { kind: 'placed', point } : { kind: 'unplaceable' };
  } catch (e) {
    return { kind: 'later', reason: (e as Error).message };
  }
}
