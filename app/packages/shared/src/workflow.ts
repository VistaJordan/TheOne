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

/** Statuses a request-mode person moves to DIRECTLY, no approval task
    (Elise, 2026-10-22): Quote Ready is internal — it changes nothing on the
    client's side, so a manager has nothing to decide. The API lets a
    `work_orders/status` create-only actor PATCH straight to one of these;
    the status menu skips the request for them. Matched by name, case
    folded; the gates (11.2.1: a quote with data) still apply. */
export const NO_APPROVAL_STATUS_NAMES = ['Quote Ready'] as const;

export function statusMoveNeedsNoApproval(statusName: string | null | undefined): boolean {
  if (typeof statusName !== 'string') return false;
  const n = statusName.trim().toLowerCase();
  return (NO_APPROVAL_STATUS_NAMES as readonly string[]).some((s) => s.toLowerCase() === n);
}

// ── Statuses a dispatcher may not even request (Elise, 2026-10-22) ──────────
// The statuses ClickUp marks "!!" are a manager's call, never a dispatcher's
// ask. `status.request_hidden` (migration 0091) carries the flag per status
// — the "Managers only" tick in Admin › Custom fields › Statuses — so a new
// manager-only status needs no deploy; these are the names 0091 and the
// seed tick. A request-mode person is not offered them in the status menu
// and the API refuses a request for one (409 STATUS_REQUEST_HIDDEN). The
// routes that move a work order there on their own — Send to client, the
// client's approval, a manager's direct move — are untouched.

export const REQUEST_HIDDEN_STATUS_NAMES = [
  'Approved',
  'Waiting for Advice',
  'Waiting for Approval',
  'Ready to Invoice',
  'Cancelled / Postponed',
] as const;

export const STATUS_REQUEST_HIDDEN_CODE = 'STATUS_REQUEST_HIDDEN';

/** The 409's sentence, and the menu's reason when a hidden status is the
    current one (drawn, as current, but never a pick). */
export function describeRequestHidden(statusName: string): string {
  return `${statusName} is a manager's call — it cannot be requested. Ask your manager to move the work order there.`;
}

/** What a request-mode person is offered: every status whose flag is off,
    plus the one the work order sits at (it is drawn as current, with its
    tick, and clicking it only closes the menu). A direct mover sees all. */
export function requestableStatuses<T extends { id: string; request_hidden?: boolean }>(
  statuses: readonly T[],
  currentId: string | null | undefined,
): T[] {
  return statuses.filter((s) => !s.request_hidden || s.id === currentId);
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

/** Elise, 2026-10-22 (migration 0093): an OM Under Probation does not change
    who the work order is for — the Client and the FM are view-only for that
    role. Its own list, apart from 0085's, because the wave-c test pins that
    list to 0085's file; Admin › Roles or Adjust can loosen it per person. */
export const PROBATION_LOCKED_FIELD_PATHS = [
  'work_orders/fields/client/fields.Client',
  'work_orders/fields/client/fields.22. FM',
] as const;
export const PROBATION_FIELD_LOCKED_ROLES = ['om_probation'] as const;

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
