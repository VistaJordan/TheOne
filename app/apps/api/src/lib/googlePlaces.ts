// 0140 · Google's Places API (New): address suggestions as someone types,
// and the full address of the one they pick. The key is GOOGLE_MAPS_API_KEY,
// the one the geocoder uses (lib/googleGeocode.ts); the Places API (New) must
// be enabled for it in the Google Cloud project. Both calls are reads: nothing
// here writes anything to Google.
//
// A typing session carries one session token from the first suggestion to the
// pick, which is how Google bills it as one session instead of per keystroke.
// The mapping of Google's answers is pure and lives in shared
// (addressSuggest.ts), so it is tested without the network.

import {
  placeFromGoogle,
  suggestionsFromGoogle,
  type AddressPlace,
  type AddressSuggestion,
  type GoogleAutocompleteBody,
  type GooglePlaceBody,
} from '@theone/shared';
import { googleKey } from './googleGeocode.js';

const BASE = 'https://places.googleapis.com/v1';
const TIMEOUT_MS = 6_000;

/** Google could not be asked (no key, network, quota, the API not enabled). */
export class PlacesUnavailable extends Error {}

async function ask<T>(url: string, init: RequestInit, fieldMask: string): Promise<T> {
  const key = googleKey();
  if (!key) throw new PlacesUnavailable('GOOGLE_MAPS_API_KEY is not set');
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new PlacesUnavailable(`Google Places unreachable: ${(e as Error).message}`);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* an empty or non-JSON answer is handled by the status below */
  }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string; status?: string } } | null)?.error;
    throw new PlacesUnavailable(`Google Places: ${res.status}${msg?.status ? ` ${msg.status}` : ''}${msg?.message ? ` — ${msg.message}` : ''}`);
  }
  return body as T;
}

/** US addresses matching the typed text. */
export async function placesAutocomplete(input: string, sessionToken: string): Promise<AddressSuggestion[]> {
  const body = await ask<GoogleAutocompleteBody>(
    `${BASE}/places:autocomplete`,
    {
      method: 'POST',
      body: JSON.stringify({ input, sessionToken, includedRegionCodes: ['us'], languageCode: 'en', regionCode: 'us' }),
    },
    'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat',
  );
  return suggestionsFromGoogle(body);
}

/** The picked place's full address (with its ZIP) and point. */
export async function placeDetails(placeId: string, sessionToken: string): Promise<AddressPlace | null> {
  const url = new URL(`${BASE}/places/${encodeURIComponent(placeId)}`);
  url.searchParams.set('sessionToken', sessionToken);
  url.searchParams.set('languageCode', 'en');
  url.searchParams.set('regionCode', 'us');
  const body = await ask<GooglePlaceBody>(url.toString(), { method: 'GET' }, 'formattedAddress,location');
  return placeFromGoogle(body);
}
