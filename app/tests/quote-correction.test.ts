// 0092 · a dispatcher's quote is corrected by a manager before approval
// (Elise, 2026-10-22). The rule is pure (`quoteSubmitTarget`); the rest pins
// the transitions, the editable statuses, the migration's CHECK and the
// screens that list the new status — the suite opens no database.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DISPATCHER_ROLE_CODES,
  QUOTE_CORRECTION_PENDING_CODE,
  QUOTE_SUBMIT_ACTION,
  QUOTE_SUBMIT_LABEL,
  quoteSubmitTarget,
} from '../packages/shared/src/index';
import { migrationFileProblems } from '../packages/db/src/migrateLedger';

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = src('packages/db/migrations/0092_quote_pending_correction.sql');
const quotes = src('apps/api/src/services/quotes.ts');

/** The body of one exported function: from its signature to the next export. */
function fn(file: string, signature: string): string {
  const start = file.indexOf(signature);
  expect(start, `${signature} exists`).toBeGreaterThan(-1);
  const next = file.indexOf('\nexport ', start + signature.length);
  return file.slice(start, next === -1 ? undefined : next);
}

describe('quoteSubmitTarget · where Submit takes the quote', () => {
  it("a dispatcher's draft goes for correction; a manager's for approval", () => {
    for (const code of DISPATCHER_ROLE_CODES) expect(quoteSubmitTarget(code, 'draft')).toBe('pending_correction');
    for (const code of ['tl', 'atl', 'am', 'admin', 'oa', 'ar', null, undefined]) {
      expect(quoteSubmitTarget(code, 'draft')).toBe('pending_approval');
    }
  });

  it('from pending correction only a manager submits; a dispatcher is locked', () => {
    for (const code of DISPATCHER_ROLE_CODES) expect(quoteSubmitTarget(code, 'pending_correction')).toBeNull();
    expect(quoteSubmitTarget('tl', 'pending_correction')).toBe('pending_approval');
    expect(quoteSubmitTarget('admin', 'pending_correction')).toBe('pending_approval');
  });

  it('each target has a button label and an audit action', () => {
    expect(QUOTE_SUBMIT_LABEL.pending_correction).toBe('Submit for correction');
    expect(QUOTE_SUBMIT_LABEL.pending_approval).toBe('Submit for approval');
    expect(QUOTE_SUBMIT_ACTION.pending_correction).toBe('quote_submitted_for_correction');
    // The quote_review_owed clock (obligations.ts) starts on THIS row only.
    expect(QUOTE_SUBMIT_ACTION.pending_approval).toBe('quote_submitted');
  });
});

describe('the API honours it', () => {
  it('submitQuote asks the rule, refuses a dispatcher mid-correction, stamps the submitter', () => {
    const submit = fn(quotes, 'export async function submitQuote(');
    expect(submit).toContain('quoteSubmitTarget(actor.role');
    expect(submit).toContain('QUOTE_CORRECTION_PENDING_CODE');
    expect(submit).toContain("['draft', 'pending_correction']");
    expect(submit).toContain('submitted_by = $3, submitted_at = now()');
    expect(QUOTE_CORRECTION_PENDING_CODE).toBe('QUOTE_CORRECTION_PENDING');
  });

  it('approve is from pending approval only; reject also from pending correction', () => {
    expect(fn(quotes, 'export async function approveQuote(')).toContain("['pending_approval'],");
    expect(fn(quotes, 'export async function rejectQuote(')).toContain("['pending_correction', 'pending_approval', 'approved']");
  });

  it('a quote waiting for correction is edited in place and does not return to draft', () => {
    expect(quotes).toContain("const EDITABLE_STATUSES: QuoteStatus[] = ['draft', 'pending_correction', 'pending_approval'];");
    const upd = fn(quotes, 'export async function updateQuote(');
    expect(upd).toContain("status IN ('draft', 'pending_correction', 'pending_approval')");
    // 0083 #23 stays for pending_approval alone.
    expect(upd).toContain("if (cur.status === 'pending_approval') {");
    expect(upd).not.toContain("cur.status === 'pending_correction'");
  });

  it('the permissions carry submit_target for the builder', () => {
    const perms = quotes.slice(quotes.indexOf('function permissionsFor('), quotes.indexOf('async function assertNotOwnQuote('));
    expect(perms).toContain('submit_target:');
    expect(perms).toContain("q.status === 'draft' || q.status === 'pending_correction'");
  });

  it('the inbox badge counts quotes waiting for correction too', () => {
    expect(src('apps/api/src/services/approvals.ts')).toContain("q.status IN ('pending_approval', 'pending_correction')");
  });
});

describe('migration 0092', () => {
  it('widens the status CHECK and manages no transaction of its own', () => {
    expect(MIGRATION).toContain("CHECK (status IN ('draft','pending_correction','pending_approval','approved','sent','client_approved','client_declined'))");
    expect(migrationFileProblems('0092_quote_pending_correction.sql', MIGRATION)).toEqual([]);
  });
});

describe('the screens', () => {
  it('the builder draws the label from submit_target and locks a dispatcher mid-correction', () => {
    const b = src('apps/web/src/pages/QuoteBuilderPage.tsx');
    expect(b).toContain('QUOTE_SUBMIT_LABEL[submitTarget]');
    expect(b).toContain("status === 'pending_correction'");
    expect(b).toContain("lockedButton('Submit for approval', QUOTE_CORRECTION_PENDING_TEXT");
  });

  it('the Quotes page has the lane, the inbox opens the row, the pill names it', () => {
    expect(src('apps/web/src/pages/QuotesPage.tsx')).toContain("{ key: 'pending_correction', label: 'Pending correction' }");
    const inbox = src('apps/web/src/pages/ApprovalsPage.tsx');
    expect(inbox).toContain("item.status === 'pending_approval' || item.status === 'pending_correction'");
    expect(inbox).toContain('Correct and submit');
    const pill = src('apps/web/src/components/quote/QuoteStatusPill.tsx');
    expect(pill).toContain("pending_correction: { label: 'Pending correction'");
    expect(pill).toContain("['draft', 'pending_correction', 'pending_approval', 'approved', 'sent', 'client_approved']");
  });
});
