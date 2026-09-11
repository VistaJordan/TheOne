// The built-in "Escalation Tracker" view (rules 7.3.1–7.3.3, 0038).
//
// Rule 7.3.3's team-wide tracker: every live work order whose `Escalated`
// checkbox is ticked — by a manager's Mark as Escalated button (7.3.1) or by
// the email tool's webhook (7.3.2). Like Due Today it is not a saved view: it
// cannot be renamed, deleted or pinned, and its filter is rebuilt from this
// constant. Unlike Due Today it is an ordinary filter set, so the status
// tabs, the quick-filter chips and the Filter menu all work on top of it, and
// Reset brings the flag rule back if someone removes it.
//
// Not to be confused with the Due Today view's "Escalations" list (rule 4.3):
// that one is a DATE test — Due Date on or before the day — and needs no
// flag. This view is the flag alone.

import type { WoFilterSet } from '@theone/shared';
import { FIELD } from './fields';
import type { ViewState } from './woView';

/** The id the page stores as `activeViewId` while this view is up. */
export const ESCALATIONS_VIEW_ID = 'builtin:escalations';

/** `/?view=escalations` opens the list on it (the sidebar entry). */
export const ESCALATIONS_VIEW_PARAM = 'escalations';

export const ESCALATIONS_FILTERS: WoFilterSet = {
  match: 'all',
  rules: [{ field: `fields.${FIELD.escalated}`, op: 'is_true' }],
};

/** Who has it, where it stands and what clock it is on lead; the flag itself
    is the rail. Column keys as in DEFAULT_VIEW (lib/woView.ts). */
export const ESCALATIONS_VIEW: ViewState = {
  columns: ['wo_number', 'client', 'trade', 'status', 'fields.Assignee', 'clock', 'nte', 'age_days'],
  filters: ESCALATIONS_FILTERS,
  group_by: null,
  sort: null,
};
