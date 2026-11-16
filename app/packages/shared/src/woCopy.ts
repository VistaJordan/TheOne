// The two "copy" buttons in the work-order header (Elise, 2026-11-12). Pure:
// the header hands in the bag and the core columns, this builds the text.
//
// Copy full — what our own team needs: WO #, the full address, the store,
// the scope (the WO description) and, since 2026-11-16 (Elise, UAT #41), the
// sign-off link: the billing entity's prefilled Paperform, else what the
// Sign-Off Link field holds.
// Copy vague — what can go to a technician who has not been hired yet: the
// street, city and ZIP (no state, no WO #, no store) and the scope.

import { ADDRESS_CITY_KEY, ADDRESS_KEY, ADDRESS_STREET_KEY, ADDRESS_ZIP_KEY, parseAddressParts } from './addressParts';
import { signoffFormLink, signoffLayoutFor } from './signoff';

export const WO_DESCRIPTION_KEY = '35. WO Description';
export const WO_STORE_KEY = 'Store';
export const WO_SIGNOFF_LINK_KEY = '24. Sign-Off Link';
const WO_COMP_KEY = '21. Comp';

export interface WoCopySource {
  wo_number: string;
  /** The promoted column; the bag's WO description wins when set. */
  description?: string | null;
  city?: string | null;
  /** The client's WO number — what the sign-off form is prefilled with. */
  ext_name?: string | null;
  client?: string | null;
  billing_entity?: string | null;
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

/** The link the technician signs off on: the entity's prefilled form (the
 *  client's WO #, else ours, and the address), else the Sign-Off Link field. */
export function woSignoffLink(src: WoCopySource): string | null {
  const comp = text(src.fields[WO_COMP_KEY]) ?? text(src.billing_entity);
  const client = text(src.fields.Client) ?? text(src.client);
  const form = signoffFormLink(
    signoffLayoutFor(comp, client),
    text(src.ext_name) ?? text(src.wo_number),
    text(src.fields[ADDRESS_KEY]),
  );
  return form ?? text(src.fields[WO_SIGNOFF_LINK_KEY]);
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
    ['Sign-off link', woSignoffLink(src)],
  ]);
}

export function woCopyVague(src: WoCopySource): string {
  return lines([
    ['Address', woVagueAddress(src)],
    ['Scope', woCopyScope(src)],
  ]);
}
