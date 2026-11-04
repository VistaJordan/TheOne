// Where Submit takes a quote (Elise, 2026-10-22): a dispatcher's quote is
// not asked for approval straight away — a manager corrects it first. So a
// dispatcher's Submit reads "Submit for correction" and lands the quote in
// `pending_correction`. Since 2026-10-27 (Elise: "1 dispatcher, then 1
// manager, then the client") a manager with the approve grant does not
// submit at all: they review it and click Send to client, which approves it
// on the way (since 2026-11-04 a submitted quote is locked, so a change is a
// Reject back to draft; quotes have no maker ≠ checker any more). "Submit for approval" (→ `pending_approval`) is left for
// someone who may edit quotes but not approve them. A dispatcher cannot
// press Submit while the quote waits for correction.
//
// Pure: the API decides the transition with it and the builder draws the
// button's label from the `submit_target` it is handed on QuotePermissions.
import { isDispatcherRole } from './access';

export type QuoteSubmitFrom = 'draft' | 'pending_correction';
export type QuoteSubmitTarget = 'pending_correction' | 'pending_approval';

/** The status Submit moves the quote to, or null when this person cannot
    submit from this status (a dispatcher while it waits for correction). */
export function quoteSubmitTarget(role: string | null | undefined, from: QuoteSubmitFrom): QuoteSubmitTarget | null {
  if (isDispatcherRole(role)) return from === 'draft' ? 'pending_correction' : null;
  return 'pending_approval';
}

/** The button's label for each target. */
export const QUOTE_SUBMIT_LABEL: Record<QuoteSubmitTarget, string> = {
  pending_correction: 'Submit for correction',
  pending_approval: 'Submit for approval',
};

/** The activity_log action each submit logs. */
export const QUOTE_SUBMIT_ACTION: Record<QuoteSubmitTarget, string> = {
  pending_correction: 'quote_submitted_for_correction',
  pending_approval: 'quote_submitted',
};

/** 2026-10-27 (Elise): "when the client approved, all OA+ positions can
    edit the status to approved". Roles that record the client's decision
    without the quote-approve grant; the managers above OA hold that grant
    already. */
export const QUOTE_CLIENT_DECISION_ROLES: readonly string[] = ['oa'];

// ── Moving the work order to Approved IS the client's yes (2026-11-04) ──────
// Elise: "when the client approved, all OA+ positions can edit the status to
// approved, so the additional part moves to the incurred automatically". A
// person's move into Approved (`statusApprovalNeedsNote`) records the
// client's approval on the quote — the same act as Record client decision —
// approved: the option locks, becomes incurred work for any later round, and
// the NTE takes its price. OA moves there directly although it is otherwise
// request-mode; the managers already move statuses directly.

/** The roles that move a work order straight to Approved without holding
    the direct status grant (the managers above them hold it). */
export function mayMoveToApprovedDirectly(role: string | null | undefined): boolean {
  return QUOTE_CLIENT_DECISION_ROLES.includes(role ?? '');
}

/** What a move into Approved does to the work order's quote. */
export type ApprovedMovePlan =
  /** No quote, or the client already decided it: the status just moves. */
  | { kind: 'move' }
  /** A quote exists but has not reached the client: the move is refused. */
  | { kind: 'not_sent'; status: string }
  /** A sent quote: the move records the client's approval of one option. */
  | { kind: 'record'; options: { id: string; label: string }[] };

export const QUOTE_NOT_SENT_CODE = 'QUOTE_NOT_SENT';
export const QUOTE_OPTION_REQUIRED_CODE = 'QUOTE_OPTION_REQUIRED';
export const QUOTE_NOT_SENT_TEXT =
  'The quote has not been sent to the client yet. Send it from the Quote tab first, then move the work order to Approved.';
export const QUOTE_OPTION_REQUIRED_TEXT = 'Pick the option the client approved';

/** Pure: the plan for a work order's quote (null = no quote). Options are
    the current round's, as Record client decision offers them. */
export function approvedMovePlan(
  quote: {
    status: string;
    current_round: number;
    sections: readonly { id: string | null; kind: string; round: number; label: string; name?: string | null }[];
  } | null,
): ApprovedMovePlan {
  if (!quote || quote.status === 'client_approved' || quote.status === 'client_declined') return { kind: 'move' };
  if (quote.status !== 'sent') return { kind: 'not_sent', status: quote.status };
  const options = quote.sections
    .filter((s) => s.kind === 'option' && s.round === quote.current_round && s.id)
    .map((s) => ({ id: s.id as string, label: s.name ? `${s.label} · ${s.name}` : s.label }));
  return { kind: 'record', options };
}

/** Why a dispatcher's Submit is locked while the quote waits for correction. */
export const QUOTE_CORRECTION_PENDING_CODE = 'QUOTE_CORRECTION_PENDING';
export const QUOTE_CORRECTION_PENDING_TEXT =
  'A manager reviews this quote: sends it to the client, or rejects it back to you with a note';

/** 2026-10-29 (Elise): once a quote is submitted its sections are locked.
    2026-11-04 (Elise, UAT "quote edited after submission" — a quote raised
    from $280 to $5,080 while it waited, then sent): locked for EVERYONE,
    managers and super admins included; only a draft is edited. A manager
    who wants a change clicks Reject with note: the quote goes back to draft
    as a new revision and is changed there. `canApprove` stays in the
    signature so the callers read the same; it no longer opens anything. */
export type QuoteEditStatus = 'draft' | 'pending_correction' | 'pending_approval' | string;
export const QUOTE_SUBMITTED_STATUSES: readonly string[] = ['pending_correction', 'pending_approval'];
export function quoteEditableBy(status: QuoteEditStatus, canEdit: boolean, _canApprove?: boolean): boolean {
  return canEdit && status === 'draft';
}
export const QUOTE_SUBMITTED_LOCKED_CODE = 'QUOTE_SUBMITTED_LOCKED';
export const QUOTE_SUBMITTED_LOCKED_TEXT =
  'This quote was submitted, so it is locked. To change it, a manager rejects it back to draft with a note.';
