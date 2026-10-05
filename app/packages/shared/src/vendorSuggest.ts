// 0069 · Suggested vendors: the top few vendors for a work order, by its
// trade, its location and its client. Pure: the API gathers the facts
// (services/vendorSuggest.ts) and this file decides the order, so the same
// rules can be tested without a database.
//
// Two layers:
//   1. hand-picked — the preferred-vendor rules (Admin › Vendors & map), the
//      most specific rule first, then its rank;
//   2. automatic — the slots left over, filled with vendors that pass the
//      hard filters, sorted by the tie-breakers in the order Admin set.
//
// A fixed order of tie-breakers (not a weighted score) on purpose: every row
// can say why it is where it is, and there is nothing to tune.

import type { MapReach, VendorKind } from './vendors';

export const SUGGEST_SIGNALS = [
  { key: 'client_history', label: 'Worked for this client before', hint: 'The most past work orders for the same client first.' },
  { key: 'distance', label: 'Distance', hint: 'Nearest to the work order first.' },
  { key: 'compliance', label: 'Paperwork in order', hint: 'Vendors with a current certificate of insurance before the ones without.' },
  { key: 'jobs', label: 'Jobs done with us', hint: 'The most work orders on record first.' },
  { key: 'rate', label: 'Hourly rate', hint: 'The lowest regular hourly rate first; no rate on file goes last.' },
] as const;
export type SuggestSignal = (typeof SUGGEST_SIGNALS)[number]['key'];
const SIGNAL_KEYS = SUGGEST_SIGNALS.map((s) => s.key) as SuggestSignal[];

export interface SuggestSettings {
  /** How many vendors the list shows. */
  size: number;
  /** Off = only hand-picked preferred vendors are listed. */
  auto_fill: boolean;
  /** Every tie-breaker, in the order they are applied. */
  order: SuggestSignal[];
  /** The tie-breakers that are switched off. */
  off: SuggestSignal[];
  /** Automatic picks must be filed under the work order's trade. */
  match_trade: boolean;
  /** Automatic picks must cover the work order's location. */
  in_coverage: boolean;
  /** A vendor whose COI is missing or expired is left out (off = it only warns). */
  require_compliance: boolean;
  /** On an Emergency work order, automatic picks must take same-day emergencies. */
  emergency_availability: boolean;
  /** The dispatch cascade may offer the job to automatic picks once the hand-picked run out. */
  cascade_auto: boolean;
}

export const SUGGEST_MAX_SIZE = 20;

export const SUGGEST_DEFAULTS: SuggestSettings = {
  size: 5,
  auto_fill: true,
  order: [...SIGNAL_KEYS],
  off: [],
  match_trade: true,
  in_coverage: true,
  require_compliance: false,
  emergency_availability: false,
  cascade_auto: false,
};

/** Whatever is stored or posted, made whole: every tie-breaker exactly once
 *  (unknown ones dropped, missing ones appended in the default order). */
export function cleanSuggestSettings(raw: unknown): SuggestSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const known = (v: unknown): SuggestSignal[] =>
    Array.isArray(v) ? [...new Set(v.filter((k): k is SuggestSignal => SIGNAL_KEYS.includes(k as SuggestSignal)))] : [];
  const order = known(r.order);
  for (const k of SIGNAL_KEYS) if (!order.includes(k)) order.push(k);
  const size = Number(r.size);
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    size: Number.isFinite(size) && size >= 1 ? Math.min(SUGGEST_MAX_SIZE, Math.round(size)) : SUGGEST_DEFAULTS.size,
    auto_fill: flag(r.auto_fill, SUGGEST_DEFAULTS.auto_fill),
    order,
    off: known(r.off),
    match_trade: flag(r.match_trade, SUGGEST_DEFAULTS.match_trade),
    in_coverage: flag(r.in_coverage, SUGGEST_DEFAULTS.in_coverage),
    require_compliance: flag(r.require_compliance, SUGGEST_DEFAULTS.require_compliance),
    emergency_availability: flag(r.emergency_availability, SUGGEST_DEFAULTS.emergency_availability),
    cascade_auto: flag(r.cascade_auto, SUGGEST_DEFAULTS.cascade_auto),
  };
}

/** What is known about one vendor for one work order. */
export interface SuggestCandidate {
  id: string;
  kind: VendorKind;
  name: string;
  phone: string | null;
  city: string | null;
  state: string | null;
  primary_trade: string | null;
  /** Filed under the work order's trade (primary or secondary). */
  trade_match: boolean;
  distance_miles: number | null;
  /** Why they cover the work order's location; null = they do not. */
  reach: MapReach | null;
  /** Other work orders of the same client they were on. */
  client_jobs: number;
  work_orders_count: number;
  regular_hourly_rate: number | null;
  emergency_same_day: boolean | null;
  compliance_warning: string | null;
  blacklisted: boolean;
  hired: boolean;
  /** The best preferred-vendor rule that fits the work order, if any. */
  preferred: { score: number; rank: number; note: string | null; rule: string } | null;
}

export interface SuggestedVendor extends SuggestCandidate {
  position: number;
  /** preferred = somebody picked them for this client / trade / place. */
  source: 'preferred' | 'auto';
}

export interface SuggestContext {
  /** The work order carries the Emergency flag. */
  emergency: boolean;
  /** The work order has a trade to match against. */
  has_trade: boolean;
}

const INF = Number.POSITIVE_INFINITY;

const COMPARE: Record<SuggestSignal, (a: SuggestCandidate, b: SuggestCandidate) => number> = {
  client_history: (a, b) => b.client_jobs - a.client_jobs,
  distance: (a, b) => {
    const d = (a.distance_miles ?? INF) - (b.distance_miles ?? INF);
    return Number.isNaN(d) ? 0 : d;
  },
  compliance: (a, b) => Number(a.compliance_warning !== null) - Number(b.compliance_warning !== null),
  jobs: (a, b) => b.work_orders_count - a.work_orders_count,
  rate: (a, b) => {
    const d = (a.regular_hourly_rate ?? INF) - (b.regular_hourly_rate ?? INF);
    return Number.isNaN(d) ? 0 : d;
  },
};

/** The tie-breakers in force, in order. */
export function activeSignals(settings: SuggestSettings): SuggestSignal[] {
  return settings.order.filter((k) => !settings.off.includes(k));
}

/** Passes the hard filters of an automatic pick. */
export function passesAutoFilters(c: SuggestCandidate, settings: SuggestSettings, ctx: SuggestContext): boolean {
  if (settings.match_trade && ctx.has_trade && !c.trade_match) return false;
  if (settings.in_coverage && c.reach === null) return false;
  // A technician nobody has asked stays in, as on the map; a vendor must have said yes.
  if (settings.emergency_availability && ctx.emergency && !(c.emergency_same_day === true || (c.kind === 'tech' && c.emergency_same_day === null))) {
    return false;
  }
  return true;
}

/**
 * The whole ordered list, hand-picked first — `limit` cuts it (the cascade
 * passes Infinity to walk all of it). Blacklisted vendors are never in it.
 */
export function rankSuggestions(
  candidates: SuggestCandidate[],
  settings: SuggestSettings,
  ctx: SuggestContext,
  limit: number = settings.size,
): SuggestedVendor[] {
  const usable = candidates.filter((c) => !c.blacklisted && !(settings.require_compliance && c.compliance_warning !== null));
  const byName = (a: SuggestCandidate, b: SuggestCandidate) => a.name.localeCompare(b.name);

  const picked = usable
    .filter((c) => c.preferred !== null)
    .sort((a, b) => b.preferred!.score - a.preferred!.score || a.preferred!.rank - b.preferred!.rank || byName(a, b));

  const signals = activeSignals(settings);
  const auto = settings.auto_fill
    ? usable
        .filter((c) => c.preferred === null && passesAutoFilters(c, settings, ctx))
        .sort((a, b) => {
          for (const k of signals) {
            const d = COMPARE[k](a, b);
            if (d !== 0) return d;
          }
          return byName(a, b);
        })
    : [];

  return [
    ...picked.map((c) => ({ ...c, source: 'preferred' as const })),
    ...auto.map((c) => ({ ...c, source: 'auto' as const })),
  ]
    .slice(0, Math.max(0, limit))
    .map((c, i) => ({ ...c, position: i + 1 }));
}

/** GET /work-orders/:id/suggested-vendors */
export interface SuggestedVendorsResponse {
  work_order: { id: string; wo_number: string; client: string | null; trade: string | null; city: string | null; state: string | null; emergency: boolean };
  vendors: SuggestedVendor[];
  /** The work order has no ZIP / city we could place: distance is unknown and
   *  only statewide / nationwide vendors count as covering it. */
  placed: boolean;
  auto_fill: boolean;
  can: { hire: boolean };
}
