// 0132 · Google's geocoder: a written US address → map coordinates. Used by
// the ClickUp sync for ClickUp's "17. Address" location field (services/
// addressGeo.ts keeps every answer, so an address is asked once). The key is
// GOOGLE_MAPS_API_KEY; unset = not configured, and nothing is sent.
//
// The partial-match rule is the one the team's n8n workflows learned the
// hard way: Google's "partial_match" can land in another city or another
// state entirely, so a partial match is trusted only when it is in the state
// the address names.

export interface GoogleResult {
  partial_match?: boolean;
  geometry?: { location?: { lat?: number; lng?: number } };
  address_components?: { short_name?: string; types?: string[] }[];
}

export function googleKey(): string | null {
  const k = process.env.GOOGLE_MAPS_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

/** The point Google's first result gives, or null when there is none worth
    trusting. Pure, so the rule is tested without the network. */
export function pickGooglePoint(results: GoogleResult[] | undefined, state: string | null): { lat: number; lng: number } | null {
  const r = results?.[0];
  const lat = r?.geometry?.location?.lat;
  const lng = r?.geometry?.location?.lng;
  if (!r || typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (r.partial_match) {
    const st = (r.address_components ?? []).find((c) => c.types?.includes('administrative_area_level_1'))?.short_name;
    if (!state || !st || st.toUpperCase() !== state.trim().toUpperCase()) return null;
  }
  return { lat, lng };
}

export class GeocodeUnavailable extends Error {}

/** Ask Google. Returns the point, or null when Google has no trustworthy
    answer. Throws GeocodeUnavailable when it could not be asked (no key,
    network, quota, a refused key) — the caller tries again later. */
export async function googleGeocode(address: string, state: string | null): Promise<{ lat: number; lng: number } | null> {
  const key = googleKey();
  if (!key) throw new GeocodeUnavailable('GOOGLE_MAPS_API_KEY is not set');
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('components', 'country:US');
  url.searchParams.set('key', key);
  let body: { status?: string; results?: GoogleResult[]; error_message?: string };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    body = (await res.json()) as typeof body;
  } catch (e) {
    throw new GeocodeUnavailable(`Google geocoder unreachable: ${(e as Error).message}`);
  }
  if (body.status === 'ZERO_RESULTS') return null;
  if (body.status !== 'OK') throw new GeocodeUnavailable(`Google geocoder: ${body.status ?? 'no status'}${body.error_message ? ` — ${body.error_message}` : ''}`);
  return pickGooglePoint(body.results, state);
}
