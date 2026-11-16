import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { quoteEditableBy, QUOTE_SUBMITTED_LOCKED_CODE } from '../packages/shared/src/quoteSubmit';

describe('a submitted quote is locked (2026-10-29)', () => {
  it('a draft is edited by anyone with the edit grant', () => {
    expect(quoteEditableBy('draft', true, false)).toBe(true);
    expect(quoteEditableBy('draft', false, true)).toBe(false);
  });
  it('pending approval is locked for everyone, managers included', () => {
    expect(quoteEditableBy('pending_approval', true, false)).toBe(false);
    expect(quoteEditableBy('pending_approval', true, true)).toBe(false);
  });
  it('2026-11-15: pending correction is edited by a quote approver only', () => {
    expect(quoteEditableBy('pending_correction', true, false)).toBe(false);
    expect(quoteEditableBy('pending_correction', false, false)).toBe(false);
    expect(quoteEditableBy('pending_correction', true, true)).toBe(true);
    expect(quoteEditableBy('pending_correction', false, true)).toBe(true);
  });
  it('the builder saves a manager’s corrections before sending it back', () => {
    const src = readFileSync(new URL('../apps/web/src/pages/QuoteBuilderPage.tsx', import.meta.url), 'utf8');
    expect(src).toContain('flushThen(() => rejectQuote(');
    expect(src).toContain('Send back to dispatcher');
  });
  it('approved and later is never edited', () => {
    for (const s of ['approved', 'sent', 'client_approved', 'client_declined']) {
      expect(quoteEditableBy(s, true, true)).toBe(false);
    }
  });
  it('updateQuote asks the rule before and under the row lock', () => {
    const src = readFileSync(new URL('../apps/api/src/services/quotes.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export async function updateQuote('), src.indexOf('// ── Lifecycle'));
    // Before the lock, and twice under it (the submitted-lock 409 and QUOTE_MOVED).
    expect(fn.match(/quoteEditableBy\(/g)?.length).toBe(3);
    expect(fn).toContain('FOR UPDATE');
    expect(fn).toContain('QUOTE_SUBMITTED_LOCKED_CODE');
    expect(QUOTE_SUBMITTED_LOCKED_CODE).toBe('QUOTE_SUBMITTED_LOCKED');
  });
  it('the builder draws the same rule', () => {
    const src = readFileSync(new URL('../apps/web/src/pages/QuoteBuilderPage.tsx', import.meta.url), 'utf8');
    expect(src).toContain('quoteEditableBy(status, canEdit, canApprove)');
  });
});
