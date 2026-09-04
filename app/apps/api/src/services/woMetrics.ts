// Metrics over the audit trail and the live work-order set.
//
// Every field change already lands in activity_log with a timestamp (woAudit.ts
// is the single choke point), so "when did check-in happen" is a query, not a
// new column. This module answers three questions:
//
//   metricBreakdown : the filtered work-order set bucketed by ANY catalogue
//                     field — the engine behind a dashboard breakdown card.
//   metricDuration  : elapsed time between two field-change events, per work
//                     order, aggregated — "Checked-in → Checked-out" and any
//                     other pair the dashboard asks for.
//   getFieldTimes   : one work order's per-field change timestamps, for pages
//                     that need "when did X last change" without the full trail.
//
// Duration semantics (deliberate, documented on the card): per work order we
// take the FIRST time the `from` event was recorded and the NEXT `to` event
// after it. Later cycles (checked in again, out again) are not summed — v1
// measures the first completed span. Only changes made through the app count:
// imported/seeded values carry no change history.

import { query } from '../db.js';
import type {
  MetricBreakdown,
  MetricDuration,
  MetricDurationSample,
  MetricEvent,
  WoFieldTime,
} from '@theone/shared';
import {
  Params,
  compileFilters,
  compileGroupExpr,
  resolveField,
  type FilterSet,
  type ResolvedField,
} from './woFields.js';

// The same FROM the list query uses, so compiled filters (which reference the
// t / s / hl aliases) drop in unchanged.
const WO_FROM = `
  FROM task t
  JOIN status s ON s.id = t.status_id
  LEFT JOIN container hl ON hl.id = t.home_list_id`;

const ISO = (col: string) =>
  `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

// ── Breakdown ────────────────────────────────────────────────────────────────

export async function metricBreakdown(
  fieldKey: string,
  filters: FilterSet | undefined,
  limit: number,
): Promise<MetricBreakdown> {
  const f = await resolveField(fieldKey); // validates the key (throws on unknown)
  const p = new Params();
  const expr = await compileGroupExpr(fieldKey, p);
  const where = ['t.deleted_at IS NULL'];
  if (filters) {
    const w = await compileFilters(filters, p);
    if (w) where.push(w);
  }

  const res = await query<{ v: string | null; count: number | string }>(
    `SELECT ${expr} AS v, COUNT(*)::int AS count
       ${WO_FROM}
      WHERE ${where.join(' AND ')}
      GROUP BY 1`,
    p.values,
  );

  // '' and NULL are the same bucket to a reader ("not set"), so merge in JS —
  // simpler than teaching the group expression about blank semantics.
  const byValue = new Map<string | null, number>();
  for (const r of res.rows) {
    const v = r.v === '' ? null : r.v;
    byValue.set(v, (byValue.get(v) ?? 0) + Number(r.count));
  }
  const buckets = [...byValue.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || String(a.value ?? '').localeCompare(String(b.value ?? '')));

  const total = buckets.reduce((n, b) => n + b.count, 0);
  const items = buckets.slice(0, limit);
  const other = total - items.reduce((n, b) => n + b.count, 0);
  return { field: f.key, label: f.label, total, other, items };
}

// ── Duration between two events ──────────────────────────────────────────────

/**
 * The activity_log predicate for "this field changed (to this value)", built
 * from the row shapes woAudit.ts documents:
 *   status  → action 'status_changed', new name in after->>'status_name'
 *   routing → action 'routed',         new name in after->>'list_name'
 *   others  → action 'field_updated',  field = catalogue key, after->>'value'
 * Values compare trimmed and case-insensitively: dropdown vocabularies drift
 * in case across imports, and "checked-in" should mean "Checked-in".
 */
function eventMatch(alias: string, f: ResolvedField, value: string | null | undefined, p: Params): string {
  const parts = [`${alias}.entity_type = 'task'`];
  const want = value == null || value === '' ? null : value;
  if (f.key === 'status' || f.key === 'status_id') {
    parts.push(`${alias}.action = 'status_changed'`);
    if (want) parts.push(`lower(btrim(${alias}.after->>'status_name')) = lower(btrim(${p.add(want)}))`);
  } else if (f.key === 'home_list' || f.key === 'home_list_id') {
    parts.push(`${alias}.action = 'routed'`);
    if (want) parts.push(`lower(btrim(${alias}.after->>'list_name')) = lower(btrim(${p.add(want)}))`);
  } else {
    parts.push(`${alias}.action = 'field_updated'`);
    parts.push(`${alias}.field = ${p.add(f.key)}`);
    if (want) parts.push(`lower(btrim(coalesce(${alias}.after->>'value',''))) = lower(btrim(${p.add(want)}))`);
  }
  return parts.join(' AND ');
}

const SAMPLE_CAP = 25;

export async function metricDuration(
  from: MetricEvent,
  to: MetricEvent,
  filters: FilterSet | undefined,
): Promise<MetricDuration> {
  const fromField = await resolveField(from.field);
  const toField = await resolveField(to.field);
  const p = new Params();
  const fromSql = eventMatch('a', fromField, from.value, p);
  const toSql = eventMatch('b', toField, to.value, p);
  const where = ['t.deleted_at IS NULL'];
  if (filters) {
    const w = await compileFilters(filters, p);
    if (w) where.push(w);
  }

  // `b.id > f.from_id` rather than a timestamp comparison: activity_log.id is a
  // monotonic identity, so two events written in the same millisecond still
  // order correctly, and the from-event can never pair with itself.
  const res = await query<{
    id: string;
    wo_number: string;
    title: string | null;
    from_at: string;
    to_at: string;
    seconds: number | string;
  }>(
    `WITH f AS (
       SELECT DISTINCT ON (a.entity_id) a.entity_id, a.id AS from_id, a.created_at AS from_at
         FROM activity_log a
        WHERE ${fromSql}
        ORDER BY a.entity_id, a.id ASC
     ),
     pair AS (
       SELECT f.entity_id, f.from_at, MIN(b.created_at) AS to_at
         FROM f
         JOIN activity_log b ON b.entity_id = f.entity_id AND b.id > f.from_id AND ${toSql}
        GROUP BY f.entity_id, f.from_at
     )
     SELECT t.id, t.wo_number, t.title,
            ${ISO('pair.from_at')} AS from_at,
            ${ISO('pair.to_at')} AS to_at,
            EXTRACT(EPOCH FROM (pair.to_at - pair.from_at))::float8 AS seconds
       FROM pair
       JOIN task t ON t.id = pair.entity_id
       JOIN status s ON s.id = t.status_id
       LEFT JOIN container hl ON hl.id = t.home_list_id
      WHERE ${where.join(' AND ')}
      ORDER BY pair.to_at DESC`,
    p.values,
  );

  const samples: MetricDurationSample[] = res.rows.map((r) => ({
    id: r.id,
    wo_number: r.wo_number,
    title: r.title,
    from_at: r.from_at,
    to_at: r.to_at,
    seconds: Number(r.seconds),
  }));

  const secs = samples.map((s) => s.seconds).sort((a, b) => a - b);
  const n = secs.length;
  const median =
    n === 0 ? null : n % 2 === 1 ? secs[(n - 1) / 2] : (secs[n / 2 - 1] + secs[n / 2]) / 2;

  return {
    from: { field: fromField.key, value: from.value ?? null },
    to: { field: toField.key, value: to.value ?? null },
    count: n,
    avg_seconds: n === 0 ? null : secs.reduce((a, b) => a + b, 0) / n,
    median_seconds: median,
    min_seconds: n === 0 ? null : secs[0],
    max_seconds: n === 0 ? null : secs[n - 1],
    samples: samples.slice(0, SAMPLE_CAP),
  };
}

// ── Per-work-order field times ───────────────────────────────────────────────

/** The audit rows' field names, normalised to catalogue keys so consumers can
    join against the field catalogue without knowing the log's column names. */
function catalogueKeyOf(logField: string): string {
  if (logField === 'status_id') return 'status';
  if (logField === 'home_list_id') return 'home_list';
  return logField;
}

function lastValueOf(action: string, after: Record<string, unknown> | null): string | null {
  if (!after) return null;
  const v =
    action === 'status_changed' ? after.status_name
    : action === 'routed' ? after.list_name
    : after.value;
  return v === null || v === undefined ? null : String(v);
}

export async function getFieldTimes(taskId: string): Promise<WoFieldTime[]> {
  // Two cheap queries beat one window function PGlite has to sort twice:
  // the latest event per field (DISTINCT ON), and count+first per field.
  const [latest, spans] = await Promise.all([
    query<{ field: string; action: string; after: Record<string, unknown> | null; last_at: string }>(
      `SELECT DISTINCT ON (a.field) a.field, a.action, a.after, ${ISO('a.created_at')} AS last_at
         FROM activity_log a
        WHERE a.entity_type = 'task' AND a.entity_id = $1 AND a.field IS NOT NULL
        ORDER BY a.field, a.id DESC`,
      [taskId],
    ),
    query<{ field: string; changes: number | string; first_at: string }>(
      `SELECT a.field, COUNT(*)::int AS changes, ${ISO('MIN(a.created_at)')} AS first_at
         FROM activity_log a
        WHERE a.entity_type = 'task' AND a.entity_id = $1 AND a.field IS NOT NULL
        GROUP BY a.field`,
      [taskId],
    ),
  ]);

  const spanByField = new Map(spans.rows.map((r) => [r.field, r]));
  return latest.rows
    .map((r) => {
      const span = spanByField.get(r.field);
      return {
        field: catalogueKeyOf(r.field),
        changes: span ? Number(span.changes) : 1,
        first_at: span?.first_at ?? r.last_at,
        last_at: r.last_at,
        last_value: lastValueOf(r.action, r.after),
      };
    })
    .sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));
}
