// Rules 2.6.3 / 2.7 — Ecotrak allowed transitions.
//
// What Ecotrak lets a service provider move a work order TO depends on where
// the work order sits on THEIR side right now. This file is the pure table
// plus the question "would this move be allowed?"; it deliberately imports
// nothing from, and changes nothing in, the Ecotrak adapter
// (apps/api/src/modules/integrations/ecotrak on phase-0-ground). Nothing here
// talks to Ecotrak: the adapter is inbound-only until go-live, so today the
// verdict only annotates The One's own status change (see changeStatus). The
// same function is meant to gate the outbound push when that lands.
//
// Vocabulary is the API wire vocabulary (SCREAMING_SNAKE), which is what the
// adapter stores in the `Ecotrak Status` bag key — NOT the Ecotrak UI labels.
// "Completed" as a TARGET is written SOFT_COMPLETED: a service provider cannot
// set COMPLETED, and SOFT_COMPLETED is the close the API accepts from us.
//
// Deliberately deferred, so the table says nothing rather than guessing:
//   - A target no allowed-list mentions (PROPOSAL_SUBMITTED, which the
//     proposal push sets rather than a status write; CANCELLED, which is not
//     writable by a service provider) answers 'unlisted', never 'blocked'.
//   - Ecotrak statuses 2.7 marks "NA" (UNASSIGNED, the RMA states, RFP
//     Submitted, Internal Review, Deferred, Completed - Pending Review) and any
//     value the table does not know answer 'unlisted' as a CURRENT state. So
//     does SOFT_COMPLETED (our own soft close echoed back): 2.7 locks
//     "Completed", and whether that covers the soft close is still open.
//   - The 2.7 "Proposed Internal Status Transitions" (The One's own status
//     order) is a separate rule and is not modelled here.

/** Bag key the Ecotrak adapter writes the current external status into. */
export const ECOTRAK_STATUS_KEY = 'Ecotrak Status';
/** Bag key the adapter writes the external id into (0027 sits beside it). */
export const ECOTRAK_ID_KEY = 'Ecotrak ID';

/** 2.7's "No Status Change": no further API-triggering transitions at all. */
export const ECOTRAK_LOCKED = 'locked';

/**
 * Current Ecotrak status → the ONLY statuses a service provider may set next.
 * Straight from rules 2.6.3 and 2.7. A current status missing from this
 * table is unlisted (no rule yet).
 */
export const ECOTRAK_ALLOWED_TRANSITIONS: Readonly<Record<string, readonly string[] | typeof ECOTRAK_LOCKED>> = {
  ACCEPTED: ['ENROUTE', 'PENDING_PARTS', 'SUBMITTING_PROPOSAL'],
  ENROUTE: ['ARRIVED'],
  ARRIVED: ['SOFT_COMPLETED', 'PENDING_PARTS', 'RETURN_VISIT_REQUIRED', 'SUBMITTING_PROPOSAL'],
  SUBMITTING_PROPOSAL: ['SOFT_COMPLETED', 'RETURN_VISIT_REQUIRED', 'ENROUTE'],
  PROPOSAL_SUBMITTED: ['SOFT_COMPLETED', 'ENROUTE', 'PENDING_PARTS'],
  PROPOSAL_REJECTED: ['SOFT_COMPLETED', 'ENROUTE', 'PENDING_PARTS', 'RETURN_VISIT_REQUIRED'],
  PROPOSAL_APPROVED: ['ENROUTE', 'PENDING_PARTS'],
  PENDING_PARTS: ['RETURN_VISIT_REQUIRED', 'SUBMITTING_PROPOSAL'],
  RETURN_VISIT_REQUIRED: ['ENROUTE', 'PENDING_PARTS'],
  PENDING_SP_ACCEPTANCE: ECOTRAK_LOCKED,
  NOT_FIXED: ECOTRAK_LOCKED,
  COMPLETED: ECOTRAK_LOCKED,
  CANCELLED: ECOTRAK_LOCKED,
};

/** Every status some allowed-list names — the targets the rules actually
    govern. Anything else as a target is unlisted. */
const GOVERNED_TARGETS: ReadonlySet<string> = new Set(
  Object.values(ECOTRAK_ALLOWED_TRANSITIONS).flatMap((r) => (r === ECOTRAK_LOCKED ? [] : [...r])),
);

/**
 * Which Ecotrak statuses a move to an internal status WOULD push, in order
 * (2.7 "Nexxess to Ecotrack"). Empty = nothing crosses the wire. Two entries
 * mean a two-step push — On Site is "En route then Arrived" — and each step
 * is checked from the state the previous one leaves behind. Keyed by the
 * seeded status name like PHASE_BY_STATUS_NAME.
 */
export const ECOTRAK_PUSH_BY_STATUS_NAME: Readonly<Record<string, readonly string[]>> = {
  'Open': ['ACCEPTED'],
  'Assessment Sched': [],
  'Job Sched': [],
  'PM Sched': [],
  'On Site (Assessment)': ['ENROUTE', 'ARRIVED'],
  'On Site (Job)': ['ENROUTE', 'ARRIVED'],
  'Return Trip Needed': ['RETURN_VISIT_REQUIRED'],
  'Waiting for Quote': ['SUBMITTING_PROPOSAL'],
  'Quote Ready': [],
  'Waiting for Parts': ['PENDING_PARTS'],
  'Please Order Parts': [],
  'Waiting for Advice': [],
  'Waiting for Approval': ['PROPOSAL_SUBMITTED'],
  'Ready to Invoice': [],
  'Done / Incurred': ['SOFT_COMPLETED'],
  'Invoiced': [],
  'Invoiced Not Paid': [],
  'Cancelled / Postponed': ['CANCELLED'],
  // Statuses that exist only on phase-0-ground; neither is in 2.7. Approved
  // is the client's own decision (PROPOSAL_APPROVED comes inbound), so
  // nothing is echoed back; Emergency is a flag, not a place on the wire.
  'Approved': [],
  'Emergency': [],
};

/** Human labels for the wire values, for chips and audit sentences. */
export const ECOTRAK_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING_SP_ACCEPTANCE: 'Pending SP acceptance',
  UNASSIGNED: 'Unassigned',
  ACCEPTED: 'Accepted',
  REASSIGN: 'Reassigned',
  SUBMITTING_PROPOSAL: 'Submitting proposal',
  PROPOSAL_SUBMITTED: 'Proposal submitted',
  PROPOSAL_APPROVED: 'Proposal approved',
  PROPOSAL_REJECTED: 'Proposal rejected',
  ENROUTE: 'En route',
  ARRIVED: 'Arrived',
  PENDING_PARTS: 'Pending parts',
  RETURN_VISIT_REQUIRED: 'Return visit required',
  NOT_FIXED: 'Not fixed',
  SOFT_COMPLETED: 'Completed',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  REJECTED: 'Rejected',
};

export function ecotrakStatusLabel(wire: string | null | undefined): string {
  const w = normalizeEcotrakStatus(wire);
  if (!w) return '';
  return ECOTRAK_STATUS_LABELS[w] ?? w.toLowerCase().replace(/_/g, ' ');
}

/**
 * Wire form of whatever was stored: 'En route' / 'en_route' / 'ENROUTE' all
 * read as ENROUTE, 'Canceled' as CANCELLED. Null for an empty value.
 */
export function normalizeEcotrakStatus(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (s === 'EN_ROUTE') return 'ENROUTE';
  if (s === 'CANCELED') return 'CANCELLED';
  return s;
}

/**
 *   not_linked  the work order carries no Ecotrak status — nothing to check
 *   no_push     this internal move pushes nothing to Ecotrak
 *   unlisted    the rules say nothing yet about this move (deferred)
 *   allowed     the rules allow it
 *   blocked     the rules do not list it
 *   locked      the current Ecotrak status allows no further transition
 */
export type EcotrakTransitionOutcome = 'not_linked' | 'no_push' | 'unlisted' | 'allowed' | 'blocked' | 'locked';

export interface EcotrakTransitionVerdict {
  outcome: EcotrakTransitionOutcome;
  /** Current Ecotrak status, normalized; null when not linked. */
  from: string | null;
  /** The push that failed the check, or the last one when it passed; null
      when nothing crosses the wire. */
  to: string | null;
}

/** True when the move is one the rules forbid (blocked or locked). */
export function ecotrakTransitionRefused(v: EcotrakTransitionVerdict): boolean {
  return v.outcome === 'blocked' || v.outcome === 'locked';
}

/** One step: from `from`, may a service provider set `to`? */
function stepOutcome(from: string, to: string): 'allowed' | 'blocked' | 'locked' | 'unlisted' {
  const rule = ECOTRAK_ALLOWED_TRANSITIONS[from];
  if (rule === ECOTRAK_LOCKED) return 'locked';
  if (!GOVERNED_TARGETS.has(to)) return 'unlisted';
  if (!rule) return 'unlisted';
  // Staying put on the Ecotrak side (e.g. Please Order Parts → Waiting for
  // Parts, both PENDING_PARTS) is not a transition.
  if (to === from) return 'allowed';
  return rule.includes(to) ? 'allowed' : 'blocked';
}

/**
 * Would moving a work order whose Ecotrak status is `currentEcotrakStatus` to
 * the internal status `targetStatusName` be an allowed API transition? A
 * two-step push is walked in order; the first step that is not allowed
 * decides, and an unlisted step decides only if no later step is refused.
 */
export function checkEcotrakTransition(
  currentEcotrakStatus: unknown,
  targetStatusName: string,
): EcotrakTransitionVerdict {
  const start = normalizeEcotrakStatus(currentEcotrakStatus);
  if (!start) return { outcome: 'not_linked', from: null, to: null };
  const pushes = ECOTRAK_PUSH_BY_STATUS_NAME[targetStatusName] ?? [];
  if (pushes.length === 0) return { outcome: 'no_push', from: start, to: null };

  let from = start;
  let unlisted: string | null = null;
  for (const to of pushes) {
    const o = stepOutcome(from, to);
    if (o === 'blocked' || o === 'locked') return { outcome: o, from: start, to };
    if (o === 'unlisted' && unlisted === null) unlisted = to;
    from = to;
  }
  return unlisted
    ? { outcome: 'unlisted', from: start, to: unlisted }
    : { outcome: 'allowed', from: start, to: pushes[pushes.length - 1] };
}

/** One sentence for the audit trail, the menu and the 409, e.g.
    "Ecotrak does not allow Accepted → Arrived (rule 2.6.3)". */
export function describeEcotrakRefusal(v: EcotrakTransitionVerdict): string {
  const from = ecotrakStatusLabel(v.from);
  if (v.outcome === 'locked') return `Ecotrak is ${from}: no further transitions are allowed (rule 2.6.3)`;
  return `Ecotrak does not allow ${from} → ${ecotrakStatusLabel(v.to)} (rule 2.6.3)`;
}
