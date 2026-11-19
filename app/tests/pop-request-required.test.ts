/* The POP request: every line but "Specs if Applicable" is required
 * (Elise, 2026-11-17). Pure rule + the API and form wiring. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  POP_REQUEST_LINES,
  emptyPopRequest,
  formatPopRequest,
  formatPopRequests,
  isPopRequestText,
  parsePopRequest,
  parsePopRequests,
  popCostInputValue,
  popCostProblem,
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

  it('QTY is a whole number, the cost a number and the phone a US number', () => {
    const r = full();
    r.values.qty = 'tes';
    r.values.estimated_total_cost = 'about 300';
    r.values.phone = '555';
    expect(popRequestProblems(r).map((p) => p.key)).toEqual(['qty', 'estimated_total_cost', 'phone']);
    r.values.qty = '12';
    r.values.estimated_total_cost = '250.50';
    r.values.phone = '(409) 555-0143';
    expect(popRequestProblems(r)).toEqual([]);
    expect(popQtyProblem('0')).not.toBeNull();
    expect(popQtyProblem('1.5')).not.toBeNull();
  });

  it('Estimated Total Cost keeps only a number as it is typed (2026-11-19)', () => {
    expect(popCostInputValue('$1,250.5')).toBe('1250.5');
    expect(popCostInputValue('12.345')).toBe('12.34');
    expect(popCostInputValue('1.2.3')).toBe('1.23');
    expect(popCostInputValue('abc')).toBe('');
    expect(popCostInputValue('123456789')).toBe('1234567');
    expect(popCostProblem('300')).toBeNull();
    expect(popCostProblem('300.5')).toBeNull();
    expect(popCostProblem('about 300')).not.toBeNull();
    expect(popCostProblem('$300')).not.toBeNull();
    expect(read('apps/web/src/components/wo/PopRequestBlock.tsx')).toContain("? popCostInputValue(value)");
  });

  it('holds several POP requests in the one field (2026-11-19)', () => {
    const a = full();
    a.values.pop = 'Home Depot';
    const b = full();
    b.values.pop = 'Grainger';
    const text = formatPopRequests([a, b])!;
    expect(text).toContain('--- POP request 2 ---');
    const back = parsePopRequests(text);
    expect(back.map((r) => r.values.pop)).toEqual(['Home Depot', 'Grainger']);
    expect(back[1].notes).toBe('');
    // One request reads and writes as before.
    expect(formatPopRequests([a])).toBe(formatPopRequest(a));
    expect(parsePopRequests(formatPopRequest(a))).toHaveLength(1);
    // Empty ones are dropped; nothing at all is null.
    expect(formatPopRequests([emptyPopRequest()])).toBeNull();
    expect(parsePopRequests(formatPopRequests([emptyPopRequest(), b]))[0].values.pop).toBe('Grainger');
    expect(isPopRequestText(text)).toBe(true);
    // The API checks each one and says which.
    const api = read('apps/api/src/services/woFieldValues.ts');
    expect(api).toContain('const all = parsePopRequests(value);');
    expect(api).toContain("const which = all.length > 1 ? `POP request ${i + 1}: ` : '';");
    const form = read('apps/web/src/components/wo/PopRequestBlock.tsx');
    expect(form).toContain('Add another POP request');
    // Remove takes one request out and saves the rest.
    expect(form).toContain('formatPopRequests(requests.filter((_, i) => i !== removing))');
    expect(form).toContain('confirmLabel="Remove"');
  });

  it('an open form survives a refresh until Save, Cancel or Reset (2026-11-19)', () => {
    const form = read('apps/web/src/components/wo/PopRequestBlock.tsx');
    expect(form).toContain('const keptKey = (woId: string) => `theone.pop.draft.${woId}`;');
    expect(form).toContain('writeKept(wo.id, draft ? { draft, shotUploaded, index: editing } : null);');
    expect(form).toContain('useState<PopRequest | null>(() => (canEdit ? (readKept(wo.id)?.draft ?? null) : null))');
    expect(form).toContain('setDraft(emptyPopRequest());');
    expect(form).toMatch(/>\s*Reset\s*</);
  });

  it('the screenshot can be pasted or dropped as well as uploaded (2026-11-19)', () => {
    const form = read('apps/web/src/components/wo/PopRequestBlock.tsx');
    expect(form).toContain('const pic = imageOf(e.clipboardData.files);');
    expect(form).toContain('const pic = imageOf(e.dataTransfer.files);');
    expect(form).toContain('if (pic) void upload(pic);');
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
    expect(form).toContain("const shotOk = shotUploaded || (savedOne?.values.screenshot.trim() ?? '') !== '';");
    expect(form).toContain('setTriedSave(true);');
  });
});
