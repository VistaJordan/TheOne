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

/** A sales-tax PERCENT (D2): 0–30, up to three decimals ("8.25", "8.375"). */
export function parsePct(v: string | null | undefined): number {
  const raw = String(v ?? '').replace(/[%\s]/g, '');
  if (raw === '') return 0;
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(raw)) return NaN;
  const n = parseFloat(raw);
  return n <= 30 ? n : NaN;
}

/** '$2,890.00' — quote money always carries cents; negatives print '-$75.00'. */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

/** '$3,202' — the NTE headline + meter scale, which the comp renders whole. */
export function usd0(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** A line's computed amount, or null when the line is not yet valid. Amount is
    never an input (§3.6 read-only-distinction): qty × rate, ×1.5 when OT,
    NEGATIVE for a discount line (the sign comes from the type). */
export function lineAmount(line: DraftLine): number | null {
  const q = parseMoney(line.qty);
  const r = parseMoney(line.rate);
  if (Number.isNaN(q) || Number.isNaN(r)) return null;
  const sign = line.line_type === 'discount' ? -1 : 1;
  return round2(sign * q * r * (line.ot ? OT_MULTIPLIER : 1));
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
  /** Server section id (null for a not-yet-saved option). */
  id: string | null;
  label: string;
  name: string;
  /** The option's own lines. */
  total: number;
  /** Tax on (incurred + option) under the Yoda rule; 0 under RULE B. */
  tax: number;
  /** The client price of choosing this option. */
  grandTotal: number;
  /** 1-based line numbers left out of the total because they are invalid. */
  excluded: number[];
  include_in_summary: boolean;
  approved: boolean;
}

export interface QuoteTotals {
  totalRule: 'incurred_plus_option' | 'options_only';
  /** Incurred section + options approved in earlier rounds. */
  incurredSubtotal: number;
  incurredExcluded: number[];
  /** The CURRENT round's options. */
  options: OptionTotal[];
  /** Sum of the option sections with include_in_summary = true (RULE B basis). */
  includedOptions: number;
  salesTaxPct: number;
  /** Computed $ tax inside grandTotal. */
  salesTax: number;
  grandTotal: number;
  /** Which option grandTotal prices (key), null when none. */
  pricedKey: string | null;
  totalCost: number | null;
  profit: number | null;
  marginPct: number | null;
}

/**
 * THE grand-total rule — one function, one place, server parity with
 * computeQuoteTotals() in apps/api/src/services/quotes.ts.
 *
 * D1 — `total_rule`:
 *   incurred_plus_option (Yoda, default): each option is priced as
 *     (incurred + option) × (1 + tax%). grandTotal is the APPROVED option's price
 *     when the client has chosen, else the first included option's; with no
 *     option at all it is the incurred work alone (× tax).
 *   options_only (RULE B): Σ included option totals, incurred is context, no tax.
 *
 * Options approved in an EARLIER round price as incurred (Yoda IsIncurred = 1).
 *
 * `totalCost` is our cost on the proposed work (server-held, not part of the
 * draft form), passed in so profit/margin land in the same result.
 */
export function computeQuoteTotals(draft: DraftQuote, totalCost: number | null = null): QuoteTotals {
  const yoda = draft.total_rule !== 'options_only';
  const parsedPct = parsePct(draft.sales_tax_pct);
  const pct = Number.isNaN(parsedPct) ? 0 : parsedPct;
  const taxOn = (base: number) => (yoda ? round2((base * pct) / 100) : 0);

  const incurredLike = draft.sections.filter(
    (s) => s.kind === 'incurred' || (s.kind === 'option' && s.approved && s.round < draft.current_round),
  );
  let incurredSubtotal = 0;
  const incurredExcluded: number[] = [];
  for (const s of incurredLike) {
    const sum = sumLines(s.lines);
    incurredSubtotal = round2(incurredSubtotal + sum.total);
    if (s.kind === 'incurred') incurredExcluded.push(...sum.excluded);
  }

  const options: OptionTotal[] = draft.sections
    .filter((s) => s.kind === 'option' && s.round === draft.current_round)
    .map((opt, i) => {
      const sum = sumLines(opt.lines);
      const base = yoda ? round2(incurredSubtotal + sum.total) : sum.total;
      const tax = taxOn(base);
      return {
        key: opt.key,
        id: opt.id,
        label: `Option ${String.fromCharCode(65 + i)}`,
        name: opt.name,
        total: sum.total,
        tax,
        grandTotal: round2(base + tax),
        excluded: sum.excluded,
        include_in_summary: opt.include_in_summary,
        approved: opt.approved,
      };
    });

  const includedOptions = round2(
    options.reduce((acc, o) => acc + (o.include_in_summary ? o.total : 0), 0),
  );

  let grandTotal: number;
  let salesTax: number;
  let pricedKey: string | null = null;
  if (yoda) {
    const priced = options.find((o) => o.approved) ?? options.find((o) => o.include_in_summary) ?? null;
    if (priced) {
      grandTotal = priced.grandTotal;
      salesTax = priced.tax;
      pricedKey = priced.key;
    } else {
      salesTax = taxOn(incurredSubtotal);
      grandTotal = round2(incurredSubtotal + salesTax);
    }
  } else {
    // ── RULE B ────────────────────────────────────────────────────────────────────
    grandTotal = includedOptions;
    salesTax = 0;
  }

  const profit = totalCost == null ? null : round2(grandTotal - totalCost);
  const marginPct = profit == null || grandTotal <= 0 ? null : (profit / grandTotal) * 100;

  return {
    totalRule: yoda ? 'incurred_plus_option' : 'options_only',
    incurredSubtotal,
    incurredExcluded,
    options,
    includedOptions,
    salesTaxPct: pct,
    salesTax,
    grandTotal,
    pricedKey,
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

/** Every blocking problem on the quote, in document order. Locked sections are
    history and never block. */
export function quoteProblems(draft: DraftQuote): QuoteProblem[] {
  const problems: QuoteProblem[] = [];
  let optionIndex = 0;

  draft.sections.forEach((section) => {
    if (section.locked || section.round !== draft.current_round) {
      if (section.kind === 'option') optionIndex++;
      return;
    }
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
      const label = `Option ${String.fromCharCode(65 + optionIndex++)}`;
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

  if (Number.isNaN(parsePct(draft.sales_tax_pct))) {
    problems.push({ fieldId: 'sales-tax', message: 'Sales tax must be a percentage between 0 and 30' });
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
