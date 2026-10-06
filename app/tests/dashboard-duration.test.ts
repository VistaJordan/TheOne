/* 0073 — "time between" cards and per-person sharing: the shared vocabulary
 * the editor, the route schema and the metrics engine all agree on.
 */

import { describe, expect, it } from 'vitest';
import {
  DURATION_STATS,
  DURATION_STAT_LABELS,
  SPAN_END_FIELD,
  WIDGET_METRICS,
  WIDGET_METRIC_LABELS,
  widgetSubtitle,
  type DurationLeg,
  type WidgetConfig,
} from '@theone/shared';

describe('time between (0073)', () => {
  it('is a metric the editor offers, with a label', () => {
    expect(WIDGET_METRICS).toContain('duration');
    expect(WIDGET_METRIC_LABELS.duration).toMatch(/time between/i);
    for (const s of DURATION_STATS) expect(DURATION_STAT_LABELS[s]).toBeTruthy();
  });

  it('words its subtitle by the statistic, never by a value field', () => {
    const from: DurationLeg = { kind: 'event', field: 'status', value: 'Ready to Assign' };
    const to: DurationLeg = { kind: 'event', field: 'fields.Assignee' };
    const avg: WidgetConfig = { metric: 'duration', from, to };
    const median: WidgetConfig = { metric: 'duration', from, to, stat: 'median' };
    expect(widgetSubtitle(avg)).toBe('Average time between');
    expect(widgetSubtitle(median)).toBe('Median time between');
    // A span over payments reads the same way.
    expect(widgetSubtitle({ ...avg, source: 'payments', from: { kind: 'date', field: 'created_at' }, to: { kind: 'date', field: 'approved_at' } })).toBe('Average time between');
  });

  it('runs a line along the end of the span, under one agreed key', () => {
    expect(SPAN_END_FIELD).toBe('span_end');
  });
});
