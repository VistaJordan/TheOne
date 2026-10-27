/* Elise, 2026-10-27 — Tech Hub (migration 0095).
 *
 * Messages keeps the conversation with the team and the client, and calls to
 * the client (a typed number, a plain call). Everything about the technician
 * — suggested vendors, hiring, technician calls with the AI quote draft, the
 * Quo texts, dispatch — moved from People › Technicians onto the Tech Hub
 * tab, which has its own permission row.
 *
 * The pure half (callSide, the tab list) is exercised; the wired half is
 * pinned to the source so a refactor that drops a piece fails here.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TECH_HUB_TAB, callSide } from '../packages/shared/src/calls';
import { WO_TABS, tabPermKey } from '../packages/shared/src/permissions';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('which tab a call is listed on', () => {
  it('a plain call to the client is the client side', () => {
    expect(callSide({ contact_role: 'client', purpose: 'call' })).toBe('client');
  });

  it('technicians, vendors, others and every quote call are Tech Hub', () => {
    expect(callSide({ contact_role: 'tech', purpose: 'call' })).toBe('tech');
    expect(callSide({ contact_role: 'vendor', purpose: 'call' })).toBe('tech');
    expect(callSide({ contact_role: 'other', purpose: 'call' })).toBe('tech');
    // An imported transcript or a call placed to draft a quote: the draft lives on Tech Hub.
    expect(callSide({ contact_role: 'client', purpose: 'quote' })).toBe('tech');
  });
});

describe('the Tech Hub tab', () => {
  it('is a tab of its own, keyed by the old Technicians id', () => {
    expect(TECH_HUB_TAB).toBe('technicians');
    expect(WO_TABS.find((t) => t.id === TECH_HUB_TAB)?.label).toBe('Tech Hub');
  });

  it('its permission is its own row, no longer People', () => {
    expect(tabPermKey(TECH_HUB_TAB)).toBe('work_orders/tabs/technicians');
    const page = read('apps/web/src/pages/WorkOrderDetailPage.tsx');
    expect(page).toContain('const tabPerm = (t: Tab): string => tabPermKey(t);');
  });

  it('0095 copies People\'s grants onto it for roles and per-person overrides', () => {
    const sql = read('packages/db/migrations/0095_tech_hub_tab.sql');
    expect(sql).toMatch(/UPDATE role[\s\S]*'work_orders\/tabs\/technicians'[\s\S]*'work_orders\/tabs\/people'/);
    expect(sql).toMatch(/UPDATE principal[\s\S]*permission_overrides[\s\S]*'work_orders\/tabs\/technicians'/);
  });

  it('the Quo technician texts follow the Tech Hub tab on the API', () => {
    const routes = read('apps/api/src/routes/workOrders.ts');
    const quo = routes.slice(routes.indexOf("'/work-orders/:id/messages/quo'"));
    expect(quo.slice(0, 400)).toContain('tabPermKey(TECH_HUB_TAB)');
    const post = routes.slice(routes.indexOf("app.post('/work-orders/:id/messages/quo'"));
    expect(post.slice(0, 300)).toContain('tabPermKey(TECH_HUB_TAB)');
  });
});

describe('what each tab draws', () => {
  const page = read('apps/web/src/pages/WorkOrderDetailPage.tsx');

  it('Messages has the client calls and no Quo thread', () => {
    expect(page).toContain(`{tab === 'messages' && <CallsCard wo={wo} side="client" />}`);
    const panel = read('apps/web/src/components/wo/messages/MessagesPanel.tsx');
    expect(panel).not.toContain('TextComposer');
    expect(panel).not.toContain('MessageThread');
  });

  it('Tech Hub has suggestions, technicians, technician calls, texts and dispatch', () => {
    const hub = page.slice(page.indexOf('{tab === TECH_HUB_TAB && ('));
    const panel = hub.slice(0, hub.indexOf('</div>'));
    for (const card of ['<ResponsibleVendorCard', '<SuggestedVendorsCard', '<TechniciansCard', '<CallsCard wo={wo} side="tech" />', '<TechTextsCard', '<DispatchCard']) {
      expect(panel, card).toContain(card);
    }
  });

  it('a client call takes a typed number and never drafts a quote', () => {
    const dialog = read('apps/web/src/components/wo/calls/CallButton.tsx');
    expect(dialog).toContain('if (isClient) return out;');
    expect(dialog).toContain("purpose: isClient ? 'call' : purpose");
    const card = read('apps/web/src/components/wo/calls/CallsCard.tsx');
    expect(card).toContain("const canDraft = side === 'tech' &&");
  });
});
