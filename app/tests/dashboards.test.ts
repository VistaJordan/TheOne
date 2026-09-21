/* 0042 — dashboards, vocabulary half. The database half (services/
 * dashboards.ts) stores and shares them; these pin the shapes that would
 * otherwise only fail in front of someone.
 *
 * The prebuilt dashboards are the interesting case: they are inserted by the
 * app itself, so a card that names a field wrongly or forgets what it groups
 * by would ship as a broken card on everybody's first login. Every rule the
 * API enforces on a hand-built card is asserted here against the ones we
 * ship.
 */

import { describe, it, expect } from 'vitest';
import {
  PREBUILT_DASHBOARDS,
  SOURCE_FIELDS,
  SOURCE_STATUSES,
  WIDGET_KINDS,
  WIDGET_METRICS,
  WIDGET_WIDTHS,
  TIME_BUCKETS,
  formatBucket,
  periodSteps,
  resolvePeriod,
  widgetAsksQuestion,
  widgetIsFigure,
  widgetSubtitle,
} from '../packages/shared/src/dashboards';

const ALL_WIDGETS = PREBUILT_DASHBOARDS.flatMap((d) =>
  d.widgets.map((w) => ({ ...w, dashboard: d.name })),
);

describe('the dashboards we ship', () => {
  it('have unique keys and at least one card each', () => {
    const keys = PREBUILT_DASHBOARDS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of PREBUILT_DASHBOARDS) expect(d.widgets.length).toBeGreaterThan(0);
  });

  it('only use card types, widths and metrics the database accepts', () => {
    for (const w of ALL_WIDGETS) {
      expect(WIDGET_KINDS).toContain(w.kind);
      expect(WIDGET_WIDTHS).toContain(w.width);
      expect(WIDGET_METRICS).toContain(w.config.metric);
    }
  });

  it('give every totalling card a field to total', () => {
    for (const w of ALL_WIDGETS) {
      if (w.config.metric !== 'count') {
        expect(w.config.value_field, `${w.dashboard} › ${w.label}`).toBeTruthy();
      }
    }
  });

  it('give every card over the money records only fields that source has (0049)', () => {
    for (const w of ALL_WIDGETS) {
      const source = w.config.source;
      if (!source || source === 'work_orders') continue;
      const allowed = SOURCE_FIELDS[source].map((f) => f.key);
      for (const key of [w.config.value_field, w.config.group_field, w.config.time_field]) {
        if (key) expect(allowed, `${w.dashboard} › ${w.label}: ${key}`).toContain(key);
      }
      for (const s of w.config.source_status ?? []) {
        expect(SOURCE_STATUSES[source], `${w.dashboard} › ${w.label}: ${s}`).toContain(s);
      }
    }
  });

  it('give every piece of furniture its own bit — text, a picture, a button (0049)', () => {
    for (const w of ALL_WIDGETS) {
      if (widgetAsksQuestion(w.kind)) continue;
      if (w.kind === 'narrative') expect(w.config.text?.trim(), `${w.dashboard} › ${w.label}`).toBeTruthy();
      else expect(w.config.url?.trim(), `${w.dashboard} › ${w.label}`).toBeTruthy();
    }
  });

  it('give every chart something to cut by — a category, or time', () => {
    for (const w of ALL_WIDGETS) {
      // A figure (number, gauge, live) and the furniture cut by nothing.
      if (widgetIsFigure(w.kind) || !widgetAsksQuestion(w.kind)) continue;
      // A line cuts by WHEN; every other chart cuts by a category. Neither
      // can draw without one, which is what this guards.
      const cutBy = w.kind === 'line' ? w.config.time_field : w.config.group_field;
      expect(cutBy, `${w.dashboard} › ${w.label}`).toBeTruthy();
    }
  });

  it('only filter on operators that match the field they name', () => {
    // A checkbox field takes is_true / is_false, never eq: `Emergency eq
    // true` silently matches nothing, which is the worst way for a card to be
    // wrong. Catch it here rather than on the dashboard.
    for (const w of ALL_WIDGETS) {
      for (const rule of w.config.filters?.rules ?? []) {
        const isFlag = /Emergency|Escalated/.test(rule.field);
        if (isFlag) {
          expect(['is_true', 'is_false', 'is_set', 'is_not_set'], `${w.label}: ${rule.field}`).toContain(
            rule.op,
          );
        }
        if (rule.op === 'in' || rule.op === 'not_in') {
          expect(Array.isArray(rule.value), `${w.label}: ${rule.field}`).toBe(true);
        }
      }
    }
  });

  it('name a real bag key whenever they reach into the field bag', () => {
    // Every custom field is addressed as `fields.<key>`; a bare key would
    // resolve as a core column and throw.
    for (const w of ALL_WIDGETS) {
      const keys = [w.config.value_field, w.config.group_field].filter(Boolean) as string[];
      for (const k of keys) {
        if (k.includes('.')) expect(k.startsWith('fields.')).toBe(true);
      }
    }
  });

  it('share the operations dashboards and keep the money one to its roles', () => {
    const money = PREBUILT_DASHBOARDS.find((d) => d.key === 'money');
    expect(money?.shared_all).toBe(false);
    expect(money?.shared_roles.length).toBeGreaterThan(0);
    expect(PREBUILT_DASHBOARDS.find((d) => d.key === 'dispatch-center')?.shared_all).toBe(true);
  });
});

describe('how a card words its own number', () => {
  it('says what is being counted, totalled or averaged', () => {
    expect(widgetSubtitle({ metric: 'count' })).toBe('Work orders');
    expect(widgetSubtitle({ metric: 'sum', value_field: 'nte' }, 'NTE')).toBe('Total NTE');
    expect(widgetSubtitle({ metric: 'avg', value_field: 'nte' }, 'NTE')).toBe('Average NTE');
  });

  it('falls back to the field key when no label is to hand', () => {
    expect(widgetSubtitle({ metric: 'sum', value_field: 'fields.34. Cost' })).toContain('34. Cost');
  });
});

describe('the period the whole board is read over (0044)', () => {
  // A fixed instant, so "this month" is a fact rather than whenever the suite
  // happens to run.
  const NOW = new Date('2026-09-20T15:00:00Z');

  it('means everything until someone chooses otherwise', () => {
    const p = resolvePeriod({ preset: 'all', offset: 0 }, NOW);
    expect(p.from).toBeNull();
    expect(p.to).toBeNull();
    expect(p.label).toBe('All time');
  });

  it('covers a whole month, first day to last', () => {
    const p = resolvePeriod({ preset: 'month', offset: 0 }, NOW);
    expect(p.from).toBe('2026-09-01');
    expect(p.to).toBe('2026-09-30');
    expect(p.label).toBe('September 2026');
  });

  it('steps back a month at a time, across a year boundary', () => {
    expect(resolvePeriod({ preset: 'month', offset: -1 }, NOW).from).toBe('2026-08-01');
    const back = resolvePeriod({ preset: 'month', offset: -9 }, NOW);
    expect(back.from).toBe('2025-12-01');
    expect(back.to).toBe('2025-12-31');
    expect(back.label).toBe('December 2025');
  });

  it('knows which quarter a month is in, and steps quarters', () => {
    expect(resolvePeriod({ preset: 'quarter', offset: 0 }, NOW)).toMatchObject({
      from: '2026-07-01',
      to: '2026-09-30',
      label: 'Q3 2026',
    });
    expect(resolvePeriod({ preset: 'quarter', offset: -1 }, NOW).label).toBe('Q2 2026');
  });

  it('covers a calendar year', () => {
    expect(resolvePeriod({ preset: 'year', offset: 0 }, NOW)).toMatchObject({
      from: '2026-01-01',
      to: '2026-12-31',
      label: '2026',
    });
  });

  it('counts the last 30 days inclusively — 30 days, not 31', () => {
    const p = resolvePeriod({ preset: 'last_30', offset: 0 }, NOW);
    expect(p.to).toBe('2026-09-20');
    expect(p.from).toBe('2026-08-22');
    const days =
      (Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000 + 1;
    expect(days).toBe(30);
  });

  it('only puts arrows on the presets that can step', () => {
    expect(periodSteps('month')).toBe(true);
    expect(periodSteps('quarter')).toBe(true);
    expect(periodSteps('year')).toBe(true);
    expect(periodSteps('all')).toBe(false);
    expect(periodSteps('last_30')).toBe(false);
  });
});

describe('a line card', () => {
  it('runs along a date instead of a category', () => {
    const line = PREBUILT_DASHBOARDS.flatMap((d) => d.widgets).filter((w) => w.kind === 'line');
    expect(line.length).toBeGreaterThan(0);
    for (const w of line) {
      expect(w.config.time_field).toBeTruthy();
      expect(w.config.group_field).toBeUndefined();
      expect(TIME_BUCKETS).toContain(w.config.bucket);
    }
  });

  it('labels its points as dates', () => {
    expect(formatBucket('2026-09-01', 'month')).toBe('Sep 26');
    expect(formatBucket('2026-09-07', 'week')).toBe('Sep 7');
    expect(formatBucket('not-a-date', 'month')).toBe('not-a-date');
  });
});
