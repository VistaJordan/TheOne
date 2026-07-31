/* Quote money + validation. Every number on the quote screen comes out of this
   module: the line amounts, the two subtotals, the option totals, the grand
   total, profit/margin and the NTE meter. The rules encoded here are the
   HARDENED ones from the approved comp (scratchpad/quote-comp.tpl.html) and the
   requirements (product/quotes-payments.md §4).

   The server owns the same arithmetic (apps/api/src/services/quotes.ts,
   computeQuoteTotals) and both implement RULE B. This copy exists because the
   builder must show live totals while the operator types, i.e. BEFORE the
   debounced autosave has round-tripped — and because it can price a draft the
   server would reject, so it also decides which lines are excluded and why. */

import type { DraftLine, DraftQuote, DraftSection } from './quoteDraft';

/** Overtime multiplier — DECIDED at ×1.5 on the line rate (requirements §4.1). */
export const OT_MULTIPLIER = 1.5;

/** The NTE meter turns amber at this share of the client NTE (S2 parity). */
export const NTE_WARN_PCT = 85;

/** 2.5 × 180 × 1.5 must be 675, not 674.9999999999999 (server parity). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Parse a money/quantity field from the RAW string the user typed.
 *
 * Deliberately NOT a sanitize-then-parseFloat: stripping non-numerics before
 * parsing silently rewrites bad input into good numbers — "-75" reads as 75,
 * "5e3" as 53, "12.34.56" as 12.34. Only currency chrome ($, spaces, thousands
 * separators) is removed; what remains must be a full-string plain decimal of
 * at most two places worth at least one cent. Anything else is NaN, which IS
 * the error state every caller keys off.
 */
export function parseMoney(v: string | null | undefined): number {
  const raw = String(v ?? '').replace(/[$\s,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return NaN;
  const n = parseFloat(raw);
  return n >= 0.01 ? n : NaN;
}

/** Same grammar, but zero is legal — the sales-tax box defaults to 0. */
export function parseTax(v: string | null | undefined): number {
  const raw = String(v ?? '').replace(/[$\s,]/g, '');
  if (raw === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return NaN;
  return parseFloat(raw);
}

/** '$2,890.00' — quote money always carries cents (cf. lib/fields money(), which
    drops them for round WO amounts). */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** '$3,202' — the NTE headline + meter scale, which the comp renders whole. */
export function usd0(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** A line's computed amount, or null when the line is not yet valid. Amount is
    never an input (§3.6 read-only-distinction): qty × rate, ×1.5 when OT.
    The Day column is NOT part of this — its value is stored verbatim. */
export function lineAmount(line: DraftLine): number | null {
  const q = parseMoney(line.qty);
  const r = parseMoney(line.rate);
  if (Number.isNaN(q) || Number.isNaN(r)) return null;
  return round2(q * r * (line.ot ? OT_MULTIPLIER : 1));
}

/** Per-field errors on one line. An empty object means the line is billable. */
export interface LineErrors {
  description?: string;
  qty?: string;
  rate?: string;
}

export function lineErrors(line: DraftLine): LineErrors {
  const errs: LineErrors = {};
  if (line.description.trim() === '') errs.description = 'Description is required';
  if (Number.isNaN(parseMoney(line.qty))) {
    errs.qty = line.qty.trim() === '' ? 'Qty is required' : 'Enter a quantity greater than 0';
  }
  if (Number.isNaN(parseMoney(line.rate))) {
    errs.rate = line.rate.trim() === '' ? 'Rate is required' : 'Enter a rate greater than $0';
  }
  return errs;
}

export function hasLineError(line: DraftLine): boolean {
  return Object.keys(lineErrors(line)).length > 0;
}

/** Sum of the lines that currently compute. Invalid lines are EXCLUDED (and the
    section footer says so) rather than counted as zero. */
export function sumLines(lines: DraftLine[]): { total: number; excluded: number[] } {
  let total = 0;
  const excluded: number[] = [];
  lines.forEach((line, i) => {
    const amt = lineAmount(line);
    if (amt == null || hasLineError(line)) excluded.push(i + 1);
    else total = round2(total + amt);
  });
  return { total, excluded };
}

/** "Line 5 is excluded from the subtotal until it is complete." — the comp's
    footer note, pluralised. Null when every line counts. */
export function excludedNote(excluded: number[]): string | null {
  if (excluded.length === 0) return null;
  if (excluded.length === 1) {
    return `Line ${excluded[0]} is excluded from the subtotal until it is complete.`;
  }
  const list = excluded.slice(0, -1).join(', ');
  return `Lines ${list} and ${excluded[excluded.length - 1]} are excluded from the subtotal until they are complete.`;
}

export interface OptionTotal {
  /** The DraftSection.key, so the rail can address the section it came from. */
  key: string;
  label: string;
  name: string;
  total: number;
  /** 1-based line numbers left out of the total because they are invalid. */
  excluded: number[];
  include_in_summary: boolean;
}

export interface QuoteTotals {
  incurredSubtotal: number;
  incurredExcluded: number[];
  options: OptionTotal[];
  /** Sum of the option sections with include_in_summary = true. */
  includedOptions: number;
  salesTax: number;
  grandTotal: number;
  totalCost: number | null;
  profit: number | null;
  marginPct: number | null;
}

/**
 * THE grand-total rule. One function, one place — see the RULE B note below.
 *
 * RULE B — flip to (a) incurred+options here if Jordan reverses.
 *
 * (b) grand_total = sales tax + the sum of the option sections whose
 *     `include_in_summary` is true. The INCURRED subtotal is context only: that
 *     work is already on the work order and bills with the job, so adding it to
 *     the client-facing grand total would bill it twice. To move to rule (a),
 *     add `incurredSubtotal` to the `grandTotal` expression below — that single
 *     line is the whole change; the rail caption, the summary block and the NTE
 *     meter all read this result.
 *
 * `totalCost` is our cost on the proposed work (server-held, not part of the
 * draft form), passed in so profit/margin land in the same result.
 */
export function computeQuoteTotals(draft: DraftQuote, totalCost: number | null = null): QuoteTotals {
  const incurredSection = draft.sections.find((s) => s.kind === 'incurred');
  const incurred = sumLines(incurredSection ? incurredSection.lines : []);

  const options: OptionTotal[] = draft.sections
    .filter((s) => s.kind === 'option')
    .map((opt, i) => {
      const sum = sumLines(opt.lines);
      return {
        key: opt.key,
        label: `Option ${String.fromCharCode(65 + i)}`,
        name: opt.name,
        total: sum.total,
        excluded: sum.excluded,
        include_in_summary: opt.include_in_summary,
      };
    });

  const includedOptions = round2(
    options.reduce((acc, o) => acc + (o.include_in_summary ? o.total : 0), 0),
  );

  const parsedTax = parseTax(draft.sales_tax);
  const salesTax = Number.isNaN(parsedTax) ? 0 : parsedTax;

  // ── RULE B — flip to (a) incurred+options here if Jordan reverses ──────────
  const grandTotal = round2(includedOptions + salesTax);

  const profit = totalCost == null ? null : round2(grandTotal - totalCost);
  const marginPct = profit == null || grandTotal <= 0 ? null : (profit / grandTotal) * 100;

  return {
    incurredSubtotal: incurred.total,
    incurredExcluded: incurred.excluded,
    options,
    includedOptions,
    salesTax,
    grandTotal,
    totalCost,
    profit,
    marginPct,
  };
}

// ── Whole-quote validation (drives the error-summary chip beside the CTA) ────

export interface QuoteProblem {
  /** DOM id of the field to focus when the error chip is clicked. */
  fieldId: string;
  message: string;
}

/** Stable DOM id for one line-item field — shared by the input, its error
    message (aria-describedby) and the error chip's focus target. */
export function lineFieldId(lineKey: string, field: keyof LineErrors): string {
  return `line-${lineKey}-${field}`;
}

export function scopeFieldId(sectionKey: string, index: number): string {
  return `scope-${sectionKey}-${index}`;
}

/** Every blocking problem on the quote, in document order. */
export function quoteProblems(draft: DraftQuote): QuoteProblem[] {
  const problems: QuoteProblem[] = [];

  draft.sections.forEach((section, sectionIndex) => {
    if (section.kind === 'incurred') {
      if (section.narrative.trim() === '') {
        problems.push({ fieldId: 'inc-report', message: 'Tech report is required' });
      }
      if (section.scope_lines.every((s) => s.trim() === '')) {
        problems.push({
          fieldId: scopeFieldId(section.key, 0),
          message: 'At least one scope line is required',
        });
      }
    } else {
      // sections[0] is always INCURRED (fromQuote guarantees it), so the first
      // option sits at index 1 and is Option A.
      const label = `Option ${String.fromCharCode(64 + sectionIndex)}`;
      if (section.name.trim() === '') {
        problems.push({
          fieldId: `opt-${section.key}-name`,
          message: `${label} needs a name`,
        });
      }
      if (section.narrative.trim() === '') {
        problems.push({
          fieldId: `opt-${section.key}-narr`,
          message: `${label} needs a narrative`,
        });
      }
    }

    section.lines.forEach((line) => {
      Object.entries(lineErrors(line)).forEach(([key, message]) => {
        problems.push({
          fieldId: lineFieldId(line.key, key as keyof LineErrors),
          message,
        });
      });
    });
  });

  if (Number.isNaN(parseTax(draft.sales_tax))) {
    problems.push({ fieldId: 'sales-tax', message: 'Sales tax must be a number' });
  }

  return problems;
}

/** "1 field needs attention — fix it to submit" (the comp's string, pluralised). */
export function problemChipText(n: number): string {
  return n === 1
    ? '1 field needs attention — fix it to submit'
    : `${n} fields need attention — fix them to submit`;
}

/** Sections carry no lines at all → the quote prices nothing. Used to keep the
    primary CTA blocked on a freshly-created, still-empty draft. */
export function hasBillableWork(draft: DraftQuote): boolean {
  return draft.sections.some((s: DraftSection) => s.lines.length > 0);
}
