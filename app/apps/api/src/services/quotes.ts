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
  QuoteSection,
  QuoteStatus,
  QuoteTotals,
  QuoteOptionTotal,
  QuoteSummary,
  QuotePermissions,
  ActivityActor,
} from '@theone/shared';
import { QUOTE_EDIT_ROLES, QUOTE_APPROVE_ROLES } from '@theone/shared';
import { ApiError, badRequest, forbidden } from '../errors.js';
import type { ActingPrincipal } from './activity.js';

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
}

/** The minimum shape computeQuoteTotals needs from a section. */
export interface TotalsSectionInput {
  id: string;
  kind: 'incurred' | 'option';
  label: string;
  name: string | null;
  include_in_summary: boolean;
  lines: TotalsLineInput[];
}

export interface TotalsInput {
  sections: TotalsSectionInput[];
  sales_tax: number;
  total_cost: number | null;
  nte: number | null;
}

/**
 * One line's money: qty × rate, ×1.5 when the OT flag is set.
 * The Day column is NOT part of this — its value is stored verbatim and no math
 * is done on it anywhere (semantics TBD pending the real quote-builder import).
 */
export function computeLineAmount(line: TotalsLineInput): number {
  const qty = Number.isFinite(line.qty) ? line.qty : 0;
  const rate = Number.isFinite(line.rate) ? line.rate : 0;
  return round2(qty * rate * (line.ot ? OT_MULTIPLIER : 1));
}

/**
 * Every number on the quote screen. The single home of quote arithmetic — the
 * money rail, the NTE meter, the summary and money.quote on the WO detail all
 * read the result of this function and never re-add anything themselves.
 *
 * RULE B — grand_total is the sum of the OPTION sections flagged
 * include_in_summary. The incurred subtotal is CONTEXT: that work is already on
 * the work order and bills with the job, so adding it here would bill it twice.
 * Flip to (a) incurred + options here if Jordan reverses:
 *     const grand_total = round2(incurred_subtotal + includedOptionsTotal);
 *
 * `profit` is grand_total − total_cost (null while our cost is unknown);
 * `margin_pct` is profit / grand_total × 100, to one decimal.
 */
export function computeQuoteTotals(input: TotalsInput): QuoteTotals {
  let incurred_subtotal = 0;
  const option_totals: QuoteOptionTotal[] = [];

  for (const section of input.sections) {
    const subtotal = round2(
      section.lines.reduce((sum, line) => sum + computeLineAmount(line), 0),
    );
    if (section.kind === 'incurred') {
      incurred_subtotal = round2(incurred_subtotal + subtotal);
    } else {
      option_totals.push({
        section_id: section.id,
        label: section.label,
        name: section.name,
        include_in_summary: section.include_in_summary,
        total: subtotal,
      });
    }
  }

  // ── RULE B ────────────────────────────────────────────────────────────────
  const grand_total = round2(
    option_totals.reduce((sum, o) => sum + (o.include_in_summary ? o.total : 0), 0),
  );

  const sales_tax = round2(Number.isFinite(input.sales_tax) ? input.sales_tax : 0);
  const total_cost = input.total_cost === null ? null : round2(input.total_cost);
  const profit = total_cost === null ? null : round2(grand_total - total_cost);
  const margin_pct =
    profit !== null && grand_total > 0 ? Math.round((profit / grand_total) * 1000) / 10 : null;

  return {
    incurred_subtotal,
    option_totals,
    grand_total,
    sales_tax,
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
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

/**
 * The auto-generated client text — narratives + the included line items +
 * totals, in the approved comp's format:
 *
 *     7-ELEVEN #41669 — GALVESTON, TX
 *     Ref WOT0452814 · Refrigeration
 *     …
 *     INCURRED / PROPOSED — OPTION A / GRAND TOTAL / note to customer
 *
 * Only options flagged include_in_summary appear — the same set RULE B totals.
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

  // ── Incurred ──────────────────────────────────────────────────────────────
  const incurred = sections.filter((s) => s.kind === 'incurred');
  for (const section of incurred) {
    out.push('', 'INCURRED');
    if (section.narrative_reported) {
      out.push(...wrap(`Tech reported that ${section.narrative_reported}`, SUMMARY_WIDTH));
    }
    if (section.lines.length > 0) out.push('');
    for (const line of section.lines) out.push(...amountRows(line.description, line.amount));
    out.push(...amountRows('Incurred subtotal', totals.incurred_subtotal));
  }

  // ── Proposed options ──────────────────────────────────────────────────────
  const incurredScope = incurred.flatMap((s) => s.scope_lines);
  let usedFallbackScope = false;
  const options = sections.filter((s) => s.kind === 'option' && s.include_in_summary);

  for (const section of options) {
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
    for (const line of section.lines) out.push(...amountRows(line.description, line.amount));
    out.push(...amountRows(`${section.label} total`, total ? total.total : 0));
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  out.push('');
  out.push(...amountRows('GRAND TOTAL', totals.grand_total, ''));
  out.push(...amountRows('Sales tax', totals.sales_tax, ''));
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
// 3 · ROLE GATES
// ═══════════════════════════════════════════════════════════════════════════

export function canEditQuote(actor: ActingPrincipal): boolean {
  return QUOTE_EDIT_ROLES.includes(actor.role ?? '');
}

export function canApproveQuote(actor: ActingPrincipal): boolean {
  return QUOTE_APPROVE_ROLES.includes(actor.role ?? '');
}

/** 403 FORBIDDEN — the actor exists, the route exists, the role is below the bar. */
export function assertCanEdit(actor: ActingPrincipal): void {
  if (!canEditQuote(actor)) {
    throw forbidden('Building and editing quotes requires Senior OM or above', {
      actor: actor.name,
      role: actor.role,
      required_roles: QUOTE_EDIT_ROLES,
    });
  }
}

export function assertCanApprove(actor: ActingPrincipal): void {
  if (!canApproveQuote(actor)) {
    throw forbidden('Approving and sending a quote requires ATL or above', {
      actor: actor.name,
      role: actor.role,
      required_roles: QUOTE_APPROVE_ROLES,
    });
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
  sales_tax: number | null;
  total_cost: number | null;
  specs: string | null;
  note_to_customer: string | null;
  summary_pinned: string | null;
  sent_at: string | null;
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
  wo_number: string;
  client: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  ext_name: string | null;
  title: string | null;
  nte: number | null;
  store: string | null;
}

const QUOTE_SQL = `
  SELECT q.id::text                       AS id,
         q.task_id::text                  AS task_id,
         q.status, q.rev,
         q.sales_tax::float8              AS sales_tax,
         q.total_cost::float8             AS total_cost,
         q.specs, q.note_to_customer, q.summary_pinned,
         ${ISO('q.sent_at')}              AS sent_at,
         ${ISO('q.created_at')}           AS created_at,
         ${ISO('q.updated_at')}           AS updated_at,
         cb.id::text AS created_by_id,  cb.display_name AS created_by_name,  cb.kind::text AS created_by_kind,
         ab.id::text AS approved_by_id, ab.display_name AS approved_by_name, ab.kind::text AS approved_by_kind,
         sb.id::text AS sent_by_id,     sb.display_name AS sent_by_name,     sb.kind::text AS sent_by_kind,
         t.wo_number, t.client, t.city, t.state, t.trade, t.ext_name, t.title,
         t.nte::float8                    AS nte,
         t.fields ->> 'Store'             AS store
    FROM quote q
    JOIN task t ON t.id = q.task_id
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
}

interface LineRow {
  id: string;
  section_id: string;
  line_type: QuoteLine['line_type'];
  description: string;
  qty: number | null;
  rate: number | null;
  day_value: string | null;
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

/** Sections + their lines, incurred first, options in position order. */
async function loadSections(quoteId: string): Promise<QuoteSection[]> {
  const secRes = await query<SectionRow>(
    `SELECT id::text AS id, kind, name, narrative_reported, scope_lines,
            include_in_summary, position
       FROM quote_section
      WHERE quote_id = $1
      ORDER BY CASE kind WHEN 'incurred' THEN 0 ELSE 1 END, position ASC, id ASC`,
    [quoteId],
  );
  const lineRes = await query<LineRow>(
    `SELECT l.id::text AS id, l.section_id::text AS section_id, l.line_type, l.description,
            l.qty::float8 AS qty, l.rate::float8 AS rate, l.day_value, l.ot, l.position
       FROM quote_line l
       JOIN quote_section s ON s.id = l.section_id
      WHERE s.quote_id = $1
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
      ot: l.ot === true,
      position: Number(l.position),
      amount: computeLineAmount({ qty: Number(l.qty ?? 0), rate: Number(l.rate ?? 0), ot: l.ot === true }),
    };
    const bucket = linesBySection.get(l.section_id);
    if (bucket) bucket.push(line);
    else linesBySection.set(l.section_id, [line]);
  }

  let optionIndex = 0;
  return secRes.rows.map((s) => {
    const lines = linesBySection.get(s.id) ?? [];
    const label = s.kind === 'incurred' ? 'Incurred' : `Option ${optionLetter(optionIndex++)}`;
    return {
      id: s.id,
      kind: s.kind,
      label,
      name: s.name,
      narrative_reported: s.narrative_reported,
      scope_lines: toStringArray(s.scope_lines),
      include_in_summary: s.include_in_summary === true,
      position: Number(s.position),
      lines,
      subtotal: Math.round(lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100,
    };
  });
}

function permissionsFor(actor: ActingPrincipal): QuotePermissions {
  return { can_edit: canEditQuote(actor), can_approve: canApproveQuote(actor) };
}

/** The full quote payload for a work order, or null when none exists. */
export async function getQuote(taskId: string, actor: ActingPrincipal): Promise<Quote | null> {
  const res = await query<QuoteRow>(QUOTE_SQL, [taskId]);
  if (res.rows.length === 0) return null;
  const q = res.rows[0];

  const sections = await loadSections(q.id);
  const totals = computeQuoteTotals({
    sections,
    sales_tax: Number(q.sales_tax ?? 0),
    total_cost: q.total_cost === null ? null : Number(q.total_cost),
    nte: q.nte === null ? null : Number(q.nte),
  });

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
    specs: q.specs,
    note_to_customer: q.note_to_customer,
    created_by: actorOf(q.created_by_id, q.created_by_name, q.created_by_kind),
    approved_by: actorOf(q.approved_by_id, q.approved_by_name, q.approved_by_kind),
    sent_by: actorOf(q.sent_by_id, q.sent_by_name, q.sent_by_kind),
    sent_at: q.sent_at,
    created_at: q.created_at,
    updated_at: q.updated_at,
    sections,
    totals,
    summary,
    permissions: permissionsFor(actor),
  };
}

/**
 * money.quote for the WO detail endpoint: the grand total of an APPROVED or SENT
 * quote, else null. A draft/pending quote is not a price the NTE meter may bind
 * to — "an approved quote fills money.quote" (product/quotes-payments.md §1).
 */
export async function getBindableQuoteTotal(taskId: string): Promise<number | null> {
  const res = await query<{ id: string; sales_tax: number | null; total_cost: number | null }>(
    `SELECT id::text AS id, sales_tax::float8 AS sales_tax, total_cost::float8 AS total_cost
       FROM quote WHERE task_id = $1 AND status IN ('approved','sent') LIMIT 1`,
    [taskId],
  );
  if (res.rows.length === 0) return null;
  const sections = await loadSections(res.rows[0].id);
  return computeQuoteTotals({
    sections,
    sales_tax: Number(res.rows[0].sales_tax ?? 0),
    total_cost: null,
    nte: null,
  }).grand_total;
}

/** One row of the sidebar "Quotes" list page (GET /api/quotes). */
export interface QuoteListItem {
  id: string;
  task_id: string;
  wo_number: string;
  title: string | null;
  client: string | null;
  status: QuoteStatus;
  grand_total: number | null;
  updated_at: string | null;
}

/**
 * Every quote, newest-updated first, for the sidebar list page.
 * grand_total goes through computeQuoteTotals() like every other number on the
 * screen — RULE B included — so the list can never disagree with the builder.
 */
export async function listQuotes(limit = 200): Promise<{ items: QuoteListItem[]; total: number }> {
  const res = await query<{
    id: string;
    task_id: string;
    wo_number: string;
    title: string | null;
    client: string | null;
    status: QuoteStatus;
    sales_tax: number | null;
    updated_at: string | null;
  }>(
    `SELECT q.id::text AS id, q.task_id::text AS task_id, q.status,
            q.sales_tax::float8 AS sales_tax,
            ${ISO('q.updated_at')} AS updated_at,
            t.wo_number, t.title, t.client
       FROM quote q
       JOIN task t ON t.id = q.task_id
      ORDER BY q.updated_at DESC
      LIMIT $1`,
    [limit],
  );

  const items: QuoteListItem[] = [];
  for (const r of res.rows) {
    const sections = await loadSections(r.id);
    const totals = computeQuoteTotals({
      sections,
      sales_tax: Number(r.sales_tax ?? 0),
      total_cost: null,
      nte: null,
    });
    items.push({
      id: r.id,
      task_id: r.task_id,
      wo_number: r.wo_number,
      title: r.title,
      client: r.client,
      status: r.status,
      grand_total: totals.grand_total,
      updated_at: r.updated_at,
    });
  }
  return { items, total: items.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 · WRITE
// ═══════════════════════════════════════════════════════════════════════════

/** Section as accepted by PUT — ids are not honoured, sections are replaced whole. */
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
  ot?: boolean;
}

export interface QuoteUpdateInput {
  sales_tax?: number;
  total_cost?: number | null;
  specs?: string | null;
  note_to_customer?: string | null;
  summary_pinned?: string | null;
  sections?: SectionInput[];
}

/** Statuses a quote may still be edited in (§1: edits stop once approved). */
const EDITABLE_STATUSES: QuoteStatus[] = ['draft', 'pending_approval'];

async function currentStatus(taskId: string): Promise<{ id: string; status: QuoteStatus } | null> {
  const res = await query<{ id: string; status: QuoteStatus }>(
    `SELECT id::text AS id, status FROM quote WHERE task_id = $1 LIMIT 1`,
    [taskId],
  );
  return res.rows.length === 0 ? null : res.rows[0];
}

/** Create the empty draft (senior_om+). One quote per WO — 400 if one exists. */
export async function createQuote(taskId: string, actor: ActingPrincipal): Promise<Quote> {
  assertCanEdit(actor);
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
      `INSERT INTO quote_section (quote_id, kind, name, include_in_summary, position)
       VALUES ($1, 'incurred', 'Work already performed', true, 0)`,
      [ins.rows[0].id],
    );
    await logQuoteActivity(tx, actor.id, taskId, 'quote_created', null, { status: 'draft' });
  });

  const quote = await getQuote(taskId, actor);
  if (!quote) throw new ApiError('INTERNAL', 'Quote insert produced no row');
  return quote;
}

/**
 * Full update of the quote's fields and (when `sections` is present) its whole
 * section/line tree. Sections are REPLACED, not merged: the builder autosaves
 * the entire form, and diffing rows the operator dragged around would be a
 * bigger surface than rewriting a dozen rows inside one transaction.
 */
export async function updateQuote(
  taskId: string,
  input: QuoteUpdateInput,
  actor: ActingPrincipal,
): Promise<Quote> {
  assertCanEdit(actor);
  const cur = await currentStatus(taskId);
  if (!cur) throw new ApiError('NOT_FOUND', 'No quote on this work order');
  if (!EDITABLE_STATUSES.includes(cur.status)) {
    throw badRequest(`A quote in status "${cur.status}" can no longer be edited`, {
      status: cur.status,
      editable_in: EDITABLE_STATUSES,
    });
  }

  const db = getDb();
  await db.transaction(async (tx) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.sales_tax !== undefined) set('sales_tax', input.sales_tax);
    if (input.total_cost !== undefined) set('total_cost', input.total_cost);
    if (input.specs !== undefined) set('specs', input.specs);
    if (input.note_to_customer !== undefined) set('note_to_customer', input.note_to_customer);
    if (input.summary_pinned !== undefined) set('summary_pinned', input.summary_pinned);
    if (sets.length > 0) {
      params.push(cur.id);
      await tx.query(`UPDATE quote SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }

    if (input.sections !== undefined) {
      // ON DELETE CASCADE takes the lines with them.
      await tx.query(`DELETE FROM quote_section WHERE quote_id = $1`, [cur.id]);
      let position = 0;
      for (const section of input.sections) {
        const secRes = await tx.query<{ id: string }>(
          `INSERT INTO quote_section
             (quote_id, kind, name, narrative_reported, scope_lines, include_in_summary, position)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           RETURNING id::text AS id`,
          [
            cur.id,
            section.kind,
            section.name ?? null,
            section.narrative_reported ?? null,
            JSON.stringify(section.scope_lines ?? []),
            section.include_in_summary ?? true,
            position++,
          ],
        );
        const sectionId = secRes.rows[0].id;
        let linePos = 0;
        for (const line of section.lines ?? []) {
          await tx.query(
            `INSERT INTO quote_line
               (section_id, line_type, description, qty, rate, day_value, ot, position)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              sectionId,
              line.line_type,
              line.description,
              line.qty,
              line.rate,
              line.day_value ?? null,
              line.ot ?? false,
              linePos++,
            ],
          );
        }
      }
    }

    await logQuoteActivity(tx, actor.id, taskId, 'quote_updated', null, {
      quote_id: cur.id,
      fields: Object.keys(input),
    });
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
  return transition(taskId, ['draft'], 'pending_approval', 'quote_submitted', actor);
}

/** pending_approval → approved (atl+). Fills money.quote on the WO. */
export async function approveQuote(taskId: string, actor: ActingPrincipal): Promise<Quote> {
  assertCanApprove(actor);
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
 * approved → sent (atl+). Stamps sent_by/sent_at AND posts the client-visible
 * update to the WO feed in the SAME transaction — the client-facing record of
 * the push and the quote's own state can never drift apart.
 */
export async function sendQuote(taskId: string, actor: ActingPrincipal): Promise<Quote> {
  assertCanApprove(actor);

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
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO comment (task_id, author_principal_id, body, client_visible)
         VALUES ($1, $2, $3, true) RETURNING id::text AS id`,
        [taskId, actor.id, body],
      );
      await tx.query(
        `INSERT INTO activity_log
           (actor_principal_id, entity_type, entity_id, action, field, before, after)
         VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
        [
          actor.id,
          taskId,
          JSON.stringify({ comment_id: ins.rows[0].id, client_visible: true, quote_id: quoteId }),
        ],
      );
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
  return transition(
    taskId,
    ['pending_approval', 'approved'],
    'draft',
    'quote_rejected',
    actor,
    async (tx) => {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO comment (task_id, author_principal_id, body, client_visible)
         VALUES ($1, $2, $3, false) RETURNING id::text AS id`,
        [taskId, actor.id, `Quote returned to draft — ${note}`],
      );
      await tx.query(
        `INSERT INTO activity_log
           (actor_principal_id, entity_type, entity_id, action, field, before, after)
         VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
        [actor.id, taskId, JSON.stringify({ comment_id: ins.rows[0].id, client_visible: false })],
      );
    },
    'rev = rev + 1, approved_by = NULL',
  );
}
