// 0140 · Address suggestions from Google Maps (Elise, 2026-11-15).
//
// The Address box on Add work order, on a draft and in the work order's own
// field editor offers Google's addresses as it is typed, as ClickUp's
// location field does — the client sometimes sends the wrong address, and a
// picked suggestion is one Google knows. Typing an address Google does not
// know is still allowed (new builds, a unit inside a mall): the box is a
// text box with suggestions, never a closed list.
//
// The browser never talks to Google and never sees the key: it asks our API
// (routes/address.ts), which asks Google's Places API (New). This file is the
// vocabulary both sides share, and the pure halves of it.

/** Suggestions are asked for from this many typed characters on. */
export const ADDRESS_SUGGEST_MIN_CHARS = 4;
/** …and never for more than this many (a pasted paragraph is not an address). */
export const ADDRESS_SUGGEST_MAX_CHARS = 200;
/** The pause after the last keystroke before the API is asked. */
export const ADDRESS_SUGGEST_DEBOUNCE_MS = 300;
/** How many suggestions the list shows. */
export const ADDRESS_SUGGEST_MAX = 5;
/** Suggestion requests a day, the whole team together, before the box goes
    back to plain typing until tomorrow (Chicago); 0 = no cap. The number in
    force is the one typed under Google Maps in Admin › Integrations (0141),
    else GOOGLE_PLACES_DAILY_CAP on the server, else this. */
export const ADDRESS_SUGGEST_DAILY_CAP_DEFAULT = 3000;
/** The most the admin page accepts. */
export const ADDRESS_SUGGEST_DAILY_CAP_MAX = 100000;

/** Is this text worth asking Google about? */
export function addressSuggestWorthAsking(text: string): boolean {
  const t = text.trim();
  return t.length >= ADDRESS_SUGGEST_MIN_CHARS && t.length <= ADDRESS_SUGGEST_MAX_CHARS;
}

export interface AddressSuggestion {
  place_id: string;
  /** "7898 Bradley Long Dr" */
  main: string;
  /** "Sherrills Ford, NC, USA" */
  secondary: string;
}

/** Why the box is plain typing right now. */
export type AddressSuggestOff = 'switched_off' | 'not_set_up' | 'daily_cap' | 'unreachable';

export interface AddressSuggestResponse {
  /** False = no suggestions will come; the box is a plain text box. */
  available: boolean;
  reason?: AddressSuggestOff;
  suggestions: AddressSuggestion[];
}

export interface AddressPlace {
  /** The team's shape: "7898 Bradley Long Dr, Sherrills Ford, NC 28673, USA". */
  address: string;
  lat: number | null;
  lng: number | null;
}

export interface AddressPlaceResponse {
  place: AddressPlace | null;
}

// ── What Google sends back (Places API, New), reduced to what we read ────────

export interface GoogleAutocompleteBody {
  suggestions?: {
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
    };
  }[];
}

/** Google's predictions → our suggestions. A prediction with no id or no
    text is dropped; at most ADDRESS_SUGGEST_MAX come back. */
export function suggestionsFromGoogle(body: GoogleAutocompleteBody | null | undefined): AddressSuggestion[] {
  const out: AddressSuggestion[] = [];
  for (const s of body?.suggestions ?? []) {
    const p = s.placePrediction;
    const id = p?.placeId?.trim();
    if (!id) continue;
    const main = p?.structuredFormat?.mainText?.text?.trim() || p?.text?.text?.trim() || '';
    if (!main) continue;
    const secondary = p?.structuredFormat?.mainText?.text ? (p.structuredFormat.secondaryText?.text?.trim() ?? '') : '';
    out.push({ place_id: id, main, secondary });
    if (out.length >= ADDRESS_SUGGEST_MAX) break;
  }
  return out;
}

export interface GooglePlaceBody {
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
}

/** Google's place → the address we write. Null when it carries no address. */
export function placeFromGoogle(body: GooglePlaceBody | null | undefined): AddressPlace | null {
  const address = body?.formattedAddress?.trim();
  if (!address) return null;
  const lat = body?.location?.latitude;
  const lng = body?.location?.longitude;
  return {
    address,
    lat: typeof lat === 'number' ? lat : null,
    lng: typeof lng === 'number' ? lng : null,
  };
}

/** A place id as Google writes them: letters, digits, dash and underscore.
    Checked before it is put in a URL. */
export const GOOGLE_PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

// ── Use, for the Integrations page ───────────────────────────────────────────

/** What is counted, one row per Chicago day and kind (table google_usage). */
export const GOOGLE_USAGE_KINDS = ['autocomplete', 'place_details', 'geocode'] as const;
export type GoogleUsageKind = (typeof GOOGLE_USAGE_KINDS)[number];

export interface GoogleUsageCounts {
  autocomplete: number;
  place_details: number;
  geocode: number;
}

export interface GoogleUsageOverview {
  today: GoogleUsageCounts;
  month: GoogleUsageCounts;
  last_month: GoogleUsageCounts;
  /** Suggestion requests allowed a day; 0 = no cap. */
  daily_cap: number;
  /** Where that number comes from: typed in Admin › Integrations, the
      server's environment, or the built-in default. */
  daily_cap_source: 'admin' | 'env' | 'default';
  can: { edit: boolean };
  /** The last 14 days that saw any use, newest first. */
  days: ({ day: string } & GoogleUsageCounts)[];
}

export const emptyGoogleUsage = (): GoogleUsageCounts => ({ autocomplete: 0, place_details: 0, geocode: 0 });

/** One line for the Integrations row. */
export function googleUsageSentence(month: GoogleUsageCounts): string {
  const n = (v: number, one: string, many: string) => `${v.toLocaleString('en-US')} ${v === 1 ? one : many}`;
  return `This month: ${n(month.place_details, 'address picked', 'addresses picked')}, ${n(month.autocomplete, 'suggestion request', 'suggestion requests')}, ${n(month.geocode, 'address placed for ClickUp', 'addresses placed for ClickUp')}.`;
}
