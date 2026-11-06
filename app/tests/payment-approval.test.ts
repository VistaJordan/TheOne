/* 0090 (Elise, 2026-10-22) — who has to say yes.
 *
 * Two pure rules and the source pins that keep them wired:
 *   - paymentApprovalVerdict: under $500 is approved as it is raised, for
 *     every requester since 0115; $500 and over waits.
 *   - statusMoveNeedsNoApproval: Quote Ready is internal, so a request-mode
 *     person moves to it directly instead of raising a status request.
 *   - Approve on a payment asks the 6.2.3 amount band again (0076 had
 *     stopped), and the Approvals inbox approves a payment with no confirm
 *     dialog.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_AUTO_APPROVE_UNDER,
  paymentApprovalVerdict,
} from '../packages/shared/src/paymentApproval';
import { NO_APPROVAL_STATUS_NAMES, statusMoveNeedsNoApproval } from '../packages/shared/src/workflow';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('paymentApprovalVerdict — who has to ask (0115: the amount alone)', () => {
  it.each(['om_probation', 'om', 'senior_om', 'tl', 'atl', 'am', 'admin', 'oa', 'ar', 'ap', null, undefined])(
    '%s: under $500 is approved as requested, $500 and over waits',
    (role) => {
      expect(paymentApprovalVerdict(role, 0).needed).toBe(false);
      expect(paymentApprovalVerdict(role, PAYMENT_AUTO_APPROVE_UNDER - 0.01).needed).toBe(false);
      expect(paymentApprovalVerdict(role, PAYMENT_AUTO_APPROVE_UNDER).needed).toBe(true);
      expect(paymentApprovalVerdict(role, 3_500).needed).toBe(true);
    },
  );

  it('never auto-approves a nonsense amount', () => {
    expect(paymentApprovalVerdict('om', Number.NaN).needed).toBe(true);
    expect(paymentApprovalVerdict('om', Number.POSITIVE_INFINITY).needed).toBe(true);
    expect(paymentApprovalVerdict('om', -1).needed).toBe(true);
  });

  it('the threshold is the bottom of the second band', () => {
    expect(PAYMENT_AUTO_APPROVE_UNDER).toBe(500);
  });
});

describe('statusMoveNeedsNoApproval — Quote Ready is internal', () => {
  it('matches Quote Ready by name, case folded, and nothing else', () => {
    expect(NO_APPROVAL_STATUS_NAMES).toEqual(['Quote Ready']);
    expect(statusMoveNeedsNoApproval('Quote Ready')).toBe(true);
    expect(statusMoveNeedsNoApproval(' quote ready ')).toBe(true);
    expect(statusMoveNeedsNoApproval('Waiting for Quote')).toBe(false);
    expect(statusMoveNeedsNoApproval('Done / Incurred')).toBe(false);
    expect(statusMoveNeedsNoApproval(null)).toBe(false);
    expect(statusMoveNeedsNoApproval(undefined)).toBe(false);
  });
});

describe('the wiring (source pins)', () => {
  it('the status route lets a create-only actor through for a no-approval status only', () => {
    const src = read('apps/api/src/routes/workOrders.ts');
    const route = src.slice(src.indexOf("app.patch('/work-orders/:id/status'"));
    const body = route.slice(0, route.indexOf('app.post('));
    expect(body).toContain('statusMoveNeedsNoApproval(');
    expect(body).toContain("permAllows(p.perms, STATUS_PERM_KEY, 'create'");
    expect(body).toContain("requirePerm(p, STATUS_PERM_KEY, 'edit'");
    expect(body).toContain('changeStatus(');
  });

  it('the status menu skips the request for a no-approval status', () => {
    const src = read('apps/web/src/components/StatusChangeMenu.tsx');
    // 2026-11-04: one test for every direct move (Quote Ready, OA's Approved).
    expect(src).toContain('if (!movesDirectly(s.name))');
    expect(src).toContain("mode === 'direct' || statusMoveNeedsNoApproval(name)");
  });

  it('createPaymentRequest asks the verdict and stores the outcome', () => {
    const src = read('apps/api/src/services/payments.ts');
    const fn = src.slice(src.indexOf('export async function createPaymentRequest('));
    const body = fn.slice(0, fn.indexOf('export interface PaymentEditInput'));
    expect(body).toContain('paymentApprovalVerdict(actor.role, input.amount)');
    // 2026-10-28: an overage (past the NTE or the quote) is never auto-approved.
    expect(body).toContain('const autoApproved = !approval.needed && !overage;');
    expect(body).toContain("autoApproved ? 'approved' : 'requested'");
    expect(body).toContain('auto_approved, approved_at');
    expect(body).toContain('auto_approved: true');
  });

  it('approving a payment asks the amount band before anything is written', () => {
    const src = read('apps/api/src/services/payments.ts');
    const fn = src.slice(src.indexOf('export async function approvePaymentRequest('));
    const body = fn.slice(0, fn.indexOf('export async function payPaymentRequest('));
    expect(body).toContain("assertTierAllows('payment'");
    expect(body.indexOf("assertTierAllows('payment'")).toBeLessThan(body.indexOf('setStatus('));
  });

  it('migration 0090 re-states the payment bands and adds auto_approved', () => {
    const sql = read('packages/db/migrations/0090_payment_approval_bands.sql');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS auto_approved boolean NOT NULL DEFAULT false');
    expect(sql).toContain("DELETE FROM approval_tier WHERE kind = 'payment'");
    expect(sql).toContain("('payment', '$500 to $3,000',   500,  3000, '{tl,atl,admin}'");
    expect(sql).toContain("('payment', '$3,000 and over',  3000, NULL, '{am,admin}'");
    // Only the payment bands are rewritten: no vendor-bill or invoice row.
    expect(sql).not.toMatch(/\('vendor_bill'|\('invoice'|UPDATE approval_tier/);
  });

  it('the Approvals inbox approves a payment with no confirm dialog (within the NTE)', () => {
    const src = read('apps/web/src/pages/ApprovalsPage.tsx');
    expect(src).not.toContain('Approve this payment?');
    // 2026-11-03: above the NTE the AM is asked the reason instead.
    expect(src).toContain("(kind === 'approve' && r.data.kind === 'payment' && !r.data.item.above_nte)");
  });

  it('the quote builder has no Markup column and Labor fills the description', () => {
    const table = read('apps/web/src/components/quote/LineItemsTable.tsx');
    expect(table).not.toContain('Markup %');
    expect(table).not.toContain('markup_pct');
    expect(table).toContain('nextLaborDescription(lines, i)');
    const draft = read('apps/web/src/lib/quoteDraft.ts');
    expect(draft).toContain('markup_pct: 0,');
    expect(draft).toContain('foldMarkup(line.rate, line.markup_pct)');
  });
});

describe('nextLaborDescription — "Labor tech N"', async () => {
  const { blankLine, nextLaborDescription } = await import('../apps/web/src/lib/quoteDraft');
  it('numbers by the section\'s other labor lines, so the first reads "Labor tech 1"', () => {
    const a = { ...blankLine(), line_type: 'labor' as const, description: 'Labor tech 1' };
    const b = { ...blankLine(), line_type: 'part' as const };
    const c = blankLine();
    expect(nextLaborDescription([c], 0)).toBe('Labor tech 1');
    expect(nextLaborDescription([a, b, c], 2)).toBe('Labor tech 2');
    // The line being switched is not counted twice.
    expect(nextLaborDescription([a, { ...c, line_type: 'labor' as const }], 1)).toBe('Labor tech 2');
  });

  it('counts per day: each day of a multi-day job starts again at "Labor tech 1"', async () => {
    const { isAutoLaborDescription } = await import('../apps/web/src/lib/quoteDraft');
    const d1 = { ...blankLine(), line_type: 'labor' as const, description: 'Labor tech 1', day_value: '1' };
    const d1b = { ...blankLine(), line_type: 'labor' as const, description: 'Labor tech 2', day_value: '1' };
    const d2 = { ...blankLine(), line_type: 'labor' as const, description: '', day_value: '2' };
    // A labor line on Day 2 with two on Day 1 is the first of its day.
    expect(nextLaborDescription([d1, d1b, d2], 2)).toBe('Labor tech 1');
    // A second labor line on Day 2.
    const d2b = { ...d2, description: 'Labor tech 1' };
    expect(nextLaborDescription([d1, d2b, { ...d2 }], 2)).toBe('Labor tech 2');
    // Moving Day 1's second line to Day 2 (explicit day) counts Day 2's lines.
    expect(nextLaborDescription([d1, d1b, d2b], 1, '2')).toBe('Labor tech 2');
    expect(nextLaborDescription([d1, d1b], 1, '3')).toBe('Labor tech 1');
    expect(isAutoLaborDescription('Labor tech 3')).toBe(true);
    expect(isAutoLaborDescription('')).toBe(true);
    expect(isAutoLaborDescription('Electrician helper')).toBe(false);
  });

  it('renumberLaborLines re-counts auto names per day and leaves typed ones', async () => {
    const { renumberLaborLines } = await import('../apps/web/src/lib/quoteDraft');
    const L = (description: string, day_value: string) =>
      ({ ...blankLine(), line_type: 'labor' as const, description, day_value });
    const trip = { ...blankLine(), line_type: 'service' as const, description: 'Trip' };
    // The screenshot: Labor tech 1 on Day 1, Labor tech 2 on Day 2.
    const out = renumberLaborLines([trip, L('Labor tech 1', '1'), L('Labor tech 2', '2')]);
    expect(out.map((l) => l.description)).toEqual(['Trip', 'Labor tech 1', 'Labor tech 1']);
    const mixed = renumberLaborLines([L('Electrician', '1'), L('Labor tech 5', '1'), L('', '1')]);
    expect(mixed.map((l) => l.description)).toEqual(['Electrician', 'Labor tech 2', '']);
    const same = [L('Labor tech 1', '1')];
    expect(renumberLaborLines(same)).toBe(same);
  });
});
