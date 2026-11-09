/* Elise, 2026-11-09 — the UAT list: declining follows the approval bands, OP
 * Admin and dispatcher field locks (0127), ETAs and Needed by not in the past,
 * On Site requests need a check-in, materials orders follow the bands, and the
 * quote summary prints each section's own scope list. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_SECTIONS,
  approvalSectionPermKey,
  CREATE_FILLABLE_FIELD_KEYS,
  DISPATCHER_LOCKED_FIELD_SECTIONS_0127,
  FIELD_SECTIONS,
  OP_ADMIN_LOCKED_FIELD_PATHS,
  OP_ADMIN_LOCKED_FIELD_SECTIONS,
  QUOTE_SCOPE_FIRST_LINE,
  QUOTE_SCOPE_LAST_LINE,
  describeCheckInRequired,
  etaInPast,
  fieldPermKey,
  incurredScopeToPrint,
  neededByInPast,
  onSiteRequestLacksCheckIn,
  poIssueNeedsBand,
} from '../packages/shared/src/index';
import { buildAutoSummary } from '../apps/api/src/services/quotes';
import { migrationFileProblems } from '../packages/db/src/migrateLedger';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const MIGRATION = read('packages/db/migrations/0127_uat_locks_op_admin_dispatchers.sql');

describe('declining follows the approval rules', () => {
  const svc = read('apps/api/src/services/payments.ts');
  const fn = svc.slice(svc.indexOf('export async function rejectPaymentRequest'), svc.indexOf('Yoda ConvertToAch'));
  it('a payment decline asks the band, or above the NTE the Account Manager', () => {
    expect(fn).toContain("assertTierAllows('payment', facts.amount, actor, 'Declining a payment')");
    expect(fn).toContain('mayApproveOverNtePayment(actor.role, actor.isSuperAdmin)');
  });
  it('a purchase request decline asks the band', () => {
    expect(read('apps/api/src/services/purchasing.ts')).toContain("assertTierAllows('purchase_request', cur.estimate, actor, 'Rejecting a purchase request')");
  });
  it('the buttons lock before the click', () => {
    expect(read('apps/web/src/components/payments/PaymentActions.tsx')).toContain("locked: approveLock ?? (aboveNte ? nteApproverLock : tierLock)");
  });
});

describe('0127 field locks', () => {
  it('names real sections and only changes edit', () => {
    const slugs = FIELD_SECTIONS.map((s) => s.slug);
    for (const s of [...OP_ADMIN_LOCKED_FIELD_SECTIONS, ...DISPATCHER_LOCKED_FIELD_SECTIONS_0127]) expect(slugs, s).toContain(s);
    expect(MIGRATION).toContain(`ARRAY[${OP_ADMIN_LOCKED_FIELD_SECTIONS.map((s) => `'${s}'`).join(', ')}]`);
    expect(MIGRATION).toContain(`ARRAY[${DISPATCHER_LOCKED_FIELD_SECTIONS_0127.map((s) => `'${s}'`).join(', ')}]`);
    expect(migrationFileProblems('0127_uat_locks_op_admin_dispatchers.sql', MIGRATION)).toEqual([]);
  });
  it('Not fully paid is the path the field editor checks', () => {
    expect([...OP_ADMIN_LOCKED_FIELD_PATHS]).toEqual([fieldPermKey('fields.1. Not Fully Paid')]);
    expect(MIGRATION).toContain(OP_ADMIN_LOCKED_FIELD_PATHS[0]);
  });
  it('OP Admin stops raising payments; the dispatchers keep Payments and Not fully paid', () => {
    expect(MIGRATION).toContain('"create": false, "edit": false, "delete": false, "approve": false');
    expect(DISPATCHER_LOCKED_FIELD_SECTIONS_0127).not.toContain('payments');
  });
  it('the Add work order form can still fill Client Portal Type', () => {
    expect(CREATE_FILLABLE_FIELD_KEYS).toContain('fields.Client Portal Type');
  });
});

describe('dates', () => {
  const now = Date.UTC(2026, 10, 9, 15, 30, 40);
  it('an ETA in the current minute counts as now', () => {
    expect(etaInPast(Date.UTC(2026, 10, 9, 15, 30, 0), now)).toBe(false);
    expect(etaInPast(Date.UTC(2026, 10, 9, 15, 29, 59), now)).toBe(true);
    expect(etaInPast(Date.UTC(2026, 10, 10, 8, 0, 0), now)).toBe(false);
  });
  it('Needed by may be today, not yesterday, and may be empty', () => {
    expect(neededByInPast('2026-11-09', '2026-11-09')).toBe(false);
    expect(neededByInPast('2026-11-08', '2026-11-09')).toBe(true);
    expect(neededByInPast('', '2026-11-09')).toBe(false);
    expect(neededByInPast(null, '2026-11-09')).toBe(false);
  });
});

describe('an On Site request needs a check-in', () => {
  it('matches the visit type', () => {
    expect(onSiteRequestLacksCheckIn('On Site (Job)', [])).toBe(true);
    expect(onSiteRequestLacksCheckIn('On Site (Job)', ['Assessment'])).toBe(true);
    expect(onSiteRequestLacksCheckIn('On Site (Job)', ['Job'])).toBe(false);
    expect(onSiteRequestLacksCheckIn('On Site (Job)', ['Return trip'])).toBe(false);
    expect(onSiteRequestLacksCheckIn('On Site (Assessment)', ['Job'])).toBe(true);
    expect(onSiteRequestLacksCheckIn('On Site (Assessment)', ['Assessment'])).toBe(false);
  });
  it('leaves every other status alone and says which visit', () => {
    expect(onSiteRequestLacksCheckIn('Job Sched', [])).toBe(false);
    expect(describeCheckInRequired('On Site (Assessment)')).toContain('an Assessment visit');
    expect(describeCheckInRequired('On Site (Job)')).toContain('a Job or Return trip visit');
  });
  it('is asked at request and at approval, never on a direct move', () => {
    const svc = read('apps/api/src/services/approvals.ts');
    expect(svc.match(/assertRequestHasCheckIn\(\{ query \}/g)).toHaveLength(2);
    expect(read('apps/api/src/services/workOrders.ts')).not.toContain('assertRequestHasCheckIn');
  });
});

describe('a materials order follows the bands at Issue', () => {
  it('no request, or a request smaller than the order: asked', () => {
    expect(poIssueNeedsBand({ subtotal: 2000, approved_estimate: null, limit_approved: false })).toBe(true);
    expect(poIssueNeedsBand({ subtotal: 4000, approved_estimate: 400, limit_approved: false })).toBe(true);
  });
  it('covered by the approved request or Approve over limit: not asked', () => {
    expect(poIssueNeedsBand({ subtotal: 400, approved_estimate: 400, limit_approved: false })).toBe(false);
    expect(poIssueNeedsBand({ subtotal: 6000, approved_estimate: null, limit_approved: true })).toBe(false);
  });
  it('Issue and Approve over limit both ask the band', () => {
    const svc = read('apps/api/src/services/purchasing.ts');
    expect(svc).toContain("assertTierAllows('purchase_request', total, actor, 'Issuing a purchase order')");
    expect(svc).toContain("assertTierAllows('purchase_request', cur.total, actor, 'Approving a purchase order')");
  });
});

describe('a purchase request waits in Approvals like a payment', () => {
  const page = read('apps/web/src/pages/ApprovalsPage.tsx');
  it('is a section of its own, with its own permission path', () => {
    expect(APPROVAL_SECTIONS.find((s) => s.key === 'purchases')).toEqual({ key: 'purchases', label: 'Purchases', decides: false });
    expect(approvalSectionPermKey('purchases')).toBe('approvals/purchases');
  });
  it('lists what was submitted, for the people who decide it', () => {
    expect(page).toContain("listPurchaseRequests({ status: 'submitted' })");
    expect(page).toContain("canSeePurchases = canApprovePurchases && canSeeSection('purchases')");
  });
  it('decides through the Purchasing route, so the bands and maker ≠ checker hold', () => {
    expect(page).toContain("actOnPurchaseRequest(d.item.id, kind === 'approve' ? 'approve' : 'reject', text)");
  });
  it('counts in the sidebar badge, each statement using its bound parameters', () => {
    const svc = read('apps/api/src/services/approvals.ts');
    expect(svc).toContain("allow(PURCHASING_PERM.requests, 'approve') && allow(approvalSectionPermKey('purchases'), 'view')");
    expect(svc).toContain('`AND (r.task_id IS NULL OR ${moneyScope})`');
  });
  it('raising one is not limited by its amount', () => {
    const svc = read('apps/api/src/services/purchasing.ts');
    const save = svc.slice(svc.indexOf('export async function saveRequest'), svc.indexOf('export async function actOnRequest'));
    expect(save).not.toContain('assertTierAllows');
  });
});

describe('the quote summary prints each section’s own scope list', () => {
  const base = { lines: [], approved_at: null, locked: false, include_in_summary: true, narrative_reported: null, name: null };
  const totals = { total_rule: 'yoda', incurred_subtotal: 0, option_totals: [], priced_section_id: null, sales_tax_pct: 0, sales_tax: 0, grand_total: 0, nte: null };
  const ctx = { client: null, store: null, city: null, state: null, ext_name: null, trade: null, title: null, note_to_customer: null };
  const defaults = [QUOTE_SCOPE_FIRST_LINE, '', '', '', QUOTE_SCOPE_LAST_LINE];
  const section = (kind: string, scope_lines: string[]) => ({ ...base, id: kind, kind, label: kind, scope_lines });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summary = (incurred: string[], option: string[]) => buildAutoSummary(ctx, [section('incurred', incurred), section('option', option)] as any, totals as any);

  it('lines typed on the Incurred card appear, under INCURRED', () => {
    const text = summary([QUOTE_SCOPE_FIRST_LINE, 'Replace the fan motor', QUOTE_SCOPE_LAST_LINE], defaults);
    expect(text).toContain('Replace the fan motor');
    expect(text.indexOf('Replace the fan motor')).toBeLessThan(text.indexOf('PROPOSED'));
  });
  it('an option’s own lines stay under PROPOSED', () => {
    const text = summary(defaults, [QUOTE_SCOPE_FIRST_LINE, 'Test the unit', QUOTE_SCOPE_LAST_LINE]);
    expect(text.indexOf('Test the unit')).toBeGreaterThan(text.indexOf('PROPOSED'));
  });
  it('an Incurred list nobody touched prints nothing', () => {
    expect(incurredScopeToPrint(defaults)).toEqual([]);
    const text = summary(defaults, defaults);
    expect(text.indexOf('Required is to:')).toBeGreaterThan(text.indexOf('PROPOSED'));
  });
});
