/* 0090 (Elise, 2026-10-22) — who has to say yes.
 *
 * Two pure rules and the source pins that keep them wired:
 *   - paymentApprovalVerdict: an OM Under Probation's payment request always
 *     waits; an OM / Senior OM's under $500 is approved as it is raised;
 *     everyone else's waits (unchanged).
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

describe('paymentApprovalVerdict — who has to ask', () => {
  it('an OM Under Probation always waits, whatever the amount', () => {
    expect(paymentApprovalVerdict('om_probation', 1).needed).toBe(true);
    expect(paymentApprovalVerdict('om_probation', 499.99).needed).toBe(true);
    expect(paymentApprovalVerdict('om_probation', 10_000).needed).toBe(true);
  });

  it.each(['om', 'senior_om'])('%s: under $500 is approved as requested, $500 and over waits', (role) => {
    expect(paymentApprovalVerdict(role, 0).needed).toBe(false);
    expect(paymentApprovalVerdict(role, PAYMENT_AUTO_APPROVE_UNDER - 0.01).needed).toBe(false);
    expect(paymentApprovalVerdict(role, PAYMENT_AUTO_APPROVE_UNDER).needed).toBe(true);
    expect(paymentApprovalVerdict(role, 3_500).needed).toBe(true);
  });

  it('everyone else still waits, including a request with no role', () => {
    for (const role of ['tl', 'atl', 'am', 'admin', 'oa', 'ar', 'ap', null, undefined]) {
      expect(paymentApprovalVerdict(role, 10).needed).toBe(true);
    }
  });

  it('never auto-approves a nonsense amount', () => {
    expect(paymentApprovalVerdict('om', Number.NaN).needed).toBe(true);
    expect(paymentApprovalVerdict('om', Number.POSITIVE_INFINITY).needed).toBe(true);
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
    expect(src).toContain("if (mode === 'request' && !statusMoveNeedsNoApproval(s.name))");
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

  it('the Approvals inbox approves a payment with no confirm dialog', () => {
    const src = read('apps/web/src/pages/ApprovalsPage.tsx');
    expect(src).not.toContain('Approve this payment?');
    expect(src).toContain("(kind === 'approve' && r.data.kind === 'payment')");
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
});
