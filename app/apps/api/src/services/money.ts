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
 * - `profit` prefers the source `Profit` formula field; when it is absent but
 *   both `invoiced` and `cost` are known, profit is derived as invoiced − cost
 *   (this is exactly what the ClickUp formula computes, and it is what makes
 *   the not-yet-closed WOs show a sensible number instead of a blank).
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

  const rawProfit = num(f[K_PROFIT]);
  const profit =
    rawProfit !== null
      ? round2(rawProfit)
      : invoiced !== null && cost !== null
        ? round2(invoiced - cost)
        : null;

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
