/* One card on a dashboard (0042).
 *
 * A card is a question with a drill-through: the number it shows and the list
 * its click opens are built from the SAME filter, so the two can never
 * disagree — the oldest trap in dashboards is a card that says 41 and a list
 * that shows 38.
 *
 * Four drawings, one meaning:
 *   number   the headline figure alone
 *   bar      one row per bucket, biggest first
 *   donut    the same buckets as a share of the whole, with a legend
 *   table    the same buckets as rows — the accessible reading of any chart,
 *            and the better choice when the labels matter more than the shape
 *
 * Recharts is loaded lazily, so a page without a chart on it never downloads
 * the library.
 */

import { Suspense, lazy, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { WidgetConfig, WidgetResult, DashboardWidget, WoFilterSet } from '@theone/shared';
import { formatBucket, widgetSubtitle } from '@theone/shared';
import { Icon } from '../Icon';
import { filterUrl } from '../../lib/woView';
import { CHART_OTHER, EVERYTHING_ELSE, colorFor, type ChartDatum } from './chartPalette';

const Charts = {
  Bars: lazy(() => import('./WidgetCharts').then((m) => ({ default: m.WidgetBars }))),
  Donut: lazy(() => import('./WidgetCharts').then((m) => ({ default: m.WidgetDonut }))),
  Line: lazy(() => import('./WidgetCharts').then((m) => ({ default: m.WidgetLine }))),
};

interface WidgetCardProps {
  widget: DashboardWidget;
  result?: WidgetResult;
  loading: boolean;
  /** Shown only to someone who may edit this dashboard. */
  onEdit?: () => void;
  onRemove?: () => void;
}

/** Money reads as money, counts read as counts, and an average keeps one
    decimal so "1.0 visits" is not rounded into "1". */
function formatter(config: WidgetConfig): (n: number) => string {
  const isMoney = config.metric !== 'count' && /nte|cost|invoiced|profit|amount|price/i.test(config.value_field ?? '');
  return (n: number) => {
    if (!Number.isFinite(n)) return '—';
    if (isMoney) {
      return n >= 1000
        ? `$${Math.round(n).toLocaleString()}`
        : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    }
    if (config.metric === 'avg') return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return Math.round(n).toLocaleString();
  };
}

/** The list this card's rows live in: the card's own filters, plus the bucket
    the person clicked. */
function drillUrl(config: WidgetConfig, bucket?: { raw: string | null }): string {
  const base: WoFilterSet = config.filters ?? { match: 'all', rules: [] };
  if (!bucket || !config.group_field) return filterUrl(base);
  const rules = [...base.rules];
  rules.push(
    bucket.raw === null
      ? { field: config.group_field, op: 'is_not_set' }
      : { field: config.group_field, op: 'eq', value: bucket.raw },
  );
  return filterUrl({ match: base.match, rules });
}

export function WidgetCard({ widget, result, loading, onEdit, onRemove }: WidgetCardProps) {
  const navigate = useNavigate();
  const fmt = useMemo(() => formatter(widget.config), [widget.config]);

  const overTime = widget.kind === 'line';

  const data: ChartDatum[] = useMemo(() => {
    const buckets = result?.buckets ?? [];
    const rows: ChartDatum[] = buckets.map((b, i) => ({
      // A line's buckets are points in time, not categories: they keep the
      // order the API sent and share one hue.
      name: overTime ? formatBucket(b.value ?? '', widget.config.bucket) : (b.value ?? 'Not set'),
      value: b.n,
      raw: b.value,
      color: overTime ? 'var(--chart-1)' : colorFor(i, b.value),
    }));
    if (!overTime && (result?.other ?? 0) > 0) {
      rows.push({
        name: EVERYTHING_ELSE,
        value: result?.other ?? 0,
        raw: null,
        color: CHART_OTHER,
      });
    }
    return rows;
  }, [result, overTime, widget.config.bucket]);

  const pick = (d: ChartDatum) => {
    // "Everything else" has no single value to filter on, so it opens the
    // card's own list rather than pretending to be a bucket.
    navigate(d.name === EVERYTHING_ELSE ? drillUrl(widget.config) : drillUrl(widget.config, d));
  };

  return (
    <section className={`card dash-widget is-${widget.width}`}>
      <div className="card-head">
        <h3 className="card-title">{widget.label}</h3>
        <span className="card-meta">
          {(onEdit || onRemove) && (
            <span className="dash-widget-tools">
              {onEdit && (
                <button type="button" className="linkbtn" onClick={onEdit}>
                  Edit
                </button>
              )}
              {onRemove && (
                <button type="button" className="linkbtn" onClick={onRemove}>
                  Remove
                </button>
              )}
            </span>
          )}
        </span>
      </div>

      {result?.error ? (
        <p className="dash-widget-error">
          <Icon name="alert" size={14} /> {result.error}
        </p>
      ) : loading ? (
        <p className="hint">Working it out…</p>
      ) : widget.kind === 'number' ? (
        <Link className="dash-figure" to={drillUrl(widget.config)}>
          <span className="dash-figure-n">{fmt(result?.total ?? 0)}</span>
          <span className="dash-figure-sub">{widgetSubtitle(widget.config)}</span>
        </Link>
      ) : data.length === 0 ? (
        <p className="hint">Nothing matches this card yet.</p>
      ) : widget.kind === 'table' ? (
        <table className="ct dash-table">
          <tbody>
            {data.map((d, i) => (
              <tr key={d.name}>
                <td className="dash-table-rank">{i + 1}</td>
                <td>
                  <Link to={d.name === EVERYTHING_ELSE ? drillUrl(widget.config) : drillUrl(widget.config, d)}>
                    {d.name}
                  </Link>
                </td>
                <td className="num">{fmt(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Suspense fallback={<p className="hint">Drawing…</p>}>
          {widget.kind === 'bar' ? (
            <Charts.Bars data={data} fmt={fmt} onPick={pick} />
          ) : widget.kind === 'line' ? (
            <Charts.Line data={data} fmt={fmt} onPick={() => navigate(drillUrl(widget.config))} />
          ) : (
            <Charts.Donut data={data} fmt={fmt} onPick={pick} />
          )}
        </Suspense>
      )}

      {/* The total under a chart is the figure the card would show as a
          number, so the two readings of the same question always agree. */}
      {widget.kind !== 'number' && !result?.error && data.length > 0 && (
        <Link className="dash-widget-total" to={drillUrl(widget.config)}>
          {widgetSubtitle(widget.config)}: <strong>{fmt(result?.total ?? 0)}</strong>
        </Link>
      )}
    </section>
  );
}
