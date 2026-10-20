// ── UAT round 1, Wave C (migration 0085): workflow ───────────────────────────
//
// The pure half of Wave C — what the API enforces and the web draws before
// the click. Nothing here opens a database. The decisions behind each block
// are #15 / #16 / M5 / M8 / M9 / M31 in docs/specs/uat-round-1.md; the gate
// half (#2, M3) lives beside the gates themselves in statusGates.ts.

import { permAllows, type PermissionSet } from './permissions';

// ── #15 / #16 · request mode ─────────────────────────────────────────────────

/** `work_orders/status` — edit = change it directly; create = ask a manager. */
const STATUS_KEY = 'work_orders/status';

/** A person who may only REQUEST a status change (rule 2.4.1): create
    without edit. Super admins never are. */
export function isStatusRequestMode(perms: PermissionSet, isSuperAdmin = false): boolean {
  if (isSuperAdmin) return false;
  return !permAllows(perms, STATUS_KEY, 'edit') && permAllows(perms, STATUS_KEY, 'create');
}

/** #15: Cancel, Reopen, Pause / Resume and Complete service on the record
    bar. Unset inherits `work_orders` edit; 0085 sets it off for every
    request-mode system role, so Admin › Roles can loosen it per role. */
export const LIFECYCLE_PERM_KEY = 'work_orders/lifecycle';

/** The roles 0085 puts in request mode (#16, D3) — the dispatchers (0085
    named ops_coord too; 0088 merged it into om_probation). */
export const REQUEST_MODE_DISPATCHER_ROLES = ['om_probation', 'om', 'senior_om'] as const;

/** The request-mode roles 0085 takes the record-bar lifecycle actions from:
    the dispatchers plus the two roles 0084 put in request mode. */
export const LIFECYCLE_LOCKED_ROLES = [...REQUEST_MODE_DISPATCHER_ROLES, 'vr_officer', 'oa'] as const;

/** #15: the fields 0085 makes view-only for the dispatchers (and the VR
    officer): the NTE, the SLA dates and the AR section. The Cost is already
    hidden from them by 0084 (M13). The OP Admin (`oa`) keeps them: intake
    and Add work order are where those fields are typed. */
export const DISPATCHER_LOCKED_FIELD_PATHS = [
  'work_orders/fields/header/nte',
  'work_orders/fields/finances/fields.16. Client NTE 🔴',
  'work_orders/fields/dates/fields.Due Date',
  'work_orders/fields/dates/fields.SLA Due Date',
  'work_orders/fields/dates/fields.🚨 SLA Requested',
  'work_orders/fields/dates/fields.🚨 SLA Updated',
  'work_orders/fields/ar',
] as const;
export const FIELD_LOCKED_ROLES = [...REQUEST_MODE_DISPATCHER_ROLES, 'vr_officer'] as const;

// ── M5 · the status follows the quote ────────────────────────────────────────
// The lifecycle (docs/lifecycle.ts): Quote Ready → Waiting for Approval when
// the quote goes to the client; → Approved when the client says yes. A
// decline sends the work order back to Waiting for Quote (Yoda: re-quote in a
// new round). Matched by name, and a status that does not exist is skipped.

export type QuoteEvent = 'sent' | 'client_approved' | 'client_declined';

export const QUOTE_EVENT_STATUS_NAME: Record<QuoteEvent, string> = {
  sent: 'Waiting for Approval',
  client_approved: 'Approved',
  client_declined: 'Waiting for Quote',
};

/** Statuses a quote event may move the work order FROM. A work order that is
    already further along (scheduled, on site, done, cancelled) stays put:
    a late decision never pulls it backwards. */
const QUOTE_EVENT_FROM: Record<QuoteEvent, readonly string[]> = {
  sent: ['Open', 'Emergency', 'Assessment Sched', 'On Site (Assessment)', 'Return Trip Needed', 'Waiting for Quote', 'Quote Ready', 'Waiting for Advice'],
  client_approved: ['Waiting for Quote', 'Quote Ready', 'Waiting for Advice', 'Waiting for Approval'],
  client_declined: ['Quote Ready', 'Waiting for Advice', 'Waiting for Approval'],
};

/** The status a quote event moves the work order to, or null to leave it. */
export function quoteEventStatusName(event: QuoteEvent, currentStatusName: string | null | undefined): string | null {
  const target = QUOTE_EVENT_STATUS_NAME[event];
  const cur = (currentStatusName ?? '').trim().toLowerCase();
  if (cur === '' || cur === target.toLowerCase()) return null;
  return QUOTE_EVENT_FROM[event].some((s) => s.toLowerCase() === cur) ? target : null;
}

/** M6: recording the client's approval needs evidence — a note or a file. */
export const CLIENT_APPROVAL_EVIDENCE_CODE = 'CLIENT_APPROVAL_EVIDENCE';

// ── M8 · a visit's status follows its stamps ─────────────────────────────────

export type VisitStampStatus = 'planned' | 'checked_in' | 'checked_out';

export interface VisitStamps {
  status: VisitStampStatus;
  checked_in_at: string | null;
  checked_out_at: string | null;
}

/**
 * The visit after a write. Typed stamps are applied first; a status move then
 * fills only the stamp it needs that is still EMPTY (now) — a time somebody
 * typed is never overwritten. Moving back to checked in clears the
 * check-out, moving to planned clears both (that is what those moves mean).
 * The status is then read off the stamps: a check-out stamp is checked out,
 * a check-in stamp alone is checked in, neither is planned.
 */
export function nextVisitStamps(
  cur: VisitStamps,
  patch: { status?: VisitStampStatus; checked_in_at?: string | null; checked_out_at?: string | null },
  now: string,
): VisitStamps {
  let inAt = patch.checked_in_at !== undefined ? patch.checked_in_at : cur.checked_in_at;
  let outAt = patch.checked_out_at !== undefined ? patch.checked_out_at : cur.checked_out_at;
  if (patch.status !== undefined && patch.status !== cur.status) {
    if (patch.status === 'planned') {
      if (patch.checked_in_at === undefined) inAt = null;
      if (patch.checked_out_at === undefined) outAt = null;
    } else if (patch.status === 'checked_in') {
      inAt = inAt ?? now;
      if (patch.checked_out_at === undefined) outAt = null;
    } else {
      outAt = outAt ?? now;
    }
  }
  const status: VisitStampStatus = outAt ? 'checked_out' : inAt ? 'checked_in' : 'planned';
  return { status, checked_in_at: inAt, checked_out_at: outAt };
}

// ── M9 · honest progress, no cancel once billed ──────────────────────────────

export const CANCEL_BILLED_CODE = 'CANCEL_BILLED';

/** Why Cancel is refused, or null. An invoice sent or paid, or a vendor
    payment paid, means money moved: the work order is past cancelling. */
export function cancelBlockedReason(state: { invoiceStatuses: readonly string[]; paidPayments: number }): string | null {
  if (state.invoiceStatuses.some((s) => s === 'paid')) return 'The client invoice is paid — a billed work order cannot be cancelled.';
  if (state.invoiceStatuses.some((s) => s === 'sent')) return 'The client invoice has been sent — void it before cancelling the work order.';
  if (state.paidPayments > 0) return 'A vendor payment on this work order is paid — a paid work order cannot be cancelled.';
  return null;
}

// ── M31 · reopen ─────────────────────────────────────────────────────────────

/** The status a reopen returns to: the one the cancel moved the work order
    out of. Null when it was never moved (no cancel status) or nothing says. */
export function statusBeforeCancel(
  rows: readonly { before?: { status_id?: string | null; status_name?: string | null } | null; after?: { status_name?: string | null } | null }[],
): { status_id: string; status_name: string | null } | null {
  for (const r of rows) {
    const to = r.after?.status_name ?? '';
    if (/^cancel/i.test(to.trim()) && r.before?.status_id) {
      return { status_id: r.before.status_id, status_name: r.before.status_name ?? null };
    }
  }
  return null;
}
