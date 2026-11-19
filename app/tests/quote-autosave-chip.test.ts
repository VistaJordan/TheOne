/* 2026-11-19: the quote builder's autosave chip sits beside the work order's
 * tab strip. Its hooks must run before the builder's loading / error returns —
 * placed after them, React counted a different number of hooks once the quote
 * loaded and the whole Quote tab went blank. Source pins: no browser. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('the autosave chip beside the tabs', () => {
  const qb = read('apps/web/src/pages/QuoteBuilderPage.tsx');

  it('declares its hooks above the early returns', () => {
    const hook = qb.indexOf('const [autosaveSlot, setAutosaveSlot] = useState');
    const firstEarlyReturn = qb.indexOf('Loading the quote for');
    expect(hook).toBeGreaterThan(0);
    expect(firstEarlyReturn).toBeGreaterThan(0);
    expect(hook).toBeLessThan(firstEarlyReturn);
  });

  it('draws into the slot after All fields', () => {
    expect(read('apps/web/src/pages/WorkOrderDetailPage.tsx')).toContain('id={WO_TABS_ASIDE_ID}');
    expect(qb).toContain('createPortal(autosaveChip, autosaveSlot)');
  });
});
