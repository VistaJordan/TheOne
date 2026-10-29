import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { quoteEditableBy, QUOTE_SUBMITTED_LOCKED_CODE } from '../packages/shared/src/quoteSubmit';

describe('a submitted quote is locked (2026-10-29)', () => {
  it('a draft is edited by anyone with the edit grant', () => {
    expect(quoteEditableBy('draft', true, false)).toBe(true);
    expect(quoteEditableBy('draft', false, true)).toBe(false);
  });
  it('once submitted only a manager with approve edits it', () => {
    for (const s of ['pending_correction', 'pending_approval']) {
      expect(quoteEditableBy(s, true, false)).toBe(false);
      expect(quoteEditableBy(s, true, true)).toBe(true);
    }
  });
  it('approved and later is never edited', () => {
    for (const s of ['approved', 'sent', 'client_approved', 'client_declined']) {
      expect(quoteEditableBy(s, true, true)).toBe(false);
    }
  });
  it('updateQuote asks the rule before and under the row lock', () => {
    const src = readFileSync(new URL('../apps/api/src/services/quotes.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export async function updateQuote('), src.indexOf('// ── Lifecycle'));
    expect(fn.match(/quoteEditableBy\(/g)?.length).toBe(2);
    expect(fn).toContain('FOR UPDATE');
    expect(fn).toContain('QUOTE_SUBMITTED_LOCKED_CODE');
    expect(QUOTE_SUBMITTED_LOCKED_CODE).toBe('QUOTE_SUBMITTED_LOCKED');
  });
  it('the builder draws the same rule', () => {
    const src = readFileSync(new URL('../apps/web/src/pages/QuoteBuilderPage.tsx', import.meta.url), 'utf8');
    expect(src).toContain('quoteEditableBy(status, canEdit, canApprove)');
  });
});
