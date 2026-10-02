// 0068 — tabs and groups inside a dashboard are names on its cards.
import { describe, expect, it } from 'vitest';
import { DASH_DEFAULT_TAB, PREBUILT_DASHBOARDS, dashboardTabs, widgetsByGroup } from '@theone/shared';

const w = (label: string, tab?: string, section?: string) => ({ label, config: { tab, section } });

describe('tabs inside a dashboard', () => {
  it('a dashboard whose cards name no tab has none, as before', () => {
    expect(dashboardTabs([w('a'), w('b', '  ')])).toEqual([]);
    expect(widgetsByGroup([w('a'), w('b')], null)).toEqual([{ section: null, widgets: [w('a'), w('b')] }]);
  });

  it('lists tabs in the order the cards first name them, whatever their capitals', () => {
    expect(dashboardTabs([w('a', 'Work'), w('b', 'Money'), w('c', 'work')])).toEqual(['Work', 'Money']);
  });

  it('files cards with no tab under Overview, first', () => {
    expect(dashboardTabs([w('a', 'Work'), w('b')])).toEqual([DASH_DEFAULT_TAB, 'Work']);
    expect(widgetsByGroup([w('a', 'Work'), w('b')], DASH_DEFAULT_TAB)[0].widgets.map((x) => x.label)).toEqual(['b']);
    expect(dashboardTabs([w('a', 'Overview'), w('b')])).toEqual(['Overview']);
  });

  it('cuts a tab into groups, the ungrouped cards first', () => {
    const cards = [w('a', 'T', 'Late'), w('b', 'T'), w('c', 'T', 'late'), w('d', 'T', 'Team'), w('e', 'Other')];
    const out = widgetsByGroup(cards, 'T');
    expect(out.map((g) => [g.section, g.widgets.map((x) => x.label)])).toEqual([[null, ['b']], ['Late', ['a', 'c']], ['Team', ['d']]]);
  });

  it('the five boards shipped with tabs each have more than one, except Store Manager', () => {
    const tabsOf = (key: string) => dashboardTabs(PREBUILT_DASHBOARDS.find((d) => d.key === key)!.widgets);
    for (const key of ['maintenance-supervisor', 'vendor-performance', 'technician', 'unified-ops']) expect(tabsOf(key).length, key).toBeGreaterThan(1);
    expect(tabsOf('store-manager')).toEqual([]);
    // The boards that existed before have no tabs at all.
    for (const key of ['dispatch-center', 'vendors', 'portfolio', 'service-levels']) expect(tabsOf(key), key).toEqual([]);
  });
});
