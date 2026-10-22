// What a quote section opens with, and how a lone option is named (Elise,
// 2026-10-22). Pure: the API seeds a new quote with these rows in
// createQuote, the builder opens a new option with the same, and the summary
// text, the printed quote and the builder all read the option label through
// optionDisplayLabel so one option carries no letter and no name.
//
// The "Required is to…" list opens with FIVE lines: the first and the last
// are filled, the three between are blank for the person to type into. Blank
// lines are STORED (so a reload shows the list as it was left) and skipped
// wherever the list is printed (visibleScopeLines). "Add scope line" inserts
// ABOVE the last line, so "Clean the working area" stays last; any line may
// still be removed by hand.

export const QUOTE_SCOPE_FIRST_LINE = 'Full inspection of the working area';
export const QUOTE_SCOPE_LAST_LINE = 'Clean the working area';

/** The five lines a new section's "Required is to…" list opens with. */
export function defaultScopeLines(): string[] {
  return [QUOTE_SCOPE_FIRST_LINE, '', '', '', QUOTE_SCOPE_LAST_LINE];
}

/** The service line every new section opens with: a trip at the labor-rate
    card's trip rate (0 — blank in the builder — when no card covers the
    work order). */
export const QUOTE_DEFAULT_TRIP_DESCRIPTION = 'Trip';

/** "Add scope line": a blank line ABOVE the last one, so the closing line
    ("Clean the working area") stays last. An empty list gets its first line. */
export function insertScopeLine(lines: readonly string[]): string[] {
  if (lines.length === 0) return [''];
  const next = [...lines];
  next.splice(next.length - 1, 0, '');
  return next;
}

/** The lines worth printing: trimmed, blanks dropped. */
export function visibleScopeLines(lines: readonly unknown[] | null | undefined): string[] {
  return (lines ?? []).map((l) => String(l ?? '').trim()).filter((l) => l !== '');
}

/** True when a line is one of the two default texts (the AI draft's
    "does this quote already hold content" test ignores them). */
export function isDefaultScopeLine(line: string): boolean {
  const t = line.trim();
  return t === QUOTE_SCOPE_FIRST_LINE || t === QUOTE_SCOPE_LAST_LINE;
}

/**
 * How an option is named on screen and in the client text: with ONE option
 * in the round there is no choice to make, so it reads "Proposed" with no
 * letter and no name; with two or more each keeps its letter ("Option A").
 */
export function optionDisplayLabel(label: string, optionCount: number): string {
  return optionCount <= 1 ? 'Proposed' : label;
}

/** Every line's Day defaults to 1 and the column is drawn only when a line
    says otherwise (or the person asks for it). */
export const QUOTE_DEFAULT_DAY = 1;
