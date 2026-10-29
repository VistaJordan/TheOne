/* 2026-10-28 (Elise: "we have to refresh after each change") — the screen
 * follows every change without a reload.
 *   - every successful mutation re-reads what is on screen (MutationCache),
 *     except the ones marked QUIET_MUTATION (autosaves, prefs, notice reads);
 *   - coming back to the tab re-reads the screen (refetchOnWindowFocus). */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('the screen follows each change', () => {
  const qc = read('apps/web/src/lib/queryClient.ts');

  it('a successful mutation invalidates every query unless quiet', () => {
    expect(qc).toContain('new MutationCache(');
    expect(qc).toContain('if (mutation.meta?.quiet) return;');
    expect(qc).toContain('queryClient.invalidateQueries()');
  });

  it('returning to the tab refetches', () => {
    expect(qc).toContain('refetchOnWindowFocus: true');
  });

  it('the app uses that client', () => {
    const app = read('apps/web/src/App.tsx');
    expect(app).toContain("import { queryClient } from './lib/queryClient';");
    expect(app).not.toContain('new QueryClient(');
  });

  it('the autosaves stay quiet, so typing does not reload the page', () => {
    for (const p of ['apps/web/src/pages/QuoteBuilderPage.tsx', 'apps/web/src/pages/AiQuoteReviewPage.tsx']) {
      expect(read(p)).toContain('meta: QUIET_MUTATION,');
    }
  });
});
