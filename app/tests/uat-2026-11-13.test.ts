/**
 * Elise's list of 2026-11-13 (migration 0134): Notifications opens on Unread
 * with no Read view and no Mark all buttons; the sub category follows the
 * trade on Add work order; Due Date is required there; Senior OM reads the
 * client conversation without writing to it; Zelle / Cash App always ask a
 * TL, ATL or AM; a manager's quote rejection sends the work order back to
 * Waiting for Quote; a ticked penalty needs its explanation; AF, TPM and EDS
 * are closed.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MANAGER_APPROVAL_METHODS,
  SIGNOFF_LAYOUTS,
  WO_CREATE_REQUIRED_KEYS,
  mayApproveManagerMethod,
  needsManagerForMethod,
  paymentApprovalVerdict,
  penaltyDescriptionProblem,
  quoteEventStatusName,
  signoffLayoutFor,
} from '@theone/shared';

const root = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');
const mig = read('packages', 'db', 'migrations', '0134_entities_due_date_senior_om.sql');

describe('Notifications: Unread first, no Read view, no Mark all', () => {
  const page = read('apps', 'web', 'src', 'pages', 'NotificationsPage.tsx');
  it('offers Unread and All only, Unread by default', () => {
    expect(page).toContain("{ id: 'unread', label: 'Unread' },\n  { id: 'all', label: 'All' },");
    expect(page).not.toContain("label: 'Read' }");
    expect(page).toContain("?.id ?? 'unread') as NoticeReadFilter");
  });
  it('has no Mark all read / unread buttons', () => {
    expect(page).not.toContain('/> Mark all read');
    expect(page).not.toContain('/> Mark all unread');
    expect(page).not.toContain('markAll(');
  });
});

describe('Add work order', () => {
  it('drops a sub category the new trade does not offer', () => {
    const dlg = read('apps', 'web', 'src', 'components', 'wo', 'list', 'CreateWorkOrderDialog.tsx');
    expect(dlg).toContain('key === WO_TRADE_KEY &&');
    expect(dlg).toContain('[WO_SUBCATEGORY_KEY]: \'\'');
  });
  it('requires the Due Date (shared list and migration)', () => {
    expect(WO_CREATE_REQUIRED_KEYS).toContain('Due Date');
    expect(mig).toContain("UPDATE field_def SET create_mode = 'required' WHERE key = 'Due Date';");
  });
});

describe('Senior OM reads but does not message the client', () => {
  it('0134 turns off work_orders/comments/client create for senior_om', () => {
    expect(mig).toMatch(/'work_orders\/comments\/client'[\s\S]*"create": false[\s\S]*WHERE code = 'senior_om'/);
  });
});

describe('Zelle and Cash App always ask a manager', () => {
  it('are never approved as they are raised', () => {
    expect(MANAGER_APPROVAL_METHODS).toEqual(['zelle', 'cashapp']);
    expect(paymentApprovalVerdict('om', 50, 'zelle').needed).toBe(true);
    expect(paymentApprovalVerdict('om', 50, 'cashapp').needed).toBe(true);
    expect(paymentApprovalVerdict('om', 50, 'ach').needed).toBe(false);
    expect(paymentApprovalVerdict('om', 50).needed).toBe(false);
    expect(needsManagerForMethod('Zelle')).toBe(true);
  });
  it('are approved by a TL, ATL, AM or a super admin only', () => {
    for (const r of ['tl', 'atl', 'am']) expect(mayApproveManagerMethod(r, false)).toBe(true);
    for (const r of ['admin', 'ap', 'om', 'senior_om']) expect(mayApproveManagerMethod(r, false)).toBe(false);
    expect(mayApproveManagerMethod('ap', true)).toBe(true);
  });
  it('is asked at approve, decline, and when a processor switches the method', () => {
    const src = read('apps', 'api', 'src', 'services', 'payments.ts');
    expect(src).toContain("assertManagerForMethod(row, actor, 'Approving a payment');");
    expect(src).toContain("assertManagerForMethod(row, actor, 'Declining a payment');");
    expect(src).toContain("status = 'requested', approved_by = NULL, approved_at = NULL, auto_approved = false");
    expect(src).toContain('paymentTierSummary(opts.tiers, Number(r.amount ?? 0), r.method, opts.viewer)');
  });
});

describe("A manager's quote rejection sends the work order back to Waiting for Quote", () => {
  it('moves from Quote Ready and the approval statuses only', () => {
    expect(quoteEventStatusName('manager_rejected', 'Quote Ready')).toBe('Waiting for Quote');
    expect(quoteEventStatusName('manager_rejected', 'Waiting for Approval')).toBe('Waiting for Quote');
    expect(quoteEventStatusName('manager_rejected', 'Waiting for Quote')).toBeNull();
    expect(quoteEventStatusName('manager_rejected', 'On Site (Job)')).toBeNull();
    expect(quoteEventStatusName('manager_rejected', 'Approved')).toBeNull();
  });
  it('rejectQuote follows the event', () => {
    expect(read('apps', 'api', 'src', 'services', 'quotes.ts')).toContain("return withStatusMove(taskId, quote, 'manager_rejected', actor);");
  });
});

describe('A ticked penalty needs its explanation', () => {
  it('refuses a tick with no description, only when the save touches the penalties', () => {
    expect(penaltyDescriptionProblem({ Penalty: true }, ['Penalty'])).not.toBeNull();
    expect(penaltyDescriptionProblem({ Recall: 'true', 'Penalty Description': '  ' }, ['fields.Recall'])).not.toBeNull();
    expect(penaltyDescriptionProblem({ '12. Bad quote': true, 'Penalty Description': 'Wrong parts' }, ['12. Bad quote'])).toBeNull();
    expect(penaltyDescriptionProblem({ 'Missed ETA': true }, ['Address'])).toBeNull();
    expect(penaltyDescriptionProblem({ 'Late Quote': true, 'Penalty Description': '' }, ['Penalty Description'])).not.toBeNull();
    expect(penaltyDescriptionProblem({ Penalty: false }, ['Penalty'])).toBeNull();
  });
  it('is asked by the field editor, bulk edit and the create paths', () => {
    expect(read('apps', 'api', 'src', 'services', 'woFieldValues.ts').match(/assertPenaltyDescription\(/g)?.length).toBe(2);
    expect(read('apps', 'api', 'src', 'services', 'woBulk.ts')).toContain('assertPenaltyDescription(merged');
  });
});

describe('AF, TPM and EDS are closed', () => {
  it('leave the Comp list in the seed and the migration', () => {
    // 0137 (2026-11-14) closed RF too.
    expect(read('packages', 'db', 'src', 'seed.ts')).toContain("options: ['SFM', 'BKR'] }");
    expect(mig).toContain("DELETE FROM client_team        WHERE upper(btrim(billing_entity)) IN ('AF', 'TPM', 'EDS');");
    expect(mig).toContain("DELETE FROM client_cico_method WHERE upper(btrim(billing_entity)) IN ('AF', 'TPM', 'EDS');");
    expect(mig).toContain("DELETE FROM price_card         WHERE upper(btrim(billing_entity)) IN ('AF', 'TPM', 'EDS');");
    expect(mig).toContain("WHERE f.key = '21. Comp';");
  });
  it('have no sign-off sheet', () => {
    expect(SIGNOFF_LAYOUTS).toEqual(['sfm', 'bkr', 'bkr_emcor']);
    for (const c of ['AF', 'TPM', 'EDS']) expect(signoffLayoutFor(c, null)).toBeNull();
  });
});
