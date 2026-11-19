// Rule 2.2.2 — a check-in moves the work order On Site.
//
//   IF Technician executes Check-In AND Visit_Type == "Assessment (A)",
//      THEN WO_Status = On Site (Assessment).
//   IF Technician executes Check-In AND Visit_Type == "Job (J)",
//      THEN WO_Status = On Site (Job).
//
// The visit log (0021) has a third type, Return trip: a tech on site for a
// return trip is on site for the job (2.7's own order goes Return Trip
// Needed → Job Sched → On Site (Job)), so it lands on On Site (Job) too. A
// visit type the vocabulary does not know (Admin › Custom fields can add
// one) moves nothing. Matched by prefix, case-insensitively, so the BRD's
// "Assessment (A)" / "Job (J)" spellings and ours both resolve.
//
// The move itself is services/visits.ts (moveOnSite); this is the vocabulary
// the API and the browser share.

export const ON_SITE_ASSESSMENT_STATUS_NAME = 'On Site (Assessment)';
export const ON_SITE_JOB_STATUS_NAME = 'On Site (Job)';

/** The status a check-in on a visit of this type moves the work order to,
    or null when the type moves nothing. */
export function onSiteStatusNameForVisitType(visitType: string | null | undefined): string | null {
  const t = (visitType ?? '').trim().toLowerCase();
  if (t === '') return null;
  if (t.startsWith('assessment')) return ON_SITE_ASSESSMENT_STATUS_NAME;
  if (t.startsWith('job') || t.startsWith('return')) return ON_SITE_JOB_STATUS_NAME;
  return null;
}

// Elise, 2026-11-09: nobody asks for On Site without a check-in. A status
// request for either On Site status needs a visit of the matching type with a
// check-in stamp (checked out since or not). The request a real check-in
// raises (moveOnSite) runs after the visit is saved, so it always passes; a
// manager's direct move is not asked.
export const CHECK_IN_REQUIRED_CODE = 'CHECK_IN_REQUIRED';

/** True when a request for this status needs a check-in that none of these
    checked-in visit types provides. Any status but the two On Site ones: false. */
export function onSiteRequestLacksCheckIn(
  targetStatusName: string | null | undefined,
  checkedInVisitTypes: readonly (string | null | undefined)[],
): boolean {
  const target = (targetStatusName ?? '').trim().toLowerCase();
  if (target !== ON_SITE_ASSESSMENT_STATUS_NAME.toLowerCase() && target !== ON_SITE_JOB_STATUS_NAME.toLowerCase()) return false;
  return !checkedInVisitTypes.some((t) => onSiteStatusNameForVisitType(t)?.toLowerCase() === target);
}

export function describeCheckInRequired(statusName: string): string {
  const visit = statusName.trim().toLowerCase() === ON_SITE_ASSESSMENT_STATUS_NAME.toLowerCase() ? 'an Assessment visit' : 'a Job or Return trip visit';
  // Same shape as missingStepsText (statusGates.ts).
  return `Missing step:\n- Must check in on ${visit}`;
}

// ── Check-in / check-out requests and the check-out outcomes (Elise, 2026-11-18)
//
// A check-out says how the visit ended, and that decides where the work order
// goes: Completed → Done / Incurred, Quote → Waiting for Quote, Return →
// Return Trip Needed, Parts → Waiting for Parts. Someone who must REQUEST
// status changes (work_orders/status create without edit) requests the
// check-in and the check-out too: the visit stays as it was, a status_change
// task carrying `visit` (VisitRequestDetail) waits under Approvals › Status
// change, and approving it stamps the visit with the time asked for, then
// moves the status. A check-out request is asked everything a status request
// for its target is asked (gates, Ecotrak, the portal's steps), the visit
// being checked out counting as the check-out the Done gate wants.

export const CHECK_OUT_OUTCOMES = ['completed', 'quote', 'return', 'parts'] as const;
export type CheckOutOutcome = (typeof CHECK_OUT_OUTCOMES)[number];

export const CHECK_OUT_OUTCOME_LABEL: Record<CheckOutOutcome, string> = {
  completed: 'Check out - Completed',
  quote: 'Check out - Quote',
  return: 'Check out - Return',
  parts: 'Check out - Parts',
};

/** The short word a checked-out visit wears ("Completed", "Quote"…). */
export const CHECK_OUT_OUTCOME_SHORT: Record<CheckOutOutcome, string> = {
  completed: 'Completed',
  quote: 'Quote',
  return: 'Return trip needed',
  parts: 'Parts',
};

export const CHECK_OUT_STATUS_NAME: Record<CheckOutOutcome, string> = {
  completed: 'Done / Incurred',
  quote: 'Waiting for Quote',
  return: 'Return Trip Needed',
  parts: 'Waiting for Parts',
};

export function isCheckOutOutcome(v: unknown): v is CheckOutOutcome {
  return typeof v === 'string' && (CHECK_OUT_OUTCOMES as readonly string[]).includes(v);
}

/** The status a check-out with this outcome moves the work order to. */
export function checkOutStatusName(outcome: CheckOutOutcome | null | undefined): string | null {
  return outcome ? CHECK_OUT_STATUS_NAME[outcome] : null;
}

export const VISIT_OUTCOME_REQUIRED_CODE = 'VISIT_OUTCOME_REQUIRED';
export const VISIT_OUTCOME_REQUIRED_TEXT =
  'Pick how the visit ended: Check out - Completed, Quote, Return or Parts';

export type VisitRequestAction = 'check_in' | 'check_out';

/** `detail.visit` on a status_change task raised by a check-in / check-out. */
export interface VisitRequestDetail {
  action: VisitRequestAction;
  visit_id: string;
  visit_seq: number;
  visit_type: string;
  /** The check-in stamp to write (check_in, or a check_out of a visit that
      was never checked in), UTC ISO to the second. */
  checked_in_at: string | null;
  /** check_out only. */
  checked_out_at: string | null;
  outcome: CheckOutOutcome | null;
}

/** How a request reads in a title, a chip, the inbox. */
export function visitRequestLabel(v: Pick<VisitRequestDetail, 'action' | 'outcome' | 'visit_seq' | 'visit_type'>): string {
  const what = v.action === 'check_in' ? 'Check in' : v.outcome ? CHECK_OUT_OUTCOME_LABEL[v.outcome] : 'Check out';
  return `${what} · Visit ${v.visit_seq} (${v.visit_type})`;
}

/** The open request on one visit, carried on the visit for the CICO card. */
export interface VisitPendingRequest {
  approval_task_id: string;
  action: VisitRequestAction;
  outcome: CheckOutOutcome | null;
  /** The stamp asked for (check-in for check_in, check-out for check_out). */
  at: string | null;
  to_status_name: string | null;
  requested_by: string | null;
}
