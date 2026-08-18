// Receivables (AR) — the completion-audit rules engine and its queue model.
//
// Ported from the Support Automation shadow-audit assistant (Support
// Automation/support-automation/lib/audit-rules.ts): the same deterministic
// checks an admin runs before a finished WO may leave the Low (Grey) flag and
// be invoiced — CICO, client quote, SharePoint deliverables (SO sheet,
// before/after images, label convention), CO# format, and the Admin/Quote
// release gate.
//
// The prototype has no ClickUp/Graph integration, so every audit fact the
// rules read (BFI, CICO, folder contents…) is derived HERE, seeded by the WO
// id — stable across reloads, different per WO, and entirely client-side.
// The four audit checkboxes are interactive: ticking Admin + Quote on a WO
// with no findings flips it clean, which is exactly what moves it into the
// Invoicing subtab's "Ready" lane. One derivation, both subtabs.

import type { WorkOrderListItemV2 } from '../api/client';

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
  /** Billed For Invoice — after-images are not required when set. */
  bfi: boolean;
  cico: 'Checked-out' | 'Checked-in' | 'RTN';
  hasClientQuote: boolean;
  clientQuotePreview: string | null;
  /** Closeout number. Only validated when populated (6 digits). */
  coNumber: string | null;
  daysDone: number;
  daysGrey: number;
  fm: string;
  comp: string;
  assignee: string;
  sp: {
    live: boolean;
    accessible: boolean;
    empty: boolean;
    hasSo: boolean;
    hasBefore: boolean;
    hasAfter: boolean;
    mislabeled: number;
  };
  /** Seeded defaults; the page overlays the user's toggles on top. */
  checks: AuditChecks;
}

// ── Seeded derivation ───────────────────────────────────────────────────────
// FNV-1a over id+salt. Not randomness — a stable property of the WO.

function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const unit = (id: string, salt: string) => (hash(id + salt) % 1000) / 1000;
const chance = (id: string, salt: string, p: number) => unit(id, salt) < p;
const intIn = (id: string, salt: string, min: number, max: number) =>
  min + (hash(id + salt) % (max - min + 1));

const ASSIGNEES = ['Elise T.', 'Mya R.', 'Kelly D.', 'Ram P.', 'Dana W.'];

/** Billing entity → the short "Comp" code the audit table shows. */
function compCode(wo: WorkOrderListItemV2): string {
  const src = wo.billing_entity ?? wo.client ?? 'SFM';
  const letters = src.replace(/[^a-zA-Z]/g, '').toUpperCase();
  return letters.slice(0, 3) || 'SFM';
}

function deriveRow(wo: WorkOrderListItemV2): AuditRow {
  const id = wo.id;
  const cicoRoll = unit(id, 'cico');
  const coApplicable = chance(id, 'co-app', 0.4);
  const coRoll = unit(id, 'co-fmt');
  const coNumber = !coApplicable
    ? null
    : coRoll < 0.15
      ? null // applicable but not yet filled — reviewer optional, no finding
      : coRoll < 0.32
        ? `CO-${intIn(id, 'co-bad', 100, 9999)}` // wrong format → minor
        : String(100000 + (hash(id + 'co-ok') % 900000)); // valid 6 digits

  const daysGrey = Math.max(0, intIn(id, 'grey', 0, 11) - 4); // most sit at 0–2
  const live = chance(id, 'sp-live', 0.88);
  const accessible = chance(id, 'sp-acc', 0.93);
  const empty = accessible && chance(id, 'sp-empty', 0.08);

  return {
    wo,
    bfi: chance(id, 'bfi', 0.15),
    cico: cicoRoll < 0.78 ? 'Checked-out' : cicoRoll < 0.92 ? 'Checked-in' : 'RTN',
    hasClientQuote: chance(id, 'cq', 0.78),
    clientQuotePreview: chance(id, 'cq', 0.78)
      ? wo.nte != null
        ? `$${wo.nte.toLocaleString('en-US')} — ${wo.trade ?? 'service'} per quote`
        : `${wo.trade ?? 'Service'} — see quote thread`
      : null,
    coNumber,
    daysDone: daysGrey + intIn(id, 'done', 1, 6),
    daysGrey,
    fm: wo.client ?? '—',
    comp: compCode(wo),
    assignee: ASSIGNEES[hash(id + 'who') % ASSIGNEES.length],
    sp: {
      live,
      accessible,
      empty,
      hasSo: chance(id, 'sp-so', 0.72),
      hasBefore: chance(id, 'sp-b', 0.9),
      hasAfter: chance(id, 'sp-a', 0.78),
      mislabeled: chance(id, 'sp-lbl', 0.18) ? intIn(id, 'sp-lbl-n', 1, 3) : 0,
    },
    checks: {
      gtg: chance(id, 'ck-gtg', 0.55),
      elise: chance(id, 'ck-el', 0.45),
      admin: chance(id, 'ck-adm', 0.3),
      quote: chance(id, 'ck-qt', 0.35),
    },
  };
}

/**
 * One partition, both subtabs. Done-group WOs split into:
 *   queue    — still held by the completion audit (the Grey Flag queue)
 *   history  — released and billed in a past life (plus any closed-group WOs);
 *              these seed the invoicing pipeline's Invoiced/Paid lanes.
 * A WO is in exactly one of the two, so the demo stays self-consistent.
 * Topped up from active rows when the seed data is thin.
 */
export interface ReceivablesModel {
  queue: AuditRow[];
  history: InvoiceRow[];
}

export function deriveReceivables(items: WorkOrderListItemV2[]): ReceivablesModel {
  const byAge = (a: WorkOrderListItemV2, b: WorkOrderListItemV2) =>
    (b.age_days ?? 0) - (a.age_days ?? 0);
  const done = items.filter((w) => w.status.group === 'done').sort(byAge);
  const closed = items.filter((w) => w.status.group === 'closed').sort(byAge);

  const split = Math.max(8, Math.ceil(done.length * 0.6));
  const queueSrc = done.slice(0, split);
  if (queueSrc.length < 8) {
    const active = items.filter((w) => w.status.group === 'active').sort(byAge);
    queueSrc.push(...active.slice(0, 8 - queueSrc.length));
  }

  const history = [...closed, ...done.slice(split)].slice(0, 24).map((wo) => ({
    wo,
    stage: chance(wo.id, 'inv-paid', 0.55) ? ('paid' as const) : ('invoiced' as const),
    amount: invoiceAmount(wo),
    invoiceNo: invoiceNoFor(wo),
    agedDays: intIn(wo.id, 'inv-age', 1, 38),
  }));

  return { queue: queueSrc.map(deriveRow), history };
}

// ── The rules engine (computeIssues, ported check-for-check) ────────────────

const WO_LINK = { label: 'Open work order', kind: 'wo' as const };
const CU_LINK = { label: 'ClickUp task', kind: 'clickup' as const };
const SP_LINK = { label: 'SharePoint folder', kind: 'sharepoint' as const };

export function computeAuditIssues(row: AuditRow, checks: AuditChecks): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const id = row.wo.id;

  if (row.cico !== 'Checked-out') {
    issues.push({
      id: `${id}-cico`,
      severity: 'minor',
      title: `CICO is "${row.cico}", expected "Checked-out"`,
      description:
        'The Check-in/out status is not Checked-out. The dispatcher should confirm the technician has checked out.',
      resolve: [WO_LINK, CU_LINK],
    });
  }

  if (!row.hasClientQuote) {
    issues.push({
      id: `${id}-client-quote`,
      severity: 'major',
      title: 'Client Quote missing',
      description:
        'The Client Quote field is empty. The quote sent to the client must be filled before this WO can be audited.',
      resolve: [WO_LINK, CU_LINK],
    });
  }

  if (!row.sp.live) {
    issues.push({
      id: `${id}-sp-offline`,
      severity: 'offline',
      title: 'SharePoint integration offline',
      description:
        'Folder content checks (SO present, before/after images, labeling) are skipped for this WO. They activate once the Microsoft Graph integration is wired up.',
      resolve: [SP_LINK],
    });
  } else if (!row.sp.accessible) {
    issues.push({
      id: `${id}-sp-inaccessible`,
      severity: 'major',
      title: 'SharePoint folder inaccessible',
      description:
        'The SharePoint link is set but the folder cannot be accessed. Verify permissions or the path.',
      resolve: [SP_LINK, CU_LINK],
    });
  } else if (row.sp.empty) {
    issues.push({
      id: `${id}-sp-empty`,
      severity: 'major',
      title: 'SharePoint folder is empty',
      description:
        'No images or sign-off sheet have been uploaded for this WO. Dispatcher or technician must add the deliverables.',
      resolve: [SP_LINK],
    });
  } else {
    if (!row.sp.hasSo) {
      issues.push({
        id: `${id}-so-missing`,
        severity: 'major',
        title: 'Sign-off sheet (SO) missing',
        description:
          "No file named 'SO' exists in the folder. The signed sign-off sheet must be uploaded before release.",
        resolve: [SP_LINK],
      });
    }
    if (!row.sp.hasBefore) {
      issues.push({
        id: `${id}-before-images`,
        severity: 'major',
        title: 'Before-images missing',
        description:
          "No before-work images detected (no file starting with 'B'). Before-images are required for every WO.",
        resolve: [SP_LINK],
      });
    }
    if (!row.bfi && !row.sp.hasAfter) {
      issues.push({
        id: `${id}-after-images`,
        severity: 'major',
        title: 'After-images missing',
        description:
          "No after-work images detected (no file starting with 'A') and the WO is not marked BFI. After-images are required.",
        resolve: [SP_LINK],
      });
    }
    if (row.sp.mislabeled > 0) {
      issues.push({
        id: `${id}-labels`,
        severity: 'minor',
        title: `${row.sp.mislabeled} image${row.sp.mislabeled > 1 ? 's' : ''} mislabeled`,
        description:
          "Image filenames do not follow the 'B (n)' / 'a (n)' convention and should be renamed before release.",
        resolve: [SP_LINK],
      });
    }
  }

  if (row.coNumber !== null && !/^\d{6}$/.test(row.coNumber)) {
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
// that read-out is the audit assistant's signature surface.

export type CheckOutcome = 'pass' | 'minor' | 'major' | 'info' | 'na' | 'offline';

export interface CheckLine {
  label: string;
  outcome: CheckOutcome;
  detail: string;
}

export function buildCheckLines(row: AuditRow, checks: AuditChecks): CheckLine[] {
  const lines: CheckLine[] = [];
  lines.push(
    row.cico === 'Checked-out'
      ? { label: 'CICO', outcome: 'pass', detail: 'Checked-out' }
      : { label: 'CICO', outcome: 'minor', detail: `"${row.cico}" — expected Checked-out` },
  );
  lines.push(
    row.hasClientQuote
      ? { label: 'Client Quote', outcome: 'pass', detail: row.clientQuotePreview ?? 'present' }
      : { label: 'Client Quote', outcome: 'major', detail: 'missing' },
  );
  if (!row.sp.live) {
    lines.push({
      label: 'SharePoint folder',
      outcome: 'offline',
      detail: 'integration offline — content checks skipped',
    });
  } else if (!row.sp.accessible) {
    lines.push({ label: 'SharePoint folder', outcome: 'major', detail: 'inaccessible' });
  } else if (row.sp.empty) {
    lines.push({ label: 'SharePoint folder', outcome: 'major', detail: 'empty — no deliverables' });
  } else {
    lines.push({ label: 'SharePoint folder', outcome: 'pass', detail: 'accessible, has files' });
    lines.push(
      row.sp.hasSo
        ? { label: 'Sign-off sheet', outcome: 'pass', detail: 'SO.pdf present' }
        : { label: 'Sign-off sheet', outcome: 'major', detail: 'no SO file found' },
    );
    lines.push(
      row.sp.hasBefore
        ? { label: 'Before-images', outcome: 'pass', detail: 'present' }
        : { label: 'Before-images', outcome: 'major', detail: 'none found' },
    );
    lines.push(
      row.bfi
        ? { label: 'After-images', outcome: 'na', detail: 'not required — WO is BFI' }
        : row.sp.hasAfter
          ? { label: 'After-images', outcome: 'pass', detail: 'present' }
          : { label: 'After-images', outcome: 'major', detail: 'none found' },
    );
    lines.push(
      row.sp.mislabeled > 0
        ? {
            label: 'Image labels',
            outcome: 'minor',
            detail: `${row.sp.mislabeled} file${row.sp.mislabeled > 1 ? 's' : ''} off convention`,
          }
        : { label: 'Image labels', outcome: 'pass', detail: 'B (n) / a (n) convention held' },
    );
  }
  lines.push(
    row.coNumber === null
      ? { label: 'CO#', outcome: 'na', detail: 'empty — reviewer optional' }
      : /^\d{6}$/.test(row.coNumber)
        ? { label: 'CO#', outcome: 'pass', detail: row.coNumber }
        : { label: 'CO#', outcome: 'minor', detail: `"${row.coNumber}" — must be 6 digits` },
  );
  lines.push(
    checks.admin && checks.quote
      ? { label: 'Release gate', outcome: 'pass', detail: 'Admin ✓ · Quote ✓' }
      : {
          label: 'Release gate',
          outcome: 'info',
          detail: `Admin ${checks.admin ? '✓' : '✗'} · Quote ${checks.quote ? '✓' : '✗'} — both required`,
        },
  );
  return lines;
}

// ── Invoicing pipeline ──────────────────────────────────────────────────────
// Downstream of the audit: a WO reaches "ready" the moment its audit is clean
// and the release gate is ticked. Sent/paid rows are seeded from the CLOSED
// status group — those already left the queue in a past life.

export type InvoiceStage = 'ready' | 'invoiced' | 'paid';

export interface InvoiceRow {
  wo: WorkOrderListItemV2;
  stage: InvoiceStage;
  amount: number;
  invoiceNo: string;
  /** Days since sent (invoiced/paid rows). */
  agedDays: number;
}

export function invoiceAmount(wo: WorkOrderListItemV2): number {
  return wo.nte ?? intIn(wo.id, 'inv-amt', 18, 240) * 10;
}

export function invoiceNoFor(wo: WorkOrderListItemV2): string {
  return `INV-${1000 + (hash(wo.id + 'inv-no') % 9000)}`;
}
