/* No browser suggestions and no sample values in OBI's boxes.
 * 2026-11-17 (Elise): every input and textarea gets autocomplete="off".
 * 2026-11-19 (Elise): every box, a phone box included (it offered remembered
 * numbers); only the sign-in's username and password keep theirs. And a box
 * never shows a sample value as its placeholder — a phone number, a name, an
 * email, "e.g. …" — only what to type ("Search…", "Why?"). */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('no browser autofill', () => {
  it('main.tsx switches it off for the whole app', () => {
    const main = read('apps/web/src/main.tsx');
    expect(main).toContain("import { initNoAutofill } from './lib/noAutofill';");
    expect(main).toContain('initNoAutofill();');
  });

  it('quiets every box but the sign-in credentials', () => {
    const lib = read('apps/web/src/lib/noAutofill.ts');
    expect(lib).toContain("const KEEP = new Set(['username', 'current-password', 'new-password']);");
    expect(lib).toContain("setAttribute('autocomplete', 'off')");
    expect(lib).toContain('MutationObserver');
    expect(lib).toContain("'focusin'");
  });

  it('no box asks the browser for anything else', () => {
    const asks: string[] = [];
    for (const f of walk(join(__dirname, '..', 'apps', 'web', 'src'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/autoComplete="([^"]+)"/g)) {
        if (!['off', 'username', 'current-password', 'new-password'].includes(m[1])) asks.push(`${f}: ${m[1]}`);
      }
    }
    expect(asks).toEqual([]);
  });
});

describe('no sample values as placeholders', () => {
  const SAMPLE = /e\.g\.|\d{3}\)?[ .-]\d{3}-\d{4}|@example\.com|@client\.com|Gulf Coast|Bayou|Jeff Sanders|\$gulfcoast/;
  it('finds none in the web source', () => {
    const found: string[] = [];
    for (const f of walk(join(__dirname, '..', 'apps', 'web', 'src'))) {
      const lines = readFileSync(f, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/placeholder[=:]/.test(line) && SAMPLE.test(line)) found.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found, found.join('\n')).toEqual([]);
  });
});
