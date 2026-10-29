/* 0111 (Elise, 2026-10-29) — the Quotes tab on a work order stays for the
 * dispatchers. The Quotes page in the sidebar has its own permission
 * (`quotes/page`); `quotes` view still opens the work order's Quotes tab. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QUOTES_PAGE_PERM_KEY, permAllows } from '../packages/shared/src/permissions';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('the Quotes page permission', () => {
  it('is its own path and follows quotes view when unset', () => {
    expect(QUOTES_PAGE_PERM_KEY).toBe('quotes/page');
    expect(permAllows({ role: { quotes: { view: true } }, overrides: {} }, QUOTES_PAGE_PERM_KEY, 'view', false)).toBe(true);
    expect(permAllows({ role: { quotes: { view: true }, 'quotes/page': { view: false } }, overrides: {} }, QUOTES_PAGE_PERM_KEY, 'view', false)).toBe(false);
    expect(permAllows({ role: { quotes: { view: true }, 'quotes/page': { view: false } }, overrides: {} }, 'quotes', 'view', false)).toBe(true);
  });

  it('migration 0111 copies the old setting onto the page and turns the tab on', () => {
    const sql = read('packages/db/migrations/0111_quotes_page.sql');
    expect(sql).toContain("COALESCE((permissions -> 'quotes' ->> 'view')::boolean, true)");
    expect(sql).toContain(`'quotes', '{"view": true}'`);
    expect(sql).toContain(`'work_orders/tabs/quotes', '{"view": true}'`);
    expect(sql).toContain("ARRAY['om', 'senior_om', 'om_probation']");
  });

  it('the sidebar and the route use the page permission; the tab keeps quotes view', () => {
    expect(read('apps/web/src/components/AppShell.tsx')).toContain('Quotes: QUOTES_PAGE_PERM_KEY,');
    expect(read('apps/web/src/App.tsx')).toContain('<RequireCan perm={QUOTES_PAGE_PERM_KEY} nav="Quotes"><QuotesPage /></RequireCan>');
    expect(read('apps/web/src/pages/WorkOrderDetailPage.tsx')).toContain("(t !== 'quotes' || can('quotes', 'view'))");
  });
});
