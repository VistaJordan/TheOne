/* Ecotrak `trade` -> The One trade vocabulary.
 *
 * REBUILT from 232 production work orders (2026-08-19). The existing
 * ecotrak-clickup-sync TRADE_MAP has 10 entries and matches only 7 of the 29
 * trades that actually occur, so ~69 of 232 WOs (30%) silently fall back to
 * "Handyman" — including 10 x "Refrigeration - Walk-in" and a bare "Locksmith",
 * both of which have exact destination options available.
 *
 * Every one of the 29 observed values is listed below, with its production
 * count, so coverage is auditable rather than assumed.
 */

/** Destination vocabulary — the ClickUp `Trade` dropdown options. */
export const TRADES = [
  'Plumbing', 'Electric', 'HVAC', 'Handyman', 'Janitorial', 'Locksmith',
  'Overhead Door', 'Roofing', 'Pest Control', 'Landscaping',
  'General Contracting', 'HVAC PM', 'Appliance', 'Refrigeration',
  'Refrigeration PM', 'PM',
] as const;

export type Trade = (typeof TRADES)[number];

export interface TradeRule {
  trade: Trade;
  /** Occurrences in the 2026-08-19 production read. */
  seen: number;
  /** false = a judgement call that ops should confirm. */
  confirmed: boolean;
}

export const TRADE_MAP: Record<string, TradeRule> = {
  // ── Exact, high confidence ────────────────────────────────────────────────
  'HVAC': { trade: 'HVAC', seen: 58, confirmed: true },
  'Handyman': { trade: 'Handyman', seen: 56, confirmed: true },
  'Plumber': { trade: 'Plumbing', seen: 27, confirmed: true },
  'Electrician': { trade: 'Electric', seen: 16, confirmed: true },
  'Refrigeration': { trade: 'Refrigeration', seen: 3, confirmed: true },
  'Janitorial': { trade: 'Janitorial', seen: 1, confirmed: true },
  'Appliance': { trade: 'Appliance', seen: 1, confirmed: true },

  // ── Fixes the existing map gets WRONG today ───────────────────────────────
  // Falls to Handyman today despite an exact option existing.
  'Refrigeration - Walk-in': { trade: 'Refrigeration', seen: 10, confirmed: true },
  // The old map has "Safe / Locksmith" but not the bare value.
  'Locksmith': { trade: 'Locksmith', seen: 1, confirmed: true },
  'Safe / Locksmith': { trade: 'Locksmith', seen: 3, confirmed: true },
  'Plumber - Water Heater': { trade: 'Plumbing', seen: 2, confirmed: true },
  'HVAC - Preventative Maintenance': { trade: 'HVAC PM', seen: 2, confirmed: true },
  'HVAC Test and Balance': { trade: 'HVAC', seen: 1, confirmed: true },
  'Roofing Company': { trade: 'Roofing', seen: 1, confirmed: true },
  'Landscaper': { trade: 'Landscaping', seen: 1, confirmed: true },
  'Door Repair': { trade: 'Overhead Door', seen: 8, confirmed: true },
  'Cooking Equipment': { trade: 'Appliance', seen: 1, confirmed: true },

  // ── Judgement calls — no exact destination option exists ──────────────────
  // These are the rows to confirm with ops before the map goes live.
  'Windows and Storefront': { trade: 'General Contracting', seen: 10, confirmed: false },
  'Painter': { trade: 'General Contracting', seen: 10, confirmed: false },
  'Tile/Grout Repair': { trade: 'General Contracting', seen: 7, confirmed: false },
  'Flooring Contractor': { trade: 'General Contracting', seen: 1, confirmed: false },
  'Signage Company': { trade: 'General Contracting', seen: 1, confirmed: false },
  'Store Graphics': { trade: 'General Contracting', seen: 1, confirmed: false },
  'Fire / Life / Safety Company': { trade: 'General Contracting', seen: 1, confirmed: false },
  'Parking Lot': { trade: 'General Contracting', seen: 1, confirmed: false },
  'Door Key Program': { trade: 'Locksmith', seen: 1, confirmed: false },
  'Tea Brewer': { trade: 'Appliance', seen: 1, confirmed: false },
  'MISC': { trade: 'Handyman', seen: 4, confirmed: false },
  'Internal': { trade: 'Handyman', seen: 2, confirmed: false },
};

/**
 * Resolve a trade. Matching is case- and whitespace-insensitive because
 * production carries trailing-space variants (e.g. "Store Graphics ",
 * "Capital Expense " both occur).
 *
 * Returns null for an unknown trade rather than defaulting. A silent fallback
 * to Handyman is what produced the current 30% mis-classification: the caller
 * must decide whether to park the record or apply a default, and either way it
 * gets logged.
 */
export function resolveTrade(raw: string | null | undefined): TradeRule | null {
  if (!raw) return null;
  const key = raw.trim();
  if (TRADE_MAP[key]) return TRADE_MAP[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(TRADE_MAP)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/** Trades needing an ops decision before the map is trusted. */
export function unconfirmedTrades(): string[] {
  return Object.entries(TRADE_MAP)
    .filter(([, v]) => !v.confirmed)
    .sort((a, b) => b[1].seen - a[1].seen)
    .map(([k]) => k);
}
