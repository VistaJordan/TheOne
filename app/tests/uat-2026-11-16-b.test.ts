/* UAT list of 2026-11-16, second batch (Elise): payment bands, rejected
 * payments, quote line types and rates, the tax bar, the kept quote, new
 * clients and their price cards, the work order's clock, probation's Dates.
 * Pure functions and source pins — no database. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TIER_SUPER_ADMIN_ONLY,
  tierAllows,
  tierFor,
  tierRolesText,
  type ApprovalTier,
} from '../packages/shared/src/approvalTiers';
import { cardRatesLockedFor, quoteCardRate } from '../packages/shared/src/quoteDefaults';
import { NOTICE_KINDS_ALWAYS_SHOWN, NOTICE_TYPES, PAYMENT_REJECTED_NOTICE_KIND } from '../packages/shared/src/notices';
import { CREATE_FILLABLE_FIELD_KEYS } from '../packages/shared/src/workflow';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n');

describe('#8 / #36 — one payment ladder', () => {
  const sql = read('packages/db/migrations/0149_payment_bands_50k.sql');
  const band = (id: string, min: number, max: number | null, roles: string[], position: number): ApprovalTier =>
    ({ id, kind: 'payment', label: id, min_amount: min, max_amount: max, roles, position });
  const LADDER = [
    band('u500', 0, 500, [], 0),
    band('3k', 500, 3000, ['atl', 'tl', 'am'], 1),
    band('5k', 3000, 5000, ['tl', 'am'], 2),
    band('50k', 5000, 50000, ['am'], 3),
    band('top', 50000, null, [TIER_SUPER_ADMIN_ONLY], 4),
  ];
  const may = (role: string, amount: number, sa = false) => tierAllows(tierFor(LADDER, 'payment', amount), role, sa);

  it('the migration writes the five bands', () => {
    expect(sql).toContain("('payment', '$500 to $3,000',      500,   3000,  '{atl,tl,am}',   1)");
    expect(sql).toContain("('payment', '$3,000 to $5,000',    3000,  5000,  '{tl,am}',       2)");
    expect(sql).toContain("('payment', '$5,000 to $50,000',   5000,  50000, '{am}',          3)");
    expect(sql).toContain("('payment', '$50,000 and over',    50000, NULL,  '{super_admin}', 4)");
    expect(sql).toContain("DELETE FROM approval_tier WHERE kind = 'payment';");
    expect(sql).not.toContain("('purchase_request',");
  });

  it('each level approves everything under its ceiling — an AM may approve $2,000', () => {
    expect(may('atl', 2999)).toBe(true);
    expect(may('atl', 3000)).toBe(false);
    expect(may('tl', 4999)).toBe(true);
    expect(may('tl', 5000)).toBe(false);
    expect(may('am', 2000)).toBe(true);
    expect(may('am', 49999)).toBe(true);
    expect(may('am', 50000)).toBe(false);
    expect(may('om', 100)).toBe(true); // under $500 needs no approval at all
  });

  it('above $50,000 only a super admin decides', () => {
    expect(may('admin', 60000)).toBe(false);
    expect(may('am', 60000, true)).toBe(true);
    expect(tierRolesText([TIER_SUPER_ADMIN_ONLY])).toBe('a super admin');
    expect(tierRolesText(['atl', 'tl', 'am'])).toBe('ATL, TL or AM');
  });
});

describe('#49 — a rejected payment says rejected and tells the requester', () => {
  const approvals = read('apps/api/src/services/approvals.ts');
  const payments = read('apps/api/src/services/payments.ts');
  it('rejecting the hold a payment waits behind rejects the payment', () => {
    expect(approvals).toMatch(/function linkedHoldPayment[\s\S]*'nte_override' && task\.type !== 'over_quote'/);
    expect(approvals).toMatch(/rejectPaymentRequest\(paymentId, note, actor, \{ fromHold: true \}\)/);
  });
  it('the requester gets a notice that always shows', () => {
    expect(payments).toMatch(/kind: 'payment_rejected'/);
    expect(payments).toMatch(/dedupeKey: `payment_rejected:\$\{id\}`/);
    expect(NOTICE_TYPES[PAYMENT_REJECTED_NOTICE_KIND]).toBeDefined();
    expect(NOTICE_KINDS_ALWAYS_SHOWN).toContain(PAYMENT_REJECTED_NOTICE_KIND);
  });
});

describe('#17 / #22 — line types', () => {
  it('the builder offers Labor, Material, Trip, Fee, Discount', () => {
    const draft = read('apps/web/src/lib/quoteDraft.ts');
    const list = draft.slice(draft.indexOf('export const LINE_TYPES'), draft.indexOf('];', draft.indexOf('export const LINE_TYPES')));
    expect(list).toContain("'trip'");
    expect(list).not.toContain("'service'");
    expect(list).not.toContain("'part'");
  });
  it('0150 allows trip and moves the lines on file; new quotes open with a Trip line', () => {
    const sql = read('packages/db/migrations/0150_quote_line_trip.sql');
    expect(sql).toContain("'trip'");
    expect(sql).toContain("UPDATE quote_line SET line_type = 'material' WHERE line_type = 'part'");
    expect(read('apps/api/src/services/quotes.ts')).toContain("VALUES ($1, 'trip', $2, 1, $3");
  });
});

describe('#23 — the price list sets labor and trip rates for dispatchers', () => {
  const card = { tech_rate: 95, helper_rate: 60, trip_rate: 85, afterhours_rate: 140, holiday_rate: null };
  it('the card figure per line', () => {
    expect(quoteCardRate({ line_type: 'labor', description: 'Labor tech 1' }, card)).toBe(95);
    expect(quoteCardRate({ line_type: 'labor', description: 'Helper' }, card)).toBe(60);
    expect(quoteCardRate({ line_type: 'labor', description: 'Holiday tech' }, card)).toBe(95);
    expect(quoteCardRate({ line_type: 'trip', description: 'Second visit' }, card)).toBe(85);
    expect(quoteCardRate({ line_type: 'material', description: 'Motor' }, card)).toBeNull();
  });
  it('locked for the three dispatcher tiers only; the save refuses a changed rate', () => {
    for (const r of ['om_probation', 'om', 'senior_om']) expect(cardRatesLockedFor(r, false)).toBe(true);
    for (const r of ['tl', 'atl', 'am', 'admin']) expect(cardRatesLockedFor(r, false)).toBe(false);
    expect(cardRatesLockedFor('om', true)).toBe(false);
    const quotes = read('apps/api/src/services/quotes.ts');
    expect(quotes).toMatch(/if \(input\.sections\) await assertCardRatesKept\(taskId, cur\.id, input\.sections, actor\);/);
    expect(quotes).toContain('code: QUOTE_RATE_LOCKED_CODE');
  });
});

describe('#27 — the tax bar', () => {
  it('sits at the top of the builder and each section shows its tax in dollars', () => {
    const page = read('apps/web/src/pages/QuoteBuilderPage.tsx');
    expect(page.indexOf('<QuoteTaxBar')).toBeLessThan(page.indexOf('{/* ── INCURRED ── */}'));
    expect(page).toContain('sectionTax(incurredTotals.total, taxPct)');
    expect(read('apps/web/src/components/quote/OptionCard.tsx')).toContain('sectionTax(totals.total, salesTaxPct)');
    expect(read('apps/web/src/components/quote/MoneyRail.tsx')).not.toContain('id="sales-tax"');
  });
});

describe('#10 — a quote leaving draft is kept whole on its activity row', () => {
  it('transition() snapshots the quote', () => {
    const quotes = read('apps/api/src/services/quotes.ts');
    expect(quotes).toContain("const keep = to !== 'draft';");
    expect(quotes).toContain('...(keep ? { quote: await snapshotQuote(tx, cur.id) } : {}),');
  });
});

describe('#12 / #13 / #14 — clients and price cards', () => {
  it('a new client needs every field but notes', () => {
    const svc = read('apps/api/src/services/portfolioExtras.ts');
    for (const k of ['code', 'contact_name', 'contact_phone', 'contact_email', 'billing_email', 'billing_entity', 'portal_type', 'payment_terms', 'address']) {
      expect(svc).toContain(`['${k}', `);
    }
    expect(read('apps/web/src/pages/ClientsPage.tsx')).toContain("void qc.invalidateQueries({ queryKey: ['prices'] });");
  });
  it('trades are picked from the field options and the trades on file', () => {
    expect(read('apps/api/src/services/prices.ts')).toMatch(/async function tradeChoices[\s\S]*FROM price_rate/);
    expect(read('apps/web/src/pages/PricesPage.tsx')).not.toContain('placeholder="Name, e.g. Plumber - Electrician"');
  });
});

describe('#16 — the clock starts when the work order was received', () => {
  it('no more midnight-UTC start', () => {
    const rec = read('apps/api/src/services/woRecord.ts');
    expect(rec).not.toContain('T00:00:00Z');
    expect(rec).toContain('const start = receivedStart(t, now).toISOString();');
    expect(read('apps/web/src/components/wo/record/RecordParts.tsx')).toContain('live(t.received_at ?? t.created_at)');
  });
});

describe('#20 — OM Under Probation is view-only on the Dates', () => {
  it('0151 locks the section and Add work order still takes its dates', () => {
    const sql = read('packages/db/migrations/0151_probation_dates_view_only.sql');
    expect(sql).toContain("'work_orders/fields/dates'");
    expect(sql).toContain('"edit": false');
    for (const k of ['fields.Date-Time Received', 'fields.Due Date', 'fields.SLA Due Date']) {
      expect(CREATE_FILLABLE_FIELD_KEYS as readonly string[]).toContain(k);
    }
  });
});
