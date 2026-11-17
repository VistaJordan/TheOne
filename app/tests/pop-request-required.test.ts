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
  popQtyProblem,
  popRequestMissing,
  popRequestProblems,
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

  it('QTY is a whole number and the phone a US number', () => {
    const r = full();
    r.values.qty = 'tes';
    r.values.phone = '555';
    expect(popRequestProblems(r).map((p) => p.key)).toEqual(['qty', 'phone']);
    r.values.qty = '12';
    r.values.phone = '(409) 555-0143';
    expect(popRequestProblems(r)).toEqual([]);
    expect(popQtyProblem('0')).not.toBeNull();
    expect(popQtyProblem('1.5')).not.toBeNull();
  });

  it('the API refuses an incomplete one and a screenshot with no picture; the form asks first', () => {
    const api = read('apps/api/src/services/woFieldValues.ts');
    expect(api).toContain('async function assertPopRequestComplete(');
    expect(api).toContain('for (const p of patch) await assertPopRequestComplete(p.jsonKey, p.value, task.id);');
    expect(api).toContain('await assertPopRequestComplete(jsonKey, checked, null);');
    expect(api).toContain("content_type LIKE 'image/%'");
    expect(api).toContain('POP_SCREENSHOT_NEEDS_PICTURE');
    const form = read('apps/web/src/components/wo/PopRequestBlock.tsx');
    expect(form).toContain('const missing = popRequestMissing(draft);');
    expect(form).toContain('const problems = popRequestProblems(draft);');
    expect(form).toContain("const shotOk = shotUploaded || saved.values.screenshot.trim() !== '';");
    expect(form).toContain('setTriedSave(true);');
  });
});
