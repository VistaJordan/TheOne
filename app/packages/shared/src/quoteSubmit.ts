// Where Submit takes a quote (Elise, 2026-10-22): a dispatcher's quote is
// not asked for approval straight away — a manager corrects it first. So a
// dispatcher's Submit reads "Submit for correction" and lands the quote in
// `pending_correction`. Since 2026-10-27 (Elise: "1 dispatcher, then 1
// manager, then the client") a manager with the approve grant does not
// submit at all: they correct it and click Approve (approveQuote takes a
// quote from draft or pending correction; quotes have no maker ≠ checker
// any more). "Submit for approval" (→ `pending_approval`) is left for
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

/** Why a dispatcher's Submit is locked while the quote waits for correction. */
export const QUOTE_CORRECTION_PENDING_CODE = 'QUOTE_CORRECTION_PENDING';
export const QUOTE_CORRECTION_PENDING_TEXT =
  'A manager corrects this quote and submits it for approval';
