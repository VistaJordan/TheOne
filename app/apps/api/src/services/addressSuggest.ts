// 0140 · Address suggestions from Google Maps, and the count of what we ask
// Google (Elise, 2026-11-15).
//
// Three things stand between a keystroke and Google: the Google Maps switch
// in Admin › Integrations, the key on the server, and the daily cap on
// suggestion requests (GOOGLE_PLACES_DAILY_CAP, the whole team together, a
// Chicago day). Any of them missing answers `available: false` with the
// reason and the box is plain typing — never an error on the form.
//
// Every request made is counted in google_usage (one row per Chicago day and
// kind), which is what the Integrations row and its panel show, so the spend
// can be watched from inside OBI as well as on Google's own billing page.

import {
  ADDRESS_SUGGEST_DAILY_CAP_DEFAULT,
  ADDRESS_SUGGEST_DAILY_CAP_MAX,
  GOOGLE_USAGE_KINDS,
  INTEGRATIONS_PERM_KEY,
  addressSuggestWorthAsking,
  emptyGoogleUsage,
  type AddressPlaceResponse,
  type AddressSuggestResponse,
  type GoogleUsageCounts,
  type GoogleUsageKind,
  type GoogleUsageOverview,
} from '@theone/shared';
import { query } from '../db.js';
import { googleKey } from '../lib/googleGeocode.js';
import { PlacesUnavailable, placeDetails, placesAutocomplete } from '../lib/googlePlaces.js';
import { ApiError } from '../errors.js';
import { logAdminEvent } from './adminAudit.js';
import { integrationOn } from './integrations.js';
import { allowFor, requirePerm, type PermissionBearer } from './permissions.js';

const TODAY = `(now() AT TIME ZONE 'America/Chicago')::date`;

/** The limit when nobody has typed one in Admin › Integrations: the
    server's GOOGLE_PLACES_DAILY_CAP, else the default. 0 = no cap. */
export function googlePlacesDailyCap(): number {
  const raw = process.env.GOOGLE_PLACES_DAILY_CAP?.trim();
  if (!raw) return ADDRESS_SUGGEST_DAILY_CAP_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : ADDRESS_SUGGEST_DAILY_CAP_DEFAULT;
}

const validCap = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= ADDRESS_SUGGEST_DAILY_CAP_MAX;

/** 0141 · the limit in force: the number typed in Admin › Integrations, else
    the environment's, else the default. Before 0141, or with the database
    away, the fallback answers. */
export async function dailyCapInForce(): Promise<{ cap: number; source: 'admin' | 'env' | 'default' }> {
  try {
    const r = await query<{ value: { value?: unknown } | null }>(`SELECT value FROM google_setting WHERE key = 'daily_cap'`);
    const v = r.rows[0]?.value?.value;
    if (validCap(v)) return { cap: v, source: 'admin' };
  } catch {
    /* before 0141 */
  }
  return { cap: googlePlacesDailyCap(), source: process.env.GOOGLE_PLACES_DAILY_CAP?.trim() ? 'env' : 'default' };
}

type Admin = PermissionBearer & { id: string };

/** 0141 · change the limit from the admin page (admin/integrations edit).
    Takes effect on the next suggestion request; logged. */
export async function setDailyCap(cap: number, user: Admin): Promise<GoogleUsageOverview> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'edit', 'You cannot change Admin › Integrations');
  if (!validCap(cap)) {
    throw new ApiError('BAD_REQUEST', `The daily limit is a whole number from 0 to ${ADDRESS_SUGGEST_DAILY_CAP_MAX.toLocaleString('en-US')} (0 = no limit)`, { code: 'VALIDATION', field: 'daily_cap' });
  }
  const before = (await dailyCapInForce()).cap;
  await query(
    `INSERT INTO google_setting (key, value, updated_by, updated_at) VALUES ('daily_cap', $1::jsonb, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify({ value: cap }), user.id],
  );
  if (before !== cap) {
    await logAdminEvent({
      actorId: user.id,
      entity: 'integration',
      entityId: 'google_maps',
      action: 'google_maps_limit_changed',
      before: { name: 'Google Maps', daily_cap: before },
      after: { name: 'Google Maps', daily_cap: cap },
    });
  }
  return googleUsageOverview(user);
}

/** Count one request to Google. Never throws: a missed count must not cost
    anyone their suggestions (before 0140 the table is simply not there). */
export async function countGoogleUse(kind: GoogleUsageKind): Promise<void> {
  try {
    await query(
      `INSERT INTO google_usage (day, kind, uses) VALUES (${TODAY}, $1, 1)
       ON CONFLICT (day, kind) DO UPDATE SET uses = google_usage.uses + 1`,
      [kind],
    );
  } catch (e) {
    console.warn('[google] could not count a use:', (e as Error).message);
  }
}

async function suggestionsToday(): Promise<number> {
  try {
    const r = await query<{ uses: number }>(`SELECT uses FROM google_usage WHERE day = ${TODAY} AND kind = 'autocomplete'`);
    return r.rows[0]?.uses ?? 0;
  } catch {
    return 0;
  }
}

export async function suggestAddresses(text: string, sessionToken: string): Promise<AddressSuggestResponse> {
  if (!integrationOn('google_maps')) return { available: false, reason: 'switched_off', suggestions: [] };
  if (!googleKey()) return { available: false, reason: 'not_set_up', suggestions: [] };
  if (!addressSuggestWorthAsking(text)) return { available: true, suggestions: [] };
  const { cap } = await dailyCapInForce();
  if (cap > 0 && (await suggestionsToday()) >= cap) return { available: false, reason: 'daily_cap', suggestions: [] };
  await countGoogleUse('autocomplete');
  try {
    return { available: true, suggestions: await placesAutocomplete(text.trim(), sessionToken) };
  } catch (e) {
    if (!(e instanceof PlacesUnavailable)) throw e;
    console.warn('[google]', e.message);
    return { available: false, reason: 'unreachable', suggestions: [] };
  }
}

export async function pickedAddress(placeId: string, sessionToken: string): Promise<AddressPlaceResponse> {
  if (!integrationOn('google_maps') || !googleKey()) return { place: null };
  await countGoogleUse('place_details');
  try {
    return { place: await placeDetails(placeId, sessionToken) };
  } catch (e) {
    if (!(e instanceof PlacesUnavailable)) throw e;
    console.warn('[google]', e.message);
    return { place: null };
  }
}

// ── Use, for Admin › Integrations ────────────────────────────────────────────

function fold(rows: { kind: string; uses: number | string }[]): GoogleUsageCounts {
  const out = emptyGoogleUsage();
  for (const r of rows) {
    if ((GOOGLE_USAGE_KINDS as readonly string[]).includes(r.kind)) out[r.kind as GoogleUsageKind] += Number(r.uses);
  }
  return out;
}

/** Today, this month and last month (Chicago), and the last 14 days used.
    Before 0140, or with the database away, everything reads zero. */
export async function googleUsageOverview(user: PermissionBearer): Promise<GoogleUsageOverview> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'view', 'Admin › Integrations is not available to you');
  const limit = await dailyCapInForce();
  const empty: GoogleUsageOverview = {
    today: emptyGoogleUsage(),
    month: emptyGoogleUsage(),
    last_month: emptyGoogleUsage(),
    daily_cap: limit.cap,
    daily_cap_source: limit.source,
    can: { edit: allowFor(user)(INTEGRATIONS_PERM_KEY, 'edit') },
    days: [],
  };
  try {
    const span = await query<{ span: string; kind: string; uses: string }>(
      `SELECT s.span, u.kind, sum(u.uses)::text AS uses
         FROM google_usage u
         JOIN (VALUES
                ('today',      ${TODAY},                                         ${TODAY}),
                ('month',      date_trunc('month', ${TODAY})::date,              ${TODAY}),
                ('last_month', (date_trunc('month', ${TODAY}) - interval '1 month')::date,
                               (date_trunc('month', ${TODAY}) - interval '1 day')::date)
              ) AS s(span, from_day, to_day) ON u.day BETWEEN s.from_day AND s.to_day
        GROUP BY s.span, u.kind`,
    );
    const days = await query<{ day: string; kind: string; uses: number }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, kind, uses
         FROM google_usage WHERE day > ${TODAY} - 14 ORDER BY day DESC`,
    );
    const byDay = new Map<string, GoogleUsageCounts>();
    for (const r of days.rows) {
      const c = byDay.get(r.day) ?? emptyGoogleUsage();
      if ((GOOGLE_USAGE_KINDS as readonly string[]).includes(r.kind)) c[r.kind as GoogleUsageKind] += Number(r.uses);
      byDay.set(r.day, c);
    }
    const of = (name: string) => fold(span.rows.filter((r) => r.span === name));
    return {
      ...empty,
      today: of('today'),
      month: of('month'),
      last_month: of('last_month'),
      days: [...byDay.entries()].map(([day, c]) => ({ day, ...c })),
    };
  } catch {
    return empty;
  }
}
