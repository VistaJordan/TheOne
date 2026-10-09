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
// PGlite is single-connection: the acting principal is ALWAYS resolved BEFORE a
// db.transaction() opens (a plain query() issued inside a transaction queues
// behind it and self-deadlocks — same note as S1's changeStatus).

import { query, getDb } from '../db.js';
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
  ActivityActor,
  LaborRate,
  SalesTaxLookup,
  WoActionMap,
} from '@theone/shared';
import { permAllows } from '@theone/shared';
import { ApiError, badRequest, conflict, forbidden } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
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

/** Overtime is a flat rate multiplier (Jordan, 2026-07-30: "OT = overtime, ×1.5 rate"). */
export const OT_MULTIPLIER = 1.5;

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
}

/**
 * One line's money: qty × rate, ×1.5 when the OT flag is set, NEGATIVE for a
 * discount line (the sign comes from the type, never from the input — the money
 * validation still refuses a typed minus sign).
 */
export function computeLineAmount(line: TotalsLineInput): number {
  const qty = Number.isFinite(line.qty) ? line.qty : 0;
  const rate = Number.isFinite(line.rate) ? line.rate : 0;
  const sign = line.line_type === 'discount' ? -1 : 1;
  return round2(sign * qty * rate * (line.ot ? OT_MULTIPLIER : 1));
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
 * `profit` is grand_total − total_cost (null while our cost is unknown);
 * `margin_pct` is profit / grand_total × 100, to one decimal.
 */
export function computeQuoteTotals(input: TotalsInput): QuoteTotals {
  const pct = Number.isFinite(input.sales_tax_pct) ? Math.max(0, input.sales_tax_pct) : 0;
  const yoda = input.total_rule !== 'options_only';
  const taxOn = (base: number) => (yoda ? round2((base * pct) / 100) : 0);

  let incurred_subtotal = 0;
  const optionSections: { section: TotalsSectionInput; total: number }[] = [];

  for (const section of input.sections) {
    const subtotal = round2(section.lines.reduce((sum, line) => sum + computeLineAmount(line), 0));
    if ((section.priced_as ?? section.kind) === 'incurred') {
      incurred_subtotal = round2(incurred_subtotal + subtotal);
    } else {
      optionSections.push({ section, total: subtotal });
    }
  }

  const option_totals: QuoteOptionTotal[] = optionSections.map(({ section, total }) => {
    const base = yoda ? round2(incurred_subtotal + total) : total;
    const tax = taxOn(base);
    return {
      section_id: section.id,
      label: section.label,
      name: section.name,
      include_in_summary: section.include_in_summary,
      total,
      tax,
      grand_total: round2(base + tax),
    };
  });

  let grand_total: number;
  let sales_tax: number;
  let priced_section_id: string | null = null;

  if (yoda) {
    const priced =
      option_totals.find((o) => o.section_id === input.approved_section_id) ??
      option_totals.find((o) => o.include_in_summary) ??
      null;
    if (priced) {
      grand_total = priced.grand_total;
      sales_tax = priced.tax;
      priced_section_id = priced.section_id;
    } else {
      sales_tax = taxOn(incurred_subtotal);
      grand_total = round2(incurred_subtotal + sales_tax);
    }
  } else {
    // ── RULE B ──────────────────────────────────────────────────────────────
    grand_total = round2(option_totals.reduce((sum, o) => sum + (o.include_in_summary ? o.total : 0), 0));
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
            ? `Tech reported that ${section.narrative_reported}`
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
  const incurredScope = sections.filter((s) => s.kind === 'incurred').flatMap((s) => s.scope_lines);
  let usedFallbackScope = false;

  for (const section of pricedOptions) {
    const total = totals.option_totals.find((o) => o.section_id === section.id);
    out.push('', `PROPOSED — ${section.label.toUpperCase()}`);
    if (section.name) out.push(...wrap(section.name, SUMMARY_WIDTH));
    if (section.narrative_reported) {
      out.push('', ...wrap(section.narrative_reported, SUMMARY_WIDTH));
    }

    let scope = section.scope_lines;
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
    out.push(...amountRows(`${section.label} total`, total ? total.total : 0));
    if (yoda && total) {
      if (totals.sales_tax_pct > 0) {
        out.push(...amountRows(`Sales tax (${pctText(totals.sales_tax_pct)})`, total.tax));
      }
      out.push(...amountRows(`${section.label} grand total`, total.grand_total));
    }
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  out.push('');
  if (yoda) {
    const priced = totals.option_totals.find((o) => o.section_id === totals.priced_section_id);
    out.push(
      ...amountRows(
        priced ? `GRAND TOTAL — ${priced.label.toUpperCase()}` : 'GRAND TOTAL',
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
    to the lifecycle, not a grant, so it stays a role test. */
const DISPATCHER_ROLES: readonly string[] = ['om', 'senior_om', 'om_probation'];
export function canClientDecide(actor: ActingPrincipal, snap: WoStatusSnapshot | null): boolean {
  if (canApproveQuote(actor)) return true;
  return DISPATCHER_ROLES.includes(actor.role ?? '') && snap?.phase === 'Approval';
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
}

const QUOTE_SQL = `
  SELECT q.id::text                       AS id,
         q.task_id::text                  AS task_id,
         q.status, q.rev,
         q.sales_tax_pct::float8          AS sales_tax_pct,
         q.total_rule, q.bill_to, q.is_cost_tbd,
         q.total_cost::float8             AS total_cost,
         q.specs, q.note_to_customer, q.summary_pinned,
         q.approved_section_id::text      AS approved_section_id,
         q.client_decision_note, q.client_approved_on_site,
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
         t.fields ->> '34. Cost'          AS wo_cost
    FROM quote q
    JOIN task t ON t.id = q.task_id
    LEFT JOIN principal cd ON cd.id = q.client_decided_by
    LEFT JOIN principal cb ON cb.id = q.created_by
    LEFT JOIN principal ab ON ab.id = q.approved_by
    LEFT JOIN principal sb ON sb.id = q.sent_by
   WHERE q.task_id = $1
   LIMIT 1
`;

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
  position: number | string;
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
async function loadSections(quoteId: string): Promise<QuoteSection[]> {
  const secRes = await query<SectionRow>(
    `SELECT s.id::text AS id, s.kind, s.name, s.narrative_reported, s.scope_lines,
            s.include_in_summary, s.position, s.round, s.locked, s.rejection_note,
            ${ISO('s.approved_at')} AS approved_at,
            ab.id::text AS approved_by_id, ab.display_name AS approved_by_name, ab.kind::text AS approved_by_kind
       FROM quote_section s
       LEFT JOIN principal ab ON ab.id = s.approved_by
      WHERE s.quote_id = $1 AND s.deleted_at IS NULL
      ORDER BY CASE s.kind WHEN 'incurred' THEN 0 ELSE 1 END, s.round ASC, s.position ASC, s.id ASC`,
    [quoteId],
  );
  const lineRes = await query<LineRow>(
    `SELECT l.id::text AS id, l.section_id::text AS section_id, l.line_type, l.description,
            l.qty::float8 AS qty, l.rate::float8 AS rate, l.day_value, l.day, l.ot, l.position
       FROM quote_line l
       JOIN quote_section s ON s.id = l.section_id
      WHERE s.quote_id = $1 AND s.deleted_at IS NULL
      ORDER BY l.position ASC, l.id ASC`,
    [quoteId],
  );

  const linesBySection = new Map<string, QuoteLine[]>();
  for (const l of lineRes.rows) {
    const line: QuoteLine = {
      id: l.id,
      line_type: l.line_type,
      description: l.description,
      qty: Number(l.qty ?? 0),
      rate: Number(l.rate ?? 0),
      day_value: l.day_value,
      day: l.day === null || l.day === undefined ? null : Number(l.day),
      ot: l.ot === true,
      position: Number(l.position),
      amount: computeLineAmount({
        qty: Number(l.qty ?? 0),
        rate: Number(l.rate ?? 0),
        ot: l.ot === true,
        line_type: l.line_type,
      }),
    };
    const bucket = linesBySection.get(l.section_id);
    if (bucket) bucket.push(line);
    else linesBySection.set(l.section_id, [line]);
  }

  const optionIndexByRound = new Map<number, number>();
  return secRes.rows.map((s) => {
    const lines = linesBySection.get(s.id) ?? [];
    const round = Number(s.round ?? 1);
    let label = 'Incurred';
    if (s.kind === 'option') {
      const idx = optionIndexByRound.get(round) ?? 0;
      optionIndexByRound.set(round, idx + 1);
      label = `Option ${optionLetter(idx)}`;
    }
    return {
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
    };
  });
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
  });
}

function permissionsFor(actor: ActingPrincipal, snap: WoStatusSnapshot | null): QuotePermissions {
  return {
    can_edit: canEditQuote(actor),
    can_approve: canApproveQuote(actor),
    can_client_decide: canClientDecide(actor, snap),
  };
}

/** The full quote payload for a work order, or null when none exists. */
export async function getQuote(taskId: string, actor: ActingPrincipal): Promise<Quote | null> {
  const res = await query<QuoteRow>(QUOTE_SQL, [taskId]);
  if (res.rows.length === 0) return null;
  const q = res.rows[0];

  const sections = await loadSections(q.id);
  const totals = totalsFor(q, sections);
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
    permissions: permissionsFor(actor, snap),
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
    `${QUOTE_SQL.replace('WHERE q.task_id = $1', "WHERE q.task_id = $1 AND q.status IN ('approved','sent','client_approved')")}`,
    [taskId],
  );
  if (res.rows.length === 0) return null;
  const sections = await loadSections(res.rows[0].id);
  return totalsFor(res.rows[0], sections).grand_total;
}

/** One row of the sidebar "Quotes" list page (GET /api/quotes). */
export interface QuoteListItem {
  id: string;
  task_id: string;
  wo_number: string;
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
    QUOTE_SQL.replace(
      'WHERE q.task_id = $1\n   LIMIT 1',
      `WHERE t.deleted_at IS NULL ${scope ? `AND ${scope}` : ''}\n   ORDER BY q.updated_at DESC LIMIT ${p.add(limit)}`,
    ),
    p.values,
  );

  const items: QuoteListItem[] = [];
  for (const r of res.rows) {
    const sections = await loadSections(r.id);
    const totals = totalsFor(r, sections);
    items.push({
      id: r.id,
      task_id: r.task_id,
      wo_number: r.wo_number,
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
}

/** Statuses a quote may still be edited in (§1: edits stop once approved). */
const EDITABLE_STATUSES: QuoteStatus[] = ['draft', 'pending_approval'];

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

  const db = getDb();
  await db.transaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO quote (task_id, status, created_by) VALUES ($1, 'draft', $2) RETURNING id::text AS id`,
      [taskId, actor.id],
    );
    // Every quote opens with its INCURRED section: the comp has no "add incurred"
    // affordance, it is always there.
    await tx.query(
      `INSERT INTO quote_section (quote_id, kind, name, include_in_summary, position, round)
       VALUES ($1, 'incurred', 'Work already performed', true, 0, 1)`,
      [ins.rows[0].id],
    );
    await logQuoteActivity(tx, actor.id, taskId, 'quote_created', null, { status: 'draft' });
  });

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

  const db = getDb();
  await db.transaction(async (tx) => {
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
    if (sets.length > 0) {
      params.push(cur.id);
      await tx.query(`UPDATE quote SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
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
               (section_id, line_type, description, qty, rate, day_value, day, ot, position)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
            ],
          );
        }
      }
    }

    // The builder autosaves the whole form, so most PUTs change nothing; an
    // identical snapshot logs no row rather than a "revised" that revised nothing.
    const after = await snapshotQuote(tx, cur.id);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await logQuoteActivity(tx, actor.id, taskId, 'quote_updated', before, { ...after, round });
    }
  });

  const quote = await getQuote(taskId, actor);
  if (!quote) throw new ApiError('INTERNAL', 'Quote vanished mid-update');
  return quote;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** Minimal shape shared by PGlite's db and its transaction handle. */
interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

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
  grand_total: number;
  lines: string[];
  sections: unknown[];
}

async function snapshotQuote(tx: Queryable, quoteId: string): Promise<QuoteSnapshot> {
  const head = (
    await tx.query(
      `SELECT sales_tax_pct::float8 AS sales_tax_pct, total_rule, total_cost::float8 AS total_cost,
              bill_to, is_cost_tbd, specs, note_to_customer, summary_pinned,
              approved_section_id::text AS approved_section_id
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
  };
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
      `SELECT l.id::text AS id, l.section_id::text AS section_id, l.line_type, l.description,
              l.qty::float8 AS qty, l.rate::float8 AS rate, l.day_value, l.day, l.ot, l.position
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
        lines.push(
          `${label} · ${l.description}: ${qty} × ${money(rate)}${ot ? ' OT' : ''} = ${money(computeLineAmount({ qty, rate, ot, line_type: l.line_type }))}`,
        );
        return { line_type: l.line_type, description: l.description, qty, rate, day: l.day == null ? null : Number(l.day), ot };
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
  });

  return {
    name: 'Quote',
    quote_id: quoteId,
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
): Promise<Quote> {
  const cur = await currentStatus(taskId);
  if (!cur) throw new ApiError('NOT_FOUND', 'No quote on this work order');
  assertTransition(cur.status, from, to);

  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE quote SET status = $1${extraSet ? `, ${extraSet}` : ''} WHERE id = $2`,
      [to, cur.id, ...extraParams],
    );
    if (extra) await extra(tx as Queryable, cur.id);
    await logQuoteActivity(tx as Queryable, actor.id, taskId, action, { status: cur.status }, {
      status: to,
      quote_id: cur.id,
    });
  });

  const quote = await getQuote(taskId, actor);
  if (!quote) throw new ApiError('INTERNAL', 'Quote vanished mid-transition');
  return quote;
}

/** draft → pending_approval (senior_om+). */
export async function submitQuote(taskId: string, actor: ActingPrincipal): Promise<Quote> {
  assertCanEdit(actor);
  await assertWoAllows(taskId, 'quote.submit');
  return transition(taskId, ['draft'], 'pending_approval', 'quote_submitted', actor);
}

/** pending_approval → approved (quotes:approve). Fills money.quote on the WO.
    Refused (409) while an NTE override waits on a manager — rule 1.5.2. */
export async function approveQuote(taskId: string, actor: ActingPrincipal): Promise<Quote> {
  assertCanApprove(actor);
  await assertWoAllows(taskId, 'quote.approve');
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
  await assertNoOpenNteOverride(taskId, 'Sending the quote');

  // Read the numbers BEFORE the transaction opens (single-connection rule).
  const pre = await getQuote(taskId, actor);
  if (!pre) throw new ApiError('NOT_FOUND', 'No quote on this work order');
  const summaryText = pre.summary.pinned ?? pre.summary.auto;
  const firstLine = summaryText.split('\n').find((l) => l.trim().length > 0) ?? pre.wo_number;
  const body = `Quote for ${money(pre.totals.grand_total)} submitted for approval — ${firstLine.trim()}`;

  return transition(
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
  );
}

/**
 * pending_approval | approved → draft (atl+), with the reviewer's note landing
 * as an INTERNAL comment (it is feedback for the dispatcher, never for the
 * client). `rev` bumps: the quote that comes back is a new revision.
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
    ['pending_approval', 'approved'],
    'draft',
    'quote_rejected',
    actor,
    async (tx) => {
      await addComment(tx, actor.id, taskId, `Quote returned to draft — ${note}`, false);
    },
    'rev = rev + 1, approved_by = NULL',
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
  const priced = pre.totals.option_totals.find((o) => o.section_id === option.id);
  const amount = priced ? priced.grand_total : pre.totals.grand_total;
  const noteText = input.note?.trim() ? ` — ${input.note.trim()}` : '';
  const body = `Client approved ${option.label}${option.name ? ` (${option.name})` : ''} for ${money(amount)}${input.on_site ? ' (on site)' : ''}${noteText}`;

  return transition(
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
      await addComment(tx, actor.id, taskId, body, true, { quote_id: quoteId, section_id: option.id });
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
    'approved_section_id = $3, client_decided_at = now(), client_decided_by = $4, client_decision_note = $5, client_approved_on_site = $6',
    [option.id, actor.id, input.note?.trim() || null, input.on_site === true],
  );
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

  return transition(
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
    'rev = rev + 1, approved_by = NULL, sent_by = NULL, sent_at = NULL, approved_section_id = NULL, client_decided_at = NULL, client_decided_by = NULL, client_decision_note = NULL, client_approved_on_site = false',
  );
}
