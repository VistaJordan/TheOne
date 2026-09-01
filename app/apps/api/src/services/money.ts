// Money derivation (S2 contract item 4).
//
// There is no dedicated financial table in S1's DDL: the numbers live in the
// promoted `task.nte` column plus the `task.fields` JSONB bag, keyed by the
// verbatim ClickUp field names. This module is the ONLY place those key names
// are spelled out, so a future financial table is a one-file swap.
//
// Field keys as they actually appear in packages/db/seed/clickup-data.json:
//   '16. Client NTE 🔴'  currency  (also promoted to task.nte)
//   '34. Cost'           currency
//   'Total Invoiced'     currency  (only on invoiced / not-paid WOs)
//   'Profit'             FORMULA — arrives as a STRING, e.g. "474.44000000000005"
// There is no quote field in the source data at all → `quote` is null until a
// real quote entity exists (S3+).

import type { Money } from '@theone/shared';

const K_NTE = '16. Client NTE \u{1F534}'; // '16. Client NTE 🔴'
const K_COST = '34. Cost';
const K_INVOICED = 'Total Invoiced';
const K_PROFIT = 'Profit';
const K_QUOTE = 'Quote'; // absent today; read anyway so a future field flows through

/**
 * Coerce a JSONB value to a finite number. Handles the formula fields that
 * arrive as strings and currency strings like "$1,610". Anything else → null.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s]/g, '');
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Kill float noise (Profit arrives as "474.44000000000005"). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the `money` block for a work order.
 *
 * - `profit` is a FORMULA: always Total Invoiced − Cost (founder-specified).
 *   The stored `Profit` bag value is never trusted for display — it is kept in
 *   step by applyProfitFormula() on the write paths, but an old export may
 *   hold a drifted snapshot. An absent input counts as $0; both absent → null.
 * - `marginPct` is profit / invoiced × 100, only when both are present and
 *   invoiced is non-zero (a $0 invoice has no meaningful margin).
 */
export function computeMoney(
  fields: Record<string, unknown> | null | undefined,
  promotedNte: number | null,
): Money {
  const f = fields ?? {};

  const nte = promotedNte !== null && promotedNte !== undefined ? Number(promotedNte) : num(f[K_NTE]);
  const quote = num(f[K_QUOTE]);
  const cost = num(f[K_COST]);
  const invoiced = num(f[K_INVOICED]);

  const profit =
    cost === null && invoiced === null ? null : round2((invoiced ?? 0) - (cost ?? 0));

  const marginPct =
    profit !== null && invoiced !== null && invoiced !== 0
      ? Math.round((profit / invoiced) * 1000) / 10
      : null;

  return {
    nte: nte === null || Number.isNaN(nte) ? null : round2(nte),
    quote: quote === null ? null : round2(quote),
    cost: cost === null ? null : round2(cost),
    invoiced: invoiced === null ? null : round2(invoiced),
    profit,
    marginPct,
  };
}

/**
 * The Profit formula applied to a task's field bag IN PLACE: always
 * Total Invoiced − Cost. Every write path that can touch either input calls
 * this (inline editor, bulk edit, CSV import), so the STORED value — what the
 * list column, filters and exports read straight from the bag — never drifts
 * from the formula the detail page computes. Both inputs absent clears the
 * key. The field itself is write-guarded (subtype 'formula'), so this is the
 * only way it moves.
 */
export function applyProfitFormula(bag: Record<string, unknown>): void {
  const cost = num(bag[K_COST]);
  const invoiced = num(bag[K_INVOICED]);
  if (cost === null && invoiced === null) delete bag[K_PROFIT];
  else bag[K_PROFIT] = round2((invoiced ?? 0) - (cost ?? 0));
}
