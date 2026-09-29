/* Client Updates (0055) — the headline tiles and the clickable charts.
 *
 * Drawn twice: on our page (tiles and charts drill the list) and on the
 * client's read-only link (they filter the rows in the browser). Both hand
 * over the same shapes, so this file knows nothing about where the numbers
 * came from — only how to draw them and which click means what.
 *
 * A chart click narrows by that bar's value; clicking the same bar again, or
 * its chip above the list, lets go. "Everything else" is not a value, so it
 * is not clickable. Recharts stays lazy (WidgetCharts), as on the dashboard.
 */

import { lazy, Suspense } from 'react';
import type { ClientUpdateChartResult, ClientUpdateSummary, SummaryTileDef } from '@theone/shared';
import { Icon } from '../Icon';
import { CHART_OTHER, EVERYTHING_ELSE, colorFor, type ChartDatum } from '../dash/chartPalette';

const Charts = {
  Bars: lazy(() => import('../dash/WidgetCharts').then((m) => ({ default: m.WidgetBars }))),
  Donut: lazy(() => import('../dash/WidgetCharts').then((m) => ({ default: m.WidgetDonut }))),
};

const MONEY0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const COUNT = (n: number) => n.toLocaleString('en-US');

export const NOT_SET = 'Not set';

export function CuTiles({
  summary,
  tiles,
  active,
  onPick,
  loading,
}: {
  summary: ClientUpdateSummary | null | undefined;
  tiles: SummaryTileDef[];
  /** The tile currently narrowing the list, if any. */
  active?: string | null;
  /** Absent = the tiles are read-only (the client's link). */
  onPick?: (key: SummaryTileDef['key'] | null) => void;
  loading?: boolean;
}) {
  const cells: { key: string; label: string; hint: string; value: string; clickable: boolean }[] = [
    {
      key: 'total',
      label: 'Work orders',
      hint: 'Everything in this tracker',
      value: summary ? COUNT(summary.total) : '—',
      clickable: Boolean(onPick && active),
    },
    ...tiles.map((t) => ({
      key: t.key,
      label: t.label,
      hint: t.hint,
      value: summary ? (t.money ? MONEY0.format(summary.tiles[t.key]) : COUNT(summary.tiles[t.key])) : '—',
      clickable: Boolean(onPick),
    })),
  ];
  return (
    <div className={`cu-tiles${loading ? ' is-loading' : ''}`}>
      {cells.map((c) => {
        const on = active === c.key || (c.key === 'total' && !active);
        const body = (
          <>
            <span className="cu-tile-label">{c.label}</span>
            <span className="cu-tile-value">{c.value}</span>
            <span className="cu-tile-hint">{c.hint}</span>
          </>
        );
        return c.clickable || (onPick && c.key !== 'total') ? (
          <button
            key={c.key}
            type="button"
            className={`cu-tile${on && onPick ? ' is-on' : ''}`}
            aria-pressed={on}
            onClick={() => onPick?.(c.key === 'total' || active === c.key ? null : (c.key as SummaryTileDef['key']))}
          >
            {body}
          </button>
        ) : (
          <div key={c.key} className={`cu-tile${on && onPick ? ' is-on' : ''}`}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

export function CuChartGrid({
  charts,
  picked,
  onPick,
  teamOnly,
  loading,
}: {
  charts: ClientUpdateChartResult[];
  /** field → the value narrowing the list (null = "not set"); absent = none. */
  picked: Record<string, string | null | undefined>;
  onPick: (field: string, value: string | null) => void;
  /** Fields whose chart the client does not see (our page marks them). */
  teamOnly?: Set<string>;
  loading?: boolean;
}) {
  if (charts.length === 0) return null;
  return (
    <div className={`cu-charts${loading ? ' is-loading' : ''}`}>
      {charts.map((c) => (
        <CuChartCard
          key={c.field}
          chart={c}
          picked={picked[c.field]}
          hasPick={c.field in picked}
          onPick={(v) => onPick(c.field, v)}
          teamOnly={teamOnly?.has(c.field) ?? false}
        />
      ))}
    </div>
  );
}

function CuChartCard({
  chart,
  picked,
  hasPick,
  onPick,
  teamOnly,
}: {
  chart: ClientUpdateChartResult;
  picked: string | null | undefined;
  hasPick: boolean;
  onPick: (value: string | null) => void;
  teamOnly: boolean;
}) {
  let named = 0;
  const data: ChartDatum[] = chart.buckets.map((b) => {
    const color = b.value === null ? CHART_OTHER : colorFor(named++, b.value);
    return { name: b.value ?? NOT_SET, value: b.n, raw: b.value, color };
  });
  if (chart.other > 0) data.push({ name: EVERYTHING_ELSE, value: chart.other, raw: null, color: CHART_OTHER });
  // Dim everything but the picked bar, so the chart still shows the whole.
  const shown = hasPick
    ? data.map((d) =>
        d.name !== EVERYTHING_ELSE && d.raw === (picked ?? null) ? d : { ...d, color: 'var(--chart-other)' },
      )
    : data;
  const pick = (d: ChartDatum) => {
    if (d.name === EVERYTHING_ELSE) return;
    onPick(d.raw);
  };
  return (
    <section className="card cu-chart" aria-label={`${chart.label} chart`}>
      <header className="cu-chart-head">
        <h3 className="cu-chart-title">
          {chart.label}
          <span className="cu-chart-total">{COUNT(chart.total)}</span>
        </h3>
        {teamOnly && (
          <span className="cu-team-only" title="The client does not see this chart">
            <Icon name="lock" size={12} /> Team only
          </span>
        )}
      </header>
      {data.length === 0 ? (
        <p className="cu-chart-empty">Nothing to count.</p>
      ) : (
        <Suspense fallback={<div className="cu-chart-wait" aria-hidden="true" />}>
          {chart.kind === 'donut' ? (
            <Charts.Donut data={shown} fmt={COUNT} onPick={pick} />
          ) : (
            <Charts.Bars data={shown} fmt={COUNT} onPick={pick} />
          )}
        </Suspense>
      )}
    </section>
  );
}
