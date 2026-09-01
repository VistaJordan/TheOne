// KPI service (§5 GET /api/kpis) — all computed live from the DB.
//  - active.count        : status_group IN ('open','active')
//  - waitingApproval     : status name 'Waiting for Approval' (+ oldest age)
//  - readyToInvoice      : status name 'Ready to Invoice'     (+ sum(nte))
//  - margin              : from invoiced WOs' fields; else fallback placeholder.

import { query } from '../db.js';
import type { Kpis } from '@theone/shared';

// §5/§10: fallback margin from aggregates.invoicedSample (27092/60653 = 44.7%, avgProfit 271).
const MARGIN_FALLBACK = { pct: 44.7, avgProfit: 271 };

export async function getKpis(): Promise<Kpis> {
  const activeRes = await query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
       FROM task
      WHERE deleted_at IS NULL AND status_group IN ('open','active')`,
  );

  const waitRes = await query<{ count: number | string; oldest: number | string | null }>(
    `SELECT COUNT(*)::int AS count,
            MAX(now()::date - t.date_received) AS oldest
       FROM task t JOIN status s ON s.id = t.status_id
      WHERE t.deleted_at IS NULL AND s.name = 'Waiting for Approval'`,
  );

  const readyRes = await query<{ count: number | string; queued: number | string | null }>(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(t.nte), 0)::float8 AS queued
       FROM task t JOIN status s ON s.id = t.status_id
      WHERE t.deleted_at IS NULL AND s.name = 'Ready to Invoice'`,
  );

  // Margin from invoiced WOs: sum(total_invoiced - cost) / sum(total_invoiced).
  const marginRes = await query<{
    n: number | string;
    total_invoiced: number | string | null;
    total_cost: number | string | null;
  }>(
    `SELECT COUNT(*)::int AS n,
            SUM((t.fields->>'Total Invoiced')::numeric)::float8 AS total_invoiced,
            SUM(CASE WHEN (t.fields->>'34. Cost') ~ '^[0-9.]+$'
                     THEN (t.fields->>'34. Cost')::numeric ELSE 0 END)::float8 AS total_cost
       FROM task t
      WHERE t.deleted_at IS NULL
        AND (t.fields->>'Total Invoiced') ~ '^[0-9.]+$'
        AND (t.fields->>'Total Invoiced')::numeric > 0`,
  );

  const mr = marginRes.rows[0];
  const n = Number(mr.n);
  const totalInvoiced = mr.total_invoiced === null ? 0 : Number(mr.total_invoiced);
  const totalCost = mr.total_cost === null ? 0 : Number(mr.total_cost);

  let margin: Kpis['margin'];
  if (n > 0 && totalInvoiced > 0) {
    const profit = totalInvoiced - totalCost;
    margin = {
      pct: Math.round((profit / totalInvoiced) * 1000) / 10,
      avgProfit: Math.round(profit / n),
      placeholder: false,
    };
  } else {
    margin = { pct: MARGIN_FALLBACK.pct, avgProfit: MARGIN_FALLBACK.avgProfit, placeholder: true };
  }

  const oldest = waitRes.rows[0].oldest;
  const queued = readyRes.rows[0].queued;

  return {
    active: { count: Number(activeRes.rows[0].count) },
    waitingApproval: {
      count: Number(waitRes.rows[0].count),
      oldestAgeDays: oldest === null ? null : Number(oldest),
    },
    readyToInvoice: {
      count: Number(readyRes.rows[0].count),
      queuedAmount: queued === null ? 0 : Number(queued),
    },
    margin,
  };
}
