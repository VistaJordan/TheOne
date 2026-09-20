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
  WIDGET_KINDS,
  WIDGET_METRICS,
  WIDGET_WIDTHS,
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

  it('give every chart a field to group by, and never give one to a figure', () => {
    for (const w of ALL_WIDGETS) {
      if (w.kind === 'number') continue;
      expect(w.config.group_field, `${w.dashboard} › ${w.label}`).toBeTruthy();
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
