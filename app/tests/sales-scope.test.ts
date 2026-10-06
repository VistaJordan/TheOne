/* 0072 — the sales team: one dashboard, counted over the clients assigned to
 * them in Admin › Users.
 *
 * Three things are worth pinning. The role as the migration writes it opens
 * the Dashboard section and the Sales board and nothing else. The scope
 * predicate grows a client clause only for a person who HAS clients, and
 * never for someone who sees everything anyway. And the shipped Sales board
 * asks only plain work-order questions, so a salesperson's counts are their
 * clients' work orders and nothing a wider record set could leak.
 */

import { describe, expect, it } from 'vitest';
import {
  DASH_BOARDS_PERM_ROOT,
  PREBUILT_DASHBOARDS,
  QUERY_WIDGET_KINDS,
  WO_SCOPE_PERM_KEY,
  dashboardPermKey,
  permAllows,
  resolveWoScope,
  type PermissionSet,
} from '@theone/shared';
import { woScopeSql } from '../apps/api/src/services/woScope';
import { Params } from '../apps/api/src/services/woFields';
import type { ActingPrincipal } from '../apps/api/src/services/activity';

/** The grants 0072 writes on the `sales` role. */
const salesRole: PermissionSet = {
  role: {
    dashboard: { view: true },
    [DASH_BOARDS_PERM_ROOT]: { view: false },
    [dashboardPermKey('sales')]: { view: true },
    [WO_SCOPE_PERM_KEY]: { view: false },
  },
  overrides: {},
};

const noCan = { quoteEdit: false, quoteApprove: false, manageUsers: false, editWoFields: false, viewFieldHistory: false };

function actor(over: Partial<ActingPrincipal> = {}): ActingPrincipal {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Sam Rivera',
    kind: 'human',
    role: 'sales',
    roleLabel: 'Sales',
    isSuperAdmin: false,
    perms: salesRole,
    can: noCan,
    ...over,
  };
}

describe('the sales role (0072)', () => {
  it('opens the Dashboard section and the Sales board only', () => {
    expect(permAllows(salesRole, 'dashboard', 'view')).toBe(true);
    expect(permAllows(salesRole, dashboardPermKey('sales'), 'view')).toBe(true);
    // The two built-in pages and every other board follow the "no" on the root.
    expect(permAllows(salesRole, dashboardPermKey('main'), 'view')).toBe(false);
    expect(permAllows(salesRole, dashboardPermKey('attention'), 'view')).toBe(false);
    expect(permAllows(salesRole, dashboardPermKey('dispatch-center'), 'view')).toBe(false);
    // No list, no quotes, no admin.
    for (const section of ['work_orders', 'quotes', 'payments', 'approvals', 'admin', 'clients', 'vendors']) {
      expect(permAllows(salesRole, section, 'view')).toBe(false);
    }
  });

  it('is "only theirs" with no entities — their clients are the whole book', () => {
    expect(resolveWoScope(salesRole)).toEqual({ all: false, entities: [] });
  });
});

describe('woScopeSql with clients (0072)', () => {
  it('adds the client clause for a person with clients', () => {
    const p = new Params();
    const sql = woScopeSql(actor({ hasClients: true }), p);
    expect(sql).not.toBeNull();
    expect(sql).toContain('principal_client');
    expect(sql).toContain("lower(btrim(COALESCE(t.client, '')))");
    // Still ORed with the Assignee match, and the actor's id is bound, not inlined.
    expect(sql).toContain("'Assignee'");
    expect(sql).toMatch(/\) OR /);
    expect(p.values).toContain('11111111-1111-4111-8111-111111111111');
    expect(sql).not.toContain('11111111-1111');
  });

  it('adds nothing for a person with no clients', () => {
    const p = new Params();
    const sql = woScopeSql(actor(), p);
    expect(sql).not.toBeNull();
    expect(sql).not.toContain('principal_client');
  });

  it('is still unrestricted for a super admin and for "Everything"', () => {
    expect(woScopeSql(actor({ hasClients: true, isSuperAdmin: true }), new Params())).toBeNull();
    const everything: PermissionSet = { role: { work_orders: { view: true } }, overrides: {} };
    expect(woScopeSql(actor({ hasClients: true, perms: everything }), new Params())).toBeNull();
  });

  it('honours the table alias', () => {
    const sql = woScopeSql(actor({ hasClients: true }), new Params(), 'w');
    expect(sql).toContain("COALESCE(w.client, '')");
    expect(sql).not.toContain('t.client');
  });
});

describe('the Sales board', () => {
  const board = PREBUILT_DASHBOARDS.find((d) => d.key === 'sales');

  it('ships, in its own folder, shared with the sales role', () => {
    expect(board).toBeDefined();
    expect(board?.folder).toBe('Sales');
    expect(board?.shared_all).toBe(false);
    expect(board?.shared_roles).toContain('sales');
  });

  it('asks only plain work-order questions', () => {
    for (const w of board?.widgets ?? []) {
      expect(QUERY_WIDGET_KINDS).toContain(w.kind);
      expect(w.config.source ?? 'work_orders').toBe('work_orders');
      expect(w.config.metric).toBe('count');
      if (w.kind === 'line') expect(w.config.time_field).toBe('date_received');
      if (w.kind === 'bar' || w.kind === 'donut' || w.kind === 'table') expect(w.config.group_field).toBeTruthy();
    }
    // The headline card: every work order received, period applied by the board.
    expect(board?.widgets[0]).toMatchObject({ kind: 'number', config: { metric: 'count' } });
  });
});
