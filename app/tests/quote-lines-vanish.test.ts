import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// 2026-11-16 · "Lines are disappearing in the quote section randomly".
// Three causes: a save that came back marked the form clean although more had
// been typed while it was in flight (the rest was never sent); overlapping
// saves could land out of order; and a re-seed from somebody else's save
// dropped the rows not finished yet (never sent). Plus the server refused
// every save of a quote in pending correction (`status = 'draft'`).

describe('carryUnsavedLines', () => {
  it('keeps unfinished rows when the form is re-seeded from the server', async () => {
    const { blankLine, blankOption, carryUnsavedLines, lineIsUnsent } = await import('../apps/web/src/lib/quoteDraft');
    const saved = { ...blankLine(), line_type: 'labor' as const, description: 'Labor tech 1', qty: '2', rate: '90' };
    const typing = { ...blankLine(), description: 'Compressor' }; // no Type yet
    const empty = blankLine();
    expect(lineIsUnsent(saved)).toBe(false);
    expect(lineIsUnsent(typing)).toBe(true);
    expect(lineIsUnsent(empty)).toBe(true);

    const option = blankOption(1);
    const prev = {
      sections: [{ ...option, kind: 'incurred' as const, lines: [] }, { ...option, lines: [saved, typing, empty] }],
      current_round: 1,
    } as never;
    const fromServer = {
      sections: [{ ...option, kind: 'incurred' as const, lines: [] }, { ...option, lines: [{ ...saved, key: 'k2' }] }],
      current_round: 1,
    } as never;
    const merged = carryUnsavedLines(prev, fromServer) as { sections: { lines: { description: string }[] }[] };
    expect(merged.sections[1].lines.map((l) => l.description)).toEqual(['Labor tech 1', 'Compressor', '']);
    expect(carryUnsavedLines(null, fromServer)).toBe(fromServer);
  });

  it('never carries rows into a locked section', async () => {
    const { blankLine, blankOption, carryUnsavedLines } = await import('../apps/web/src/lib/quoteDraft');
    const option = blankOption(1);
    const prev = { sections: [{ ...option, lines: [blankLine()] }] } as never;
    const next = { sections: [{ ...option, locked: true, lines: [] }] } as never;
    expect(carryUnsavedLines(prev, next)).toBe(next);
  });
});

describe('the builder saves one at a time and stays dirty for later edits', () => {
  const src = readFileSync(new URL('../apps/web/src/pages/QuoteBuilderPage.tsx', import.meta.url), 'utf8');
  it('tracks an edit version and clears dirty only when the save carried the latest', () => {
    expect(src).toMatch(/editVersion\.current \+= 1;\s*setDraft\(next\)/);
    expect(src).toMatch(/if \(savedVersion\.current === editVersion\.current\) setDirty\(false\)/);
    expect(src).not.toMatch(/onSuccess: \(res\) => \{[\s\S]{0,900}?setDirty\(false\);\s*\},\s*onError/);
  });
  it('never starts a save while one is in flight, and flushes wait for it', () => {
    expect(src).toMatch(/if \(!next \|\| inflight\.current\) return;/);
    expect(src).toMatch(/if \(!draft \|\| !editable \|\| !dirty \|\| saving\) return;/);
    expect(src).toMatch(/if \(inflight\.current\) await inflight\.current;/);
  });
  it('carries unfinished rows across a re-seed of the same quote', () => {
    expect(src).toMatch(/carryUnsavedLines\(draftRef\.current, fresh\)/);
  });
});

describe('the server takes a save of a quote in pending correction', () => {
  const src = readFileSync(new URL('../apps/api/src/services/quotes.ts', import.meta.url), 'utf8');
  it('checks the editable statuses in the UPDATE, not draft alone', () => {
    expect(src).not.toMatch(/AND status = 'draft' RETURNING id/);
    expect(src).toMatch(/status::text = ANY\(\$\$\{params\.length\}::text\[\]\)/);
  });
});
