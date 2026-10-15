/**
 * Contracts and labor rates (0046) — what a client has agreed the work costs.
 *
 * A contract is a rate card with a span of dates and a scope: one client (or
 * every client), one billing entity (or every entity), some sites and trades
 * (or all of them). Two readers:
 *
 *   the quote builder  takes its overtime multiplier from overtime ÷ standard
 *                      instead of the hard-coded ×1.5, and offers the
 *                      contract's rates as the default price of a labor line;
 *   the invoice        bills hours on site at the contract rate when the work
 *                      order carries no quote.
 *
 * Everything that decides WHICH contract applies, and WHAT its rates come to,
 * is a pure function here so the API and the browser agree, and so it can be
 * pinned by tests without a database.
 */

export const CONTRACT_KINDS = ['tm', 'scheduled_pm'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

export const CONTRACT_KIND_LABELS: Record<ContractKind, string> = {
  tm: 'Time and materials',
  scheduled_pm: 'Scheduled maintenance',
};

export const RATE_TYPES = ['standard', 'overtime', 'double_time', 'trip_charge', 'markup_pct'] as const;
export type RateType = (typeof RATE_TYPES)[number];

export const RATE_TYPE_LABELS: Record<RateType, string> = {
  standard: 'Standard hour',
  overtime: 'Overtime hour',
  double_time: 'Double-time hour',
  trip_charge: 'Trip charge',
  markup_pct: 'Markup on parts (%)',
};

/** How a rate's amount reads: per hour, per trip, or a percentage. */
export const RATE_TYPE_UNITS: Record<RateType, 'hour' | 'trip' | 'pct'> = {
  standard: 'hour',
  overtime: 'hour',
  double_time: 'hour',
  trip_charge: 'trip',
  markup_pct: 'pct',
};

/** The house overtime multiplier when no contract says otherwise (Jordan,
    2026-07-30: "OT = overtime, ×1.5 rate"). Lives here so the quote services
    on both sides and the rate resolver read the same constant. */
export const DEFAULT_OT_MULTIPLIER = 1.5;

export interface ContractRate {
  id: string;
  rate_type: RateType;
  /** NULL applies to every trade the contract covers. */
  trade: string | null;
  amount: number;
  position: number;
}

/** 0053 · whose terms these are. A client contract prices what WE bill the
    client; a vendor contract prices what a vendor bills US for the same
    hours. Matching is by client / entity / trade / site for the first and by
    the vendor's name (plus trade / site) for the second. */
export const CONTRACT_PARTIES = ['client', 'vendor'] as const;
export type ContractParty = (typeof CONTRACT_PARTIES)[number];

export const CONTRACT_PARTY_LABELS: Record<ContractParty, string> = {
  client: 'Client rate card — what we bill',
  vendor: 'Vendor terms — what the vendor bills us',
};

export interface Contract {
  id: string;
  name: string;
  /** 0053 · 'client' or 'vendor'. */
  party: ContractParty;
  /** 0053 · party = 'vendor': the vendor these terms belong to. NULL = any
      vendor (a house rate for every sub-contractor). */
  vendor_name: string | null;
  /** 0053 · BRD §6.4: when the work order completes, propose the invoice
      (client) or the vendor bill (vendor) from these rates and the hours on
      site, for a person to confirm. */
  auto_invoice: boolean;
  client: string | null;
  billing_entity: string | null;
  kind: ContractKind;
  account_code: string | null;
  starts_on: string;
  ends_on: string | null;
  active: boolean;
  sites_covered: string[];
  trades_covered: string[];
  notes: string | null;
  created_by: { id: string; display_name: string } | null;
  created_at: string;
  updated_at: string;
  rates: ContractRate[];
  /** Derived for the list: true while today sits inside its dates and it is active. */
  in_force: boolean;
}

export interface ContractsResponse {
  items: Contract[];
}

export interface ContractRateInput {
  rate_type: RateType;
  trade?: string | null;
  amount: number;
}

export interface ContractInput {
  name: string;
  party?: ContractParty;
  vendor_name?: string | null;
  auto_invoice?: boolean;
  client?: string | null;
  billing_entity?: string | null;
  kind?: ContractKind;
  account_code?: string | null;
  starts_on?: string;
  ends_on?: string | null;
  active?: boolean;
  sites_covered?: string[];
  trades_covered?: string[];
  notes?: string | null;
  rates?: ContractRateInput[];
}

/** The permission path the module is gated on. */
export const CONTRACT_PERM_KEY = 'contracts';

// ── Which contract applies ───────────────────────────────────────────────────

export interface ContractSubject {
  client: string | null;
  billing_entity: string | null;
  trade: string | null;
  /** The work order's store number or site name, whichever the site carries. */
  site: string | null;
  /** 0053 · which side is asking. Defaults to 'client'; a vendor contract
      never prices a client invoice and the other way round. */
  party?: ContractParty;
  /** 0053 · the vendor on the job (party = 'vendor' only). */
  vendor?: string | null;
}

/** Case-insensitive, trimmed equality — client names arrive from three CMMSs. */
function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

function coversList(list: string[], value: string | null): boolean {
  if (list.length === 0) return true;
  if (value === null) return false;
  return list.some((v) => same(v, value));
}

/** True when the contract's dates include `on` (YYYY-MM-DD) and it is active. */
export function contractInForce(
  c: Pick<Contract, 'active' | 'starts_on' | 'ends_on'>,
  on: string,
): boolean {
  if (!c.active) return false;
  if (c.starts_on && c.starts_on > on) return false;
  if (c.ends_on && c.ends_on < on) return false;
  return true;
}

/**
 * How well a contract fits a work order, or -1 when it does not apply.
 * Higher wins: a contract naming the client AND the entity beats one naming
 * the client alone, which beats a house rate card; a named trade or site
 * beats "all".
 */
export function contractScore(c: Contract, s: ContractSubject, on: string): number {
  if (!contractInForce(c, on)) return -1;
  // 0053 · the two parties never compete: a vendor's terms are not a price
  // for the client, and a vendor card naming a vendor applies to that vendor.
  if ((c.party ?? 'client') !== (s.party ?? 'client')) return -1;
  if (c.party === 'vendor' && c.vendor_name !== null && !same(c.vendor_name, s.vendor)) return -1;
  if (c.client !== null && !same(c.client, s.client)) return -1;
  if (c.billing_entity !== null && !same(c.billing_entity, s.billing_entity)) return -1;
  if (!coversList(c.trades_covered, s.trade)) return -1;
  if (!coversList(c.sites_covered, s.site)) return -1;
  let score = 0;
  if (c.party === 'vendor' && c.vendor_name !== null) score += 16;
  if (c.client !== null) score += 8;
  if (c.billing_entity !== null) score += 4;
  if (c.trades_covered.length > 0) score += 2;
  if (c.sites_covered.length > 0) score += 1;
  return score;
}

/** The single best contract for a work order, or null. Ties go to the one
    that started most recently — the newer agreement is the current one. */
export function pickContract(
  contracts: Contract[],
  subject: ContractSubject,
  on: string,
): Contract | null {
  let best: Contract | null = null;
  let bestScore = -1;
  for (const c of contracts) {
    const score = contractScore(c, subject, on);
    if (score < 0) continue;
    if (
      score > bestScore ||
      (score === bestScore && best !== null && c.starts_on > best.starts_on)
    ) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

// ── M32 (UAT round 1, Wave D): no two cards for the same work ────────────────

/** `details.code` on the 409 an overlapping rate card gets. */
export const CONTRACT_OVERLAP_CODE = 'CONTRACT_OVERLAP';

export type ContractScope = Pick<
  Contract,
  'party' | 'vendor_name' | 'client' | 'billing_entity' | 'sites_covered' | 'trades_covered' | 'starts_on' | 'ends_on' | 'active'
>;

/** Both lists "all" (empty), or both name something and share a value. A
    card naming HVAC and one naming everything are different specificities —
    `pickContract` already prefers the named one, so that is not a clash. */
function listsClash(a: string[], b: string[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  if (a.length === 0 || b.length === 0) return false;
  return a.some((x) => b.some((y) => same(x, y)));
}

/** True when two ACTIVE cards would both be the best match for some work
    order on some day: same party (and vendor), client, entity, the same
    specificity of trades and sites with a value in common, and date windows
    that overlap (no end = open-ended). `pickContract` could only break that
    tie by start date, which is the silent re-pricing M32 refuses. */
export function contractsOverlap(a: ContractScope, b: ContractScope): boolean {
  if (!a.active || !b.active) return false;
  if ((a.party ?? 'client') !== (b.party ?? 'client')) return false;
  if ((a.party ?? 'client') === 'vendor' && !same(a.vendor_name, b.vendor_name)) return false;
  if (!same(a.client, b.client)) return false;
  if (!same(a.billing_entity, b.billing_entity)) return false;
  if (!listsClash(a.trades_covered ?? [], b.trades_covered ?? [])) return false;
  if (!listsClash(a.sites_covered ?? [], b.sites_covered ?? [])) return false;
  const aEnd = a.ends_on ?? '9999-12-31';
  const bEnd = b.ends_on ?? '9999-12-31';
  return a.starts_on <= bEnd && b.starts_on <= aEnd;
}

// ── M30 (UAT round 1, Wave D): rates as they stood ───────────────────────────

/** One version of a card's rates (`contract_rate_version`, 0086): what
    applies to a work order RECEIVED on or after `effective_from` (until the
    next version). The first version of every card reaches back forever. */
export interface ContractRateVersion {
  effective_from: string | null;
  rates: ContractRate[];
}

/** The version in force for a work order received on `asOf` (YYYY-MM-DD):
    the latest one that took effect on or before that day. Null when there
    is none (a card saved before 0086 and never versioned). */
export function rateVersionAsOf(versions: readonly ContractRateVersion[], asOf: string): ContractRateVersion | null {
  let best: ContractRateVersion | null = null;
  for (const v of versions) {
    const from = v.effective_from ? v.effective_from.slice(0, 10) : '0000-01-01';
    if (from > asOf) continue;
    const bestFrom = best?.effective_from ? best.effective_from.slice(0, 10) : '0000-01-01';
    if (!best || from >= bestFrom) best = v;
  }
  return best;
}

// ── What its rates come to ───────────────────────────────────────────────────

export interface ResolvedRates {
  standard: number | null;
  overtime: number | null;
  double_time: number | null;
  trip_charge: number | null;
  markup_pct: number | null;
  /** overtime ÷ standard when both are set, else the house default. */
  ot_multiplier: number;
}

/** Pick each rate type once: the row naming the trade first, the trade-less
    row as the fallback. */
export function resolveRates(rates: ContractRate[], trade: string | null): ResolvedRates {
  const pick = (type: RateType): number | null => {
    const specific = rates.find((r) => r.rate_type === type && r.trade !== null && same(r.trade, trade));
    const general = rates.find((r) => r.rate_type === type && r.trade === null);
    const row = specific ?? general;
    return row ? row.amount : null;
  };
  const standard = pick('standard');
  const overtime = pick('overtime');
  return {
    standard,
    overtime,
    double_time: pick('double_time'),
    trip_charge: pick('trip_charge'),
    markup_pct: pick('markup_pct'),
    ot_multiplier: otMultiplierFrom(standard, overtime),
  };
}

/** ×1.5 unless the contract states both hourly rates, in which case their
    ratio — rounded to three places so 82.50 ÷ 55 reads as exactly 1.5. */
export function otMultiplierFrom(standard: number | null, overtime: number | null): number {
  if (standard === null || overtime === null || standard <= 0 || overtime <= 0) {
    return DEFAULT_OT_MULTIPLIER;
  }
  return Math.round((overtime / standard) * 1000) / 1000;
}

/** Hours between two ISO stamps, to the quarter hour, never negative. A
    visit that is checked in but not out is not billable time yet. */
export function billableHours(checkIn: string | null, checkOut: string | null): number {
  if (!checkIn || !checkOut) return 0;
  const ms = Date.parse(checkOut) - Date.parse(checkIn);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round((ms / 3_600_000) * 4) / 4;
}
