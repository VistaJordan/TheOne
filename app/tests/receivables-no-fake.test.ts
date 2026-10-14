/* G7 / AUDIT.md W2-1 — Receivables shows no invented facts.
 *
 * Before this batch `lib/receivables.ts` built every Audit row from an FNV
 * hash of the work-order id (BFI, CICO, client quote, CO#, SharePoint folder
 * contents, photo counts, days on Grey), picked the assignee from a hard-coded
 * list and made up invoice numbers and amounts; the Invoicing "Ready" lane
 * fed from those, and /receivables had no RequireCan while the sidebar hid it
 * behind `invoicing`. This suite pins the fix (D9):
 *
 *   - source text: no hash-seeded derivation, no assignee list, no invented
 *     invoice numbers, and the route gated on `invoicing` like the nav;
 *   - behaviour: facts come from the list payload alone (two rows identical
 *     except their id derive identical facts), an unknown fact is null and
 *     never a major / minor finding, and Ready uses only real facts;
 *   - the skeptic round: a text fact the record carries but holds empty is ''
 *     (tracked, empty — its own dash), not "not tracked"; and the lists are
 *     windows — a quote the quotes list did not reach (it failed, the viewer
 *     may not read quotes, or it came back full) is UNKNOWN, never a "Client
 *     Quote missing" finding, with the caps pinned against the API source so
 *     a changed LIMIT fails here before it misleads the page.
 *
 * Hermetic: reads source files and imports the pure lib (its only import from
 * the API client is a type, erased at compile time).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_COLUMNS,
  INVOICES_LIST_CAP,
  QUOTES_LIST_CAP,
  WO_LIST_CAP,
  buildCheckLines,
  computeAuditIssues,
  deriveReceivables,
  isReadyToInvoice,
  listCapped,
  quotesByTask,
  readyAmount,
  type AuditChecks,
} from '../apps/web/src/lib/receivables';
import type { QuoteListItem, WorkOrderListItemV2 } from '../apps/web/src/api/client';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function wo(over: Partial<WorkOrderListItemV2> = {}): WorkOrderListItemV2 {
  return {
    id: 'a1',
    wo_number: 'WO-1',
    ext_name: null,
    title: 'Leaking faucet',
    client: 'Walmart',
    city: 'Dallas',
    state: 'TX',
    trade: 'Plumbing',
    billing_entity: 'SFM',
    nte: 500,
    priority: 'normal',
    emergency: false,
    escalated: false,
    date_received: '2026-10-01',
    home_list: null,
    status: { id: 's-done', name: 'Done / Incurred', group: 'done', color: null },
    age_days: 4,
    ...over,
  } as WorkOrderListItemV2;
}

function quote(over: Partial<QuoteListItem> = {}): QuoteListItem {
  return {
    id: 'q1',
    task_id: 'a1',
    wo_number: 'WO-1',
    number: 'Q-SFM-2026-0001',
    title: null,
    client: 'Walmart',
    status: 'approved',
    rev: 1,
    current_round: 1,
    grand_total: 1234.5,
    updated_at: null,
    wo_due: null,
    wo_nte: 500,
    wo_cost: null,
    wo_emergency: false,
    wo_escalated: false,
    ...over,
  };
}

const noChecks: AuditChecks = { gtg: false, elise: false, admin: false, quote: false };

/** The list and page fail the whole request for a `fields.*` key the viewer
    may not see? No — the API drops it; but a key with NO field_def is a 400.
    Either way the lib only ever sees `custom`, so these fixtures are the
    payload shapes: absent key, present-but-null, present-but-blank, value. */
const sev = (issues: ReturnType<typeof computeAuditIssues>, s: string) =>
  issues.filter((i) => i.severity === s);

describe('W2-1 · the source holds no invented data', () => {
  const lib = read('../apps/web/src/lib/receivables.ts');

  it('has no hash-seeded derivation, assignee list or invented invoice numbers', () => {
    for (const banned of ['hash(', 'chance(', 'intIn(', 'ASSIGNEES', "'INV-", 'inv-paid']) {
      expect(lib, `lib/receivables.ts still contains ${banned}`).not.toContain(banned);
    }
  });

  it('asks the list for exactly the three facts it reads', () => {
    expect([...AUDIT_COLUMNS]).toEqual([
      'fields.Assignee',
      'fields.18. Check-in/out Status',
      'fields.Bill For Incurred',
    ]);
  });

  it('gates /receivables on `invoicing`, like the sidebar does', () => {
    const app = read('../apps/web/src/App.tsx');
    for (const path of ['/receivables', '/receivables/:tab']) {
      const m = app.match(new RegExp(`<Route\\s+path="${path.replace(/[/:]/g, (c) => `\\${c}`)}"\\s+element=\\{([^}]*)\\}`));
      expect(m, `route ${path} not found`).not.toBeNull();
      expect(m?.[1]).toContain('<RequireAuth>');
      expect(m?.[1]).toContain('<RequireCan perm="invoicing" nav="Receivables">');
    }
  });
});

describe('W2-1 · the lists are windows, and the lib knows how wide', () => {
  it('pins the quotes cap to GET /quotes (services/quotes.ts, no limit from the route)', () => {
    const quotes = read('../apps/api/src/services/quotes.ts');
    const m = quotes.match(/export async function listQuotes\(\s*limit = (\d+)/);
    expect(m, 'listQuotes(limit = N) not found').not.toBeNull();
    expect(Number(m?.[1])).toBe(QUOTES_LIST_CAP);
    const route = read('../apps/api/src/routes/quotes.ts');
    expect(route).toContain('listQuotes(undefined, viewer)');
  });

  it('pins the invoices cap to GET /invoices (services/invoices.ts)', () => {
    const invoices = read('../apps/api/src/services/invoices.ts');
    const body = invoices.slice(invoices.indexOf('export async function listInvoices('));
    const m = body.match(/LIMIT (\d+)/);
    expect(m, 'listInvoices LIMIT not found').not.toBeNull();
    expect(Number(m?.[1])).toBe(INVOICES_LIST_CAP);
  });

  it('asks for the Done group alone, as many as the list route allows', () => {
    const route = read('../apps/api/src/routes/workOrders.ts');
    const m = route.match(/const listQuerySchema = [\s\S]*?limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\((\d+)\)/);
    expect(m, 'listQuerySchema limit not found').not.toBeNull();
    expect(Number(m?.[1])).toBe(WO_LIST_CAP);
    const page = read('../apps/web/src/pages/ReceivablesPage.tsx');
    expect(page).toContain("status_group: 'done', limit: WO_LIST_CAP");
  });

  it('calls a list full once it reaches its cap', () => {
    expect(listCapped(199, 200)).toBe(false);
    expect(listCapped(200, 200)).toBe(true);
    expect(listCapped(0, 200)).toBe(false);
  });
});

describe('W2-1 · facts come from the payload, never from the id', () => {
  it('derives identical facts for two rows that differ only by id', () => {
    const custom = {
      'fields.Assignee': 'Mya Reyes',
      'fields.18. Check-in/out Status': 'Checked-out',
      'fields.Bill For Incurred': 'true',
    };
    const { queue } = deriveReceivables([wo({ id: 'a1', custom }), wo({ id: 'zz-9', custom })], []);
    expect(queue).toHaveLength(2);
    const [{ wo: _a, ...a }, { wo: _b, ...b }] = queue;
    expect(a).toEqual(b);
    expect(a.assignee).toBe('Mya Reyes');
    expect(a.cico).toBe('Checked-out');
    expect(a.bfi).toBe(true);
  });

  it('reads BFI as a checkbox and leaves an unprojected key unknown', () => {
    const derive = (custom?: Record<string, string | null>) =>
      deriveReceivables([wo({ custom })], []).queue[0];
    expect(derive({ 'fields.Bill For Incurred': 'true' }).bfi).toBe(true);
    expect(derive({ 'fields.Bill For Incurred': 'yes' }).bfi).toBe(true);
    expect(derive({ 'fields.Bill For Incurred': 'false' }).bfi).toBe(false);
    expect(derive({ 'fields.Bill For Incurred': '' }).bfi).toBe(false);
    // Projected and empty = the checkbox is not ticked; not projected = unknown.
    expect(derive({ 'fields.Bill For Incurred': null }).bfi).toBe(false);
    expect(derive({ 'fields.Assignee': 'x' }).bfi).toBeNull();
    expect(derive(undefined).bfi).toBeNull();
  });

  it('tells a text fact the list did not carry (null) from one it carries empty ("")', () => {
    const derive = (custom?: Record<string, string | null>) =>
      deriveReceivables([wo({ custom })], []).queue[0];
    // Not asked / redacted: the key is absent → not tracked for this viewer.
    expect(derive(undefined).assignee).toBeNull();
    expect(derive({ 'fields.Bill For Incurred': 'true' }).cico).toBeNull();
    // Carried but empty: the record is tracked and holds nothing — unassigned,
    // no visit recorded — which is a different dash from "not tracked yet".
    expect(derive({ 'fields.Assignee': null }).assignee).toBe('');
    expect(derive({ 'fields.Assignee': '  ' }).assignee).toBe('');
    expect(derive({ 'fields.18. Check-in/out Status': null }).cico).toBe('');
    expect(derive({ 'fields.18. Check-in/out Status': ' Checked-out ' }).cico).toBe('Checked-out');
  });

  it('leaves what the payload does not carry as null, and never fabricates the rest', () => {
    const row = deriveReceivables([wo({ custom: undefined })], []).queue[0];
    expect(row.bfi).toBeNull();
    expect(row.cico).toBeNull();
    expect(row.assignee).toBeNull();
    expect(row.coNumber).toBeNull();
    expect(row.daysDone).toBeNull();
    expect(row.daysGrey).toBeNull();
    expect(row.sp).toEqual({ live: false });
    expect(row.checks).toEqual(noChecks);
    // An empty quotes list is complete: no quote really means no quote.
    expect(row.hasClientQuote).toBe(false);
    expect(row.clientQuotePreview).toBeNull();
  });

  it('raises no major / minor finding over an unknown fact', () => {
    const row = deriveReceivables([wo({ custom: undefined })], [quote()]).queue[0];
    const issues = computeAuditIssues(row, noChecks);
    expect(issues.filter((i) => i.severity === 'major' || i.severity === 'minor')).toEqual([]);
    // Each unknown fact is reported once, as coverage, with nowhere to resolve
    // it (the SharePoint line keeps its inert chip, as before).
    const offline = issues.filter((i) => i.severity === 'offline');
    expect(offline.map((i) => i.title)).toEqual(
      expect.arrayContaining(['CICO not tracked yet', 'BFI not tracked yet', 'CO# not tracked yet']),
    );
    for (const i of offline.filter((i) => i.title.endsWith('not tracked yet'))) {
      expect(i.resolve).toEqual([]);
    }
    expect(issues.filter((i) => i.title.endsWith('not tracked yet'))).toHaveLength(3);
    const lines = buildCheckLines(row, noChecks);
    expect(lines.find((l) => l.label === 'CICO')).toEqual({ label: 'CICO', outcome: 'offline', detail: 'not tracked yet' });
    expect(lines.find((l) => l.label === 'CO#')).toEqual({ label: 'CO#', outcome: 'offline', detail: 'not tracked yet' });
  });

  it('still raises the real findings: a missing quote, a technician not checked out, no visit at all', () => {
    const noQuote = deriveReceivables([wo({ custom: undefined })], []).queue[0];
    expect(sev(computeAuditIssues(noQuote, noChecks), 'major').map((i) => i.id)).toEqual(['a1-client-quote']);

    const checkedIn = deriveReceivables(
      [wo({ custom: { 'fields.18. Check-in/out Status': 'Checked-in' } })],
      [quote()],
    ).queue[0];
    const minors = sev(computeAuditIssues(checkedIn, noChecks), 'minor');
    expect(minors).toHaveLength(1);
    expect(minors[0].id).toBe('a1-cico');
    expect(minors[0].title).toContain('Checked-in');
    expect(sev(computeAuditIssues(checkedIn, noChecks), 'major')).toEqual([]);

    // Carried but empty is a real fact about a Done work order: nobody has
    // checked in or out, so there is no check-out to confirm. A finding, not
    // a coverage line.
    const noVisit = deriveReceivables(
      [wo({ custom: { 'fields.18. Check-in/out Status': null } })],
      [quote()],
    ).queue[0];
    const issues = computeAuditIssues(noVisit, noChecks);
    expect(sev(issues, 'minor').map((i) => i.id)).toEqual(['a1-cico']);
    expect(sev(issues, 'minor')[0].title).toBe('CICO is empty — no visit recorded');
    expect(issues.map((i) => i.id)).not.toContain('a1-cico-offline');
    expect(buildCheckLines(noVisit, noChecks).find((l) => l.label === 'CICO')).toEqual({
      label: 'CICO',
      outcome: 'minor',
      detail: 'empty — no visit recorded',
    });
  });

  it('lists the done group only — no padding from active rows, an empty queue is the answer', () => {
    const active = { id: 's-open', name: 'Open', group: 'active', color: null };
    const items = [
      wo({ id: 'd1', age_days: 2 }),
      wo({ id: 'd2', age_days: 9 }),
      wo({ id: 'o1', status: active }),
      wo({ id: 'o2', status: active }),
      wo({ id: 'o3', status: active }),
    ];
    const { queue } = deriveReceivables(items, []);
    expect(queue.map((r) => r.wo.id)).toEqual(['d2', 'd1']);
    expect(deriveReceivables([wo({ id: 'o1', status: active })], []).queue).toEqual([]);
  });
});

describe('W2-1 · a quote the quotes list did not reach is unknown, never missing', () => {
  const otherQuotes = (n: number) =>
    Array.from({ length: n }, (_, i) => quote({ id: `q-${i}`, task_id: `other-${i}` }));

  it('reads null when the quotes list did not come back at all', () => {
    const row = deriveReceivables([wo()], null).queue[0];
    expect(row.hasClientQuote).toBeNull();
    expect(row.clientQuotePreview).toBeNull();
    const issues = computeAuditIssues(row, noChecks);
    expect(sev(issues, 'major')).toEqual([]);
    const offline = issues.filter((i) => i.id === 'a1-client-quote-offline');
    expect(offline).toHaveLength(1);
    expect(offline[0].severity).toBe('offline');
    expect(offline[0].title).toBe('Client Quote not checked');
    expect(issues.map((i) => i.id)).not.toContain('a1-client-quote');
    expect(buildCheckLines(row, noChecks).find((l) => l.label === 'Client Quote')?.outcome).toBe('offline');
  });

  it('reads null when the list came back full and holds no quote for the row', () => {
    const full = deriveReceivables([wo()], otherQuotes(QUOTES_LIST_CAP)).queue[0];
    expect(full.hasClientQuote).toBeNull();
    expect(sev(computeAuditIssues(full, noChecks), 'major')).toEqual([]);
    // One short of the cap the list is complete: no quote means no quote.
    const complete = deriveReceivables([wo()], otherQuotes(QUOTES_LIST_CAP - 1)).queue[0];
    expect(complete.hasClientQuote).toBe(false);
    expect(sev(computeAuditIssues(complete, noChecks), 'major').map((i) => i.id)).toEqual(['a1-client-quote']);
  });

  it('a quote the list does hold is a fact however full the list is', () => {
    const row = deriveReceivables([wo()], [...otherQuotes(QUOTES_LIST_CAP), quote()]).queue[0];
    expect(row.hasClientQuote).toBe(true);
    expect(row.clientQuotePreview).toBe('Q-SFM-2026-0001 · $1,234.50 · approved');
    expect(computeAuditIssues(row, noChecks).map((i) => i.id)).not.toContain('a1-client-quote-offline');
  });
});

describe('W2-1 · the Ready lane uses only real facts', () => {
  const none = new Set<string>();

  it('is Done + a quote the client can be billed on + no invoice yet', () => {
    for (const status of ['approved', 'sent', 'client_approved'] as const) {
      const byTask = quotesByTask([quote({ status })]);
      expect(isReadyToInvoice(wo(), byTask, none), status).toBe(true);
    }
  });

  it('is not ready when the quote is missing, draft, pending or declined', () => {
    expect(isReadyToInvoice(wo(), quotesByTask([]), none)).toBe(false);
    for (const status of ['draft', 'pending_approval', 'client_declined'] as const) {
      expect(isReadyToInvoice(wo(), quotesByTask([quote({ status })]), none), status).toBe(false);
    }
    // A quote on another work order does not count.
    expect(isReadyToInvoice(wo(), quotesByTask([quote({ task_id: 'other' })]), none)).toBe(false);
  });

  it('is not ready before Done, nor once an invoice exists', () => {
    const byTask = quotesByTask([quote()]);
    const active = { id: 's-open', name: 'Open', group: 'active', color: null };
    expect(isReadyToInvoice(wo({ status: active }), byTask, none)).toBe(false);
    expect(isReadyToInvoice(wo(), byTask, new Set(['a1']))).toBe(false);
  });

  it('shows the quote total, or nothing — never a made-up amount', () => {
    expect(readyAmount(quote({ grand_total: 1234.5 }))).toBe(1234.5);
    expect(readyAmount(quote({ grand_total: null }))).toBeNull();
    expect(readyAmount(undefined)).toBeNull();
  });
});
