// Sales tax derivation — Yoda QuoteSalesTaxEngine.
//
//   1. Only when LaborRate.IsSalesTaxRequired for the WO's (Comp, FM, Trade).
//   2. ZIP from the WO's address fields.
//   3. ZIP → combined rate: the local cache table first, then the provider
//      (RapidAPI when SALES_TAX_API_KEY is set), else a per-state fallback table
//      so the builder still gets a sensible default offline. The operator can
//      always override the % on the quote (logged).

import { query } from '../db.js';
import type { SalesTaxLookup } from '@theone/shared';

const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;
/** "…Galveston, TX 77551" — a ZIP that follows a state code is unambiguous. */
const STATE_ZIP_RE = /\b[A-Z]{2},?\s+(\d{5})(?:-\d{4})?\b/;

/**
 * The site ZIP from a WO's fields. Store numbers and reference ids are also
 * five digits, so a bare match only counts in a ZIP-named field; everywhere
 * else the ZIP must follow a state code ("TX 77551").
 */
export function zipFromFields(fields: unknown): string | null {
  if (!fields || typeof fields !== 'object') return null;
  const entries = Object.entries(fields as Record<string, unknown>).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  );
  for (const [k, v] of entries) {
    if (/\bzip\b|postal/i.test(k)) {
      const m = ZIP_RE.exec(v);
      if (m) return m[1];
    }
  }
  const addressy = entries.filter(([k]) => /address|location|site/i.test(k));
  for (const [, v] of [...addressy, ...entries]) {
    const m = STATE_ZIP_RE.exec(v);
    if (m) return m[1];
  }
  return null;
}

/** State-level combined averages (fallback only — the ZIP provider wins). */
const STATE_FALLBACK_PCT: Record<string, number> = {
  TX: 8.25, FL: 7.0, GA: 7.4, CA: 8.75, AZ: 8.4, NV: 8.25, CO: 7.8, NC: 7.0,
  SC: 7.5, TN: 9.55, AL: 9.25, LA: 9.55, OK: 8.95, NM: 7.7, UT: 7.2, WA: 9.4,
  OR: 0, MT: 0, NH: 0, DE: 0, NY: 8.5, NJ: 6.625, PA: 6.3, OH: 7.2, MI: 6.0,
  IL: 8.8, IN: 7.0, MO: 8.3, KS: 8.7, NE: 6.95, IA: 6.9, MN: 7.5, WI: 5.4,
  VA: 5.75, MD: 6.0, MA: 6.25, CT: 6.35, KY: 6.0, AR: 9.45, MS: 7.05, ID: 6.0,
};

async function fromCache(zip: string): Promise<number | null> {
  const res = await query<{ pct: number | string }>(`SELECT pct FROM sales_tax_rate WHERE zip = $1`, [zip]);
  return res.rows.length === 0 ? null : Number(res.rows[0].pct);
}

/** Provider seam — RapidAPI "sales tax by zip" when configured, else null. */
async function fromProvider(zip: string): Promise<number | null> {
  const key = process.env.SALES_TAX_API_KEY;
  const host = process.env.SALES_TAX_API_HOST;
  if (!key || !host) return null;
  try {
    const res = await fetch(`https://${host}/rates?zip_code=${encodeURIComponent(zip)}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { combined_rate?: number | string; rate?: number | string };
    const raw = body.combined_rate ?? body.rate;
    if (raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    // Providers answer 0.0825 or 8.25 depending on the API — normalise to percent.
    const pct = n < 1 ? n * 100 : n;
    await query(
      `INSERT INTO sales_tax_rate (zip, pct, source) VALUES ($1, $2, 'provider')
       ON CONFLICT (zip) DO UPDATE SET pct = EXCLUDED.pct, source = 'provider', fetched_at = now()`,
      [zip, pct],
    );
    return pct;
  } catch {
    return null;
  }
}

export async function lookupSalesTax(input: {
  required: boolean;
  fields: unknown;
  state: string | null;
}): Promise<SalesTaxLookup> {
  if (!input.required) return { required: false, pct: 0, zip: null, source: 'labor_rate_not_required' };
  const zip = zipFromFields(input.fields);
  if (zip) {
    const cached = await fromCache(zip);
    if (cached !== null) return { required: true, pct: cached, zip, source: 'cache' };
    const live = await fromProvider(zip);
    if (live !== null) return { required: true, pct: live, zip, source: 'provider' };
  }
  const st = input.state?.trim().toUpperCase() ?? '';
  const fallback = STATE_FALLBACK_PCT[st];
  return fallback === undefined
    ? { required: true, pct: 0, zip, source: 'unavailable' }
    : { required: true, pct: fallback, zip, source: 'state_fallback' };
}
