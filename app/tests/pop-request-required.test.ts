/* The POP request: every line but "Specs if Applicable" is required
 * (Elise, 2026-11-17). Pure rule + the API and form wiring. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  POP_REQUEST_LINES,
  emptyPopRequest,
  formatPopRequest,
  isPopRequestText,
  parsePopRequest,
  popRequestMissing,
} from '../packages/shared/src/popRequest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const full = () => {
  const r = emptyPopRequest();
  for (const l of POP_REQUEST_LINES) r.values[l.key] = `${l.label} value`;
  return r;
};

describe('POP request required lines', () => {
  it('requires every line but Specs', () => {
    expect(POP_REQUEST_LINES.filter((l) => !l.required).map((l) => l.key)).toEqual(['specs']);
  });

  it('lists the blank required lines, Specs never', () => {
    const r = full();
    r.values.specs = '';
    expect(popRequestMissing(r)).toEqual([]);
    r.values.qty = '';
    r.values.phone = '  ';
    expect(popRequestMissing(r)).toEqual(['QTY', 'Phone Number']);
  });

  it('only text in the form is held to it; a free-text list or a clear is not', () => {
    const r = full();
    r.values.link = '';
    expect(isPopRequestText(formatPopRequest(r))).toBe(true);
    expect(popRequestMissing(parsePopRequest(formatPopRequest(r)))).toEqual(['Link']);
    expect(isPopRequestText('2 x 20A breaker, 1 x GFCI')).toBe(false);
    expect(isPopRequestText(null)).toBe(false);
  });

  it('the API refuses an incomplete one; the form asks first', () => {
    const api = read('apps/api/src/services/woFieldValues.ts');
    expect(api).toContain('function assertPopRequestComplete(');
    expect(api).toContain('if (!auto) assertPopRequestComplete(');
    expect(api).toContain('assertPopRequestComplete(jsonKey, checked);');
    const form = read('apps/web/src/components/wo/PopRequestBlock.tsx');
    expect(form).toContain('const missing = popRequestMissing(draft);');
    expect(form).toContain('setTriedSave(true);');
  });
});
