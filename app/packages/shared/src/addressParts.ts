// City, State and Zip Code read off a work order's address.
//
// Whenever `17. Address` is written — the field editor, bulk edit, an
// automation, Add work order, an intake draft's Submit, the CSV import, a
// planned-maintenance raise, the Ecotrak sync — the API reads the city, the
// state and the ZIP from the end of the text and writes them into their own
// fields (services/addressFill.ts). This file is the reading: pure, no
// database. A ZIP with no readable city or state is completed from the ZIP
// table (geo_zip, 0056) by the API, never by an outside geocoder.
//
// The usual shape is "7898 Bradley Long Dr, Sherrills Ford, NC 28673, USA":
// street, city, "ST ZIP", country — commas between the parts. Also read: a
// spelled-out state ("North Carolina"), ZIP+4, a missing country, a suite as
// its own part, and "City ST ZIP" with no comma before the state. A bare
// street ("123 Main St") yields nothing: the information is not in the text.

import { normalizeState } from './vendors';

/** The bag keys the address fills. */
export const ADDRESS_KEY = '17. Address';
export const ADDRESS_CITY_KEY = 'City';
export const ADDRESS_STATE_KEY = 'State';
export const ADDRESS_ZIP_KEY = 'Zip Code';
export const ADDRESS_PART_KEYS = [ADDRESS_CITY_KEY, ADDRESS_STATE_KEY, ADDRESS_ZIP_KEY] as const;
export type AddressPartKey = (typeof ADDRESS_PART_KEYS)[number];

export interface AddressParts {
  city: string | null;
  state: string | null;
  /** As written: five digits, or ZIP+4 ("28673-1234"). */
  zip: string | null;
}

const COUNTRY_RE = /[,\s]*\b(?:u\.?s\.?a\.?|u\.?s\.?|united states(?: of america)?)\.?\s*$/i;
const ZIP_RE = /^(\d{5}(?:-\d{4})?)$/;
const TAIL_ZIP_RE = /^(.*?)[\s,]*\b(\d{5}(?:-\d{4})?)$/;

/** The state at the END of `text` (a code or a name of up to four words), and
 *  the words before it. */
function stateAtEnd(text: string): { state: string; rest: string } | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    const candidate = words.slice(words.length - n).join(' ').replace(/\./g, '');
    // A bare two-letter code must be upper case unless it stands alone, so
    // "in" or "me" at the end of a street is not read as a state.
    if (n === 1 && candidate.length === 2 && candidate !== candidate.toUpperCase() && words.length > 1) continue;
    const state = normalizeState(candidate);
    if (state) return { state, rest: words.slice(0, words.length - n).join(' ') };
  }
  return null;
}

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,.]+$/g, '').trim();
  return t === '' ? null : t;
};

/** Read the city, state and ZIP from the end of an address. Every part that
 *  cannot be read is null; nothing is guessed. */
export function parseAddressParts(address: unknown): AddressParts {
  const none: AddressParts = { city: null, state: null, zip: null };
  if (typeof address !== 'string') return none;
  const text = address.replace(/\s+/g, ' ').trim().replace(COUNTRY_RE, '').trim();
  if (text === '') return none;

  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return none;

  let zip: string | null = null;
  let state: string | null = null;
  let city: string | null = null;

  // The ZIP: the end of the last part, or the whole last part.
  let last = parts[parts.length - 1];
  // A ZIP that was a part of its own ("…, Sherrills Ford, 28673") leaves the
  // city as the last part — counted like a part the state would have held.
  let zipAlone = false;
  const z = TAIL_ZIP_RE.exec(last);
  if (z) {
    zip = z[2];
    last = z[1].trim();
    if (last === '') {
      parts.pop();
      zipAlone = true;
    } else parts[parts.length - 1] = last;
  }
  if (parts.length === 0) return { city, state, zip };

  // The state: the end of what is now the last part.
  const tail = parts[parts.length - 1];
  const st = stateAtEnd(tail);
  if (st) {
    state = st.state;
    if (st.rest !== '') {
      // "Dallas TX" in one part: the words before the state are the city —
      // unless that part is the only one (it is the street then, "123 Main St TX").
      if (parts.length >= 2) city = clean(st.rest);
    } else if (parts.length >= 3) {
      // "…, Sherrills Ford, NC": the part before the state is the city. With
      // only two parts the one before is the street, not a city.
      city = clean(parts[parts.length - 2]);
    }
  } else if (zipAlone && parts.length >= 2 && !ZIP_RE.test(tail)) {
    // "…, Sherrills Ford, 28673": no state written, the city still is.
    city = clean(tail);
  }

  // A city that is a street number or a suite is not a city.
  if (city && (/^\d/.test(city) || /^(?:suite|ste|unit|apt|#)\b/i.test(city))) city = null;

  return { city, state, zip };
}

/** The bag values the parts give, keyed by field. Only parts that were read. */
export function addressPartValues(parts: AddressParts): Partial<Record<AddressPartKey, string>> {
  const out: Partial<Record<AddressPartKey, string>> = {};
  if (parts.city) out[ADDRESS_CITY_KEY] = parts.city;
  if (parts.state) out[ADDRESS_STATE_KEY] = parts.state;
  if (parts.zip) out[ADDRESS_ZIP_KEY] = parts.zip;
  return out;
}
