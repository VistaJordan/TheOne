// "All unassigned jobs" (Elise, 2026-10-22): the third tab of Incoming Work
// Orders — every live work order nobody carries, whichever way it arrived
// and whether or not an acceptance task is open on it. One filter set over
// the ordinary /work-orders list, so the rule-8.5 scope applies as it does
// everywhere, and the same filter can be saved as a view or put on a card.
import type { WoFilterRule, WoFilterSet } from './index';

/** The Assignee seat — the catalogue key the scope rule keys on (0032). */
export const ASSIGNEE_FIELD_KEY = 'fields.Assignee';

/** Live work: not done, closed or cancelled. */
export const UNASSIGNED_STATUS_GROUPS: readonly string[] = ['open', 'active', 'pending'];

/** The page reads at most this many rows (the list's own cap is 500). */
export const UNASSIGNED_LIST_CAP = 500;

/** Assignee empty (`''` counts as empty since T9) AND a live status group. */
export function unassignedWorkFilter(): WoFilterSet {
  const rules: WoFilterRule[] = [
    { field: ASSIGNEE_FIELD_KEY, op: 'is_not_set' },
    { field: 'status_group', op: 'in', value: [...UNASSIGNED_STATUS_GROUPS], join: 'and' },
  ];
  return { match: 'all', rules };
}
