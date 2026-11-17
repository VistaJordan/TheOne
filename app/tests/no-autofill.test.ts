/* No browser suggestions in OBI's boxes (Elise, 2026-11-17): every input and
 * textarea without its own autocomplete gets autocomplete="off", app-wide. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('no browser autofill', () => {
  it('main.tsx switches it off for the whole app', () => {
    const main = read('apps/web/src/main.tsx');
    expect(main).toContain("import { initNoAutofill } from './lib/noAutofill';");
    expect(main).toContain('initNoAutofill();');
  });

  it('keeps a box that asks for something specific, quiets every other one', () => {
    const lib = read('apps/web/src/lib/noAutofill.ts');
    expect(lib).toContain("el.hasAttribute('autocomplete')");
    expect(lib).toContain("setAttribute('autocomplete', 'off')");
    expect(lib).toContain('MutationObserver');
    expect(lib).toContain("'focusin'");
  });
});
