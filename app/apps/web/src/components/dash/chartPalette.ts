/* The chart palette (0042) — deliberately its own module, with NO import of
 * Recharts.
 *
 * WidgetCard needs the colours and the row shape to draw a table and to build
 * its legend, but a table must not drag a charting library onto a page that
 * has no chart on it. Anything both the card and the chart need lives here;
 * anything that draws lives in WidgetCharts, which is loaded lazily. Import
 * from the wrong side and the code-splitting quietly stops working (the
 * bundle grows by ~400KB and nothing else complains).
 *
 * Hues are handed out IN ORDER from the theme's eight chart tokens and never
 * cycled: a ninth bucket has already been folded into "other" by the API, and
 * "other" wears a neutral so it never reads as one more category.
 */

const SLOTS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
];

export const CHART_OTHER = 'var(--chart-other)';

export function colorFor(index: number, value: string | null): string {
  // "Not set" is not a category: it wears the neutral so it never competes
  // with a real one for a hue.
  if (value === null) return CHART_OTHER;
  return SLOTS[index % SLOTS.length];
}

/** One drawn mark: its label, its number, the raw value behind it (for the
    drill-through), and the hue it was assigned. */
export interface ChartDatum {
  name: string;
  value: number;
  raw: string | null;
  color: string;
}

/** The label the tail bucket carries, in one place — the card tests for it to
    decide whether a click can filter to a single value. */
export const EVERYTHING_ELSE = 'Everything else';
