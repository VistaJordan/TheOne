/* UAT round 1, Wave A — money integrity (migration 0083, docs/specs/uat-round-1.md).
 *
 * Two halves, in the house pattern: the pure rules in packages/shared/src/
 * moneyGuards.ts are exercised directly, and the wiring in the API services is
 * pinned as source text (no database is opened, no API module imported). A
 * reformat of a pinned fragment turns a test red without a behaviour change:
 * update the fragment the failing assertion names.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_SECTIONS,
  MONEY_MAX,
  PERCENT_MAX,
  PO_LIMIT_DEFAULT,
  SYSTEM_MONEY_KEYS,
  TOTAL_INVOICED_FIELD_KEY,
  approvalSectionOf,
  billOverOwed,
  invoiceAllowedForStatus,
  isPaymentPurposeCode,
  nextPurpose,
  overNte,
  overQuoteReason,
  poNeedsLimitApproval,
  projectedCost,
  purposeBase,
  purposeLabel,
  quoteOverNte,
  selfApprovalVerdict,
  vendorOwed,
  withinMoneyBound,
} from '@theone/shared';

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const payments = src('apps/api/src/services/payments.ts');
const quotes = src('apps/api/src/services/quotes.ts');
const approvals = src('apps/api/src/services/approvals.ts');
const invoices = src('apps/api/src/services/invoices.ts');
const vendorBills = src('apps/api/src/services/vendorBills.ts');
const purchasing = src('apps/api/src/services/purchasing.ts');
const moneySync = src('apps/api/src/services/moneySync.ts');
const workOrders = src('apps/api/src/services/workOrders.ts');
const woBulk = src('apps/api/src/services/woBulk.ts');
const errors = src('apps/api/src/errors.ts');
const validation = src('apps/api/src/validation.ts');
const migration = src('packages/db/migrations/0083_uat_money.sql');

/** The body of one top-level function, from its header to the closing brace. */
function fn(file: string, header: string): string {
  const start = file.indexOf(header);
  expect(start, `missing ${header}`).toBeGreaterThan(-1);
  return file.slice(start, file.indexOf('\n}', start));
}

describe('D2 · maker ≠ checker (selfApprovalVerdict)', () => {
  it('blocks the maker, lets anyone else through, and flags a super admin deciding their own', () => {
    expect(selfApprovalVerdict('u1', 'u1', false)).toBe('blocked');
    expect(selfApprovalVerdict('u1', 'u2', false)).toBe('ok');
    expect(selfApprovalVerdict('u1', 'u1', true)).toBe('self_approved');
    expect(selfApprovalVerdict(null, 'u1', false)).toBe('ok');
  });

  it.each([
    ['payments approve', payments, 'export async function approvePaymentRequest('],
    ['payments pay', payments, 'export async function payPaymentRequest('],
    ['approval tasks decide', approvals, 'async function decide('],
    ['invoice send', invoices, 'async function move('],
    ['vendor bill approve', vendorBills, 'async function move('],
    ['purchase request approve', purchasing, 'export async function actOnRequest('],
    ['PO over limit', purchasing, 'export async function approvePoOverLimit('],
  ])('%s refuses its maker with SELF_APPROVAL', (_name, file, header) => {
    const body = fn(file, header);
    expect(/selfApprovalVerdict\(|assertNotOwnRequest\(|assertNotOwnQuote\(/.test(body)).toBe(true);
  });

  it('quotes have no maker ≠ checker (Elise, 2026-10-27: one dispatcher, one manager, the client)', () => {
    for (const header of ['export async function approveQuote(', 'export async function sendQuote(']) {
      expect(/selfApprovalVerdict\(|assertNotOwnQuote\(/.test(fn(quotes, header))).toBe(false);
    }
    expect(quotes).toContain('self_approval: false,');
  });

  it('logs a super admin deciding their own as self_approved', () => {
    for (const file of [payments, quotes, approvals, invoices, vendorBills]) {
      expect(file).toContain('self_approved: true');
    }
  });
});

describe('#4 / #25 · payments: pay only from approved, one winner per move', () => {
  it('pay refuses a request that was never approved and moves only from approved', () => {
    const body = fn(payments, 'export async function payPaymentRequest(');
    expect(body).toContain("row.status === 'requested'");
    expect(body).toContain('PAYMENT_NOT_APPROVED');
    expect(body).toContain("setStatus(row, ['approved', 'sent_to_yoda'], 'paid'");
    expect(body).not.toContain("['requested', 'approved', 'sent_to_yoda'], 'paid'");
  });

  it('every status move is one conditional UPDATE on the status it was read in', () => {
    const body = fn(payments, 'async function setStatus(');
    expect(body).toContain('WHERE id = $2 AND status = $${3 + extraParams.length}');
    expect(body).toContain('RETURNING id');
    expect(body).toContain("code: 'PAYMENT_MOVED'");
    // The Cost roll-up runs only after the conditional statement won.
    expect(body.indexOf('if (!moved.rows[0])')).toBeLessThan(body.indexOf('if (extra) costChanges'));
  });

  it('quote transitions and approval decisions are conditional too', () => {
    const t = fn(quotes, 'async function transition(');
    expect(t).toContain('WHERE id = $2 AND status = $${3 + extraParams.length} RETURNING id');
    expect(t).toContain("code: 'QUOTE_MOVED'");
    const d = fn(approvals, 'async function decide(');
    expect(d).toContain("WHERE id = $4 AND status = 'open'");
    expect(d).toContain("code: 'ALREADY_DECIDED'");
  });
});

describe('#5 / #7 · payment holds before the money moves', () => {
  it('projects Cost to the cent', () => {
    expect(projectedCost(100.1, 0.2)).toBe(100.3);
    expect(projectedCost(null, 50)).toBe(50);
  });

  it('is over the NTE only past it and only while no approval covers that much', () => {
    expect(overNte(1000, 1000, null)).toBe(false);
    expect(overNte(1000.01, 1000, null)).toBe(true);
    expect(overNte(1200, 1000, 1200)).toBe(false);
    expect(overNte(1300, 1000, 1200)).toBe(true);
    expect(overNte(5000, null, null)).toBe(false);
  });

  it('is over the quote past its price (negative margin) or its cost side; no quote, no ceiling', () => {
    expect(overQuoteReason(900, { total: 1000, cost: 800 }, null)).toMatch(/cost of \$800\.00/);
    expect(overQuoteReason(1100, { total: 1000, cost: 800 }, null)).toMatch(/negative margin/);
    expect(overQuoteReason(700, { total: 1000, cost: 800 }, null)).toBeNull();
    expect(overQuoteReason(1100, { total: 1000, cost: null }, 1100)).toBeNull();
    expect(overQuoteReason(1100, null, null)).toBeNull();
  });

  it('approve and pay ask before they write, and raise the hold rather than just refusing', () => {
    for (const header of ['export async function approvePaymentRequest(', 'export async function payPaymentRequest(']) {
      const body = fn(payments, header);
      expect(body.indexOf('assertPaymentNotHeld(')).toBeGreaterThan(-1);
      expect(body.indexOf('assertPaymentNotHeld(')).toBeLessThan(body.indexOf('setStatus('));
    }
    const held = fn(payments, 'async function assertPaymentNotHeld(');
    expect(held).toContain("type: 'nte_override'");
    expect(held).toContain("type: 'over_quote'");
    expect(held).toContain('NTE_OVERRIDE_REQUIRED_CODE');
    expect(held).toContain('covers: projected');
  });

  it('an approved hold covers a rule re-raising the same cost, and reconcile keeps a projected hold', () => {
    const create = fn(approvals, 'export async function createApprovalTask(');
    expect(create).toContain("approvedCover(input.taskId, 'nte_override')");
    const rec = fn(approvals, 'async function reconcileNteOverride(');
    expect(rec).toContain('holdSubjectLive(d)');
  });

  it('the money holds live in their own inbox section', () => {
    expect(approvalSectionOf('over_quote')).toBe('money');
    expect(approvalSectionOf('bill_over_owed')).toBe('money');
    expect(approvalSectionOf('nte_override')).toBe('nte');
    expect(APPROVAL_SECTIONS.some((s) => s.key === 'money' && s.decides)).toBe(true);
  });
});

describe('#10 · Total Invoiced comes only from the invoice', () => {
  it('is a system-only key the editor never offers', () => {
    expect(SYSTEM_MONEY_KEYS).toContain(TOTAL_INVOICED_FIELD_KEY);
  });

  it('is refused by the field editor and bulk edit unconditionally', () => {
    const body = fn(moneySync, 'export async function assertMoneyNotLocked(');
    expect(body).toContain('if (jsonKeys.includes(TOTAL_INVOICED_FIELD_KEY))');
    expect(body.indexOf('TOTAL_INVOICED_FIELD_KEY')).toBeLessThan(body.indexOf('const checks'));
  });

  it('is written when the invoice is sent, inside the send, and no status move stamps it from the quote', () => {
    const move = fn(invoices, 'async function move(');
    expect(move).toContain("if (to === 'sent') {\n      invoicedChanges = await setInvoicedFromInvoice(tx,");
    expect(workOrders).not.toContain('syncInvoicedFromQuote(');
    expect(woBulk).not.toContain('syncInvoicedFromQuote(');
    expect(moneySync).toContain("TOTAL_INVOICED_FIELD_KEY, Math.round(total * 100) / 100, 'invoice')");
  });
});

describe('#20 · vendor bills', () => {
  it('owes the approved quote cost less what went out', () => {
    expect(vendorOwed(1000, 300, 200)).toBe(500);
    expect(vendorOwed(null, 0, 0)).toBeNull();
    expect(vendorOwed(0, 0, 0)).toBeNull();
    expect(billOverOwed(600, 500, null)).toBe(true);
    expect(billOverOwed(500, 500, null)).toBe(false);
    expect(billOverOwed(600, 500, 600)).toBe(false);
    expect(billOverOwed(600, null, null)).toBe(false);
  });

  it('refuses a bill for nothing, a repeat number, and holds one over what is owed', () => {
    expect(vendorBills).toContain("throw badRequest('A bill has to total more than $0.00'");
    expect(vendorBills).toContain("code: 'VENDOR_BILL_DUPLICATE'");
    const move = fn(vendorBills, 'async function move(');
    expect(move).toContain('await assertBillWithinOwed(cur, actor);');
    expect(move).toContain('WHERE id = $1 AND status = $7');
    expect(fn(vendorBills, 'async function assertBillWithinOwed(')).toContain("type: 'bill_over_owed'");
  });
});

describe('#21 · purchasing', () => {
  it('needs a second approval over the limit only without a request', () => {
    expect(PO_LIMIT_DEFAULT).toBe(5000);
    expect(poNeedsLimitApproval({ total: 5000.01, request_id: null, limit_approved: false }, 5000)).toBe(true);
    expect(poNeedsLimitApproval({ total: 5000, request_id: null, limit_approved: false }, 5000)).toBe(false);
    expect(poNeedsLimitApproval({ total: 9000, request_id: 'pr', limit_approved: false }, 5000)).toBe(false);
    expect(poNeedsLimitApproval({ total: 9000, request_id: null, limit_approved: true }, 5000)).toBe(false);
  });

  it('issue checks the limit and the vendor record under the order lock', () => {
    const body = fn(purchasing, 'export async function actOnOrder(');
    const issue = body.slice(body.indexOf("action === 'issue'"), body.indexOf("action === 'close'"));
    expect(issue).toContain('FOR UPDATE');
    expect(issue).toContain('PO_OVER_LIMIT_CODE');
    expect(issue).toContain('VENDOR_REQUIRED_CODE');
  });

  it('one live order per request, and a vendor is a record', () => {
    expect(purchasing).toContain("WHERE request_id = $1 AND status <> 'cancelled' LIMIT 1");
    expect(fn(purchasing, 'export async function saveOrder(')).toContain('assertNoLiveOrder(tx, from.id)');
    expect(fn(purchasing, 'export async function awardQuote(')).toContain('assertNoLiveOrder(tx, cur.request.id)');
    expect(fn(purchasing, 'async function vendorRef(')).toContain('VENDOR_REQUIRED_CODE');
  });
});

describe('#23 · quotes', () => {
  it('a pending quote edited goes back to draft, logged, and one over the NTE is not sent', () => {
    const upd = fn(quotes, 'export async function updateQuote(');
    expect(upd).toContain("SET status = 'draft', submitted_by = NULL, submitted_at = NULL");
    expect(upd).toContain("'quote_returned_to_draft'");
    expect(fn(quotes, 'export async function sendQuote(')).toContain('QUOTE_OVER_NTE_CODE');
    expect(quoteOverNte(1000.01, 1000)).toBe(true);
    expect(quoteOverNte(1000, 1000)).toBe(false);
    expect(quoteOverNte(1000, null)).toBe(false);
  });

  it('submit records who submitted (the maker)', () => {
    expect(fn(quotes, 'export async function submitQuote(')).toContain('submitted_by = $3, submitted_at = now()');
  });
});

describe('#24 · payment purpose codes', () => {
  it('takes J, M or A and numbers repeats per work order', () => {
    expect(isPaymentPurposeCode('J')).toBe(true);
    expect(isPaymentPurposeCode('X')).toBe(false);
    expect(nextPurpose('J', [])).toBe('J');
    expect(nextPurpose('J', ['J'])).toBe('J1');
    expect(nextPurpose('J', ['J', 'J1', 'M'])).toBe('J2');
    expect(nextPurpose('M', ['J', 'J1'])).toBe('M');
    // A number is never handed out twice, even after a gap.
    expect(nextPurpose('J', ['J', 'J3'])).toBe('J4');
    // Free-text purposes from before 0083 are ignored.
    expect(nextPurpose('A', ['Assessment trip charge'])).toBe('A');
    expect(purposeBase('j2')).toBe('J');
    expect(purposeBase('Trip charge')).toBeNull();
    expect(purposeLabel('J2')).toBe('Job (J2)');
    expect(purposeLabel('Trip charge')).toBe('Trip charge');
  });

  it('numbers under the task lock and no longer refuses a repeat', () => {
    expect(payments).not.toContain('DUPLICATE_PURPOSE');
    const create = fn(payments, 'export async function createPaymentRequest(');
    expect(create.indexOf('FOR NO KEY UPDATE')).toBeGreaterThan(-1);
    expect(create.indexOf('FOR NO KEY UPDATE')).toBeLessThan(create.indexOf('numberPurpose(tx'));
  });
});

describe('#26 / #2 · invoices', () => {
  it('raises only for a done work order', () => {
    expect(invoiceAllowedForStatus('Done / Incurred', 'done')).toBe(true);
    expect(invoiceAllowedForStatus('Ready to Invoice', 'done')).toBe(true);
    expect(invoiceAllowedForStatus('invoiced', 'closed')).toBe(true);
    expect(invoiceAllowedForStatus('On Site (Job)', 'active')).toBe(false);
    expect(invoiceAllowedForStatus('Cancelled / Postponed', 'closed')).toBe(false);
    // A status the phase map does not know is billable only from the done group.
    expect(invoiceAllowedForStatus('Custom finished', 'done')).toBe(true);
    expect(invoiceAllowedForStatus('Custom open', 'open')).toBe(false);
  });

  it('a repeat create returns the live invoice, checked again under the task lock', () => {
    const body = fn(invoices, 'export async function createInvoice(');
    expect(body).toContain('await assertInvoiceable(taskId);');
    expect(body).toContain("SELECT 1 FROM task WHERE id = $1 FOR NO KEY UPDATE");
    expect(body).toContain("WHERE task_id = $1 AND status <> 'void' LIMIT 1");
    expect(body).toContain("'23505'");
    expect(body).not.toContain('throw conflict(`This work order is already on invoice');
  });

  it('the migration adds the partial unique indexes only when the rows on file allow them', () => {
    expect(migration).toContain("ON invoice (task_id) WHERE status <> 'void'");
    expect(migration).toContain('vendor_bill_number_per_vendor');
    expect(migration).toContain("ON purchase_order (request_id) WHERE request_id IS NOT NULL AND status <> 'cancelled'");
    expect(migration).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/m);
    expect(migration).not.toMatch(/CONCURRENTLY/);
  });
});

describe('M7 · Mark paid records the reference and the date', () => {
  it('refuses a payment with no reference or date', () => {
    const body = fn(invoices, 'async function move(');
    expect(body).toContain('INVOICE_PAYMENT_DETAILS_CODE');
    expect(body).toContain('($6::date)::timestamptz');
  });
});

describe('M1 · numbers a column cannot hold', () => {
  it('bounds money and percents', () => {
    expect(MONEY_MAX).toBe(9_999_999.99);
    expect(PERCENT_MAX).toBe(999.99);
    expect(withinMoneyBound(9_999_999.99)).toBe(true);
    expect(withinMoneyBound(10_000_000)).toBe(false);
    expect(withinMoneyBound(Number.NaN)).toBe(false);
  });

  it('the raw-money pattern stops at seven whole digits', () => {
    expect(validation).toContain('export const MONEY_RE = /^\\d{1,7}(?:\\.\\d{1,2})?$/;');
  });

  it('maps out-of-range and bad-text Postgres errors to a 400 VALIDATION', () => {
    expect(errors).toContain("pgCode === '22003' || pgCode === '22P02'");
    expect(errors).toContain("details: { code: 'VALIDATION', pg_code: pgCode }");
  });
});
