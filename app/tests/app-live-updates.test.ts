/* Live sync between accounts (migration 0126, Elise 2026-11-05). Every write
 * request rings a doorbell (live_change, tagged with the browser tab); every
 * signed-in screen polls GET /activity/since and re-reads what it shows when
 * another tab, a webhook or the system changed something. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isLiveWrite, liveChangeTab } from '../apps/api/src/plugins/liveChange';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const shell = read('apps/web/src/components/AppShell.tsx');
const hook = read('apps/web/src/hooks/useAppLiveUpdates.ts');
const client = read('apps/web/src/api/client.ts');
const app = read('apps/api/src/app.ts');
const routes = read('apps/api/src/routes/activity.ts');
const service = read('apps/api/src/services/activity.ts');
const migration = read('packages/db/migrations/0126_live_change.sql');

describe('live sync between accounts', () => {
  it('every write request rings the doorbell, before the reply leaves', () => {
    expect(app).toMatch(/installLiveChange\(app\)/);
    expect(read('apps/api/src/plugins/liveChange.ts')).toMatch(/addHook\('onSend'/);
    expect(migration).toMatch(/CREATE UNLOGGED TABLE IF NOT EXISTS live_change/);
  });

  it('counts successful writes, not reads, refusals or private ones', () => {
    expect(isLiveWrite('PATCH', '/api/work-orders/WO-1/fields', 200)).toBe(true);
    expect(isLiveWrite('POST', '/api/payment-requests/x/approve', 201)).toBe(true);
    expect(isLiveWrite('POST', '/api/webhooks/ecotrak?key=k', 200)).toBe(true);
    expect(isLiveWrite('GET', '/api/work-orders', 200)).toBe(false);
    expect(isLiveWrite('PATCH', '/api/work-orders/WO-1/fields', 409)).toBe(false);
    expect(isLiveWrite('PUT', '/api/prefs/columns', 200)).toBe(false);
    expect(isLiveWrite('POST', '/api/notices/mark', 200)).toBe(false);
    expect(isLiveWrite('POST', '/api/auth/logout', 200)).toBe(false);
  });

  it('every request carries this tab, whatever headers the call passes', () => {
    expect(client).toMatch(/'x-obi-tab': TAB_ID/);
    const req = client.slice(client.indexOf('async function request<T>'));
    expect(req.indexOf('...init,')).toBeLessThan(req.indexOf("'x-obi-tab'"));
    expect(liveChangeTab('abc_123-DEF')).toBe('abc_123-DEF');
    expect(liveChangeTab('bad tab!')).toBeNull();
    expect(liveChangeTab(undefined)).toBeNull();
  });

  it('the shell polls; only another tab or the system re-reads the screen', () => {
    expect(shell).toMatch(/useAppLiveUpdates\(!!user\)/);
    expect(hook).toMatch(/refetchInterval: APP_POLL_MS/);
    expect(hook).toMatch(/after !== null && res\.others/);
    expect(hook).toMatch(/q\.queryKey\[0\] !== APP_LATEST_KEY/);
    expect(routes).toMatch(/app\.get\('\/activity\/since'/);
    expect(service).toMatch(/tab_id IS DISTINCT FROM \$3/);
    expect(service).toMatch(/p\.kind = 'service'/);
  });
});
