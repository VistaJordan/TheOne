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
  return `Check the technician in on ${visit} before requesting ${statusName}.`;
}
