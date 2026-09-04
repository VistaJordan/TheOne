/* Pipeline phases for the PhaseBar.
   The phase label is served by GET /api/statuses (S2 contract item 3). The
   name→phase table below is the SAME mapping, kept client-side purely as a
   fallback for an API build that has not shipped `phase` yet — it never
   overrides a phase the API did send. */

import type { Phase, StatusWithPhase } from '../api/client';

/** Left-to-right pipeline order. `Parts` is the conditional stage. */
export const PHASE_ORDER: Phase[] = [
  'Intake',
  'Assessment',
  'Quote',
  'Approval',
  'Scheduled',
  'In Progress',
  'Parts',
  'Done',
  'Invoiced',
];

export const CONDITIONAL_PHASE: Phase = 'Parts';

/** Contract mapping, keyed by lower-cased status name. */
const PHASE_BY_STATUS_NAME: Record<string, Phase | null> = {
  'open': 'Intake',
  'assessment sched': 'Assessment',
  'on site (assessment)': 'Assessment',
  'return trip needed': 'Assessment',
  'waiting for quote': 'Quote',
  'quote ready': 'Quote',
  'waiting for advice': 'Approval',
  'waiting for approval': 'Approval',
  'job sched': 'Scheduled',
  'pm sched': 'Scheduled',
  'on site (job)': 'In Progress',
  'please order parts': 'Parts',
  'waiting for parts': 'Parts',
  'ready to invoice': 'Done',
  'done / incurred': 'Done',
  'invoiced not paid': 'Invoiced',
  'invoiced': 'Invoiced',
  'cancelled / postponed': null,
};

/** Resolve a status to its phase: API value first, local table as fallback. */
export function phaseForStatus(
  statusName: string,
  fromApi?: StatusWithPhase | null,
): Phase | null {
  if (fromApi && fromApi.phase !== undefined) return fromApi.phase;
  const mapped = PHASE_BY_STATUS_NAME[statusName.trim().toLowerCase()];
  return mapped === undefined ? null : mapped;
}
