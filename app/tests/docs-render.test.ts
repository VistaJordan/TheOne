/* 0075 — the three documents render to markup without a snapshot and with a
 * minimal one (the page shows the written sections when the live read
 * fails). A render smoke test: phase-0 has no local database, so this is the
 * closest check to opening the page before the live deploy. */

import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import type { DocsSnapshot } from '../packages/shared/src/docs';
import { BrdDoc, brdToc } from '../apps/web/src/components/docs/BrdDoc';
import { SopDoc, sopToc } from '../apps/web/src/components/docs/SopDoc';
import { LifecycleChart } from '../apps/web/src/components/docs/LifecycleChart';

const snap: DocsSnapshot = {
  generated_at: '2026-10-06T12:00:00.000Z',
  instance: { auth_mode: 'entra', node_env: 'production', web_origin: 'https://the-one.example', database: 'Postgres (Neon)', migrations_applied: 75, latest_migration: '0075_documentation.sql' },
  counts: { work_orders: 1200, users: 20, roles: 14, statuses: 20, fields: 80, automations: 2, saved_views: 5, dashboards: 14, vendors: 300, sites: 40, assets: 10, clients: 12, quotes: 400, invoices: 100, payment_requests: 500, audit_rows: 90000 },
  super_admins: ['Elise Abdel Massih', 'Jordan Brown'],
  service_principals: ['Ecotrak sync', 'Quo'],
  status_groups: [{ code: 'open', label: 'Open', position: 0, is_builtin: true, status_count: 2 }],
  statuses: [
    { name: 'Open', group: 'open', color: '#3b82f6', position: 0, is_archive: false, phase: 'Intake', wo_count: 12 },
    { name: 'Done / Incurred', group: 'done', color: '#22c55e', position: 15, is_archive: false, phase: 'Done', wo_count: 3 },
  ],
  fields: [{ key: '34. Cost', label: 'Cost', type: 'money', section: 'Finances', options: [], create_mode: 'off', used_by: 900, computed: false, visit_owned: false }],
  roles: [
    {
      code: 'om',
      label: 'OM (dispatcher)',
      description: 'Sources technicians.',
      is_system: true,
      user_count: 6,
      sections: [{ key: 'work_orders', label: 'Work orders', view: true, create: false, edit: true, delete: false, approve: false }],
      wo_scope: 'only_theirs',
      status_mode: 'request',
    },
  ],
  automations: [{ name: 'Cost over NTE', enabled: true, trigger: '34. Cost changes to more than nte', conditions: 0, actions: ['Raise an approval task (nte_override)'], run_count: 4 }],
  integrations: [{ key: 'quo', name: 'Quo', group: 'communications', enabled: true, built: true, configured: false, summary: 'Calls and texts.' }],
  approval_tiers: [{ kind: 'payment', label: 'Under $500', min_amount: 0, max_amount: 500, roles: [] }],
  holidays: [{ day: '2026-12-25', name: 'Christmas Day' }],
  dashboards: [{ name: 'Dispatch Center', folder: 'Operations', system_key: 'dispatch', widgets: 8 }],
  migrations: [{ n: 75, filename: '0075_documentation.sql', title: 'documentation', applied_at: '2026-10-06T10:00:00.000Z' }],
};

describe('the documents render', () => {
  it('BRD with and without the live appendix', () => {
    const bare = renderToStaticMarkup(createElement(BrdDoc, { snap: null }));
    expect(bare).toContain('Business rules register');
    expect(bare).toContain('could not be read');
    const full = renderToStaticMarkup(createElement(BrdDoc, { snap }));
    expect(full).toContain('0075_documentation.sql');
    expect(full).toContain('OM (dispatcher)');
    expect(full).toContain('Christmas Day');
    expect(brdToc(snap).length).toBeGreaterThan(brdToc(null).length);
  });
  it('SOP with and without the ledger', () => {
    const bare = renderToStaticMarkup(createElement(SopDoc, { snap: null }));
    expect(bare).toContain('SOP 1: Signing In');
    expect(bare).toContain('Document Sign-Off');
    const full = renderToStaticMarkup(createElement(SopDoc, { snap }));
    expect(full).toContain('documentation');
    expect(sopToc().some((t) => t.id === 'sop-20')).toBe(true);
  });
  it('the lifecycle chart draws every status and the live counts', () => {
    const svgRef = createRef<SVGSVGElement>();
    const html = renderToStaticMarkup(createElement(LifecycleChart, { snap, svgRef }));
    expect(html).toContain('Waiting for Quote');
    expect(html).toContain('Cancelled / Postponed');
    expect(html).toContain('>12<'); // Open's live count
    expect(html).toContain('What runs beside the statuses');
    const bare = renderToStaticMarkup(createElement(LifecycleChart, { snap: null, svgRef }));
    expect(bare).toContain('lc-svg');
  });
});
