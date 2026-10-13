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
  QuoteTotalRule,
  QuoteUpdateInput,
} from '../api/client';
import type { QuoteDocumentType, QuoteDraftBody, QuoteDraftSection } from '@theone/shared';
import { parseLinePct, parseMoney, parsePct } from './quoteTotals';

// ── Vocabulary ────────────────────────────────────────────────────────────────────

/** The Yoda line types (Labor, Materials, Service, Fees, Discount) + part.
    Value is the stored lowercase enum; label is the display text. A discount's
    amount is negative BY TYPE — the operator still types a positive number. */
export const LINE_TYPES: { value: QuoteLineType; label: string }[] = [
  { value: 'service', label: 'Service' },
  { value: 'labor', label: 'Labor' },
  { value: 'part', label: 'Part' },
  { value: 'material', label: 'Material' },
  { value: 'fee', label: 'Fee' },
  { value: 'discount', label: 'Discount' },
];

/** The Day column's options (Yoda `Day` int). '' = single-day job. */
export const DAY_VALUES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

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
  /** '' = single day; otherwise the Day number as typed ('2'). */
  day_value: string;
  ot: boolean;
  /** 0048 · unit of measure ('' = none) and the line's own tax / markup
      percentages as RAW strings ('' = 0). */
  uom: string;
  tax_pct: string;
  markup_pct: string;
}

export interface DraftSection {
  key: string;
  /** Server id when the section came from the wire (needed to approve an option). */
  id: string | null;
  kind: 'incurred' | 'option';
  /** Option title ("Condenser fan motor + start kit replacement"); '' on incurred. */
  name: string;
  /** "Tech reported that…" / the option narrative. */
  narrative: string;
  scope_lines: string[];
  include_in_summary: boolean;
  lines: DraftLine[];
  /** Yoda round. Sections of earlier rounds are history and render locked. */
  round: number;
  locked: boolean;
  approved: boolean;
  rejection_note: string | null;
}

export interface DraftQuote {
  /** [0] is always the INCURRED section; the rest are the options in order
      (earlier-round options first, then the current round's). */
  sections: DraftSection[];
  current_round: number;
  /** Sales tax PERCENT as typed (D2). */
  sales_tax_pct: string;
  total_rule: QuoteTotalRule;
  bill_to: string;
  is_cost_tbd: boolean;
  specs: string;
  note_to_customer: string;
  /** Non-null = the operator used "Edit text" and pinned a manual summary. */
  summary_pinned: string | null;
  /** 0048 · the document fields (bill_to is above). */
  document_type: QuoteDocumentType;
  ship_to: string;
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
    uom: '',
    tax_pct: '',
    markup_pct: '',
  };
}

export function blankOption(round = 1): DraftSection {
  return {
    key: uid('opt'),
    id: null,
    kind: 'option',
    name: '',
    narrative: '',
    scope_lines: [],
    include_in_summary: true,
    lines: [blankLine()],
    round,
    locked: false,
    approved: false,
    rejection_note: null,
  };
}

function blankIncurred(): DraftSection {
  return {
    key: uid('inc'),
    id: null,
    kind: 'incurred',
    name: 'Work already performed',
    narrative: '',
    scope_lines: [''],
    include_in_summary: true,
    lines: [blankLine()],
    round: 1,
    locked: false,
    approved: false,
    rejection_note: null,
  };
}

// ── wire → draft ─────────────────────────────────────────────────────────────

/** Takes a saved section or an AI draft section (0054) — the draft is the
    builder's PUT body, so it carries the lines but no round, lock or
    decision: it lands in the current round, open for editing. */
function sectionToDraft(section: QuoteSection | QuoteDraftSection, currentRound: number): DraftSection {
  const saved = 'round' in section ? (section as QuoteSection) : null;
  const round = saved ? saved.round : currentRound;
  const locked = saved ? saved.locked || saved.round < currentRound : false;
  return {
    key: uid(section.kind === 'incurred' ? 'inc' : 'opt'),
    id: saved ? saved.id : null,
    kind: section.kind,
    name: section.name ?? '',
    narrative: section.narrative_reported ?? '',
    scope_lines:
      (section.scope_lines ?? []).length > 0 ? [...(section.scope_lines ?? [])] : locked ? [] : [''],
    include_in_summary: section.include_in_summary ?? true,
    lines: (section.lines ?? []).map((line) => ({
      key: uid('line'),
      line_type: line.line_type,
      description: line.description,
      qty: qtyToInput(line.qty),
      rate: rateToInput(line.rate),
      // A saved line carries the Day as a number; an AI draft line (0054) only
      // as text ("Day 2") — the digits are the Day either way.
      day_value:
        'day' in line && line.day != null
          ? String(line.day)
          : (line.day_value ?? '').replace(/\D/g, ''),
      ot: line.ot ?? false,
      uom: line.uom ?? '',
      tax_pct: (line.tax_pct ?? 0) > 0 ? String(line.tax_pct) : '',
      markup_pct: (line.markup_pct ?? 0) > 0 ? String(line.markup_pct) : '',
    })),
    round,
    locked,
    approved: saved ? saved.approved_at !== null : false,
    rejection_note: saved ? saved.rejection_note : null,
  };
}

function pctToInput(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return String(parseFloat(n.toFixed(3)));
}

/**
 * Build the editable draft from the saved quote. The incurred section is
 * guaranteed to exist and to sit at index 0 even if the server ever answers
 * without one — the comp has no "add incurred" affordance, so the screen would
 * otherwise be unbuildable. Options of earlier rounds come before the current
 * round's so the letters the server derived line up with the cards.
 */
export function fromQuote(quote: Quote): DraftQuote {
  const incurred = quote.sections.find((s) => s.kind === 'incurred');
  const options = quote.sections.filter((s) => s.kind === 'option');
  const inc = incurred ? sectionToDraft(incurred, quote.current_round) : blankIncurred();
  // From round 2 on the incurred work is what the client already approved — locked.
  if (quote.current_round > 1) inc.locked = true;
  return {
    sections: [inc, ...options.map((o) => sectionToDraft(o, quote.current_round))],
    current_round: quote.current_round,
    sales_tax_pct: pctToInput(quote.sales_tax_pct),
    total_rule: quote.total_rule,
    bill_to: quote.bill_to ?? '',
    is_cost_tbd: quote.is_cost_tbd,
    specs: quote.specs ?? '',
    note_to_customer: quote.note_to_customer ?? '',
    summary_pinned: quote.summary.pinned,
    document_type: quote.document_type ?? 'quote',
    ship_to: quote.ship_to ?? '',
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
        day: line.day_value === '' ? null : Number(line.day_value),
        ot: line.ot,
        uom: line.uom.trim() === '' ? null : line.uom.trim(),
        tax_pct: Number.isNaN(parseLinePct(line.tax_pct)) ? 0 : parseLinePct(line.tax_pct),
        markup_pct: Number.isNaN(parseLinePct(line.markup_pct)) ? 0 : parseLinePct(line.markup_pct),
      })),
  };
}

/**
 * Only the CURRENT round's unlocked sections go over the wire: earlier rounds
 * are history the server refuses to rewrite, and from round 2 on the incurred
 * section is locked too (409 SECTION_LOCKED if sent).
 */
export function toUpdateInput(draft: DraftQuote): QuoteUpdateInput {
  const pct = parsePct(draft.sales_tax_pct);
  return {
    sales_tax_pct: Number.isNaN(pct) ? 0 : pct,
    total_rule: draft.total_rule,
    bill_to: draft.bill_to.trim() === '' ? null : draft.bill_to.trim(),
    is_cost_tbd: draft.is_cost_tbd,
    specs: draft.specs.trim() === '' ? null : draft.specs,
    note_to_customer: draft.note_to_customer.trim() === '' ? null : draft.note_to_customer,
    summary_pinned: draft.summary_pinned,
    sections: draft.sections
      .filter((s) => !s.locked && s.round === draft.current_round)
      .map(sectionToInput),
    document_type: draft.document_type,
    ship_to: draft.ship_to.trim() === '' ? null : draft.ship_to,
  };
}

// ── AI quote draft (0054) ────────────────────────────────────────────────────

/** The AI draft (stored server-side as the builder's PUT body) → the form.
    What a draft does not carry — sales tax, the document fields, a pinned
    summary — takes the builder's defaults and is never sent on Submit quote,
    so the quote keeps its own values for them. */
export function fromDraftBody(body: QuoteDraftBody): DraftQuote {
  const incurred = body.sections.find((s) => s.kind === 'incurred');
  const options = body.sections.filter((s) => s.kind === 'option');
  return {
    sections: [
      incurred ? sectionToDraft(incurred, 1) : blankIncurred(),
      ...options.map((o) => sectionToDraft(o, 1)),
    ],
    current_round: 1,
    sales_tax_pct: '0',
    total_rule: 'incurred_plus_option',
    bill_to: '',
    is_cost_tbd: false,
    specs: body.specs ?? '',
    note_to_customer: body.note_to_customer ?? '',
    summary_pinned: null,
    document_type: 'quote',
    ship_to: '',
  };
}

/** The form → the AI draft body: the same conversion the builder saves with,
    trimmed to the three things a draft holds. */
export function toDraftBody(draft: DraftQuote): QuoteDraftBody {
  const input = toUpdateInput(draft);
  return {
    // The draft keeps the S4 line shape: the Day as text, every field present.
    sections: draft.sections.map(sectionToInput).map((s) => ({
      kind: s.kind,
      name: s.name ?? null,
      narrative_reported: s.narrative_reported ?? null,
      scope_lines: s.scope_lines ?? [],
      include_in_summary: s.include_in_summary ?? true,
      lines: (s.lines ?? []).map((l) => ({
        line_type: l.line_type,
        description: l.description,
        qty: l.qty,
        rate: l.rate,
        day_value: l.day == null ? null : `Day ${l.day}`,
        ot: l.ot ?? false,
        uom: l.uom ?? null,
        tax_pct: l.tax_pct ?? 0,
        markup_pct: l.markup_pct ?? 0,
      })),
    })),
    specs: input.specs ?? null,
    note_to_customer: input.note_to_customer ?? null,
  };
}

/** The sections the operator can still type into. */
export function editableSections(draft: DraftQuote): DraftSection[] {
  return draft.sections.filter((s) => !s.locked && s.round === draft.current_round);
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
