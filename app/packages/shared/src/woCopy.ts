// The two "copy" buttons in the work-order header (Elise, 2026-11-12). Pure:
// the header hands in the bag and the core columns, this builds the text.
//
// Copy full — what our own team needs: WO #, the full address, the store and
// the scope (the WO description).
// Copy vague — what can go to a technician who has not been hired yet: the
// street, city and ZIP (no state, no WO #, no store) and the scope.

import { ADDRESS_CITY_KEY, ADDRESS_KEY, ADDRESS_STREET_KEY, ADDRESS_ZIP_KEY, parseAddressParts } from './addressParts';

export const WO_DESCRIPTION_KEY = '35. WO Description';
export const WO_STORE_KEY = 'Store';

export interface WoCopySource {
  wo_number: string;
  /** The promoted column; the bag's WO description wins when set. */
  description?: string | null;
  city?: string | null;
  fields: Record<string, unknown>;
}

const text = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/** The scope of work: the WO description, kept as written (line breaks too). */
export function woCopyScope(src: WoCopySource): string | null {
  return text(src.fields[WO_DESCRIPTION_KEY]) ?? text(src.description);
}

/** "Street, City ZIP" — each part from its own field, else read off the
 *  address. A part nobody knows is left out. */
export function woVagueAddress(src: WoCopySource): string | null {
  const parsed = parseAddressParts(src.fields[ADDRESS_KEY]);
  const street = text(src.fields[ADDRESS_STREET_KEY]) ?? parsed.street;
  const city = text(src.fields[ADDRESS_CITY_KEY]) ?? text(src.city) ?? parsed.city;
  const zip = text(src.fields[ADDRESS_ZIP_KEY]) ?? parsed.zip;
  const place = [city, zip].filter(Boolean).join(' ');
  const out = [street, place].filter(Boolean).join(', ');
  return out === '' ? null : out;
}

const lines = (rows: Array<[string, string | null]>): string =>
  rows
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

export function woCopyFull(src: WoCopySource): string {
  return lines([
    ['WO#', text(src.wo_number)],
    ['Address', text(src.fields[ADDRESS_KEY])],
    ['Store', text(src.fields[WO_STORE_KEY])],
    ['Scope', woCopyScope(src)],
  ]);
}

export function woCopyVague(src: WoCopySource): string {
  return lines([
    ['Address', woVagueAddress(src)],
    ['Scope', woCopyScope(src)],
  ]);
}
