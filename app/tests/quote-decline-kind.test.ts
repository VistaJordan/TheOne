/* 2026-10-29 (Elise, migration 0109) — the client's decline is one of two
 * kinds:
 *   - Challenged: the work order goes back to Waiting for Quote (re-quote);
 *   - Bill for incurred only: the Incurred section stays, the round's
 *     proposed options come off the live quote (kept in the history and
 *     restorable), Bill For Incurred is ticked and the work order moves to
 *     Done / Incurred. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  QUOTE_DECLINE_KINDS,
  quoteDeclineEvent,
  quoteEventStatusName,
} from '../packages/shared/src/workflow';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const fn = (src: string, head: string) => {
  const at = src.indexOf(head);
  const end = src.indexOf('\nexport ', at + head.length);
  return src.slice(at, end === -1 ? undefined : end);
};

describe('where each decline sends the work order', () => {
  it('two kinds', () => {
    expect([...QUOTE_DECLINE_KINDS]).toEqual(['challenged', 'bfi']);
  });
  it('challenged → Waiting for Quote', () => {
    expect(quoteEventStatusName(quoteDeclineEvent('challenged'), 'Waiting for Approval')).toBe('Waiting for Quote');
  });
  it('bill for incurred → Done / Incurred', () => {
    expect(quoteEventStatusName(quoteDeclineEvent('bfi'), 'Waiting for Approval')).toBe('Done / Incurred');
    expect(quoteEventStatusName(quoteDeclineEvent('bfi'), 'Quote Ready')).toBe('Done / Incurred');
  });
  it('a work order further along is left alone', () => {
    expect(quoteEventStatusName(quoteDeclineEvent('bfi'), 'Invoiced')).toBeNull();
    expect(quoteEventStatusName(quoteDeclineEvent('challenged'), 'On Site (Job)')).toBeNull();
  });
});

describe('the API', () => {
  const svc = read('apps/api/src/services/quotes.ts');
  const decline = fn(svc, 'export async function clientDeclineQuote(');
  const restore = fn(svc, 'export async function restoreBfiOptions(');

  it('stores the kind and refuses BFI on a single option', () => {
    expect(decline).toContain('client_decline_kind = $5');
    expect(decline).toContain("kind === 'bfi' && target");
  });
  it('copies the quote before removing the options, and marks them restorable', () => {
    const snap = decline.indexOf("await snapshot(tx, pre, 'client_declined'");
    const removal = decline.indexOf('bfi_removed_at = now()');
    expect(snap).toBeGreaterThan(-1);
    expect(removal).toBeGreaterThan(snap);
    expect(decline).toContain("kind = 'option' AND approved_at IS NULL");
  });
  it('ticks Bill For Incurred before the status move (the Done gate reads it)', () => {
    const flag = decline.indexOf('await setBfiFlag(taskId, true, actor)');
    const move = decline.indexOf('withStatusMove(taskId, declined, quoteDeclineEvent(kind)');
    expect(flag).toBeGreaterThan(-1);
    expect(move).toBeGreaterThan(flag);
  });
  it('restore brings back exactly the removed options as the next draft and unticks BFI', () => {
    expect(restore).toContain("['client_declined']");
    expect(restore).toContain("'draft'");
    expect(restore).toContain('bfi_removed_at IS NOT NULL AND deleted_at IS NOT NULL');
    expect(restore).toContain('await setBfiFlag(taskId, false, actor)');
    expect(restore).toContain("assertWoAllows(taskId, 'quote.new_round')");
  });
  it('the route and the migration exist', () => {
    expect(read('apps/api/src/routes/quotes.ts')).toContain("'/work-orders/:id/quote/restore-options'");
    const mig = read('packages/db/migrations/0109_quote_decline_kind.sql');
    expect(mig).toContain('client_decline_kind');
    expect(mig).toContain('bfi_removed_at');
  });
});

describe('the builder and Receivables', () => {
  it('the decline asks which kind', () => {
    const page = read('apps/web/src/pages/QuoteBuilderPage.tsx');
    expect(page).toContain('QUOTE_DECLINE_KINDS.map');
    expect(page).toContain("'Restore removed options'");
  });
  it('a BFI decline is ready to invoice', () => {
    expect(read('apps/web/src/lib/receivables.ts')).toContain("q.client_decline_kind === 'bfi'");
  });
});
