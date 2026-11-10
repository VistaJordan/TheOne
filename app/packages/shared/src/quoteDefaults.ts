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

/** 2026-11-10 (Elise) · a pasted block is one scope line per line of text.
    Splits on line breaks, drops a leading number or bullet ("1.", "2)", "-",
    "•") and the empty lines. One line or none = not a block (null), so an
    ordinary paste stays the browser's. */
export function splitPastedScope(text: string): string[] | null {
  const parts = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/^\s*(?:\d{1,3}\s*[.)\-:]|[-*•·–—▪●○])\s*/u, '').trim())
    .filter((l) => l !== '');
  return parts.length > 1 ? parts : null;
}

/** Puts a pasted block into the list at `index`: the first piece goes into
    that line (after what is before the caret, `before`; what was after the
    caret, `after`, joins the last piece), the rest fill the BLANK lines that
    follow it, and whatever is left is inserted before the next filled line —
    so the closing "Clean the working area" stays last. Returns the new list
    and the index of the line holding the last piece. */
export function pasteScopeLines(
  lines: readonly string[],
  index: number,
  pieces: readonly string[],
  before = '',
  after = '',
): { lines: string[]; last: number } {
  const next = [...lines];
  if (pieces.length === 0) return { lines: next, last: index };
  const out = [...pieces];
  out[0] = `${before}${out[0]}`;
  out[out.length - 1] = `${out[out.length - 1]}${after}`;
  next[index] = out[0];
  let at = index;
  for (const piece of out.slice(1)) {
    at += 1;
    if (at < next.length && next[at].trim() === '') next[at] = piece;
    else next.splice(at, 0, piece);
  }
  return { lines: next, last: at };
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

/** 2026-11-09 (Elise) · what the summary prints under INCURRED: the section's
    own list, unless nobody touched it (only the default texts left), so a
    quote with nothing typed there does not print a to-do list for it. */
export function incurredScopeToPrint(lines: readonly unknown[] | null | undefined): string[] {
  const visible = visibleScopeLines(lines);
  return visible.every(isDefaultScopeLine) ? [] : visible;
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

/** 2026-11-09 (Elise) · overtime is for labor only: a trip, a part, a material,
    a fee or a discount never bills at the OT multiplier. The builder draws the
    OT tick on Labor lines alone, the save stores `ot = false` on any other
    line, and every price (quote totals, the invoice prefill, the summary)
    reads `lineBillsOt`, so a line saved with OT before the rule prices at its
    plain rate. */
export const OT_LINE_TYPE = 'labor';
export function lineTakesOt(lineType: string | null | undefined): boolean {
  return lineType === OT_LINE_TYPE;
}
export function lineBillsOt(line: { line_type?: string | null; ot?: boolean | null }): boolean {
  return line.ot === true && lineTakesOt(line.line_type);
}
