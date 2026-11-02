/* Live updates on an open work order (Elise, 2026-11-02). The API runs as
 * Vercel functions (no socket per browser), so an open work order polls
 * GET /activity/latest and, when the newest change it may see moves and was
 * made by somebody else, reloads every query of that work order on screen.
 * The quote builder takes in another person's save only while this person
 * has nothing unsaved. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const route = read('apps/api/src/routes/activity.ts');
const service = read('apps/api/src/services/activity.ts');
const hook = read('apps/web/src/hooks/useWoLiveUpdates.ts');
const page = read('apps/web/src/pages/WorkOrderDetailPage.tsx');
const builder = read('apps/web/src/pages/QuoteBuilderPage.tsx');

describe('work order live updates', () => {
  it('the latest-change route has the work order gate, the scope and M28', () => {
    const fn = route.slice(route.indexOf("app.get('/activity/latest'"));
    expect(fn).toContain("requirePerm(viewer, 'work_orders', 'view'");
    expect(fn).toContain('resolveTaskId(wo, viewer)');
    expect(fn).toContain('activityValuesVisible(allow, h.field)');
    // A row on a hidden field moves the version but never names anyone.
    expect(fn).toContain('actor: null');
  });

  it('reads only the task rows, newest first, without values', () => {
    const fn = service.slice(service.indexOf('export async function getRecentChangeHeads'));
    expect(fn).toContain("a.entity_type = 'task' AND a.entity_id = $1::text");
    expect(fn).toContain('ORDER BY a.created_at DESC, a.id DESC');
    expect(fn.slice(0, fn.indexOf('FROM activity_log'))).not.toMatch(/a\.(before|after)/);
  });

  it('polls, skips the first answer and the person\'s own change, reloads the rest', () => {
    expect(hook).toContain('refetchInterval: LIVE_POLL_MS');
    expect(hook).toMatch(/seen\.current\.wo !== woId[\s\S]*?return;/);
    expect(hook).toContain("meKey.split('|').includes(actor.id)");
    expect(hook).toContain('invalidateQueries({ predicate: (q) => belongsTo(q, ids) })');
    expect(hook).toContain("if (key[0] === LATEST_KEY) return false;");
  });

  it('the work order page runs it for the user and whom they view as', () => {
    expect(page).toContain('useWoLiveUpdates(wo?.id, woNumber, [user?.id, actingAs?.id])');
    expect(page).toContain('className="wo-live-note" role="status"');
  });

  it('the quote builder never overwrites unsaved typing', () => {
    expect(builder).toContain('const signature = quote ? `${identity}:${quote.updated_at}` : null;');
    expect(builder).toContain('if (sameQuote && (dirty || saving)) return;');
    // Its own autosave sets the signature from the response, updated_at included.
    expect(builder).toContain('`${res.quote.id}:${res.quote.status}:${res.quote.rev}:${res.quote.updated_at}`');
  });
});
