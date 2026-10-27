// What a quote section opens with, and how a lone option is named (Elise,
// 2026-10-22): the five default "Required is to…" lines, the Trip line, "Add
// scope line" inserting above the last line, blank lines kept but never
// printed, Day 1 by default, no letter or name on a lone option, and
// required fields that paint red only after a Submit was tried.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  QUOTE_DEFAULT_DAY,
  QUOTE_DEFAULT_TRIP_DESCRIPTION,
  QUOTE_SCOPE_FIRST_LINE,
  QUOTE_SCOPE_LAST_LINE,
  defaultScopeLines,
  insertScopeLine,
  isDefaultScopeLine,
  optionDisplayLabel,
  visibleScopeLines,
} from '../packages/shared/src/quoteDefaults';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('defaultScopeLines', () => {
  it('opens with five lines: inspection first, clean-up last, three blanks between', () => {
    const lines = defaultScopeLines();
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(QUOTE_SCOPE_FIRST_LINE);
    expect(lines[4]).toBe(QUOTE_SCOPE_LAST_LINE);
    expect(lines.slice(1, 4)).toEqual(['', '', '']);
    expect(QUOTE_SCOPE_FIRST_LINE).toBe('Full inspection of the working area');
    expect(QUOTE_SCOPE_LAST_LINE).toBe('Clean the working area');
  });

  it('returns a fresh array each time, so one section cannot edit another', () => {
    const a = defaultScopeLines();
    a[1] = 'typed';
    expect(defaultScopeLines()[1]).toBe('');
  });
});

describe('insertScopeLine — "Add scope line" goes above the last line', () => {
  it('keeps the closing line last', () => {
    expect(insertScopeLine(['a', 'b', 'Clean the working area'])).toEqual(['a', 'b', '', 'Clean the working area']);
  });
  it('a one-line list gets its new line above that line', () => {
    expect(insertScopeLine(['only'])).toEqual(['', 'only']);
  });
  it('an empty list gets its first line', () => {
    expect(insertScopeLine([])).toEqual(['']);
  });
  it('does not mutate the input', () => {
    const lines = ['a', 'z'];
    insertScopeLine(lines);
    expect(lines).toEqual(['a', 'z']);
  });
});

describe('visibleScopeLines — blanks are stored but never printed', () => {
  it('drops blank and whitespace lines and trims the rest', () => {
    expect(visibleScopeLines(['  Full inspection ', '', '   ', 'Clean', null, undefined])).toEqual(['Full inspection', 'Clean']);
  });
  it('an absent list prints nothing', () => {
    expect(visibleScopeLines(null)).toEqual([]);
    expect(visibleScopeLines(undefined)).toEqual([]);
  });
});

describe('isDefaultScopeLine', () => {
  it('knows the two default texts, whatever the surrounding spaces', () => {
    expect(isDefaultScopeLine(' Full inspection of the working area ')).toBe(true);
    expect(isDefaultScopeLine('Clean the working area')).toBe(true);
    expect(isDefaultScopeLine('Replace the motor')).toBe(false);
    expect(isDefaultScopeLine('')).toBe(false);
  });
});

describe('optionDisplayLabel — a lone option carries no letter', () => {
  it('reads "Proposed" with one option and keeps the letter with two or more', () => {
    expect(optionDisplayLabel('Option A', 1)).toBe('Proposed');
    expect(optionDisplayLabel('Option A', 0)).toBe('Proposed');
    expect(optionDisplayLabel('Option A', 2)).toBe('Option A');
    expect(optionDisplayLabel('Option B', 3)).toBe('Option B');
  });
});

describe('the builder follows the vocabulary', async () => {
  const { blankLine, blankOption, tripLine } = await import('../apps/web/src/lib/quoteDraft');
  const { quoteProblems } = await import('../apps/web/src/lib/quoteTotals');

  it('every new line opens on Day 1 and the Trip line carries the card rate', () => {
    expect(QUOTE_DEFAULT_DAY).toBe(1);
    expect(blankLine().day_value).toBe('1');
    const t = tripLine(85);
    expect(t.description).toBe(QUOTE_DEFAULT_TRIP_DESCRIPTION);
    expect(t.line_type).toBe('service');
    expect(t.rate).toBe('85.00');
    expect(t.qty).toBe('1');
    expect(tripLine(null).rate).toBe('');
    expect(tripLine(0).rate).toBe('');
  });

  it('a new option opens with the five scope lines and the Trip line', () => {
    const opt = blankOption(1, 60);
    expect(opt.scope_lines).toEqual(defaultScopeLines());
    expect(opt.lines).toHaveLength(1);
    expect(opt.lines[0].description).toBe('Trip');
    expect(opt.lines[0].rate).toBe('60.00');
    expect(opt.name).toBe('');
  });

  it('asks for an option name only once the round offers a choice', () => {
    const draft = {
      sections: [
        { ...blankOption(1, 60), kind: 'incurred' as const, narrative: 'Tech found the unit down.', scope_lines: ['Inspect'] },
        blankOption(1, 60),
      ],
      current_round: 1,
      sales_tax_pct: '0',
      total_rule: 'incurred_plus_option' as const,
      bill_to: '',
      is_cost_tbd: false,
      specs: '',
      note_to_customer: '',
      summary_pinned: null,
      document_type: 'quote' as const,
      ship_to: '',
    };
    expect(quoteProblems(draft).map((p) => p.message)).toEqual([]);
    const two = { ...draft, sections: [...draft.sections, blankOption(1, 60)] };
    expect(quoteProblems(two).map((p) => p.message)).toEqual(['Option A needs a name', 'Option B needs a name']);
  });

  it('an option with no scope line at all is a problem; its narrative is not asked', () => {
    const opt = { ...blankOption(1, 60), scope_lines: ['', ''] };
    const draft = {
      sections: [
        { ...blankOption(1, 60), kind: 'incurred' as const, narrative: 'x', scope_lines: ['Inspect'] },
        opt,
      ],
      current_round: 1,
      sales_tax_pct: '0',
      total_rule: 'incurred_plus_option' as const,
      bill_to: '',
      is_cost_tbd: false,
      specs: '',
      note_to_customer: '',
      summary_pinned: null,
      document_type: 'quote' as const,
      ship_to: '',
    };
    expect(quoteProblems(draft).map((p) => p.message)).toEqual(['Proposed needs at least one scope line']);
  });
});

describe('source pins', () => {
  it('the builder paints required fields only after a Submit attempt — no blur handler', () => {
    const page = read('apps/web/src/pages/QuoteBuilderPage.tsx');
    expect(page).not.toMatch(/onBlur=\{\(\) => setShowErrors\(true\)\}/);
    expect(page).toMatch(/const focusFirstProblem = \(\) => \{\s*setShowErrors\(true\);/);
    // Tech reported is one line that grows.
    expect(page).toMatch(/id="inc-report"\s+rows=\{1\}/);
  });

  it('the line table has no UOM column and hides Day until asked', () => {
    const table = read('apps/web/src/components/quote/LineItemsTable.tsx');
    expect(table).not.toMatch(/c-uom/);
    expect(table).not.toMatch(/unit of measure/);
    expect(table).toMatch(/dayColumn && \(/);
    expect(table).toMatch(/Multi-day job/);
  });

  it('the option card hides letter and name on a lone option and draws the scope list', () => {
    const card = read('apps/web/src/components/quote/OptionCard.tsx');
    expect(card).toMatch(/\{!sole && <span className="opt-tag"/);
    expect(card).toMatch(/<ScopeList/);
    // 2026-10-27: the option has its own "Tech reported that…" line.
    expect(card).toContain('Tech reported that…');
    expect(card).toContain('fld fld-grow');
  });

  it('the summary card has no Edit text button', () => {
    const card = read('apps/web/src/components/quote/SummaryCard.tsx');
    expect(card).not.toMatch(/name="pencil"/);
    expect(card).not.toMatch(/Save text/);
    expect(card).not.toMatch(/setEditing|<textarea/);
  });

  it('createQuote seeds incurred + one option, each with the defaults and a Trip line', () => {
    const svc = read('apps/api/src/services/quotes.ts');
    expect(svc).toMatch(/\(\$1, 'incurred', 'Work already performed', \$2::jsonb, true, 0, 1\),\s*\(\$1, 'option', NULL, \$2::jsonb, true, 1, 1\)/);
    expect(svc).toMatch(/JSON\.stringify\(defaultScopeLines\(\)\)/);
    expect(svc).toMatch(/QUOTE_DEFAULT_TRIP_DESCRIPTION, tripRate/);
  });

  it('the route stores blank scope lines and the summary skips them', () => {
    expect(read('apps/api/src/routes/quotes.ts')).toMatch(/scope_lines: z\.array\(z\.string\(\)\.trim\(\)\.max\(1000\)\)/);
    const svc = read('apps/api/src/services/quotes.ts');
    expect(svc).toMatch(/let scope = visibleScopeLines\(section\.scope_lines\)/);
    expect(svc).toMatch(/optionCount > 1 \? `PROPOSED — \$\{section\.label\.toUpperCase\(\)\}` : 'PROPOSED'/);
  });

  it('the AI draft ignores the defaults when asking whether the quote has content', () => {
    const ai = read('apps/api/src/services/aiQuote.ts');
    expect(ai).toMatch(/l\.description <> \$2/);
    expect(ai).toMatch(/btrim\(x\) NOT IN \(\$3, \$4\)/);
  });
});
