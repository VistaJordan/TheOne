/* The quote builder's LOCAL draft model.
 *
 * The server contract (@theone/shared) carries money as numbers. The builder
 * cannot: the hardened validation rules key off the RAW STRING the operator
 * typed — "-75", "5e3" and "12.34.56" must stay errors instead of silently
 * becoming 75, 53 and 12.34 (lib/quoteTotals.ts). So the form holds strings and
 * this module owns the two conversions, once each:
 *
 *   fromQuote()      wire → draft   (numbers formatted back into inputs)
 *   toUpdateInput()  draft → wire   (parsed, invalid fields sent as 0)
 *
 * `key` is a stable React identity, NOT a database id: PUT replaces the whole
 * section tree, so server ids do not survive a save and a row keyed by one would
 * remount (and lose focus) on every autosave round-trip.
 */

import type {
  Quote,
  QuoteLineType,
  QuoteSection,
  QuoteSectionInput,
  QuoteUpdateInput,
} from '../api/client';
import { parseMoney, parseTax } from './quoteTotals';

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The four line types (requirements §1). Value is the stored lowercase enum
    (0003 CHECK constraint); label is the comp's capitalised display text. */
export const LINE_TYPES: { value: QuoteLineType; label: string }[] = [
  { value: 'service', label: 'Service' },
  { value: 'labor', label: 'Labor' },
  { value: 'part', label: 'Part' },
  { value: 'material', label: 'Material' },
];

/** The Day column's options. The selected value is stored VERBATIM and no math
    is ever done on it — its semantics are TBD (errata §3 / requirements §4.1). */
export const DAY_VALUES = ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5'];

/** 'Option A', 'Option B', … derived from position among the option sections —
    the letter is never stored, so deleting A promotes B. */
export function optionLabel(index: number): string {
  return `Option ${String.fromCharCode(65 + index)}`;
}

/** Just the letter, for the comp's round .opt-tag. */
export function optionTag(index: number): string {
  return String.fromCharCode(65 + index);
}

// ── Draft shapes ─────────────────────────────────────────────────────────────

export interface DraftLine {
  key: string;
  line_type: QuoteLineType;
  description: string;
  /** RAW user input — validated as typed, never pre-sanitised. */
  qty: string;
  rate: string;
  /** '' = nothing selected. */
  day_value: string;
  ot: boolean;
}

export interface DraftSection {
  key: string;
  kind: 'incurred' | 'option';
  /** Option title ("Condenser fan motor + start kit replacement"); '' on incurred. */
  name: string;
  /** "Tech reported that…" / the option narrative. */
  narrative: string;
  scope_lines: string[];
  include_in_summary: boolean;
  lines: DraftLine[];
}

export interface DraftQuote {
  /** [0] is always the INCURRED section; the rest are the options in order. */
  sections: DraftSection[];
  sales_tax: string;
  specs: string;
  note_to_customer: string;
  /** Non-null = the operator used "Edit text" and pinned a manual summary. */
  summary_pinned: string | null;
  /** "Show all options as separate quotes" — UI-only. Migration 0003 has no
      column for it, so it is deliberately not sent and not persisted. */
  separate_quotes: boolean;
}

let seq = 0;
export function uid(prefix = 'k'): string {
  seq += 1;
  return `${prefix}${seq}`;
}

// ── Formatting (wire → input) ────────────────────────────────────────────────

/** 1 → "1", 2.5 → "2.5" — a quantity keeps only the decimals it needs. */
function qtyToInput(n: number): string {
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 100) / 100);
}

/** 180 → "180.00" — money always carries cents in the builder. */
function rateToInput(n: number): string {
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}

// ── Constructors ─────────────────────────────────────────────────────────────

export function blankLine(): DraftLine {
  return {
    key: uid('line'),
    line_type: 'service',
    description: '',
    qty: '1',
    rate: '',
    day_value: '',
    ot: false,
  };
}

export function blankOption(): DraftSection {
  return {
    key: uid('opt'),
    kind: 'option',
    name: '',
    narrative: '',
    scope_lines: [],
    include_in_summary: true,
    lines: [blankLine()],
  };
}

function blankIncurred(): DraftSection {
  return {
    key: uid('inc'),
    kind: 'incurred',
    name: 'Work already performed',
    narrative: '',
    scope_lines: [''],
    include_in_summary: true,
    lines: [blankLine()],
  };
}

// ── wire → draft ─────────────────────────────────────────────────────────────

function sectionToDraft(section: QuoteSection): DraftSection {
  return {
    key: uid(section.kind === 'incurred' ? 'inc' : 'opt'),
    kind: section.kind,
    name: section.name ?? '',
    narrative: section.narrative_reported ?? '',
    scope_lines: section.scope_lines.length > 0 ? [...section.scope_lines] : [''],
    include_in_summary: section.include_in_summary,
    lines: section.lines.map((line) => ({
      key: uid('line'),
      line_type: line.line_type,
      description: line.description,
      qty: qtyToInput(line.qty),
      rate: rateToInput(line.rate),
      day_value: line.day_value ?? '',
      ot: line.ot,
    })),
  };
}

/**
 * Build the editable draft from the saved quote. The incurred section is
 * guaranteed to exist and to sit at index 0 even if the server ever answers
 * without one — the comp has no "add incurred" affordance, so the screen would
 * otherwise be unbuildable.
 */
export function fromQuote(quote: Quote): DraftQuote {
  const incurred = quote.sections.find((s) => s.kind === 'incurred');
  const options = quote.sections.filter((s) => s.kind === 'option');
  return {
    sections: [
      incurred ? sectionToDraft(incurred) : blankIncurred(),
      ...options.map(sectionToDraft),
    ],
    sales_tax: quote.totals.sales_tax.toFixed(2),
    specs: quote.specs ?? '',
    note_to_customer: quote.note_to_customer ?? '',
    summary_pinned: quote.summary.pinned,
    separate_quotes: false,
  };
}

// ── draft → wire ─────────────────────────────────────────────────────────────

/** A half-typed qty/rate saves as 0 rather than failing the autosave. Nothing is
    lost: an invalid line is excluded from every subtotal (with the note saying
    so) and blocks submit until it is fixed — see quoteProblems(). */
function toNumber(raw: string): number {
  const n = parseMoney(raw);
  return Number.isNaN(n) ? 0 : n;
}

function sectionToInput(section: DraftSection): QuoteSectionInput {
  return {
    kind: section.kind,
    name: section.name.trim() === '' ? null : section.name.trim(),
    narrative_reported: section.narrative.trim() === '' ? null : section.narrative,
    // The API requires every scope line to be non-empty, so blanks (including
    // the placeholder row a fresh section opens with) never go over the wire.
    scope_lines: section.scope_lines.map((s) => s.trim()).filter((s) => s.length > 0),
    include_in_summary: section.include_in_summary,
    // A line with no description CANNOT be saved: the route's Zod schema demands
    // description.min(1) and rejects the whole body otherwise. Sending the row
    // anyway would 400 the autosave — permanently, for as long as one unfinished
    // row sat on the form — so an unnamed row stays local until it has a
    // description. It is still counted as a blocking problem by quoteProblems(),
    // so it cannot be forgotten: the CTA stays blocked and points at it.
    lines: section.lines
      .filter((line) => line.description.trim() !== '')
      .map((line) => ({
        line_type: line.line_type,
        description: line.description.trim(),
        qty: toNumber(line.qty),
        rate: toNumber(line.rate),
        day_value: line.day_value === '' ? null : line.day_value,
        ot: line.ot,
      })),
  };
}

export function toUpdateInput(draft: DraftQuote): QuoteUpdateInput {
  const tax = parseTax(draft.sales_tax);
  return {
    sales_tax: Number.isNaN(tax) ? 0 : tax,
    specs: draft.specs.trim() === '' ? null : draft.specs,
    note_to_customer: draft.note_to_customer.trim() === '' ? null : draft.note_to_customer,
    summary_pinned: draft.summary_pinned,
    sections: draft.sections.map(sectionToInput),
  };
}

// ── Immutable list helpers (used by every editor in components/quote) ─────────

export function replaceAt<T>(list: T[], index: number, next: T): T[] {
  return list.map((item, i) => (i === index ? next : item));
}

export function removeAt<T>(list: T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

/** Move `from` to `to`, clamping — the drag/keyboard reorder of scope lines and
    line items both route through this. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const target = Math.min(Math.max(to, 0), list.length - 1);
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}
