/* 0050 — which dashboards a role opens, and what each one counts.
 *
 * The part worth pinning is the scope row: it is read at its exact path, so
 * ticking a dashboard (view = true on the row above it) must NOT quietly make
 * it count every work order, and an unset choice must leave the person's own
 * "Which work orders" in charge.
 */

import { describe, it, expect } from 'vitest';
import {
  DASH_BOARDS_PERM_ROOT,
  WO_SCOPE_PERM_KEY,
  buildPermissionTree,
  dashboardPermKey,
  dashboardRef,
  dashboardScopePermKey,
  permAllows,
  resolveDashboardScope,
  resolveWoScope,
  withDashboardScope,
  type PermissionSet,
} from '@theone/shared';

const om: PermissionSet = {
  role: {
    dashboard: { view: true },
    [DASH_BOARDS_PERM_ROOT]: { view: false },
    [dashboardPermKey('main')]: { view: true },
    [dashboardPermKey('dispatch-center')]: { view: true },
    [WO_SCOPE_PERM_KEY]: { view: false },
  },
  overrides: {},
};

describe('dashboard grants (0050)', () => {
  it('keys a shipped dashboard by system_key and a built one by id', () => {
    expect(dashboardRef({ id: 'abc', system_key: 'money' })).toBe('money');
    expect(dashboardRef({ id: 'abc', system_key: null })).toBe('abc');
    expect(dashboardScopePermKey('money')).toBe('dashboard/boards/money/scope');
  });

  it('opens what is ticked and nothing that only inherits the closed default', () => {
    expect(permAllows(om, dashboardPermKey('main'), 'view')).toBe(true);
    expect(permAllows(om, dashboardPermKey('money'), 'view')).toBe(false);
    expect(permAllows(om, dashboardPermKey('some-new-id'), 'view')).toBe(false);
  });

  it('an unset scope follows "Which work orders", even on a ticked dashboard', () => {
    expect(resolveDashboardScope(om, 'main')).toBeUndefined();
    expect(withDashboardScope(om, 'main')).toBe(om);
    expect(resolveWoScope(withDashboardScope(om, 'main')).all).toBe(false);
  });

  it('"Everything" on one dashboard widens that dashboard only', () => {
    const set: PermissionSet = {
      ...om,
      role: { ...om.role, [dashboardScopePermKey('dispatch-center')]: { view: true } },
    };
    expect(resolveWoScope(withDashboardScope(set, 'dispatch-center')).all).toBe(true);
    expect(resolveWoScope(withDashboardScope(set, 'main')).all).toBe(false);
    // The person's own list is untouched.
    expect(resolveWoScope(set).all).toBe(false);
  });

  it('"Only theirs" narrows a dashboard for someone who sees everything', () => {
    const tl: PermissionSet = {
      role: { dashboard: { view: true }, work_orders: { view: true }, [dashboardScopePermKey('main')]: { view: false } },
      overrides: {},
    };
    expect(resolveWoScope(tl).all).toBe(true);
    expect(resolveWoScope(withDashboardScope(tl, 'main')).all).toBe(false);
  });

  it("a person's override beats the role at the scope path", () => {
    const set: PermissionSet = {
      role: { ...om.role, [dashboardScopePermKey('main')]: { view: false } },
      overrides: { [dashboardScopePermKey('main')]: { view: true } },
    };
    expect(resolveDashboardScope(set, 'main')).toBe(true);
  });

  it('draws both built-in pages and every record under Which dashboards', () => {
    const tree = buildPermissionTree([], { dashboards: [{ ref: 'money', label: 'Money' }] });
    const dash = tree.find((n) => n.key === 'dashboard');
    const boards = dash?.children?.find((n) => n.key === DASH_BOARDS_PERM_ROOT);
    expect(boards?.children?.map((n) => n.label)).toEqual(['Needs Attention', 'Main Dashboard', 'Money']);
    const scope = boards?.children?.[2].children?.[0];
    expect(scope?.key).toBe('dashboard/boards/money/scope');
    expect(scope?.exact).toBe(true);
    expect(scope?.choices?.map((c) => c.code)).toEqual(['same', 'all', 'assigned']);
  });
});
