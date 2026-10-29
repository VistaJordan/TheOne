/* 0108 (Elise, 2026-10-29) — "Records opened by link ignore scope": OM, Senior
 * OM and OM Under Probation see payments only inside the work order. The
 * Payments page has its own permission (`payments/page`); `payments` view
 * still opens a work order's Payables. Every read across work orders — the
 * queue, one request by link, the vendor-bill lane, one bill by link — needs
 * the page (the queue also opens to the Approvals inbox's Payments lane). */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAYMENTS_PAGE_PERM_KEY, permAllows } from '../packages/shared/src/permissions';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('the Payments page permission', () => {
  it('is its own path and follows payments view when unset', () => {
    expect(PAYMENTS_PAGE_PERM_KEY).toBe('payments/page');
    expect(permAllows({ role: { payments: { view: true } }, overrides: {} }, PAYMENTS_PAGE_PERM_KEY, 'view', false)).toBe(true);
    expect(permAllows({ role: { payments: { view: true }, 'payments/page': { view: false } }, overrides: {} }, PAYMENTS_PAGE_PERM_KEY, 'view', false)).toBe(false);
    expect(permAllows({ role: { payments: { view: true }, 'payments/page': { view: false } }, overrides: {} }, 'payments', 'view', false)).toBe(true);
  });

  it('migration 0108 gives the dispatchers payments on the work order and no page', () => {
    const sql = read('packages/db/migrations/0108_payments_page.sql');
    expect(sql).toContain(`'payments', '{"view": true, "create": true, "approve": false}'`);
    expect(sql).toContain(`'payments/page', '{"view": false}'`);
    expect(sql).toContain(`'approvals/payments', '{"view": false}'`);
    expect(sql).toContain("ARRAY['om', 'senior_om', 'om_probation']");
  });
});

describe('the wiring (source pins)', () => {
  it('the payments queue and one request by link need the page (or the inbox lane)', () => {
    const r = read('apps/api/src/routes/payments.ts');
    const queue = r.slice(r.indexOf("app.get('/payments'"), r.indexOf("app.get('/payment-requests/:pid'"));
    expect(queue).toContain('requirePaymentsOutsideWo(viewer);');
    const one = r.slice(r.indexOf("app.get('/payment-requests/:pid'"), r.indexOf("app.patch('/payment-requests/:pid'"));
    expect(one).toContain('requirePaymentsOutsideWo(actor);');
    expect(r).toContain("permAllows(p.perms, 'approvals/payments', 'view', p.isSuperAdmin)");
    // The work order's own Payables read is untouched.
    const wo = r.slice(r.indexOf("app.get('/work-orders/:id/payment-requests'"), r.indexOf("app.post('/work-orders/:id/payment-requests'"));
    expect(wo).not.toContain('requirePaymentsOutsideWo');
  });

  it('the vendor-bill lane and one bill by link need the page', () => {
    const r = read('apps/api/src/routes/vendorBills.ts');
    const list = r.slice(r.indexOf("app.get('/vendor-bills'"), r.indexOf("app.get('/vendor-bills/:id'"));
    expect(list).toContain("requirePerm(actor, PAYMENTS_PAGE_PERM_KEY, 'view'");
    const one = r.slice(r.indexOf("app.get('/vendor-bills/:id'"));
    expect(one.slice(0, one.indexOf('});'))).toContain('PAYMENTS_PAGE_PERM_KEY');
  });

  it('the sidebar, the route and the Open Payments link use the page permission', () => {
    expect(read('apps/web/src/components/AppShell.tsx')).toContain('Payments: PAYMENTS_PAGE_PERM_KEY,');
    expect(read('apps/web/src/App.tsx')).toContain('<RequireCan perm={PAYMENTS_PAGE_PERM_KEY} nav="Payments"><PaymentsPage /></RequireCan>');
    const req = read('apps/web/src/pages/RequestPaymentPage.tsx');
    expect(req).toContain("const canOpenPaymentsPage = useCan()(PAYMENTS_PAGE_PERM_KEY, 'view');");
    expect(req).toContain('{canOpenPaymentsPage && (');
  });
});
