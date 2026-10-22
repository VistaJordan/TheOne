// Quote service (S4) — the Yoda replacement.
//
// THREE responsibilities, in this order of importance:
//
//  1. computeQuoteTotals() — the ONE place quote arithmetic happens. Amounts are
//     never stored (migration 0003 header); every number the screen shows comes
//     out of this function.
//  2. buildAutoSummary() — the client-facing text block, generated server-side
//     from the narratives + included lines + totals on the comp's fixed
//     38-column monospace grid. `quote.summary_pinned` overrides it.
//  3. The lifecycle: draft → pending_approval → approved → sent (+ reject back
//     to draft), each transition role-gated and written to activity_log.
//
// Ordering: the acting principal and the pre-checks are reads that need no
// lock, so they run on the pool BEFORE withTransaction() opens and the
// transaction holds its connection for the writes alone. A write that depends
// on a row it read must re-read that row under a lock inside the transaction;
// transition() and updateQuote() do not yet: they check the quote's status on
// a pool read and their writes do not repeat the check.

import { query, withTransaction } from '../db.js';
import { assertQuoteHeld } from './statusGates.js';
import {
  CLIENT_APPROVAL_EVIDENCE_CODE,
  isDispatcherRole,
  quoteEventStatusName,
  quoteSubmitTarget,
  QUOTE_CORRECTION_PENDING_CODE,
  QUOTE_CORRECTION_PENDING_TEXT,
  QUOTE_SUBMIT_ACTION,
  type QuoteEvent,
  type QuoteSubmitFrom,
  type VisitStatusMove,
} from '@theone/shared';
import type { Queryable } from '../db.js';
import type {
  Quote,
  QuoteLine,
  QuoteLineType,
  QuoteSection,
  QuoteStatus,
  QuoteTotals,
  QuoteTotalRule,
  QuoteOptionTotal,
  QuoteSummary,
  QuotePermissions,
  QuoteRates,
  QuoteDocumentType,
  ActivityActor,
  LaborRate,
  SalesTaxLookup,
  WoActionMap,
} from '@theone/shared';
import {
  DEFAULT_OT_MULTIPLIER,
  QUOTE_DEFAULT_DAY,
  QUOTE_DEFAULT_TRIP_DESCRIPTION,
  QUOTE_OVER_NTE_CODE,
  SELF_APPROVAL_CODE,
  defaultScopeLines,
  optionDisplayLabel,
  permAllows,
  quoteOverNte,
  selfApprovalMessage,
  selfApprovalVerdict,
  reportedSentence,
  visibleScopeLines,
} from '@theone/shared';
import { ApiError, badRequest, conflict, forbidden } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { evaluateForTask } from './obligations.js';
import { contractForTask } from './contracts.js';
import { Params } from './woFields.js';
import { woScopeSql } from './woScope.js';
import { assertNoOpenNteOverride, openNteOverride } from './approvals.js';
import { assertWoAllows, woStatusSnapshot } from './woPolicy.js';
import type { WoStatusSnapshot } from './woPolicy.js';
import { enqueueOutbox } from './outbox.js';
import { lookupSalesTax } from './salesTax.js';
import { findLaborRate } from './rates.js';

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

// ═══════════════════════════════════════════════════════════════════════════
// 1 · ARITHMETIC
// ═══════════════════════════════════════════════════════════════════════════

/** Overtime is a flat rate multiplier (Jordan, 2026-07-30: "OT = overtime,
    ×1.5 rate") — the HOUSE default. Since 0046 a quote raised under a contract
    carries its own (`quote.ot_multiplier`), passed in through TotalsInput. */
export const OT_MULTIPLIER = DEFAULT_OT_MULTIPLIER;

/** Kill float noise: 2.5 × 180 × 1.5 must be 675, not 674.9999999999999. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** The minimum shape computeQuoteTotals needs from a line. */
export interface TotalsLineInput {
  qty: number;
  rate: number;
  ot: boolean;
  /** `discount` flips the sign; every other type is positive. */
  line_type?: QuoteLineType;
  /** 0048 · percentages; absent = 0. */
  tax_pct?: number;
  markup_pct?: number;
}

/** The minimum shape computeQuoteTotals needs from a section. */
export interface TotalsSectionInput {
  id: string;
  kind: 'incurred' | 'option';
  label: string;
  name: string | null;
  include_in_summary: boolean;
  lines: TotalsLineInput[];
  /** How this section prices. Defaults to `kind`; an option the client approved
      in an EARLIER round prices as incurred for the current round (Yoda sets
      its lines IsIncurred = 1). */
  priced_as?: 'incurred' | 'option';
}

export interface TotalsInput {
  sections: TotalsSectionInput[];
  sales_tax_pct: number;
  total_rule: QuoteTotalRule;
  /** The option the client approved — when set it is the one `grand_total` prices. */
  approved_section_id?: string | null;
  total_cost: number | null;
  nte: number | null;
  /** 0048 · the quote's own OT multiplier; absent = the house default. */
  ot_multiplier?: number;
}

/**
 * One line's money: qty × rate, × (1 + markup) when a markup is set (0048), ×
 * the OT multiplier when the OT flag is set (the house ×1.5, or the
 * contract's), NEGATIVE for a discount line (the sign comes from the type,
 * never from the input — the money validation still refuses a typed minus).
 */
export function computeLineAmount(line: TotalsLineInput, otMultiplier: number = OT_MULTIPLIER): number {
  const qty = Number.isFinite(line.qty) ? line.qty : 0;
  const rate = Number.isFinite(line.rate) ? line.rate : 0;
  const markup = Number.isFinite(line.markup_pct ?? 0) ? (line.markup_pct ?? 0) : 0;
  const sign = line.line_type === 'discount' ? -1 : 1;
  return round2(sign * qty * rate * (1 + markup / 100) * (line.ot ? otMultiplier : 1));
}

/** 0048 · the tax a line carries, from its own rate. 0 when it has none. */
export function computeLineTax(line: TotalsLineInput, otMultiplier: number = OT_MULTIPLIER): number {
  const pct = Number.isFinite(line.tax_pct ?? 0) ? (line.tax_pct ?? 0) : 0;
  if (pct <= 0) return 0;
  return round2((computeLineAmount(line, otMultiplier) * pct) / 100);
}

/**
 * Every number on the quote screen. The single home of quote arithmetic — the
 * money rail, the NTE meter, the summary and money.quote on the WO detail all
 * read the result of this function and never re-add anything themselves.
 *
 * D1 — `total_rule`:
 *   incurred_plus_option (Yoda, default): each option is priced as
 *     (incurred + option) × (1 + tax%). `grand_total` is the APPROVED option's
 *     price when the client has chosen, else the first included option's; with
 *     no option at all it is the incurred work alone (× tax).
 *   options_only (RULE B): Σ included option totals, incurred is context, no tax.
 *
 * 0048 · a line may carry its own tax rate. That per-line tax rides with its
 * section: under the Yoda rule an option's price adds the incurred lines' tax
 * and its own (`line_tax` is the priced option's share); under RULE B the
 * included options' line taxes add into the grand total, as before.
 *
 * `profit` is grand_total − total_cost (null while our cost is unknown);
 * `margin_pct` is profit / grand_total × 100, to one decimal.
 */
export function computeQuoteTotals(input: TotalsInput): QuoteTotals {
  const pct = Number.isFinite(input.sales_tax_pct) ? Math.max(0, input.sales_tax_pct) : 0;
  const yoda = input.total_rule !== 'options_only';
  const mult = input.ot_multiplier && input.ot_multiplier > 0 ? input.ot_multiplier : OT_MULTIPLIER;
  const taxOn = (base: number) => (yoda ? round2((base * pct) / 100) : 0);

  let incurred_subtotal = 0;
  let incurred_line_tax = 0;
  const optionSections: { section: TotalsSectionInput; total: number; lineTax: number }[] = [];

  for (const section of input.sections) {
    const subtotal = round2(section.lines.reduce((sum, line) => sum + computeLineAmount(line, mult), 0));
    const lineTax = round2(section.lines.reduce((sum, line) => sum + computeLineTax(line, mult), 0));
    if ((section.priced_as ?? section.kind) === 'incurred') {
      incurred_subtotal = round2(incurred_subtotal + subtotal);
      incurred_line_tax = round2(incurred_line_tax + lineTax);
    } else {
      optionSections.push({ section, total: subtotal, lineTax });
    }
  }

  const option_totals: QuoteOptionTotal[] = optionSections.map(({ section, total, lineTax }) => {
    const base = yoda ? round2(incurred_subtotal + total) : total;
    const tax = taxOn(base);
    const ownLineTax = yoda ? round2(incurred_line_tax + lineTax) : lineTax;
    return {
      section_id: section.id,
      label: section.label,
      name: section.name,
      include_in_summary: section.include_in_summary,
      total,
      tax,
      grand_total: round2(base + tax + ownLineTax),
    };
  });
  const lineTaxOf = (id: string) => optionSections.find((x) => x.section.id === id)?.lineTax ?? 0;

  let grand_total: number;
  let sales_tax: number;
  let line_tax: number;
  let priced_section_id: string | null = null;

  if (yoda) {
    const priced =
      option_totals.find((o) => o.section_id === input.approved_section_id) ??
      option_totals.find((o) => o.include_in_summary) ??
      null;
    if (priced) {
      grand_total = priced.grand_total;
      sales_tax = priced.tax;
      line_tax = round2(incurred_line_tax + lineTaxOf(priced.section_id));
      priced_section_id = priced.section_id;
    } else {
      sales_tax = taxOn(incurred_subtotal);
      line_tax = incurred_line_tax;
      grand_total = round2(incurred_subtotal + sales_tax + line_tax);
    }
  } else {
    // ── RULE B ──────────────────────────────────────────────────────────────
    line_tax = round2(
      optionSections.reduce((sum, o) => sum + (o.section.include_in_summary ? o.lineTax : 0), 0),
    );
    grand_total = round2(
      option_totals.reduce((sum, o) => sum + (o.include_in_summary ? o.total : 0), 0) + line_tax,
    );
    sales_tax = 0;
  }

  const total_cost = input.total_cost === null ? null : round2(input.total_cost);
  const profit = total_cost === null ? null : round2(grand_total - total_cost);
  const margin_pct =
    profit !== null && grand_total > 0 ? Math.round((profit / grand_total) * 1000) / 10 : null;

  return {
    total_rule: yoda ? 'incurred_plus_option' : 'options_only',
    incurred_subtotal,
    option_totals,
    grand_total,
    sales_tax,
    line_tax,
    sales_tax_pct: pct,
    priced_section_id,
    nte: input.nte === null ? null : round2(input.nte),
    total_cost,
    profit,
    margin_pct,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE CLIENT SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

/** The comp lays the summary out on a fixed 38-column monospace grid. */
const SUMMARY_WIDTH = 38;

function money(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function pctText(p: number): string {
  return `${parseFloat(p.toFixed(3))}%`;
}

/** Greedy wrap to `width`, `indent` on every line, `firstIndent` on the first. */
function wrap(text: string, width: number, indent = '', firstIndent = indent): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: string[] = [];
  let line = firstIndent;
  let pad = firstIndent;
  for (const word of words) {
    const candidate = line === pad ? line + word : `${line} ${word}`;
    if (candidate.length > width && line !== pad) {
      out.push(line);
      line = indent + word;
      pad = indent;
    } else {
      line = candidate;
    }
  }
  out.push(line);
  return out;
}

/**
 * A money row: label on the left, amount right-aligned to column 38. A label
 * too long to share the line wraps first and the amount lands on its last line
 * (truncating a client-facing description to fit would lose words).
 */
function amountRows(label: string, amount: number, indent = '  '): string[] {
  const amt = money(amount);
  const lines = wrap(label, SUMMARY_WIDTH - amt.length - 2, indent);
  if (lines.length === 0) return [indent + amt.padStart(SUMMARY_WIDTH - indent.length)];
  const last = lines[lines.length - 1];
  const gap = Math.max(2, SUMMARY_WIDTH - last.length - amt.length);
  lines[lines.length - 1] = last + ' '.repeat(gap) + amt;
  return lines;
}

/** Work-order context the summary header is built from. */
export interface SummaryContext {
  client: string | null;
  store: string | null;
  city: string | null;
  state: string | null;
  ext_name: string | null;
  trade: string | null;
  title: string | null;
  note_to_customer: string | null;
}

/** Line rows for one section, grouped "Day N" when the job spans several days
    (Yoda prints the prefix only when max Day > 1). */
function lineRows(lines: QuoteLine[], multiDay: boolean): string[] {
  const out: string[] = [];
  let lastDay: number | null | undefined;
  for (const line of lines) {
    if (multiDay && line.day !== lastDay) {
      out.push(`  Day ${line.day ?? '—'}`);
      lastDay = line.day;
    }
    out.push(...amountRows(line.description, line.amount, multiDay ? '    ' : '  '));
  }
  return out;
}

/**
 * The auto-generated client text — narratives + the included line items +
 * totals, in the approved comp's format:
 *
 *     7-ELEVEN #41669 — GALVESTON, TX
 *     Ref WOT0452814 · Refrigeration
 *     …
 *     INCURRED / PROPOSED — OPTION A / GRAND TOTAL / note to customer
 *
 * Only options flagged include_in_summary appear — the same set the totals
 * price. Under the Yoda rule each option prints ITS OWN grand total (incurred +
 * option + tax) so the client can read the price of choosing it; the closing
 * GRAND TOTAL is the approved option's (or the first included one's).
 *
 * Scope lines ("Required is to…") are the JOB's scope of work: the comp edits
 * them on the incurred card and prints them under the proposed option. So an
 * option prints its OWN scope_lines when it has any, and the first included
 * option falls back to the incurred section's list — one documented fallback,
 * and a future per-option scope needs no code change.
 */
export function buildAutoSummary(
  ctx: SummaryContext,
  sections: QuoteSection[],
  totals: QuoteTotals,
): string {
  const out: string[] = [];
  const yoda = totals.total_rule !== 'options_only';
  const multiDay = sections.some((s) => s.lines.some((l) => (l.day ?? 1) > 1));

  // ── Header ────────────────────────────────────────────────────────────────
  // Any of client / store / city / state can be missing on a sparse WO, so the
  // header is assembled from whatever is actually there — never with a dangling
  // separator or a leading space.
  const client = ctx.client ? ctx.client.toUpperCase() : null;
  const store = ctx.store ? `#${ctx.store}` : null;
  const place = [ctx.city ? ctx.city.toUpperCase() : null, ctx.state].filter(Boolean).join(', ');
  const head = [[client, store].filter(Boolean).join(' '), place]
    .filter((s) => s.length > 0)
    .join(' — ');
  if (head) out.push(head);
  const ref = [ctx.ext_name ? `Ref ${ctx.ext_name}` : null, ctx.trade].filter(Boolean).join(' · ');
  if (ref) out.push(ref);
  if (ctx.title) out.push(...wrap(ctx.title, SUMMARY_WIDTH));

  // ── Incurred (the incurred section + options approved in earlier rounds) ──
  const incurredLike = sections.filter(
    (s) => s.kind === 'incurred' || (s.kind === 'option' && s.approved_at !== null && s.locked),
  );
  const pricedOptions = sections.filter(
    (s) => s.kind === 'option' && !incurredLike.includes(s) && s.include_in_summary,
  );
  for (const section of incurredLike) {
    out.push('', section.kind === 'incurred' ? 'INCURRED' : `INCURRED — ${section.label.toUpperCase()} (APPROVED)`);
    if (section.name && section.kind === 'option') out.push(...wrap(section.name, SUMMARY_WIDTH));
    if (section.narrative_reported) {
      out.push(
        ...wrap(
          section.kind === 'incurred'
            ? reportedSentence(section.narrative_reported) // L1 (Wave D): never "Tech reported that Tech found…"
            : section.narrative_reported,
          SUMMARY_WIDTH,
        ),
      );
    }
    if (section.lines.length > 0) out.push('');
    out.push(...lineRows(section.lines, multiDay));
  }
  if (incurredLike.length > 0) out.push(...amountRows('Incurred subtotal', totals.incurred_subtotal));

  // ── Proposed options ──────────────────────────────────────────────────────
  const incurredScope = visibleScopeLines(sections.filter((s) => s.kind === 'incurred').flatMap((s) => s.scope_lines));
  let usedFallbackScope = false;

  // A lone option is the proposal, with no letter and no name (2026-10-22);
  // letters and names appear once the client has a choice. Blank scope lines
  // (the unfilled defaults) are never printed.
  const optionCount = pricedOptions.length;
  const named = (label: string) => optionDisplayLabel(label, optionCount);
  for (const section of pricedOptions) {
    const total = totals.option_totals.find((o) => o.section_id === section.id);
    out.push('', optionCount > 1 ? `PROPOSED — ${section.label.toUpperCase()}` : 'PROPOSED');
    if (section.name && optionCount > 1) out.push(...wrap(section.name, SUMMARY_WIDTH));
    if (section.narrative_reported) {
      out.push('', ...wrap(section.narrative_reported, SUMMARY_WIDTH));
    }

    let scope = visibleScopeLines(section.scope_lines);
    if (scope.length === 0 && !usedFallbackScope) {
      scope = incurredScope;
      usedFallbackScope = true;
    }
    if (scope.length > 0) {
      out.push('', 'Required is to:');
      scope.forEach((text, i) => {
        const n = `${i + 1}`.padStart(2);
        out.push(...wrap(text, SUMMARY_WIDTH, '    ', `${n}. `));
      });
    }

    if (section.lines.length > 0) out.push('');
    out.push(...lineRows(section.lines, multiDay));
    out.push(...amountRows(`${named(section.label)} total`, total ? total.total : 0));
    if (yoda && total) {
      if (totals.sales_tax_pct > 0) {
        out.push(...amountRows(`Sales tax (${pctText(totals.sales_tax_pct)})`, total.tax));
      }
      out.push(...amountRows(optionCount > 1 ? `${section.label} grand total` : 'Grand total', total.grand_total));
    }
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  out.push('');
  if (yoda) {
    const priced = totals.option_totals.find((o) => o.section_id === totals.priced_section_id);
    out.push(
      ...amountRows(
        priced && optionCount > 1 ? `GRAND TOTAL — ${priced.label.toUpperCase()}` : 'GRAND TOTAL',
        totals.grand_total,
        '',
      ),
    );
    if (totals.sales_tax_pct > 0 && !priced) {
      out.push(...amountRows(`Sales tax (${pctText(totals.sales_tax_pct)})`, totals.sales_tax, ''));
    }
  } else {
    out.push(...amountRows('GRAND TOTAL', totals.grand_total, ''));
  }
  if (totals.nte !== null) {
    out.push(
      totals.grand_total > totals.nte
        ? `Over the client NTE by ${money(round2(totals.grand_total - totals.nte))}.`
        : `Within the client NTE of ${money(totals.nte)}.`,
    );
  }

  // ── Note to customer ──────────────────────────────────────────────────────
  if (ctx.note_to_customer) {
    out.push('');
    for (const para of ctx.note_to_customer.split(/\n+/)) {
      out.push(...wrap(para, SUMMARY_WIDTH));
    }
  }

  return out.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · PERMISSION GATES
// ═══════════════════════════════════════════════════════════════════════════

// Since 0015 WHO may do a thing comes from the permission tree — the role's
// grants plus the person's own overrides — so "this OM specifically may not
// build quotes" is expressible without inventing a role for one person. WHEN
// the work order lets them is `assertWoAllows` (allowedWoActions), checked by
// every write below.

export function canEditQuote(actor: ActingPrincipal): boolean {
  return permAllows(actor.perms, 'quotes', 'edit', actor.isSuperAdmin);
}

export function canCreateQuote(actor: ActingPrincipal): boolean {
  return permAllows(actor.perms, 'quotes', 'create', actor.isSuperAdmin);
}

export function canApproveQuote(actor: ActingPrincipal): boolean {
  return permAllows(actor.perms, 'quotes', 'approve', actor.isSuperAdmin);
}

/** D5 — whoever may approve a quote may record the client's answer; a
    dispatcher (any OM tier) may record an ON-SITE client approval while the
    WO sits in the Approval phase. The phase exception is a business rule tied
    to the lifecycle, not a grant, so it stays a role test — over D3's one
    list of dispatchers. */
export function canClientDecide(actor: ActingPrincipal, snap: WoStatusSnapshot | null): boolean {
  if (canApproveQuote(actor)) return true;
  return isDispatcherRole(actor.role) && snap?.phase === 'Approval';
}

/** 403 FORBIDDEN — the actor exists, the route exists, the grant is missing. */
export function assertCanEdit(actor: ActingPrincipal): void {
  if (!canEditQuote(actor)) {
    throw forbidden('You cannot build or edit quotes', {
      actor: actor.name,
      role: actor.roleLabel ?? actor.role,
      required_permission: 'quotes:edit',
    });
  }
}

export function assertCanCreate(actor: ActingPrincipal): void {
  if (!canCreateQuote(actor)) {
    throw forbidden('You cannot create quotes', {
      actor: actor.name,
      role: actor.roleLabel ?? actor.role,
      required_permission: 'quotes:create',
    });
  }
}

export function assertCanApprove(actor: ActingPrincipal): void {
  if (!canApproveQuote(actor)) {
    throw forbidden('You cannot approve or send quotes', {
      actor: actor.name,
      role: actor.roleLabel ?? actor.role,
      required_permission: 'quotes:approve',
    });
  }
}

export function assertCanClientDecide(actor: ActingPrincipal, snap: WoStatusSnapshot): void {
  if (!canClientDecide(actor, snap)) {
    throw forbidden(
      'Recording the client decision needs quotes:approve (or a dispatcher while the work order is awaiting approval)',
      { actor: actor.name, role: actor.roleLabel ?? actor.role, required_permission: 'quotes:approve', phase: snap.phase },
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · READ
// ═══════════════════════════════════════════════════════════════════════════

interface QuoteRow {
  id: string;
  task_id: string;
  status: QuoteStatus;
  rev: number | string;
  sales_tax_pct: number | null;
  total_rule: QuoteTotalRule;
  bill_to: string | null;
  is_cost_tbd: boolean;
  total_cost: number | null;
  specs: string | null;
  note_to_customer: string | null;
  summary_pinned: string | null;
  sent_at: string | null;
  approved_section_id: string | null;
  client_decided_at: string | null;
  client_decision_note: string | null;
  client_approved_on_site: boolean;
  created_at: string;
  updated_at: string;
  created_by_id: string | null;
  created_by_name: string | null;
  created_by_kind: 'human' | 'service' | null;
  approved_by_id: string | null;
  approved_by_name: string | null;
  approved_by_kind: 'human' | 'service' | null;
  sent_by_id: string | null;
  sent_by_name: string | null;
  sent_by_kind: 'human' | 'service' | null;
  cd_by_id: string | null;
  cd_by_name: string | null;
  cd_by_kind: 'human' | 'service' | null;
  wo_number: string;
  client: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  billing_entity: string | null;
  ext_name: string | null;
  title: string | null;
  nte: number | null;
  store: string | null;
  wo_due: string | null;
  wo_cost: string | null;
  wo_emergency: boolean | null;
  wo_escalated: boolean | null;
  /** 0048 · the document fields. */
  number: string | null;
  document_type: string;
  currency: string;
  ship_to: string | null;
  contract_id: string | null;
  contract_name: string | null;
  ot_multiplier: number | null;
  /** 0083 (D2): who sent it for approval (else who created it) — the one
      person who may not approve or send it. */
  maker_id: string | null;
}

/** The quote SELECT without a WHERE — every reader adds its own through
    quoteSql, never by editing this text (UAT review: a string replace on the
    SQL breaks silently the day the text it looks for moves). */
export const QUOTE_BASE_SQL = `
  SELECT q.id::text                       AS id,
         q.task_id::text                  AS task_id,
         q.status, q.rev,
         q.sales_tax_pct::float8          AS sales_tax_pct,
         q.total_rule, q.bill_to, q.is_cost_tbd,
         q.total_cost::float8             AS total_cost,
         q.specs, q.note_to_customer, q.summary_pinned,
         q.approved_section_id::text      AS approved_section_id,
         q.client_decision_note, q.client_approved_on_site,
         q.number, q.document_type, q.currency, q.ship_to,
         q.contract_id::text              AS contract_id,
         c.name                           AS contract_name,
         q.ot_multiplier::float8          AS ot_multiplier,
         COALESCE(q.submitted_by, q.created_by)::text AS maker_id,
         ${ISO('q.sent_at')}              AS sent_at,
         ${ISO('q.client_decided_at')}    AS client_decided_at,
         ${ISO('q.created_at')}           AS created_at,
         ${ISO('q.updated_at')}           AS updated_at,
         cb.id::text AS created_by_id,  cb.display_name AS created_by_name,  cb.kind::text AS created_by_kind,
         ab.id::text AS approved_by_id, ab.display_name AS approved_by_name, ab.kind::text AS approved_by_kind,
         sb.id::text AS sent_by_id,     sb.display_name AS sent_by_name,     sb.kind::text AS sent_by_kind,
         cd.id::text AS cd_by_id,       cd.display_name AS cd_by_name,       cd.kind::text AS cd_by_kind,
         t.wo_number, t.client, t.city, t.state, t.trade, t.billing_entity, t.ext_name, t.title,
         t.nte::float8                    AS nte,
         t.fields ->> 'Store'             AS store,
         t.fields ->> 'Due Date'          AS wo_due,
         t.fields ->> '34. Cost'          AS wo_cost,
         COALESCE(t.fields->'Emergency' = 'true'::jsonb, false) AS wo_emergency,
         COALESCE(t.fields->'Escalated' = 'true'::jsonb, false) AS wo_escalated
    FROM quote q
    JOIN task t ON t.id = q.task_id
    LEFT JOIN contract c ON c.id = q.contract_id
    LEFT JOIN principal cd ON cd.id = q.client_decided_by
    LEFT JOIN principal cb ON cb.id = q.created_by
    LEFT JOIN principal ab ON ab.id = q.approved_by
    LEFT JOIN principal sb ON sb.id = q.sent_by
`;

/** QUOTE_BASE_SQL + `WHERE <where>` + an optional tail (ORDER BY / LIMIT).
    `where` is SQL the caller wrote with `$n` placeholders — values always
    travel as parameters. */
export function quoteSql(where: string, tail = ''): string {
  return `${QUOTE_BASE_SQL}   WHERE ${where}${tail ? `\n   ${tail}` : ''}\n`;
}

/** One work order's quote. */
const QUOTE_BY_TASK_SQL = quoteSql('q.task_id = $1', 'LIMIT 1');
/** The statuses a quote's price binds in (the NTE meter, the over-quote hold). */
const BINDABLE_STATUS_SQL = "q.status IN ('approved','sent','client_approved')";

interface SectionRow {
  id: string;
  kind: 'incurred' | 'option';
  name: string | null;
  narrative_reported: string | null;
  scope_lines: unknown;
  include_in_summary: boolean;
  position: number | string;
  round: number | string;
  locked: boolean;
  approved_at: string | null;
  approved_by_id: string | null;
  approved_by_name: string | null;
  approved_by_kind: 'human' | 'service' | null;
  rejection_note: string | null;
}

interface LineRow {
  id: string;
  section_id: string;
  line_type: QuoteLine['line_type'];
  description: string;
  qty: number | null;
  rate: number | null;
  day_value: string | null;
  day: number | string | null;
  ot: boolean;
  uom: string | null;
  tax_pct: number | null;
  markup_pct: number | null;
  position: number | string;
}

const LINE_COLUMNS = `l.id::text AS id, l.section_id::text AS section_id, l.line_type, l.description,
            l.qty::float8 AS qty, l.rate::float8 AS rate, l.day_value, l.day, l.ot,
            l.uom, l.tax_pct::float8 AS tax_pct, l.markup_pct::float8 AS markup_pct, l.position`;

/** The multiplier a quote prices overtime with: its own (snapshotted from the
    contract at creation), else the house default. */
function multOf(q: { ot_multiplier: number | null }): number {
  return q.ot_multiplier !== null && Number(q.ot_multiplier) > 0 ? Number(q.ot_multiplier) : OT_MULTIPLIER;
}

function actorOf(
  id: string | null,
  name: string | null,
  kind: 'human' | 'service' | null,
): ActivityActor | null {
  return id === null ? null : { id, display_name: name ?? '', kind: kind ?? 'human' };
}

/** 'A', 'B', … 'Z', then 'AA' — derived from the option's ordinal, never stored. */
function optionLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Live sections + their lines: incurred first, then options by round and
 * position. Soft-deleted sections (declined siblings) are omitted. Option
 * letters restart per round so "Option A" in round 2 is round 2's first option.
 */
async function loadSections(quoteId: string, otMultiplier: number = OT_MULTIPLIER): Promise<QuoteSection[]> {
  const many = await loadSectionsFor([quoteId], new Map([[quoteId, otMultiplier]]));
  return many.get(quoteId) ?? [];
}

/** UAT T5 · the same read for several quotes at once — two queries, however
    many quotes — so a queue can price every row's quote without a round trip
    per row. Keyed by quote id; a quote with no live section maps to []. */
async function loadSectionsFor(
  quoteIds: readonly string[],
  multByQuote: Map<string, number>,
): Promise<Map<string, QuoteSection[]>> {
  const out = new Map<string, QuoteSection[]>();
  if (quoteIds.length === 0) return out;
  const secRes = await query<SectionRow & { quote_id: string }>(
    `SELECT s.quote_id::text AS quote_id, s.id::text AS id, s.kind, s.name, s.narrative_reported, s.scope_lines,
            s.include_in_summary, s.position, s.round, s.locked, s.rejection_note,
            ${ISO('s.approved_at')} AS approved_at,
            ab.id::text AS approved_by_id, ab.display_name AS approved_by_name, ab.kind::text AS approved_by_kind
       FROM quote_section s
       LEFT JOIN principal ab ON ab.id = s.approved_by
      WHERE s.quote_id = ANY($1::uuid[]) AND s.deleted_at IS NULL
      ORDER BY CASE s.kind WHEN 'incurred' THEN 0 ELSE 1 END, s.round ASC, s.position ASC, s.id ASC`,
    [quoteIds],
  );
  const lineRes = await query<LineRow & { quote_id: string }>(
    `SELECT s.quote_id::text AS quote_id, ${LINE_COLUMNS}
       FROM quote_line l
       JOIN quote_section s ON s.id = l.section_id
      WHERE s.quote_id = ANY($1::uuid[]) AND s.deleted_at IS NULL
      ORDER BY l.position ASC, l.id ASC`,
    [quoteIds],
  );

  const linesBySection = new Map<string, QuoteLine[]>();
  for (const l of lineRes.rows) {
    const otMultiplier = multByQuote.get(l.quote_id) ?? OT_MULTIPLIER;
    const math: TotalsLineInput = {
      qty: Number(l.qty ?? 0),
      rate: Number(l.rate ?? 0),
      ot: l.ot === true,
      line_type: l.line_type,
      tax_pct: Number(l.tax_pct ?? 0),
      markup_pct: Number(l.markup_pct ?? 0),
    };
    const line: QuoteLine = {
      id: l.id,
      line_type: l.line_type,
      description: l.description,
      qty: math.qty,
      rate: math.rate,
      day_value: l.day_value,
      day: l.day === null || l.day === undefined ? null : Number(l.day),
      ot: math.ot,
      uom: l.uom,
      tax_pct: math.tax_pct ?? 0,
      markup_pct: math.markup_pct ?? 0,
      position: Number(l.position),
      amount: computeLineAmount(math, otMultiplier),
      tax: computeLineTax(math, otMultiplier),
    };
    const bucket = linesBySection.get(l.section_id);
    if (bucket) bucket.push(line);
    else linesBySection.set(l.section_id, [line]);
  }

  // Option letters restart per quote and per round.
  const optionIndex = new Map<string, number>();
  for (const id of quoteIds) out.set(id, []);
  for (const s of secRes.rows) {
    const lines = linesBySection.get(s.id) ?? [];
    const round = Number(s.round ?? 1);
    let label = 'Incurred';
    if (s.kind === 'option') {
      const k = `${s.quote_id}:${round}`;
      const idx = optionIndex.get(k) ?? 0;
      optionIndex.set(k, idx + 1);
      label = `Option ${optionLetter(idx)}`;
    }
    out.get(s.quote_id)!.push({
      id: s.id,
      kind: s.kind,
      label,
      name: s.name,
      narrative_reported: s.narrative_reported,
      scope_lines: toStringArray(s.scope_lines),
      include_in_summary: s.include_in_summary === true,
      position: Number(s.position),
      round,
      locked: s.locked === true,
      approved_at: s.approved_at,
      approved_by: actorOf(s.approved_by_id, s.approved_by_name, s.approved_by_kind),
      rejection_note: s.rejection_note,
      lines,
      subtotal: Math.round(lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100,
    });
  }
  return out;
}

/** The round being built / decided = the highest live round (1 when none). */
function currentRoundOf(sections: QuoteSection[]): number {
  return sections.reduce((max, s) => Math.max(max, s.round), 1);
}

/**
 * Sections as computeQuoteTotals wants them: an option approved in an EARLIER
 * round prices as incurred (Yoda IsIncurred = 1 on approval); only the current
 * round's options are priced as options.
 */
function totalsSections(sections: QuoteSection[], currentRound: number): TotalsSectionInput[] {
  return sections
    .filter((s) => s.kind === 'incurred' || s.round === currentRound || s.approved_at !== null)
    .map((s) => ({
      id: s.id,
      kind: s.kind,
      label: s.label,
      name: s.name,
      include_in_summary: s.include_in_summary,
      lines: s.lines,
      priced_as: s.kind === 'option' && s.round < currentRound && s.approved_at !== null ? 'incurred' : s.kind,
    }));
}

function totalsFor(q: QuoteRow, sections: QuoteSection[]): QuoteTotals {
  return computeQuoteTotals({
    sections: totalsSections(sections, currentRoundOf(sections)),
    sales_tax_pct: Number(q.sales_tax_pct ?? 0),
    total_rule: q.total_rule ?? 'incurred_plus_option',
    approved_section_id: q.approved_section_id,
    total_cost: q.is_cost_tbd ? null : q.total_cost === null ? null : Number(q.total_cost),
    nte: q.nte === null ? null : Number(q.nte),
    ot_multiplier: multOf(q),
  });
}

function permissionsFor(
  actor: ActingPrincipal,
  snap: WoStatusSnapshot | null,
  q: { maker_id: string | null; nte: number | null; status: QuoteStatus },
  grandTotal: number,
): QuotePermissions {
  return {
    can_edit: canEditQuote(actor),
    can_approve: canApproveQuote(actor),
    can_client_decide: canClientDecide(actor, snap),
    self_approval: selfApprovalVerdict(q.maker_id, actor.id, actor.isSuperAdmin) === 'blocked',
    over_nte: quoteOverNte(grandTotal, q.nte),
    // 0092 · the builder draws Submit's label from this, and locks it for a
    // dispatcher while a manager has the quote for correction.
    submit_target:
      q.status === 'draft' || q.status === 'pending_correction'
        ? quoteSubmitTarget(actor.role, q.status)
        : null,
  };
}

/**
 * 0083 (D2, #8): the person who submitted the quote does not approve or send
 * it. A super admin may — the quote_approved / quote_sent row then says
 * self_approved. Returns whether this is that case.
 */
async function assertNotOwnQuote(taskId: string, actor: ActingPrincipal, verb: string): Promise<boolean> {
  const res = await query<{ maker_id: string | null }>(
    `SELECT COALESCE(submitted_by, created_by)::text AS maker_id FROM quote WHERE task_id = $1 LIMIT 1`,
    [taskId],
  );
  const verdict = selfApprovalVerdict(res.rows[0]?.maker_id ?? null, actor.id, actor.isSuperAdmin);
  if (verdict === 'blocked') {
    throw forbidden(selfApprovalMessage('this quote', verb), { code: SELF_APPROVAL_CODE });
  }
  return verdict === 'self_approved';
}

/** The full quote payload for a work order, or null when none exists. */
export async function getQuote(taskId: string, actor: ActingPrincipal): Promise<Quote | null> {
  const res = await query<QuoteRow>(QUOTE_BY_TASK_SQL, [taskId]);
  if (res.rows.length === 0) return null;
  const q = res.rows[0];

  // 0048 · the multiplier the quote was priced with. A quote raised before
  // the contract existed (ot_multiplier NULL) keeps computing what it did.
  // M30 (Wave D): the rates shown are the SNAPSHOTTED card's (quote.contract_id),
  // as they stood when the work order was received — never today's pick.
  const match = await contractForTask(taskId, { contractId: q.contract_id });
  const otMultiplier =
    q.ot_multiplier !== null && q.ot_multiplier > 0
      ? Number(q.ot_multiplier)
      : match?.rates.ot_multiplier ?? OT_MULTIPLIER;
  const rates: QuoteRates = {
    ot_multiplier: otMultiplier,
    standard: match?.rates.standard ?? null,
    overtime: match?.rates.overtime ?? null,
    trip_charge: match?.rates.trip_charge ?? null,
    markup_pct: match?.rates.markup_pct ?? null,
    contract: q.contract_id
      ? { id: q.contract_id, name: q.contract_name ?? 'Contract' }
      : match
        ? { id: match.contract.id, name: match.contract.name }
        : null,
  };

  const sections = await loadSections(q.id, otMultiplier);
  const totals = totalsFor({ ...q, ot_multiplier: otMultiplier }, sections);
  const snap = await woStatusSnapshot(taskId);
  const laborRate = await findLaborRate(q.billing_entity, q.client, q.trade);
  const nteOverride = await openNteOverride(taskId);

  const summary: QuoteSummary = {
    auto: buildAutoSummary(
      {
        client: q.client,
        store: q.store,
        city: q.city,
        state: q.state,
        ext_name: q.ext_name,
        trade: q.trade,
        title: q.title,
        note_to_customer: q.note_to_customer,
      },
      sections,
      totals,
    ),
    pinned: q.summary_pinned,
  };

  return {
    id: q.id,
    task_id: q.task_id,
    wo_number: q.wo_number,
    number: q.number,
    document_type: (q.document_type || 'quote') as QuoteDocumentType,
    currency: q.currency || 'USD',
    ship_to: q.ship_to,
    rates,
    status: q.status,
    rev: Number(q.rev),
    current_round: currentRoundOf(sections),
    total_rule: q.total_rule ?? 'incurred_plus_option',
    sales_tax_pct: Number(q.sales_tax_pct ?? 0),
    bill_to: q.bill_to,
    is_cost_tbd: q.is_cost_tbd === true,
    specs: q.specs,
    note_to_customer: q.note_to_customer,
    created_by: actorOf(q.created_by_id, q.created_by_name, q.created_by_kind),
    approved_by: actorOf(q.approved_by_id, q.approved_by_name, q.approved_by_kind),
    sent_by: actorOf(q.sent_by_id, q.sent_by_name, q.sent_by_kind),
    sent_at: q.sent_at,
    approved_section_id: q.approved_section_id,
    client_decided_at: q.client_decided_at,
    client_decided_by: actorOf(q.cd_by_id, q.cd_by_name, q.cd_by_kind),
    client_decision_note: q.client_decision_note,
    client_approved_on_site: q.client_approved_on_site === true,
    created_at: q.created_at,
    updated_at: q.updated_at,
    sections,
    totals,
    summary,
    permissions: permissionsFor(actor, snap, q, totals.grand_total),
    nte_override_open: nteOverride !== null,
    wo_actions: snap.actions,
    labor_rate: laborRate,
  };
}

/** GET …/quote/sales-tax — Yoda QuoteSalesTaxEngine for this WO's quote. */
export async function quoteSalesTax(taskId: string): Promise<SalesTaxLookup> {
  const res = await query<{ billing_entity: string | null; client: string | null; trade: string | null; fields: unknown; city: string | null; state: string | null }>(
    `SELECT billing_entity, client, trade, fields, city, state FROM task WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  if (res.rows.length === 0) throw new ApiError('NOT_FOUND', 'Work order not found');
  const t = res.rows[0];
  const rate = await findLaborRate(t.billing_entity, t.client, t.trade);
  return lookupSalesTax({ required: rate?.is_sales_tax_required ?? false, fields: t.fields, state: t.state });
}

/**
 * money.quote for the WO detail endpoint: the grand total of a quote the client
 * can act on — approved, sent or client-approved — else null. A draft/pending
 * quote is not a price the NTE meter may bind to (product/quotes-payments.md §1).
 */
export async function getBindableQuoteTotal(taskId: string): Promise<number | null> {
  const res = await query<QuoteRow>(
    quoteSql(`q.task_id = $1 AND ${BINDABLE_STATUS_SQL}`, 'LIMIT 1'),
    [taskId],
  );
  if (res.rows.length === 0) return null;
  const sections = await loadSections(res.rows[0].id, multOf(res.rows[0]));
  return totalsFor(res.rows[0], sections).grand_total;
}

/**
 * The grand total of the work order's quote, whatever state it is in — what
 * Total Invoiced is stamped with when the status moves to Invoiced
 * (services/moneySync.ts). Under the Yoda rule that is the approved option's
 * price (incurred + option + tax). Null when there is no quote.
 */
export async function getQuoteTotal(taskId: string): Promise<number | null> {
  const res = await query<QuoteRow>(QUOTE_BY_TASK_SQL, [taskId]);
  if (res.rows.length === 0) return null;
  const sections = await loadSections(res.rows[0].id, multOf(res.rows[0]));
  return totalsFor(res.rows[0], sections).grand_total;
}

/**
 * UAT T5 · the quote's price (grand total) and cost side for many work orders
 * at once. Three queries whatever the count (the quotes, their sections,
 * their lines), totalled by the same totalsFor as everything else.
 * `bindableOnly` keeps the approved / sent / client-approved quotes (the
 * Payments locks, as getBindableQuoteTotal); otherwise every quote, priced
 * the way getQuote prices it — a quote with no snapshotted overtime
 * multiplier takes its contract's, as getQuote does (one contract read per
 * such quote only). A work order without one is absent from the map.
 */
async function quoteFiguresFor(
  taskIds: readonly string[],
  opts: { bindableOnly: boolean },
): Promise<Map<string, { total: number | null; cost: number | null }>> {
  const out = new Map<string, { total: number | null; cost: number | null }>();
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return out;
  const res = await query<QuoteRow>(
    quoteSql(opts.bindableOnly ? `q.task_id = ANY($1::uuid[]) AND ${BINDABLE_STATUS_SQL}` : 'q.task_id = ANY($1::uuid[])'),
    [ids],
  );
  const mult = new Map<string, number>();
  for (const r of res.rows) {
    if (!opts.bindableOnly && !(r.ot_multiplier !== null && Number(r.ot_multiplier) > 0)) {
      const match = await contractForTask(r.task_id, { contractId: r.contract_id });
      mult.set(r.id, match?.rates.ot_multiplier ?? OT_MULTIPLIER);
    } else {
      mult.set(r.id, multOf(r));
    }
  }
  const sections = await loadSectionsFor(res.rows.map((r) => r.id), mult);
  for (const r of res.rows) {
    const total = totalsFor({ ...r, ot_multiplier: mult.get(r.id) ?? multOf(r) }, sections.get(r.id) ?? []).grand_total;
    const cost = !r.is_cost_tbd && r.total_cost !== null ? Number(r.total_cost) : null;
    out.set(r.task_id, { total, cost });
  }
  return out;
}

/** The approved / sent / client-approved quote's figures per work order (T5). */
export function bindableQuoteFiguresFor(
  taskIds: readonly string[],
): Promise<Map<string, { total: number | null; cost: number | null }>> {
  return quoteFiguresFor(taskIds, { bindableOnly: true });
}

/** UAT T4 · every work order's quote grand total, whatever its status, as the
    record's Cost card reads it (getQuote) — for the list's Margin %. */
export async function quoteTotalsFor(taskIds: readonly string[]): Promise<Map<string, number>> {
  const figures = await quoteFiguresFor(taskIds, { bindableOnly: false });
  const out = new Map<string, number>();
  for (const [id, f] of figures) if (f.total !== null) out.set(id, f.total);
  return out;
}

/** One row of the sidebar "Quotes" list page (GET /api/quotes). */
export interface QuoteListItem {
  id: string;
  task_id: string;
  wo_number: string;
  /** 0048 · the document number. */
  number: string | null;
  title: string | null;
  client: string | null;
  status: QuoteStatus;
  rev: number;
  current_round: number;
  grand_total: number | null;
  updated_at: string | null;
  /** The work order's own numbers as they stand NOW (the Approvals inbox columns). */
  wo_due: string | null;
  wo_nte: number | null;
  wo_cost: number | null;
  /** Rule 2.5.1: the work order is flagged Emergency. */
  wo_emergency: boolean;
  /** Rules 7.3.x: the work order is flagged Escalated. */
  wo_escalated: boolean;
  /** UAT T5b (D2): who sent it for approval, else who created it — the one
      person whose Approve is drawn locked (quoteSelfApprovalLock). */
  submitted_by: string | null;
}

/** A bag/column value as a finite number ("$1,610" → 1610), else null. */
function moneyNum(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const digits = String(v).replace(/[^0-9.-]/g, '');
  if (!/^-?\d*\.?\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every quote the viewer may see (0026 scope), newest-updated first, for the
 * sidebar list page. grand_total goes through computeQuoteTotals() like every
 * other number on the screen so the list can never disagree with the builder.
 */
export async function listQuotes(
  limit = 200,
  viewer?: ActingPrincipal,
): Promise<{ items: QuoteListItem[]; total: number }> {
  const p = new Params();
  const scope = viewer ? woScopeSql(viewer, p) : null;
  const res = await query<QuoteRow>(
    quoteSql(`t.deleted_at IS NULL${scope ? ` AND ${scope}` : ''}`, `ORDER BY q.updated_at DESC LIMIT ${p.add(limit)}`),
    p.values,
  );

  // One batched read of every row's sections (UAT T5), not one per row.
  const sectionsByQuote = await loadSectionsFor(
    res.rows.map((r) => r.id),
    new Map(res.rows.map((r) => [r.id, multOf(r)])),
  );
  const items: QuoteListItem[] = [];
  for (const r of res.rows) {
    const sections = sectionsByQuote.get(r.id) ?? [];
    const totals = totalsFor(r, sections);
    items.push({
      id: r.id,
      task_id: r.task_id,
      wo_number: r.wo_number,
      number: r.number,
      title: r.title,
      client: r.client,
      status: r.status,
      rev: Number(r.rev),
      current_round: currentRoundOf(sections),
      grand_total: totals.grand_total,
      updated_at: r.updated_at,
      wo_due: r.wo_due,
      wo_nte: moneyNum(r.nte),
      wo_cost: moneyNum(r.wo_cost),
      wo_emergency: Boolean(r.wo_emergency),
      wo_escalated: Boolean(r.wo_escalated),
      submitted_by: r.maker_id,
    });
  }
  return { items, total: items.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 · WRITE
// ═══════════════════════════════════════════════════════════════════════════

/** Section as accepted by PUT — ids are not honoured, the CURRENT round's
    unlocked sections are replaced whole. */
export interface SectionInput {
  kind: 'incurred' | 'option';
  name?: string | null;
  narrative_reported?: string | null;
  scope_lines?: string[];
  include_in_summary?: boolean;
  lines?: LineInput[];
}

export interface LineInput {
  line_type: QuoteLine['line_type'];
  description: string;
  qty: number;
  rate: number;
  day_value?: string | null;
  day?: number | null;
  ot?: boolean;
  /** 0048 */
  uom?: string | null;
  tax_pct?: number;
  markup_pct?: number;
}

export interface QuoteUpdateInput {
  sales_tax_pct?: number;
  total_rule?: QuoteTotalRule;
  total_cost?: number | null;
  is_cost_tbd?: boolean;
  bill_to?: string | null;
  specs?: string | null;
  note_to_customer?: string | null;
  summary_pinned?: string | null;
  sections?: SectionInput[];
  /** 0048 · the document fields. */
  document_type?: QuoteDocumentType;
  currency?: string;
  ship_to?: string | null;
}

/** Statuses a quote may still be edited in (§1: edits stop once approved).
    0092: a quote waiting for a manager's correction is edited in place. */
const EDITABLE_STATUSES: QuoteStatus[] = ['draft', 'pending_correction', 'pending_approval'];

interface QuoteHead {
  id: string;
  status: QuoteStatus;
  rev: number;
  approved_section_id: string | null;
}

async function currentStatus(taskId: string): Promise<QuoteHead | null> {
  const res = await query<{ id: string; status: QuoteStatus; rev: number | string; approved_section_id: string | null }>(
    `SELECT id::text AS id, status, rev, approved_section_id::text AS approved_section_id
       FROM quote WHERE task_id = $1 LIMIT 1`,
    [taskId],
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return { id: r.id, status: r.status, rev: Number(r.rev), approved_section_id: r.approved_section_id };
}

async function currentRoundOfQuote(quoteId: string): Promise<number> {
  const res = await query<{ round: number | string | null }>(
    `SELECT max(round) AS round FROM quote_section WHERE quote_id = $1 AND deleted_at IS NULL`,
    [quoteId],
  );
  return Number(res.rows[0]?.round ?? 1) || 1;
}

/** Create the empty draft (senior_om+). One quote per WO — 400 if one exists. */
export async function createQuote(taskId: string, actor: ActingPrincipal): Promise<Quote> {
  assertCanCreate(actor);
  await assertWoAllows(taskId, 'quote.create');
  if (await currentStatus(taskId)) {
    throw badRequest('A quote already exists for this work order');
  }

  // 0048 · the number belongs to the billing entity and the year; 0046 · the
  // contract in force today is snapshotted so the price never drifts under
  // an approved quote. Both read BEFORE the transaction opens.
  const taskRow = await query<{ client: string | null; billing_entity: string | null; trade: string | null }>(
    `SELECT client, billing_entity, trade FROM task WHERE id = $1`,
    [taskId],
  );
  const entity =
    (taskRow.rows[0]?.billing_entity ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'Q';
  const match = await contractForTask(taskId);
  // The default Trip line is priced at the labor-rate card's trip rate (the
  // same card getQuote hands the builder as `labor_rate`); 0 = blank in the
  // builder, to be typed.
  const card = await findLaborRate(taskRow.rows[0]?.billing_entity ?? null, taskRow.rows[0]?.client ?? null, taskRow.rows[0]?.trade ?? null);
  const tripRate = card?.trip_rate != null && card.trip_rate > 0 ? card.trip_rate : 0;

  await withTransaction(async (tx) => {
    const year = new Date().getUTCFullYear();
    await tx.query(
      `INSERT INTO quote_sequence (billing_entity, year, next_number)
       VALUES ($1, $2, 1) ON CONFLICT (billing_entity, year) DO NOTHING`,
      [entity, year],
    );
    const seq = await tx.query<{ next_number: number }>(
      `UPDATE quote_sequence SET next_number = next_number + 1
        WHERE billing_entity = $1 AND year = $2
        RETURNING next_number - 1 AS next_number`,
      [entity, year],
    );
    const number = `Q-${entity}-${year}-${String(seq.rows[0].next_number).padStart(4, '0')}`;

    const ins = await tx.query<{ id: string }>(
      `INSERT INTO quote (task_id, status, created_by, number, bill_to, contract_id, ot_multiplier)
       VALUES ($1, 'draft', $2, $3, $4, $5::uuid, $6) RETURNING id::text AS id`,
      [
        taskId,
        actor.id,
        number,
        taskRow.rows[0]?.client ?? null,
        match?.contract.id ?? null,
        match ? match.rates.ot_multiplier : null,
      ],
    );
    // Every quote opens with its INCURRED section (the comp has no "add
    // incurred" affordance, it is always there) AND one proposed option
    // (2026-10-22, Elise: one option is already open; "Add another option"
    // is the second). Each opens with the five default "Required is to…"
    // lines and a Trip service line at the card's trip rate (quoteDefaults
    // in shared; the builder's blankOption opens the next option the same).
    const sections = await tx.query<{ id: string }>(
      `INSERT INTO quote_section (quote_id, kind, name, scope_lines, include_in_summary, position, round)
       VALUES ($1, 'incurred', 'Work already performed', $2::jsonb, true, 0, 1),
              ($1, 'option', NULL, $2::jsonb, true, 1, 1)
       RETURNING id::text AS id`,
      [ins.rows[0].id, JSON.stringify(defaultScopeLines())],
    );
    for (const s of sections.rows) {
      await tx.query(
        `INSERT INTO quote_line (section_id, line_type, description, qty, rate, day_value, day, ot, position, uom, tax_pct, markup_pct)
         VALUES ($1, 'service', $2, 1, $3, $4, $5, false, 0, NULL, 0, 0)`,
        [s.id, QUOTE_DEFAULT_TRIP_DESCRIPTION, tripRate, `Day ${QUOTE_DEFAULT_DAY}`, QUOTE_DEFAULT_DAY],
      );
    }
    await logQuoteActivity(tx, actor.id, taskId, 'quote_created', null, { status: 'draft' });
  });

  // S5 · the existence of a quote — even an empty draft — silences quote_owed.
  await evaluateForTask(taskId);

  const quote = await getQuote(taskId, actor);
  if (!quote) throw new ApiError('INTERNAL', 'Quote insert produced no row');
  return quote;
}

/**
 * Full update of the quote's fields and (when `sections` is present) the
 * CURRENT ROUND's section/line tree. Sections of the current round are REPLACED,
 * not merged: the builder autosaves the entire form, and diffing rows the
 * operator dragged around would be a bigger surface than rewriting a dozen rows
 * inside one transaction. Earlier rounds are locked history and never touched;
 * from round 2 on the incurred section is locked too (its content is the work
 * the client already approved), so an incoming incurred section is a 409.
 */
export async function updateQuote(
  taskId: string,
  input: QuoteUpdateInput,
  actor: ActingPrincipal,
): Promise<Quote> {
  assertCanEdit(actor);
  await assertWoAllows(taskId, 'quote.edit');
  const cur = await currentStatus(taskId);
  if (!cur) throw new ApiError('NOT_FOUND', 'No quote on this work order');
  if (!EDITABLE_STATUSES.includes(cur.status)) {
    throw badRequest(`A quote in status "${cur.status}" can no longer be edited`, {
      status: cur.status,
      editable_in: EDITABLE_STATUSES,
    });
  }
  const round = await currentRoundOfQuote(cur.id);
  if (input.sections && round > 1 && input.sections.some((s) => s.kind === 'incurred')) {
    throw conflict('The incurred section is locked after the first round — only options can change', {
      code: 'SECTION_LOCKED',
      round,
    });
  }

  await withTransaction(async (tx) => {
    // Rule 1.2.1: the row carries what the quote looked like before and after,
    // not just which keys the builder posted. Taken inside the transaction so
    // a concurrent edit cannot slip between the snapshot and the write.
    const before = await snapshotQuote(tx, cur.id);

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.sales_tax_pct !== undefined) set('sales_tax_pct', input.sales_tax_pct);
    if (input.total_rule !== undefined) set('total_rule', input.total_rule);
    if (input.total_cost !== undefined) set('total_cost', input.total_cost);
    if (input.is_cost_tbd !== undefined) set('is_cost_tbd', input.is_cost_tbd);
    if (input.bill_to !== undefined) set('bill_to', input.bill_to);
    if (input.specs !== undefined) set('specs', input.specs);
    if (input.note_to_customer !== undefined) set('note_to_customer', input.note_to_customer);
    if (input.summary_pinned !== undefined) set('summary_pinned', input.summary_pinned);
    if (input.document_type !== undefined) set('document_type', input.document_type);
    if (input.currency !== undefined) set('currency', input.currency);
    if (input.ship_to !== undefined) set('ship_to', input.ship_to);
    if (sets.length > 0) {
      params.push(cur.id);
      // Only while the quote is still editable, in the statement (#25): an
      // approve committed since the read above leaves the quote approved.
      const kept = await tx.query(
        `UPDATE quote SET ${sets.join(', ')} WHERE id = $${params.length} AND status IN ('draft', 'pending_correction', 'pending_approval') RETURNING id`,
        params,
      );
      if (!kept.rows[0]) throw conflict('The quote was approved while you were editing it — reload it', { code: 'QUOTE_MOVED' });
    }

    if (input.sections !== undefined) {
      // Only the current round's UNLOCKED sections are rewritten. ON DELETE
      // CASCADE takes their lines with them.
      await tx.query(
        `DELETE FROM quote_section
          WHERE quote_id = $1 AND round = $2 AND locked = false AND deleted_at IS NULL
            AND ($2 = 1 OR kind = 'option')`,
        [cur.id, round],
      );
      let position = 0;
      for (const section of input.sections) {
        const secRes = await tx.query<{ id: string }>(
          `INSERT INTO quote_section
             (quote_id, kind, name, narrative_reported, scope_lines, include_in_summary, position, round)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
           RETURNING id::text AS id`,
          [
            cur.id,
            section.kind,
            section.name ?? null,
            section.narrative_reported ?? null,
            JSON.stringify(section.scope_lines ?? []),
            section.include_in_summary ?? true,
            position++,
            round,
          ],
        );
        const sectionId = secRes.rows[0].id;
        let linePos = 0;
        for (const line of section.lines ?? []) {
          await tx.query(
            `INSERT INTO quote_line
               (section_id, line_type, description, qty, rate, day_value, day, ot, position, uom, tax_pct, markup_pct)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              sectionId,
              line.line_type,
              line.description,
              line.qty,
              line.rate,
              line.day_value ?? (line.day != null ? `Day ${line.day}` : null),
              line.day ?? null,
              line.ot ?? false,
              linePos++,
              line.uom?.trim() || null,
              line.tax_pct ?? 0,
              line.markup_pct ?? 0,
            ],
          );
        }
      }
    }

    // M3 (Wave C): a work order in Quote Ready (or done or later) entered on
    // the strength of this quote's data; emptying it there is refused, on
    // this transaction so the rewrite above rolls back with the 409.
    if (input.sections !== undefined) await assertQuoteHeld(tx, taskId);

    // The builder autosaves the whole form, so most PUTs change nothing; an
    // identical snapshot logs no row rather than a "revised" that revised nothing.
    const after = await snapshotQuote(tx, cur.id);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await logQuoteActivity(tx, actor.id, taskId, 'quote_updated', before, { ...after, round });
      // 0083 (#23): a quote edited while it waits for approval is not the quote
      // the approver was asked about — it goes back to draft (logged) and is
      // submitted again. Conditional on the status it was read in. A quote
      // waiting for CORRECTION (0092) is the opposite case: editing it is the
      // point, so it stays where it is until the manager submits it.
      if (cur.status === 'pending_approval') {
        const back = await tx.query(
          `UPDATE quote SET status = 'draft', submitted_by = NULL, submitted_at = NULL
            WHERE id = $1 AND status = 'pending_approval' RETURNING id`,
          [cur.id],
        );
        if (back.rows[0]) {
          await logQuoteActivity(tx, actor.id, taskId, 'quote_returned_to_draft', { status: 'pending_approval' }, {
            status: 'draft',
            quote_id: cur.id,
            reason: 'edited after it was submitted for approval',
          });
        }
      }
    }
  });

  const quote = await getQuote(taskId, actor);
  if (!quote) throw new ApiError('INTERNAL', 'Quote vanished mid-update');
  return quote;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * The quote as an activity_log snapshot (rule 1.2.1): the header fields, the
 * live section/line tree with ids and positions stripped (so a re-save of the
 * same form compares equal), and two reader-friendly derivations — `lines` as
 * one string per line, `grand_total` from computeQuoteTotals — so the audit
 * tab can say what moved without re-deriving quote arithmetic. `name` is what
 * the admin audit page prints as the row's title, like every other snapshot.
 */
interface QuoteSnapshot extends Record<string, unknown> {
  name: string;
  quote_id: string;
  sales_tax_pct: number;
  total_rule: QuoteTotalRule;
  total_cost: number | null;
  bill_to: string | null;
  is_cost_tbd: boolean;
  specs: string | null;
  note_to_customer: string | null;
  summary_pinned: string | null;
  number: string | null;
  document_type: string;
  ship_to: string | null;
  ot_multiplier: number;
  grand_total: number;
  lines: string[];
  sections: unknown[];
}

async function snapshotQuote(tx: Queryable, quoteId: string): Promise<QuoteSnapshot> {
  const head = (
    await tx.query(
      `SELECT sales_tax_pct::float8 AS sales_tax_pct, total_rule, total_cost::float8 AS total_cost,
              bill_to, is_cost_tbd, specs, note_to_customer, summary_pinned,
              approved_section_id::text AS approved_section_id,
              number, document_type, currency, ship_to, ot_multiplier::float8 AS ot_multiplier
         FROM quote WHERE id = $1`,
      [quoteId],
    )
  ).rows[0] as unknown as {
    sales_tax_pct: number | null;
    total_rule: QuoteTotalRule | null;
    total_cost: number | null;
    bill_to: string | null;
    is_cost_tbd: boolean | null;
    specs: string | null;
    note_to_customer: string | null;
    summary_pinned: string | null;
    approved_section_id: string | null;
    number: string | null;
    document_type: string | null;
    currency: string | null;
    ship_to: string | null;
    ot_multiplier: number | null;
  };
  const mult = head ? multOf(head) : OT_MULTIPLIER;
  const secRows = (
    await tx.query(
      `SELECT id::text AS id, kind, name, narrative_reported, scope_lines,
              include_in_summary, position, round, locked,
              ${ISO('approved_at')} AS approved_at, rejection_note
         FROM quote_section
        WHERE quote_id = $1 AND deleted_at IS NULL
        ORDER BY CASE kind WHEN 'incurred' THEN 0 ELSE 1 END, round ASC, position ASC, id ASC`,
      [quoteId],
    )
  ).rows as unknown as SectionRow[];
  const lineRows = (
    await tx.query(
      `SELECT ${LINE_COLUMNS}
         FROM quote_line l
         JOIN quote_section s ON s.id = l.section_id
        WHERE s.quote_id = $1 AND s.deleted_at IS NULL
        ORDER BY l.position ASC, l.id ASC`,
      [quoteId],
    )
  ).rows as unknown as LineRow[];

  const currentRound = secRows.reduce((m, s) => Math.max(m, Number(s.round ?? 1)), 1);
  let optionIndex = 0;
  let letterRound = 0;
  const lines: string[] = [];
  const totalsSections: TotalsSectionInput[] = [];
  const sections = secRows.map((s) => {
    const round = Number(s.round ?? 1);
    if (s.kind === 'option' && round !== letterRound) {
      letterRound = round;
      optionIndex = 0;
    }
    const label = s.kind === 'incurred' ? 'Incurred' : `Option ${optionLetter(optionIndex++)}${currentRound > 1 ? ` (round ${round})` : ''}`;
    const own = lineRows
      .filter((l) => l.section_id === s.id)
      .map((l) => {
        const qty = Number(l.qty ?? 0);
        const rate = Number(l.rate ?? 0);
        const ot = l.ot === true;
        const tax_pct = Number(l.tax_pct ?? 0);
        const markup_pct = Number(l.markup_pct ?? 0);
        const extras = [
          ot ? 'OT' : '',
          markup_pct > 0 ? `+${markup_pct}% markup` : '',
          tax_pct > 0 ? `${tax_pct}% tax` : '',
        ]
          .filter(Boolean)
          .join(', ');
        lines.push(
          `${label} · ${l.description}: ${qty}${l.uom ? ` ${l.uom}` : ''} × ${money(rate)}${extras ? ` (${extras})` : ''} = ${money(computeLineAmount({ qty, rate, ot, line_type: l.line_type, tax_pct, markup_pct }, mult))}`,
        );
        return {
          line_type: l.line_type,
          description: l.description,
          qty,
          rate,
          day: l.day == null ? null : Number(l.day),
          ot,
          uom: l.uom ?? null,
          tax_pct,
          markup_pct,
        };
      });
    // Earlier rounds: an approved option prices as incurred, the rest are history.
    const earlier = s.kind === 'option' && round < currentRound;
    if (!earlier || s.approved_at !== null) {
      totalsSections.push({
        id: s.id,
        kind: s.kind,
        label,
        name: s.name,
        include_in_summary: s.include_in_summary === true,
        lines: own,
        priced_as: earlier ? 'incurred' : s.kind,
      });
    }
    return {
      kind: s.kind,
      label,
      round,
      locked: s.locked === true,
      approved_at: s.approved_at,
      rejection_note: s.rejection_note,
      name: s.name,
      narrative_reported: s.narrative_reported,
      scope_lines: toStringArray(s.scope_lines),
      include_in_summary: s.include_in_summary === true,
      lines: own,
    };
  });

  const sales_tax_pct = Number(head?.sales_tax_pct ?? 0);
  const total_rule: QuoteTotalRule = head?.total_rule ?? 'incurred_plus_option';
  const total_cost = head?.total_cost == null ? null : Number(head.total_cost);
  const totals = computeQuoteTotals({
    sections: totalsSections,
    sales_tax_pct,
    total_rule,
    approved_section_id: head?.approved_section_id ?? null,
    total_cost,
    nte: null,
    ot_multiplier: mult,
  });

  return {
    name: head?.number ? `Quote ${head.number}` : 'Quote',
    quote_id: quoteId,
    number: head?.number ?? null,
    document_type: head?.document_type ?? 'quote',
    ship_to: head?.ship_to ?? null,
    ot_multiplier: mult,
    sales_tax_pct,
    total_rule,
    total_cost,
    bill_to: head?.bill_to ?? null,
    is_cost_tbd: head?.is_cost_tbd === true,
    specs: head?.specs ?? null,
    note_to_customer: head?.note_to_customer ?? null,
    summary_pinned: head?.summary_pinned ?? null,
    grand_total: totals.grand_total,
    lines,
    sections,
  };
}

async function logQuoteActivity(
  tx: Queryable,
  actorId: string,
  taskId: string,
  action: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx.query(
    `INSERT INTO activity_log
       (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, $3, 'quote.status', $4::jsonb, $5::jsonb)`,
    [actorId, taskId, action, before === null ? null : JSON.stringify(before), JSON.stringify(after)],
  );
}

async function addComment(
  tx: Queryable,
  actorId: string,
  taskId: string,
  body: string,
  clientVisible: boolean,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO comment (task_id, author_principal_id, body, client_visible)
     VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
    [taskId, actorId, body, clientVisible],
  );
  await tx.query(
    `INSERT INTO activity_log
       (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
    [actorId, taskId, JSON.stringify({ comment_id: ins.rows[0].id, client_visible: clientVisible, ...extra })],
  );
}

/** Pricing history: the whole quote as the client saw it at this moment. */
async function snapshot(tx: Queryable, quote: Quote, status: QuoteStatus, actorId: string): Promise<void> {
  await tx.query(
    `INSERT INTO quote_revision_snapshot (quote_id, rev, status, snapshot, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [quote.id, quote.rev, status, JSON.stringify({ sections: quote.sections, totals: quote.totals, summary: quote.summary }), actorId],
  );
}

function assertTransition(from: QuoteStatus, expected: QuoteStatus[], to: QuoteStatus): void {
  if (!expected.includes(from)) {
    throw badRequest(`A quote in status "${from}" cannot move to "${to}"`, {
      status: from,
      allowed_from: expected,
    });
  }
}

/**
 * One lifecycle transition. `extra` runs inside the same transaction as the
 * status write and the activity row — the send path uses it to post the
 * client-visible comment, so the feed can never disagree with the quote.
 *
 * `extraSet` is appended to the UPDATE's SET list and may use $3, $4… bound from
 * `extraParams` ($1 is the new status, $2 the quote id). Nothing is interpolated
 * into SQL, not even an id we just read back from the database.
 */
async function transition(
  taskId: string,
  from: QuoteStatus[],
  to: QuoteStatus,
  action: string,
  actor: ActingPrincipal,
  extra?: (tx: Queryable, quoteId: string) => Promise<void>,
  extraSet = '',
  extraParams: unknown[] = [],
  selfApproved = false,
): Promise<Quote> {
  const cur = await currentStatus(taskId);
  if (!cur) throw new ApiError('NOT_FOUND', 'No quote on this work order');
  assertTransition(cur.status, from, to);

  await withTransaction(async (tx) => {
    // 0083 (#25): ONE conditional statement on the status the quote was read
    // in — a double click or two approvers at once leave one transition; the
    // second matches no row and is refused before its comment or outbox row.
    const moved = await tx.query(
      `UPDATE quote SET status = $1${extraSet ? `, ${extraSet}` : ''}
        WHERE id = $2 AND status = $${3 + extraParams.length} RETURNING id`,
      [to, cur.id, ...extraParams, cur.status],
    );
    if (!moved.rows[0]) {
      throw conflict('The quote changed while you were looking at it — reload it', {
        code: 'QUOTE_MOVED',
        status: cur.status,
      });
    }
    if (extra) await extra(tx, cur.id);
    await logQuoteActivity(tx, actor.id, taskId, action, { status: cur.status }, {
      status: to,
      quote_id: cur.id,
      ...(selfApproved ? { self_approved: true } : {}),
    });
  });

  // S5 · every quote transition moves a clock: submit STARTS quote_review_owed
  // (its `quote_submitted` activity row is the clock's start), while approve,
  // send and reject all leave pending_approval and therefore silence it.
  await evaluateForTask(taskId);

  const quote = await getQuote(taskId, actor);
  if (!quote) throw new ApiError('INTERNAL', 'Quote vanished mid-transition');
  return quote;
}

/**
 * UAT Wave C (M5): the work order's status follows the quote. After the quote
 * transition has committed, Send moves it to the "quote sent" status, the
 * client's approval and decline to theirs (quoteEventStatusName; a status that
 * does not exist, or a work order already further along, is left alone),
 * through changeStatus with source 'quote' — so the gates, the Ecotrak check,
 * the audit row (`via: 'quote'`) and the automations all run. Nothing is
 * pushed to the client system (D5). A refusal never undoes the quote action:
 * it comes back on the reply as `status_move`.
 */
async function followQuoteEvent(taskId: string, event: QuoteEvent, actor: ActingPrincipal): Promise<VisitStatusMove | null> {
  const cur = await query<{ name: string }>(
    `SELECT s.name FROM task t JOIN status s ON s.id = t.status_id WHERE t.id = $1 LIMIT 1`,
    [taskId],
  );
  const target = quoteEventStatusName(event, cur.rows[0]?.name ?? null);
  if (!target) return null;
  const st = await query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM status WHERE lower(name) = lower($1) LIMIT 1`,
    [target],
  );
  if (!st.rows[0]) return null;
  try {
    const { changeStatus } = await import('./workOrders.js');
    await changeStatus(taskId, st.rows[0].id, actor.id, undefined, 'quote');
    return { status: st.rows[0].name, moved: true, reason: null };
  } catch (err) {
    if (err instanceof ApiError) return { status: st.rows[0].name, moved: false, reason: err.message };
    throw err;
  }
}

/** The quote action's reply with the status move on it (re-read when the
    status moved, since the quote's wo_actions follow the work order). */
async function withStatusMove(taskId: string, quote: Quote, event: QuoteEvent, actor: ActingPrincipal): Promise<Quote> {
  const status_move = await followQuoteEvent(taskId, event, actor);
  const fresh = status_move?.moved ? ((await getQuote(taskId, actor)) ?? quote) : quote;
  return { ...fresh, status_move };
}

/**
 * Submit (quotes:edit). Where it goes is `quoteSubmitTarget` (0092): a
 * dispatcher's draft → pending_correction ("Submit for correction"); a
 * manager's draft, or a quote a manager corrected → pending_approval
 * ("Submit for approval"). A dispatcher cannot submit a quote that waits
 * for correction (403 QUOTE_CORRECTION_PENDING) — that click is the
 * manager's, and it makes the manager the submitter of record, so D2 asks a
 * second manager to approve. Each submit stamps submitted_by / submitted_at.
 */
export async function submitQuote(taskId: string, actor: ActingPrincipal): Promise<Quote> {
  assertCanEdit(actor);
  await assertWoAllows(taskId, 'quote.submit');
  const cur = await currentStatus(taskId);
  if (!cur) throw new ApiError('NOT_FOUND', 'No quote on this work order');
  const from: QuoteSubmitFrom[] = ['draft', 'pending_correction'];
  assertTransition(cur.status, from, 'pending_approval');
  const target = quoteSubmitTarget(actor.role, cur.status as QuoteSubmitFrom);
  if (!target) {
    throw forbidden(QUOTE_CORRECTION_PENDING_TEXT, { code: QUOTE_CORRECTION_PENDING_CODE, status: cur.status });
  }
  return transition(taskId, [cur.status], target, QUOTE_SUBMIT_ACTION[target], actor, undefined,
    'submitted_by = $3, submitted_at = now()', [actor.id]);
}

/** pending_approval → approved (quotes:approve). Fills money.quote on the WO.
    Refused (409) while an NTE override waits on a manager — rule 1.5.2. */
export async function approveQuote(taskId: string, actor: ActingPrincipal): Promise<Quote> {
  assertCanApprove(actor);
  await assertWoAllows(taskId, 'quote.approve');
  const selfApproved = await assertNotOwnQuote(taskId, actor, 'approve');
  await assertNoOpenNteOverride(taskId, 'Approving the quote');
  return transition(
    taskId,
    ['pending_approval'],
    'approved',
    'quote_approved',
    actor,
    undefined,
    'approved_by = $3',
    [actor.id],
    selfApproved,
  );
}

/**
 * approved → sent (atl+). Stamps sent_by/sent_at, posts the client-visible
 * update to the WO feed, snapshots the revision and queues the ClickUp
 * ClientQuote push — all in the SAME transaction.
 */
export async function sendQuote(taskId: string, actor: ActingPrincipal): Promise<Quote> {
  assertCanApprove(actor);
  await assertWoAllows(taskId, 'quote.send');
  const selfApproved = await assertNotOwnQuote(taskId, actor, 'send');
  await assertNoOpenNteOverride(taskId, 'Sending the quote');

  // Read the numbers on the pool BEFORE the transaction opens: a read that
  // needs no lock (an approved quote is no longer editable).
  const pre = await getQuote(taskId, actor);
  if (!pre) throw new ApiError('NOT_FOUND', 'No quote on this work order');
  // 0083 (#23): a quote above the NTE is not sent until the NTE is raised
  // (Increase NTE on the work order, decided by a manager).
  if (pre.permissions.over_nte) {
    throw conflict(
      `The quote totals ${money(pre.totals.grand_total)}, above the work order's NTE — request an NTE increase and have it approved before sending`,
      { code: QUOTE_OVER_NTE_CODE, grand_total: pre.totals.grand_total },
    );
  }
  const summaryText = pre.summary.pinned ?? pre.summary.auto;
  const firstLine = summaryText.split('\n').find((l) => l.trim().length > 0) ?? pre.wo_number;
  // M4 (Wave C): this is THE client-visible quote message, posted when the
  // quote goes to the client — nothing client-visible is posted on submit or
  // on the internal approval. Worded as the send it is.
  const body = `Quote for ${money(pre.totals.grand_total)} sent to the client for approval — ${firstLine.trim()}`;

  const sent = await transition(
    taskId,
    ['approved'],
    'sent',
    'quote_sent',
    actor,
    async (tx, quoteId) => {
      await addComment(tx, actor.id, taskId, body, true, { quote_id: quoteId });
      await snapshot(tx, pre, 'sent', actor.id);
      await enqueueOutbox(tx, 'quote.sent', 'quote', quoteId, {
        task_id: taskId,
        wo_number: pre.wo_number,
        summary: summaryText,
        grand_total: pre.totals.grand_total,
      });
    },
    'sent_by = $3, sent_at = now()',
    [actor.id],
    selfApproved,
  );
  return withStatusMove(taskId, sent, 'sent', actor);
}

/**
 * pending_correction | pending_approval | approved → draft (atl+), with the
 * reviewer's note landing as an INTERNAL comment (it is feedback for the
 * dispatcher, never for the client). `rev` bumps: the quote that comes back
 * is a new revision.
 */
export async function rejectQuote(
  taskId: string,
  note: string,
  actor: ActingPrincipal,
): Promise<Quote> {
  assertCanApprove(actor);
  await assertWoAllows(taskId, 'quote.approve');
  return transition(
    taskId,
    ['pending_correction', 'pending_approval', 'approved'],
    'draft',
    'quote_rejected',
    actor,
    async (tx) => {
      await addComment(tx, actor.id, taskId, `Quote returned to draft — ${note}`, false);
    },
    'rev = rev + 1, approved_by = NULL, submitted_by = NULL, submitted_at = NULL',
  );
}

/**
 * sent → approved (atl+) — Yoda CancelSubmission. The client-facing record is
 * not erased: a client-visible "withdrawn" update follows the original, and the
 * ClickUp ClientQuote field clear is queued.
 */
export async function cancelSubmission(taskId: string, actor: ActingPrincipal): Promise<Quote> {
  assertCanApprove(actor);
  await assertWoAllows(taskId, 'quote.send');
  return transition(
    taskId,
    ['sent'],
    'approved',
    'quote_submission_cancelled',
    actor,
    async (tx, quoteId) => {
      await addComment(tx, actor.id, taskId, 'Quote withdrawn — a revised quote will follow.', true, { quote_id: quoteId });
      await enqueueOutbox(tx, 'quote.cancelled', 'quote', quoteId, { task_id: taskId });
    },
    'sent_by = NULL, sent_at = NULL',
  );
}

export interface ClientApproveInput {
  /** The option section the client chose — must be a live option of the current round. */
  section_id: string;
  note?: string | null;
  /** Yoda SubmitOnSite path: the approval was given on site, not through the CMMS. */
  on_site?: boolean;
  /** M6 (Wave C): a file on this work order that records the approval (the
      client's email, a signed quote). A note or this is required. */
  attachment_id?: string | null;
}

/**
 * sent → client_approved — Yoda ActionEngine.ApproveAsync + the
 * SwitchIsAdminApproved SQL: the chosen option is approved, every section of the
 * round is LOCKED, the unapproved sibling options are soft-deleted, and the
 * approved option's lines become INCURRED for any later round. Posts the
 * client-visible approval, snapshots the revision, queues the Teams ✅ /
 * ClickUp comment.
 */
export async function clientApproveQuote(
  taskId: string,
  input: ClientApproveInput,
  actor: ActingPrincipal,
): Promise<Quote> {
  const snap = await assertWoAllows(taskId, 'quote.client_decide');
  assertCanClientDecide(actor, snap);
  // Rule 1.5.2: the client's yes binds money.quote; no binding while an NTE
  // override is still waiting on a manager.
  await assertNoOpenNteOverride(taskId, 'Recording the client approval');

  const pre = await getQuote(taskId, actor);
  if (!pre) throw new ApiError('NOT_FOUND', 'No quote on this work order');
  const option = pre.sections.find(
    (s) => s.id === input.section_id && s.kind === 'option' && s.round === pre.current_round,
  );
  if (!option) {
    throw badRequest('section_id must be one of the current round’s proposed options', {
      section_id: input.section_id,
      options: pre.sections.filter((s) => s.kind === 'option' && s.round === pre.current_round).map((s) => s.id),
    });
  }
  // M6 (Wave C): the client's yes is recorded with its evidence — a note
  // (who approved, the PO number, how) or a file on this work order — like a
  // decline needs its reason.
  const evidenceNote = input.note?.trim() || null;
  let evidenceFile: { id: string; file_name: string } | null = null;
  if (input.attachment_id) {
    const f = await query<{ id: string; file_name: string }>(
      `SELECT id::text AS id, file_name FROM attachment
        WHERE id = $1 AND task_id = $2 AND review_status <> 'declined' LIMIT 1`,
      [input.attachment_id, taskId],
    );
    if (!f.rows[0]) {
      throw badRequest('That file is not on this work order', { code: CLIENT_APPROVAL_EVIDENCE_CODE, attachment_id: input.attachment_id });
    }
    evidenceFile = f.rows[0];
  }
  if (!evidenceNote && !evidenceFile) {
    throw badRequest('Say how the client approved (a note) or attach their approval before recording it', {
      code: CLIENT_APPROVAL_EVIDENCE_CODE,
    });
  }
  const priced = pre.totals.option_totals.find((o) => o.section_id === option.id);
  const amount = priced ? priced.grand_total : pre.totals.grand_total;
  const noteText = `${evidenceNote ? ` — ${evidenceNote}` : ''}${evidenceFile ? ` (approval on file: ${evidenceFile.file_name})` : ''}`;
  const body = `Client approved ${option.label}${option.name ? ` (${option.name})` : ''} for ${money(amount)}${input.on_site ? ' (on site)' : ''}${noteText}`;

  const approved = await transition(
    taskId,
    ['sent'],
    'client_approved',
    'quote_client_approved',
    actor,
    async (tx, quoteId) => {
      await tx.query(
        `UPDATE quote_section SET approved_at = now(), approved_by = $1, locked = true WHERE id = $2`,
        [actor.id, option.id],
      );
      await tx.query(
        `UPDATE quote_section SET locked = true WHERE quote_id = $1 AND round = $2 AND deleted_at IS NULL`,
        [quoteId, pre.current_round],
      );
      // Yoda step 4 — soft-delete the OTHER unapproved options in the same round.
      await tx.query(
        `UPDATE quote_section SET deleted_at = now()
          WHERE quote_id = $1 AND round = $2 AND kind = 'option' AND id <> $3 AND approved_at IS NULL AND deleted_at IS NULL`,
        [quoteId, pre.current_round, option.id],
      );
      await addComment(tx, actor.id, taskId, body, true, {
        quote_id: quoteId,
        section_id: option.id,
        ...(evidenceFile ? { attachment_id: evidenceFile.id } : {}),
      });
      await snapshot(tx, pre, 'client_approved', actor.id);
      await enqueueOutbox(tx, 'quote.client_approved', 'quote', quoteId, {
        task_id: taskId,
        wo_number: pre.wo_number,
        option: option.label,
        grand_total: amount,
        approved_by: actor.name,
        on_site: input.on_site === true,
      });
    },
    'approved_section_id = $3, client_decided_at = now(), client_decided_by = $4, client_decision_note = $5, client_approved_on_site = $6, client_decision_attachment_id = $7',
    [option.id, actor.id, evidenceNote, input.on_site === true, evidenceFile?.id ?? null],
  );
  return withStatusMove(taskId, approved, 'client_approved', actor);
}

export interface ClientDeclineInput {
  note: string;
  /** Decline ONE option (Yoda DeclineAsync); omitted = the whole round. */
  section_id?: string | null;
}

/**
 * sent → client_declined — Yoda DeclineAsync: the rejection message lands on
 * the option(s), the round is locked, the ClickUp ClientQuote clear is queued.
 * The dispatcher re-quotes by opening a new round.
 */
export async function clientDeclineQuote(
  taskId: string,
  input: ClientDeclineInput,
  actor: ActingPrincipal,
): Promise<Quote> {
  const snap = await assertWoAllows(taskId, 'quote.client_decide');
  assertCanClientDecide(actor, snap);

  const pre = await getQuote(taskId, actor);
  if (!pre) throw new ApiError('NOT_FOUND', 'No quote on this work order');
  const roundOptions = pre.sections.filter((s) => s.kind === 'option' && s.round === pre.current_round);
  const target = input.section_id ? roundOptions.find((s) => s.id === input.section_id) : null;
  if (input.section_id && !target) {
    throw badRequest('section_id must be one of the current round’s proposed options', {
      section_id: input.section_id,
    });
  }
  const note = input.note.trim();
  const body = target
    ? `Client declined ${target.label}${target.name ? ` (${target.name})` : ''} — ${note}`
    : `Client declined the quote — ${note}`;

  const declined = await transition(
    taskId,
    ['sent'],
    'client_declined',
    'quote_client_declined',
    actor,
    async (tx, quoteId) => {
      if (target) {
        await tx.query(`UPDATE quote_section SET rejection_note = $1 WHERE id = $2`, [note, target.id]);
      } else {
        await tx.query(
          `UPDATE quote_section SET rejection_note = $1 WHERE quote_id = $2 AND round = $3 AND kind = 'option' AND deleted_at IS NULL`,
          [note, quoteId, pre.current_round],
        );
      }
      await tx.query(
        `UPDATE quote_section SET locked = true WHERE quote_id = $1 AND round = $2 AND deleted_at IS NULL`,
        [quoteId, pre.current_round],
      );
      await addComment(tx, actor.id, taskId, body, false, { quote_id: quoteId });
      await snapshot(tx, pre, 'client_declined', actor.id);
      await enqueueOutbox(tx, 'quote.client_declined', 'quote', quoteId, {
        task_id: taskId,
        wo_number: pre.wo_number,
        note,
      });
    },
    'client_decided_at = now(), client_decided_by = $3, client_decision_note = $4',
    [actor.id, note],
  );
  return withStatusMove(taskId, declined, 'client_declined', actor);
}

/**
 * client_approved | client_declined → draft, round + 1 (senior_om+) — Yoda's
 * "additional quote": the next section may open only once the last one was
 * decided. The approved work of earlier rounds prices as incurred from here on.
 */
export async function startNewRound(taskId: string, actor: ActingPrincipal): Promise<Quote> {
  assertCanEdit(actor);
  await assertWoAllows(taskId, 'quote.new_round');
  const cur = await currentStatus(taskId);
  if (!cur) throw new ApiError('NOT_FOUND', 'No quote on this work order');
  const round = await currentRoundOfQuote(cur.id);

  return transition(
    taskId,
    ['client_approved', 'client_declined'],
    'draft',
    'quote_round_opened',
    actor,
    async (tx, quoteId) => {
      await tx.query(
        `INSERT INTO quote_section (quote_id, kind, name, include_in_summary, position, round)
         VALUES ($1, 'option', NULL, true, 0, $2)`,
        [quoteId, round + 1],
      );
    },
    'rev = rev + 1, approved_by = NULL, sent_by = NULL, sent_at = NULL, approved_section_id = NULL, client_decided_at = NULL, client_decided_by = NULL, client_decision_note = NULL, client_approved_on_site = false, client_decision_attachment_id = NULL',
  );
}
