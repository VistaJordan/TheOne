/**
 * The price list (migration 0101, Elise, 2026-10-27): what the team charges,
 * per billing entity (Comp), per client and per trade, as the "Prices &
 * quotes library" sheet kept it.
 *
 * One CARD per (entity, client). The entity's Standard card has no client;
 * every other card names one and states only what differs from it — a trade
 * it does not list, and a trip it leaves blank, are the Standard card's
 * (`resolvePrice`). A card holds the trip charge, the materials markup (the
 * multiplier, "up to ×1.3"), its labor RATES — one row per line of the sheet,
 * with the work-order Trade values it prices — and its FEES (snake, hydrojet,
 * boom lift …), each a figure or, when the sheet gave a range or a unit, a
 * note ("$350-550", "$250 per device").
 *
 * Read with `prices` view; created, changed and removed with `prices` create
 * / edit / delete, which 0101 grants to the admin role only.
 */

export const PRICES_PERM_KEY = 'prices';

export interface PriceRate {
  id: string;
  /** As the sheet wrote it: "Plumber - Electrician". */
  label: string;
  /** The work-order Trade values this row prices: ["Plumbing", "Electric"]. */
  trades: string[];
  tech_rate: number | null;
  helper_rate: number | null;
  afterhours_rate: number | null;
  holiday_rate: number | null;
  /** A trip of this trade's own (AF / All Systems); null = the card's. */
  trip_rate: number | null;
}

export interface PriceFee {
  id: string;
  name: string;
  amount: number | null;
  /** When the price is not one figure: "$350-550", "$250 per device". */
  note: string | null;
}

export interface PriceCard {
  id: string;
  billing_entity: string;
  /** null = the entity's Standard card. */
  client: string | null;
  /** True when a client record of that name exists (always true on Standard). */
  client_on_file: boolean;
  trip_rate: number | null;
  /** The materials markup as a multiplier: 1.3 = "up to ×1.3". */
  materials_markup: number | null;
  note: string | null;
  position: number;
  rates: PriceRate[];
  fees: PriceFee[];
  updated_at: string;
}

export type PriceRateInput = Omit<PriceRate, 'id'>;
export type PriceFeeInput = Omit<PriceFee, 'id'>;

export interface PriceCardInput {
  billing_entity: string;
  client: string | null;
  trip_rate: number | null;
  materials_markup: number | null;
  note: string | null;
  rates: PriceRateInput[];
  fees: PriceFeeInput[];
}

export interface PricesResponse {
  cards: PriceCard[];
  /** The Comp values, in the field's own order, then any a card names. */
  entities: string[];
  /** The work-order Trade options a rate row may price. */
  trades: string[];
  /** The client records' names, for the card editor's picker. */
  clients: string[];
  can: { create: boolean; edit: boolean; delete: boolean };
}

/** How client and entity names are compared (the 0062 join). */
export const priceKey = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

export const priceCardTitle = (c: { client: string | null }): string => c.client ?? 'Standard';

/** "$250.00", "$350-550", "No fee", or "—". */
export function formatPriceFee(f: { amount: number | null; note: string | null }): string {
  if (f.amount === 0 && f.note) return f.note;
  const money = f.amount === null ? null : f.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  if (money && f.note) return `${money} · ${f.note}`;
  return money ?? f.note ?? '—';
}

/** "Up to ×1.3" — the sheet's wording. */
export const formatMarkup = (m: number | null): string => (m === null ? '—' : `Up to ×${Number(m.toFixed(3))}`);

export interface ResolvedPrice {
  /** The client's card, else the Standard card. */
  card: PriceCard;
  standard: PriceCard | null;
  /** The row pricing the trade: the client card's, else the Standard card's. */
  rate: PriceRate | null;
  trip_rate: number | null;
  materials_markup: number | null;
}

/**
 * The price a work order of (entity, client, trade) is charged at. The
 * client's card for the entity first, else the Standard card; a trade the
 * client card does not list, a trip and a markup it leaves blank, come from
 * the Standard card. A row's own trip beats the card's. null when the entity
 * has no card at all.
 */
export function resolvePrice(
  cards: readonly PriceCard[],
  entity: string | null,
  client: string | null,
  trade: string | null,
): ResolvedPrice | null {
  const e = priceKey(entity);
  if (!e) return null;
  const mine = cards.filter((c) => priceKey(c.billing_entity) === e);
  const standard = mine.find((c) => c.client === null) ?? null;
  const own = priceKey(client) ? mine.find((c) => c.client !== null && priceKey(c.client) === priceKey(client)) ?? null : null;
  const card = own ?? standard;
  if (!card) return null;
  const t = priceKey(trade);
  const rowFor = (c: PriceCard | null) => (c && t ? c.rates.find((r) => r.trades.some((x) => priceKey(x) === t)) ?? null : null);
  const rate = rowFor(own) ?? rowFor(standard);
  return {
    card,
    standard,
    rate,
    trip_rate: rate?.trip_rate ?? own?.trip_rate ?? standard?.trip_rate ?? null,
    materials_markup: own?.materials_markup ?? standard?.materials_markup ?? null,
  };
}

/** What is wrong with a card before it is saved; [] = nothing. */
export function priceCardProblems(input: PriceCardInput): string[] {
  const out: string[] = [];
  if (!input.billing_entity.trim()) out.push('Pick the entity.');
  const seen = new Map<string, string>();
  input.rates.forEach((r, i) => {
    const label = r.label.trim() || `Row ${i + 1}`;
    if (!r.label.trim()) out.push(`Rate row ${i + 1} needs a name.`);
    if (r.trades.length === 0) out.push(`${label}: pick the trade it prices.`);
    for (const t of r.trades) {
      const k = priceKey(t);
      const prior = seen.get(k);
      if (prior !== undefined) out.push(`${t} is priced twice (${prior} and ${label}).`);
      else seen.set(k, label);
    }
  });
  input.fees.forEach((f, i) => {
    if (!f.name.trim()) out.push(`Fee ${i + 1} needs a name.`);
    if (f.amount === null && !(f.note ?? '').trim()) out.push(`${f.name.trim() || `Fee ${i + 1}`}: give a price or a note.`);
  });
  return out;
}
