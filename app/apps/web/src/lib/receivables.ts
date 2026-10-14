// Receivables (AR) — the completion-audit rules and the Ready-to-invoice test.
//
// Ported from the Support Automation shadow-audit assistant (Support
// Automation/support-automation/lib/audit-rules.ts): the same deterministic
// checks an admin runs before a finished WO may leave the Low (Grey) flag and
// be invoiced — CICO, client quote, SharePoint deliverables (SO sheet,
// before/after images, label convention), CO# format, and the Admin/Quote
// release gate.
//
// The Audit tab is a CLIENT-SIDE PROTOTYPE over the work-order list payload
// and the quotes list. Every fact a rule reads is either carried by those
// payloads or `null` = The One does not track it yet; nothing is derived from
// the work-order id, seeded, or invented (AUDIT.md W2-1). A null fact yields
// ONE "offline" line in the evidence panel — coverage, never a finding. The
// four audit checkboxes are page state (not saved) and do NOT feed invoicing:
// a work order is ready to invoice when it is Done, its quote is approved and
// no invoice exists for it yet (`isReadyToInvoice`).
//
// The lists are windows, not the whole table: GET /quotes answers its
// QUOTES_LIST_CAP most recently updated quotes, GET /invoices its
// INVOICES_LIST_CAP newest, and the page asks for WO_LIST_CAP Done work
// orders. A quote a full window did not reach is an UNKNOWN fact (null),
// never "missing" — the only real finding left must not depend on pagination.

import { BFI_KEY, VISIT_MIRROR_KEYS } from '@theone/shared';
import type { QuoteListItem, WorkOrderListItemV2 } from '../api/client';

/** A fact the audit reads. `null` = The One does not track this yet, or the
    list did not carry it for this viewer (not asked / redacted); the page
    draws it as a dash titled "not tracked yet". A TEXT fact the record
    carries but holds empty is `''` — tracked, empty — and gets its own dash
    ("unassigned", "no visit recorded"): an empty value is a fact too. */
export type Fact<T> = T | null;

// ── The windows the lists answer ────────────────────────────────────────────
// Pinned against the API source by tests/receivables-no-fake.test.ts.

/** services/quotes.ts `listQuotes(limit = 200)`; GET /quotes passes no limit. */
export const QUOTES_LIST_CAP = 200;
/** services/invoices.ts `listInvoices` — `LIMIT 500`, newest first. */
export const INVOICES_LIST_CAP = 500;
/** The most Done work orders the page asks for: the list route's maximum. */
export const WO_LIST_CAP = 500;

/** A list that came back full may have stopped before every row: what it
    does not hold cannot be called missing. */
export function listCapped(count: number, cap: number): boolean {
  return count >= cap;
}

// ── Severity model (verbatim from the audit assistant) ──────────────────────
export type AuditSeverity = 'major' | 'minor' | 'info' | 'offline';
export type AuditStatus = 'clean' | 'minor' | 'major';

/** Where a resolution chip points. External systems are stubbed in the
    prototype, so only `wo` navigates; the rest render as inert system chips. */
export type ResolveKind = 'wo' | 'clickup' | 'sharepoint';

export interface AuditIssue {
  id: string;
  severity: AuditSeverity;
  title: string;
  description: string;
  resolve: { label: string; kind: ResolveKind }[];
}

/** The four audit checkboxes. GTG/Elise are triage marks; Admin+Quote are the
    release gate — both must be ticked before the flag can move off Grey. */
export interface AuditChecks {
  gtg: boolean;
  elise: boolean;
  admin: boolean;
  quote: boolean;
}

export interface AuditRow {
  wo: WorkOrderListItemV2;
  /** Bill For Incurred — after-images are not required when ticked. */
  bfi: Fact<boolean>;
  /** The latest visit's Check-in/out status, as the list mirrors it;
      `''` = the work order has no visit recorded. */
  cico: Fact<string>;
  /** `''` = unassigned. */
  assignee: Fact<string>;
  /** A quote exists for the work order: true / false when the quotes list
      was complete, null when it was unavailable or came back full (it may
      have stopped before this work order's quote) — unknown, never missing. */
  hasClientQuote: Fact<boolean>;
  /** Number · total · status of that quote, when the list carries them. */
  clientQuotePreview: string | null;
  /** Closeout number. Only validated when populated (6 digits). Not tracked yet. */
  coNumber: Fact<string>;
  /** Days since done / days on Grey. Not tracked yet. */
  daysDone: Fact<number>;
  daysGrey: Fact<number>;
  fm: string;
  comp: string;
  /** No SharePoint reader runs in the browser: folder checks are always offline. */
  sp: { live: false };
  /** Nothing is seeded: every tick starts off and lives in page state. */
  checks: AuditChecks;
}

/** What the page asks the list for — the three facts the payload can carry
    (the visit mirror's status key and the 0061 BFI checkbox, from shared). */
export const AUDIT_COLUMNS = [
  'fields.Assignee',
  `fields.${VISIT_MIRROR_KEYS.status}`,
  `fields.${BFI_KEY}`,
] as const;

const ASSIGNEE_COL = AUDIT_COLUMNS[0];
const CICO_COL = AUDIT_COLUMNS[1];
const BFI_COL = AUDIT_COLUMNS[2];

// ── Reading the payload ─────────────────────────────────────────────────────
// The list projects `custom` only for the keys asked, and drops a key the
// viewer may not see (field redaction). So: key absent = unknown (null);
// key present = the record's own value, blank included.

/** `undefined` when the list did not carry the key, else its text or null. */
function projected(wo: WorkOrderListItemV2, key: string): string | null | undefined {
  const custom = wo.custom;
  if (!custom || !(key in custom)) return undefined;
  return custom[key];
}

/** Absent → null (not carried for this viewer); carried but blank → '' (the
    record is tracked and empty); else the value. */
function textFact(wo: WorkOrderListItemV2, key: string): Fact<string> {
  const v = projected(wo, key);
  if (v === undefined) return null;
  return (v ?? '').trim();
}

/** A checkbox arrives as the jsonb text ('true' / 'false'); an unticked box
    may also be absent from the bag, which projects as null = not ticked. */
function checkboxFact(wo: WorkOrderListItemV2, key: string): Fact<boolean> {
  const v = projected(wo, key);
  if (v === undefined) return null;
  const s = (v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

export function quotesByTask(quotes: QuoteListItem[]): Map<string, QuoteListItem> {
  return new Map(quotes.map((q) => [q.task_id, q]));
}

function quotePreview(q: QuoteListItem | undefined): string | null {
  if (!q) return null;
  const parts = [
    q.number,
    q.grand_total != null ? fmtMoney(q.grand_total) : null,
    q.status.replace(/_/g, ' '),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return parts.length ? parts.join(' · ') : null;
}

/** Billing entity → the short "Comp" code the audit table shows. */
function compCode(wo: WorkOrderListItemV2): string {
  const src = wo.billing_entity ?? wo.client ?? 'SFM';
  const letters = src.replace(/[^a-zA-Z]/g, '').toUpperCase();
  return letters.slice(0, 3) || 'SFM';
}

function deriveRow(
  wo: WorkOrderListItemV2,
  quoteByTask: Map<string, QuoteListItem>,
  quotesComplete: boolean,
): AuditRow {
  const q = quoteByTask.get(wo.id);
  return {
    wo,
    bfi: checkboxFact(wo, BFI_COL),
    cico: textFact(wo, CICO_COL),
    assignee: textFact(wo, ASSIGNEE_COL),
    hasClientQuote: q !== undefined ? true : quotesComplete ? false : null,
    clientQuotePreview: quotePreview(q),
    coNumber: null,
    daysDone: null,
    daysGrey: null,
    fm: wo.client ?? '—',
    comp: compCode(wo),
    sp: { live: false },
    checks: { gtg: false, elise: false, admin: false, quote: false },
  };
}

/** The Grey Flag queue: every done-group work order, oldest first. Nothing
    is padded in from active rows — an empty queue is a real answer. */
export interface ReceivablesModel {
  queue: AuditRow[];
}

/** `quotes` is the quotes list as it came back, or null when it did not
    (failed, or the viewer may not read quotes): then no row can say whether
    its quote exists. A list that came back full is treated the same way for
    the rows it holds no quote for — it may have stopped before them. */
export function deriveReceivables(
  items: WorkOrderListItemV2[],
  quotes: QuoteListItem[] | null,
): ReceivablesModel {
  const byAge = (a: WorkOrderListItemV2, b: WorkOrderListItemV2) =>
    (b.age_days ?? 0) - (a.age_days ?? 0);
  const byTask = quotes ? quotesByTask(quotes) : new Map<string, QuoteListItem>();
  const complete = quotes !== null && !listCapped(quotes.length, QUOTES_LIST_CAP);
  const queue = items
    .filter((w) => w.status.group === 'done')
    .sort(byAge)
    .map((w) => deriveRow(w, byTask, complete));
  return { queue };
}

// ── Ready to invoice ────────────────────────────────────────────────────────
// Real facts only: the status group, the quote's status, and whether an
// invoice record already exists for the work order. The audit ticks above
// are page state and decide nothing here.

export const READY_QUOTE_STATUSES: readonly QuoteListItem['status'][] = [
  'approved',
  'sent',
  'client_approved',
];

export function isReadyToInvoice(
  wo: WorkOrderListItemV2,
  quoteByTask: Map<string, QuoteListItem>,
  invoicedTaskIds: ReadonlySet<string>,
): boolean {
  if (wo.status.group !== 'done') return false;
  const q = quoteByTask.get(wo.id);
  if (!q || !READY_QUOTE_STATUSES.includes(q.status)) return false;
  return !invoicedTaskIds.has(wo.id);
}

/** The quote's grand total, or null = the lane shows a dash, never a guess. */
export function readyAmount(q: QuoteListItem | undefined): number | null {
  return q?.grand_total ?? null;
}

// ── The rules engine (computeIssues, ported check-for-check) ────────────────

const WO_LINK = { label: 'Open work order', kind: 'wo' as const };
const CU_LINK = { label: 'ClickUp task', kind: 'clickup' as const };
const SP_LINK = { label: 'SharePoint folder', kind: 'sharepoint' as const };

/** A fact The One does not carry: one coverage line, never a finding. */
function notTracked(id: string, key: string, label: string, description: string): AuditIssue {
  return { id: `${id}-${key}-offline`, severity: 'offline', title: `${label} not tracked yet`, description, resolve: [] };
}

export function computeAuditIssues(row: AuditRow, checks: AuditChecks): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const id = row.wo.id;

  if (row.cico === null) {
    issues.push(
      notTracked(
        id,
        'cico',
        'CICO',
        'The Check-in/out status did not come with the work order (the field is not defined, or not visible to you), so this check is skipped.',
      ),
    );
  } else if (row.cico === '') {
    issues.push({
      id: `${id}-cico`,
      severity: 'minor',
      title: 'CICO is empty — no visit recorded',
      description:
        'No visit has been checked in or out on this work order, so there is no check-out to confirm. The dispatcher should log the visit.',
      resolve: [WO_LINK, CU_LINK],
    });
  } else if (row.cico !== 'Checked-out') {
    issues.push({
      id: `${id}-cico`,
      severity: 'minor',
      title: `CICO is "${row.cico}", expected "Checked-out"`,
      description:
        'The Check-in/out status is not Checked-out. The dispatcher should confirm the technician has checked out.',
      resolve: [WO_LINK, CU_LINK],
    });
  }

  if (row.hasClientQuote === null) {
    // Unknown, not missing: the quotes list did not come back, or came back
    // full and may have stopped before this work order's quote.
    issues.push({
      id: `${id}-client-quote-offline`,
      severity: 'offline',
      title: 'Client Quote not checked',
      description: `The quotes list did not load, or stopped at its ${QUOTES_LIST_CAP} most recently updated quotes before reaching this work order, so whether a quote exists cannot be read here. Open the work order to see its quote.`,
      resolve: [WO_LINK],
    });
  } else if (!row.hasClientQuote) {
    issues.push({
      id: `${id}-client-quote`,
      severity: 'major',
      title: 'Client Quote missing',
      description:
        'No quote exists for this work order. The quote sent to the client must be filled before this WO can be audited.',
      resolve: [WO_LINK, CU_LINK],
    });
  }

  // No SharePoint reader runs in the browser: the folder checks (SO present,
  // before/after images, labeling) are always skipped here.
  issues.push({
    id: `${id}-sp-offline`,
    severity: 'offline',
    title: 'SharePoint integration offline',
    description:
      'Folder content checks (SO present, before/after images, labeling) are skipped for this WO. They activate once the Microsoft Graph integration is wired up.',
    resolve: [SP_LINK],
  });

  if (row.bfi === null) {
    issues.push(
      notTracked(
        id,
        'bfi',
        'BFI',
        'The Bill For Incurred checkbox did not come with the work order (not defined, or not visible to you), so the after-images waiver cannot be read.',
      ),
    );
  }

  if (row.coNumber === null) {
    issues.push(
      notTracked(
        id,
        'co',
        'CO#',
        'The One does not track closeout numbers yet, so the 6-digit format check is skipped.',
      ),
    );
  } else if (!/^\d{6}$/.test(row.coNumber)) {
    issues.push({
      id: `${id}-co`,
      severity: 'minor',
      title: `CO# format invalid ("${row.coNumber}")`,
      description:
        'The Closeout Number must be exactly 6 digits. Read the correct value from the SO and update the WO.',
      resolve: [SP_LINK, WO_LINK],
    });
  }

  if (!checks.admin || !checks.quote) {
    issues.push({
      id: `${id}-gate`,
      severity: 'info',
      title: 'Release checkboxes pending',
      description: `Admin Check ${checks.admin ? '✓' : '✗'} · Quote Check ${checks.quote ? '✓' : '✗'}. Both must be ticked before the flag can move from Low (Grey) to Normal.`,
      resolve: [],
    });
  }

  return issues;
}

export interface AuditSummary {
  major: number;
  minor: number;
  info: number;
  offline: number;
  total: number;
}

export function summarizeIssues(issues: AuditIssue[]): AuditSummary {
  return {
    major: issues.filter((i) => i.severity === 'major').length,
    minor: issues.filter((i) => i.severity === 'minor').length,
    info: issues.filter((i) => i.severity === 'info').length,
    offline: issues.filter((i) => i.severity === 'offline').length,
    total: issues.length,
  };
}

/** "offline" reflects coverage, not the WO — it never colors the status. */
export function overallStatus(issues: AuditIssue[]): AuditStatus {
  const s = summarizeIssues(issues);
  if (s.major > 0) return 'major';
  if (s.minor > 0) return 'minor';
  return 'clean';
}

// ── Auto-check lines (the per-WO evidence panel) ────────────────────────────
// The expanded row shows every check the engine RAN, not only what failed —
// that read-out is the audit assistant's signature surface. A fact The One
// does not carry reads "not tracked yet".

export type CheckOutcome = 'pass' | 'minor' | 'major' | 'info' | 'na' | 'offline';

export interface CheckLine {
  label: string;
  outcome: CheckOutcome;
  detail: string;
}

const NOT_TRACKED = 'not tracked yet';

export function buildCheckLines(row: AuditRow, checks: AuditChecks): CheckLine[] {
  const lines: CheckLine[] = [];
  lines.push(
    row.cico === null
      ? { label: 'CICO', outcome: 'offline', detail: NOT_TRACKED }
      : row.cico === ''
        ? { label: 'CICO', outcome: 'minor', detail: 'empty — no visit recorded' }
        : row.cico === 'Checked-out'
          ? { label: 'CICO', outcome: 'pass', detail: 'Checked-out' }
          : { label: 'CICO', outcome: 'minor', detail: `"${row.cico}" — expected Checked-out` },
  );
  lines.push(
    row.hasClientQuote === null
      ? {
          label: 'Client Quote',
          outcome: 'offline',
          detail: `not checked — the quotes list did not load or stopped at its ${QUOTES_LIST_CAP} newest`,
        }
      : row.hasClientQuote
        ? { label: 'Client Quote', outcome: 'pass', detail: row.clientQuotePreview ?? 'present' }
        : { label: 'Client Quote', outcome: 'major', detail: 'missing' },
  );
  lines.push({
    label: 'SharePoint folder',
    outcome: 'offline',
    detail: 'integration offline — content checks skipped',
  });
  lines.push(
    row.bfi === null
      ? { label: 'BFI', outcome: 'offline', detail: NOT_TRACKED }
      : row.bfi
        ? { label: 'BFI', outcome: 'pass', detail: 'ticked — after-images not required' }
        : { label: 'BFI', outcome: 'na', detail: 'not ticked — after-images required' },
  );
  lines.push(
    row.coNumber === null
      ? { label: 'CO#', outcome: 'offline', detail: NOT_TRACKED }
      : /^\d{6}$/.test(row.coNumber)
        ? { label: 'CO#', outcome: 'pass', detail: row.coNumber }
        : { label: 'CO#', outcome: 'minor', detail: `"${row.coNumber}" — must be 6 digits` },
  );
  lines.push(
    checks.admin && checks.quote
      ? { label: 'Release gate', outcome: 'pass', detail: 'Admin ✓ · Quote ✓ (not saved)' }
      : {
          label: 'Release gate',
          outcome: 'info',
          detail: `Admin ${checks.admin ? '✓' : '✗'} · Quote ${checks.quote ? '✓' : '✗'} — both required (not saved)`,
        },
  );
  return lines;
}
