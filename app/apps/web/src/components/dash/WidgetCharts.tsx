/* The drawing half of a dashboard card (0042) — bars and a donut.
 *
 * Loaded lazily (see WidgetCard) so only the Dashboard route pays for
 * Recharts; the rest of the app never downloads it.
 *
 * Rules this file follows, because a chart is read by people:
 *   · Hues come from the theme's eight chart tokens, IN ORDER and never
 *     cycled. A ninth bucket is not a ninth hue — the API already folded the
 *     tail into "other", which wears the neutral.
 *   · Text wears ink tokens, never the series colour. The coloured mark
 *     beside a label is what carries identity.
 *   · Bars run horizontally: a trade, a client or a person's name is long,
 *     and a horizontal bar gives it a whole row to sit on instead of a
 *     rotated stub under a column.
 *   · Every mark has a hover tooltip, and the donut also has a legend with
 *     values — identity is never colour alone.
 *   · The grid is recessive, and marks are separated by a 2px surface gap so
 *     two touching colours never read as one.
 */

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { colorFor, type ChartDatum } from './chartPalette';

/** What Recharts hands a custom tooltip — narrowed to the part we read. */
interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload: ChartDatum }>;
}

/** One hovered mark, in the app's own card styling rather than Recharts'. */
function CardTooltip({ active, payload, fmt }: TooltipProps & { fmt: (n: number) => string }) {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  return (
    <div className="chart-tip">
      <span className="chart-tip-dot" style={{ background: d.color }} aria-hidden="true" />
      <span className="chart-tip-name">{d.name}</span>
      <span className="chart-tip-val">{fmt(d.value)}</span>
    </div>
  );
}

export function WidgetBars({
  data,
  fmt,
  onPick,
}: {
  data: ChartDatum[];
  fmt: (n: number) => string;
  onPick?: (d: ChartDatum) => void;
}) {
  // Enough height for every bar to keep a readable row, and a floor so a
  // one-bar card does not collapse.
  const height = Math.max(120, data.length * 34 + 16);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 44, bottom: 4, left: 4 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          width={124}
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'var(--ink-2)', fontSize: 11 }}
        />
        <Tooltip
          cursor={{ fill: 'var(--chart-grid)' }}
          content={(props) => <CardTooltip {...(props as unknown as TooltipProps)} fmt={fmt} />}
        />
        <Bar
          dataKey="value"
          radius={[0, 4, 4, 0]}
          isAnimationActive={false}
          onClick={(d: unknown) => onPick?.((d as { payload: ChartDatum }).payload ?? (d as ChartDatum))}
          label={{
            position: 'right',
            fill: 'var(--ink-2)',
            fontSize: 11,
            formatter: (v: unknown) => fmt(Number(v ?? 0)),
          }}
        >
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} cursor={onPick ? 'pointer' : 'default'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function WidgetDonut({
  data,
  fmt,
  onPick,
}: {
  data: ChartDatum[];
  fmt: (n: number) => string;
  onPick?: (d: ChartDatum) => void;
}) {
  const total = data.reduce((n, d) => n + d.value, 0);
  return (
    <div className="donut-wrap">
      <ResponsiveContainer width="100%" height={180}>
        <PieChart>
          <Tooltip content={(props) => <CardTooltip {...(props as unknown as TooltipProps)} fmt={fmt} />} />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={48}
            outerRadius={76}
            paddingAngle={2}
            stroke="var(--chart-gap)"
            strokeWidth={2}
            isAnimationActive={false}
            onClick={(d: unknown) => onPick?.((d as { payload: ChartDatum }).payload ?? (d as ChartDatum))}
          >
            {data.map((d) => (
              <Cell key={d.name} fill={d.color} cursor={onPick ? 'pointer' : 'default'} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>

      {/* The legend carries the value too, so the donut never has to be read
          by slice size alone. */}
      <ul className="chart-legend">
        {data.map((d) => (
          <li key={d.name}>
            <span className="chart-tip-dot" style={{ background: d.color }} aria-hidden="true" />
            <span className="chart-legend-name">{d.name}</span>
            <span className="chart-legend-val">{fmt(d.value)}</span>
            <span className="chart-legend-pct">
              {total > 0 ? `${Math.round((d.value / total) * 100)}%` : '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A line over time (0044).
 *
 * The only card that reads left-to-right rather than biggest-first, because
 * that is what a trend is. One series, so no legend — the card's title names
 * it — and a dot on every point so a single month still shows something. The
 * area under the line is a faint wash of the same hue: it makes the shape
 * readable at a glance without adding a second colour to decode.
 */
export function WidgetLine({
  data,
  fmt,
  onPick,
}: {
  data: ChartDatum[];
  fmt: (n: number) => string;
  onPick?: (d: ChartDatum) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <defs>
          <linearGradient id="widget-line-wash" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={{ stroke: 'var(--chart-grid)' }}
          tick={{ fill: 'var(--ink-3)', fontSize: 10.5 }}
          minTickGap={16}
        />
        <YAxis
          width={44}
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'var(--ink-3)', fontSize: 10.5 }}
          tickFormatter={(v: unknown) => fmt(Number(v ?? 0))}
        />
        <Tooltip content={(props) => <CardTooltip {...(props as unknown as TooltipProps)} fmt={fmt} />} />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#widget-line-wash)"
          isAnimationActive={false}
          activeDot={{ r: 5, cursor: onPick ? 'pointer' : 'default' }}
          dot={{ r: 3, fill: 'var(--chart-1)', strokeWidth: 0 }}
          onClick={(d: unknown) => onPick?.((d as { payload: ChartDatum }).payload ?? (d as ChartDatum))}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
