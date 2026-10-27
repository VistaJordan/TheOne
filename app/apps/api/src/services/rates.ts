// Labor rates — Yoda LaborRate per (billing entity, FM, trade) with
// IsSalesTaxRequired. Exact combo first, then the FM-wide row, then the
// billing-entity-wide row, so a company default can stand in until a trade
// rate is entered.

import { query } from '../db.js';
import type { LaborRate } from '@theone/shared';
import { ApiError } from '../errors.js';
import { logAdminEvent, snapshotsDiffer, type Snapshot } from './adminAudit.js';
import { priceFor } from './prices.js';

interface RateRow {
  id: string;
  billing_entity: string | null;
  fm: string | null;
  trade: string | null;
  tech_rate: number | null;
  helper_rate: number | null;
  trip_rate: number | null;
  afterhours_rate: number | null;
  holiday_rate: number | null;
  is_sales_tax_required: boolean;
}

const RATE_SQL = `
  SELECT id::text AS id, billing_entity, fm, trade,
         tech_rate::float8 AS tech_rate, helper_rate::float8 AS helper_rate,
         trip_rate::float8 AS trip_rate, afterhours_rate::float8 AS afterhours_rate,
         holiday_rate::float8 AS holiday_rate, is_sales_tax_required
    FROM labor_rate`;

function mapRate(r: RateRow): LaborRate {
  return {
    id: r.id,
    billing_entity: r.billing_entity,
    fm: r.fm,
    trade: r.trade,
    tech_rate: r.tech_rate === null ? null : Number(r.tech_rate),
    helper_rate: r.helper_rate === null ? null : Number(r.helper_rate),
    trip_rate: r.trip_rate === null ? null : Number(r.trip_rate),
    afterhours_rate: r.afterhours_rate === null ? null : Number(r.afterhours_rate),
    holiday_rate: r.holiday_rate === null ? null : Number(r.holiday_rate),
    is_sales_tax_required: r.is_sales_tax_required === true,
  };
}

/**
 * The rate card the quote builder shows and prices its Trip line from. Since
 * 0101 the price list (Prices in the sidebar) is read first — the client's
 * card for the entity, else the Standard card, trade by trade — and a figure
 * it gives wins; the Yoda `labor_rate` row fills what it leaves blank and is
 * still the only source of "sales tax required".
 */
export async function findLaborRate(
  billingEntity: string | null,
  fm: string | null,
  trade: string | null,
): Promise<LaborRate | null> {
  const [legacy, price] = await Promise.all([findYodaRate(billingEntity, fm, trade), priceFor(billingEntity, fm, trade)]);
  if (!price || (!price.rate && price.trip_rate === null)) return legacy;
  const r = price.rate;
  const pick = (mine: number | null | undefined, theirs: number | null | undefined) => mine ?? theirs ?? null;
  return {
    id: legacy?.id ?? price.card.id,
    billing_entity: price.card.billing_entity,
    fm: price.card.client ?? legacy?.fm ?? null,
    trade: trade ?? legacy?.trade ?? null,
    tech_rate: pick(r?.tech_rate, legacy?.tech_rate),
    helper_rate: pick(r?.helper_rate, legacy?.helper_rate),
    trip_rate: pick(price.trip_rate, legacy?.trip_rate),
    afterhours_rate: pick(r?.afterhours_rate, legacy?.afterhours_rate),
    holiday_rate: pick(r?.holiday_rate, legacy?.holiday_rate),
    is_sales_tax_required: legacy?.is_sales_tax_required ?? false,
  };
}

async function findYodaRate(
  billingEntity: string | null,
  fm: string | null,
  trade: string | null,
): Promise<LaborRate | null> {
  const res = await query<RateRow>(
    `${RATE_SQL}
      WHERE COALESCE(billing_entity,'') = COALESCE($1,'')
        AND (COALESCE(fm,'') = COALESCE($2,'') OR fm IS NULL)
        AND (COALESCE(trade,'') = COALESCE($3,'') OR trade IS NULL)
      ORDER BY (fm IS NOT NULL) DESC, (trade IS NOT NULL) DESC
      LIMIT 1`,
    [billingEntity, fm, trade],
  );
  return res.rows.length === 0 ? null : mapRate(res.rows[0]);
}

export async function listLaborRates(): Promise<LaborRate[]> {
  const res = await query<RateRow>(`${RATE_SQL} ORDER BY billing_entity NULLS LAST, fm NULLS LAST, trade NULLS LAST`);
  return res.rows.map(mapRate);
}

export interface LaborRateInput {
  billing_entity?: string | null;
  fm?: string | null;
  trade?: string | null;
  tech_rate?: number | null;
  helper_rate?: number | null;
  trip_rate?: number | null;
  afterhours_rate?: number | null;
  holiday_rate?: number | null;
  is_sales_tax_required?: boolean;
}

/** What the audit log calls a rate: its key, a blank part read as "All". */
function rateName(r: { billing_entity: string | null; fm: string | null; trade: string | null }): string {
  const part = (v: string | null) => (v && v.trim() ? v.trim() : 'All');
  return `${part(r.billing_entity)} · ${part(r.fm)} · ${part(r.trade)}`;
}

function rateSnapshot(r: LaborRate): Snapshot {
  const { id: _id, ...rest } = r;
  return { name: rateName(r), ...rest };
}

/**
 * Upsert on the (billing entity, FM, trade) combo — Yoda's unique index.
 * Rule 1.2.1: the row on that key is read first, so the audit row says
 * whether the save created the rate or changed it, with whole before / after
 * snapshots; a save that changed nothing logs nothing. Logged after the write,
 * on the pool, like every admin row (adminAudit.ts).
 */
export async function upsertLaborRate(input: LaborRateInput, actorId: string): Promise<LaborRate> {
  const prior = await query<RateRow>(
    `${RATE_SQL}
      WHERE COALESCE(billing_entity,'') = COALESCE($1,'')
        AND COALESCE(fm,'') = COALESCE($2,'')
        AND COALESCE(trade,'') = COALESCE($3,'')`,
    [input.billing_entity ?? null, input.fm ?? null, input.trade ?? null],
  );
  const before = prior.rows[0] ? rateSnapshot(mapRate(prior.rows[0])) : null;
  const res = await query<{ id: string }>(
    `INSERT INTO labor_rate
       (billing_entity, fm, trade, tech_rate, helper_rate, trip_rate, afterhours_rate, holiday_rate, is_sales_tax_required)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (COALESCE(billing_entity,''), COALESCE(fm,''), COALESCE(trade,''))
     DO UPDATE SET tech_rate = EXCLUDED.tech_rate, helper_rate = EXCLUDED.helper_rate,
                   trip_rate = EXCLUDED.trip_rate, afterhours_rate = EXCLUDED.afterhours_rate,
                   holiday_rate = EXCLUDED.holiday_rate, is_sales_tax_required = EXCLUDED.is_sales_tax_required
     RETURNING id::text AS id`,
    [
      input.billing_entity ?? null,
      input.fm ?? null,
      input.trade ?? null,
      input.tech_rate ?? null,
      input.helper_rate ?? null,
      input.trip_rate ?? null,
      input.afterhours_rate ?? null,
      input.holiday_rate ?? null,
      input.is_sales_tax_required ?? false,
    ],
  );
  const row = await query<RateRow>(`${RATE_SQL} WHERE id = $1`, [res.rows[0].id]);
  if (row.rows.length === 0) throw new ApiError('INTERNAL', 'Labor rate vanished after upsert');
  const saved = mapRate(row.rows[0]);
  const after = rateSnapshot(saved);
  if (!before || snapshotsDiffer(before, after)) {
    await logAdminEvent({
      actorId,
      entity: 'labor_rate',
      entityId: saved.id,
      action: before ? 'labor_rate_updated' : 'labor_rate_created',
      before,
      after,
    });
  }
  return saved;
}
