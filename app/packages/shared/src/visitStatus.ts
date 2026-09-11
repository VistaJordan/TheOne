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
