/* Ecotrak `trade` -> The One's two-level trade vocabulary.
 *
 * GENERAL TRADE is the dispatch-level classification — five values, because
 * that is how the vendor bench is actually organised. SUBTRADE is the detail,
 * kept because it drives who you call (a walk-in cooler is not a reach-in, a
 * water heater is not a drain) without fragmenting the top-level list.
 *
 * Built from 232 production work orders read 2026-08-19 (GET only). All 29
 * production trade strings are covered, with counts, so coverage is auditable.
 *
 * Why this replaces the existing sync's flat TRADE_MAP: that table matches 7 of
 * the 29 values, so ~69 of 232 WOs (30%) silently became "Handyman" — including
 * 10 walk-in refrigeration jobs and a bare "Locksmith". Silent defaulting is the
 * bug, so resolveTrade returns null on an unknown value and the caller decides.
 */

/** Dispatch-level trade. Five values — the vendor bench is organised this way. */
export const GENERAL_TRADES = [
  'Handyman',
  'Electric',
  'Plumbing',
  'HVAC',
  'Refrigeration',
] as const;

export type GeneralTrade = (typeof GENERAL_TRADES)[number];

export interface TradeRule {
  general: GeneralTrade;
  /** null = the general trade with no further detail. */
  sub: string | null;
  /** Occurrences in the 2026-08-19 production read. */
  seen: number;
  /** false = a judgement call ops should confirm. */
  confirmed: boolean;
}

export const TRADE_MAP: Record<string, TradeRule> = {
  // ── HVAC · 61 ─────────────────────────────────────────────────────────────
  'HVAC': { general: 'HVAC', sub: null, seen: 58, confirmed: true },
  'HVAC - Preventative Maintenance': { general: 'HVAC', sub: 'Preventative Maintenance', seen: 2, confirmed: true },
  'HVAC Test and Balance': { general: 'HVAC', sub: 'Test and Balance', seen: 1, confirmed: true },

  // ── Refrigeration · 13 ────────────────────────────────────────────────────
  // Walk-in is the single biggest mis-classification in the live sync today.
  'Refrigeration - Walk-in': { general: 'Refrigeration', sub: 'Walk-in', seen: 10, confirmed: true },
  'Refrigeration': { general: 'Refrigeration', sub: null, seen: 3, confirmed: true },

  // ── Plumbing · 29 ─────────────────────────────────────────────────────────
  'Plumber': { general: 'Plumbing', sub: null, seen: 27, confirmed: true },
  'Plumber - Water Heater': { general: 'Plumbing', sub: 'Water Heater', seen: 2, confirmed: true },

  // ── Electric · 16 ─────────────────────────────────────────────────────────
  'Electrician': { general: 'Electric', sub: null, seen: 16, confirmed: true },

  // ── Handyman · 113 ────────────────────────────────────────────────────────
  // The general bench: anything not requiring a licensed specialty. Subtrades
  // keep the detail so dispatch can still filter on it.
  'Handyman': { general: 'Handyman', sub: null, seen: 56, confirmed: true },
  'Windows and Storefront': { general: 'Handyman', sub: 'Windows & Storefront', seen: 10, confirmed: false },
  'Painter': { general: 'Handyman', sub: 'Painting', seen: 10, confirmed: false },
  'Door Repair': { general: 'Handyman', sub: 'Doors', seen: 8, confirmed: true },
  'Tile/Grout Repair': { general: 'Handyman', sub: 'Tile & Grout', seen: 7, confirmed: false },
  'MISC': { general: 'Handyman', sub: null, seen: 4, confirmed: false },
  'Safe / Locksmith': { general: 'Handyman', sub: 'Locksmith', seen: 3, confirmed: true },
  'Internal': { general: 'Handyman', sub: null, seen: 2, confirmed: false },
  'Locksmith': { general: 'Handyman', sub: 'Locksmith', seen: 1, confirmed: true },
  'Door Key Program': { general: 'Handyman', sub: 'Locksmith', seen: 1, confirmed: false },
  'Cooking Equipment': { general: 'Handyman', sub: 'Appliance', seen: 1, confirmed: false },
  'Tea Brewer': { general: 'Handyman', sub: 'Appliance', seen: 1, confirmed: false },
  'Appliance': { general: 'Handyman', sub: 'Appliance', seen: 1, confirmed: false },
  'Signage Company': { general: 'Handyman', sub: 'Signage', seen: 1, confirmed: false },
  'Store Graphics': { general: 'Handyman', sub: 'Signage', seen: 1, confirmed: false },
  'Landscaper': { general: 'Handyman', sub: 'Landscaping', seen: 1, confirmed: false },
  'Janitorial': { general: 'Handyman', sub: 'Janitorial', seen: 1, confirmed: false },
  'Roofing Company': { general: 'Handyman', sub: 'Roofing', seen: 1, confirmed: false },
  'Flooring Contractor': { general: 'Handyman', sub: 'Flooring', seen: 1, confirmed: false },
  'Fire / Life / Safety Company': { general: 'Handyman', sub: 'Fire & Life Safety', seen: 1, confirmed: false },
  'Parking Lot': { general: 'Handyman', sub: 'Parking Lot', seen: 1, confirmed: false },
};

/**
 * Resolve a raw Ecotrak trade string.
 *
 * Case- and whitespace-insensitive: production carries trailing-space variants
 * ("Store Graphics ", "Capital Expense ").
 *
 * Returns null for an unknown trade rather than defaulting. The silent fallback
 * to Handyman is exactly what produced the current 30% mis-classification — the
 * caller must choose to park the record or apply a default, and log either way.
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

/** "HVAC" or "Refrigeration / Walk-in" — one display string. */
export function tradeLabel(rule: TradeRule): string {
  return rule.sub ? `${rule.general} / ${rule.sub}` : rule.general;
}

/** Every subtrade under a general trade, for dispatch filters. */
export function subtradesOf(general: GeneralTrade): string[] {
  return [
    ...new Set(
      Object.values(TRADE_MAP)
        .filter((r) => r.general === general && r.sub !== null)
        .map((r) => r.sub as string),
    ),
  ].sort();
}

/** Production volume per general trade — the dispatch-bench sizing. */
export function volumeByGeneral(): Record<GeneralTrade, number> {
  const out = Object.fromEntries(GENERAL_TRADES.map((g) => [g, 0])) as Record<GeneralTrade, number>;
  for (const r of Object.values(TRADE_MAP)) out[r.general] += r.seen;
  return out;
}

/** Judgement calls still needing an ops decision, highest volume first. */
export function unconfirmedTrades(): string[] {
  return Object.entries(TRADE_MAP)
    .filter(([, v]) => !v.confirmed)
    .sort((a, b) => b[1].seen - a[1].seen)
    .map(([k]) => k);
}
