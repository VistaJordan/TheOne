// The built-in "Due Today" view (rules 2.3.3, 4.1 and 4.3, 0030).
//
// Not a saved view: it cannot be renamed or deleted, and its filters are
// rebuilt every render from a TARGET DAY (today in the business time zone
// unless the user picks another) and the live status list. Under it the
// toolbar shows date sections instead of the status groups — All is their
// union. Rule 4.3 is the daily to-do engine, grouped by day:
//
//   Escalations     'Due Date'           is the day OR EARLIER, and the
//                                        status is not Job Sched / On Site
//                                        (Job) — a job already on the
//                                        calendar is not an escalation
//   Scheduled       'Scheduled Date'     is the day
//   Quote           'Quote Due Date'     is the day, and the status is still
//                                        before Quote Ready. When the day is
//                                        today, OR EARLIER too — a missed
//                                        quote must not vanish the day after
//                                        it was due (rule 2.3.3)
//   Parts arriving  'Parts Arrival Date' is the day (rule 4.3's Parts ETA)
//
// The union is one filter set in the compiler's join mode (AND binds tighter
// than OR). The quick-filter chips still work on top: their rules are ANDed
// into EVERY section group, which is the algebra of "(A or B or C) and X".

import {
  DUE_DATE_KEY,
  PARTS_ARRIVAL_KEY,
  QUOTE_DUE_KEY,
  SCHEDULED_DATE_KEY,
  type WoFilterRule,
  type WoFilterSet,
} from '@theone/shared';
import { EMPTY_FILTERS, type ViewState } from './woView';

/** The id the page stores as `activeViewId` while this view is up. */
export const DUE_TODAY_VIEW_ID = 'builtin:due-today';

export type DueSection = 'all' | 'escalations' | 'scheduled' | 'quote' | 'parts';

/** Rule 4.3: a work order whose job is already scheduled or under way is not
    escalated for its due date, however late it is. Status names as of 0020. */
export const ESCALATION_EXEMPT_STATUSES = ['Job Sched', 'On Site (Job)'];

export const DUE_SECTIONS: { key: DueSection; label: string; hint: string }[] = [
  { key: 'all', label: 'All', hint: 'Everything on the four lists' },
  {
    key: 'escalations',
    label: 'Escalations',
    hint: 'Due Date on or before the day, and not Job Sched or On Site (Job)',
  },
  { key: 'scheduled', label: 'Scheduled', hint: 'Scheduled Date is the day' },
  { key: 'quote', label: 'Quote', hint: 'Quote due on the day (today: or overdue), and still not Quote Ready' },
  { key: 'parts', label: 'Parts arriving', hint: 'Parts Arrival Date is the day' },
];

/** The four dates lead, after the row's identity. */
export const DUE_TODAY_VIEW: ViewState = {
  columns: [
    'wo_number',
    'client',
    'trade',
    'status',
    'fields.Assignee',
    `fields.${DUE_DATE_KEY}`,
    `fields.${SCHEDULED_DATE_KEY}`,
    `fields.${QUOTE_DUE_KEY}`,
    `fields.${PARTS_ARRIVAL_KEY}`,
  ],
  filters: EMPTY_FILTERS,
  group_by: null,
  sort: null,
};

/** `day` + `n` calendar days, both 'YYYY-MM-DD'. Arithmetic in UTC so a DST
    switch cannot skip or repeat a day. */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

const REAL_SECTIONS: Exclude<DueSection, 'all'>[] = ['escalations', 'scheduled', 'quote', 'parts'];

function groupFor(
  section: Exclude<DueSection, 'all'>,
  day: string,
  includeOverdue: boolean,
  owedStatuses: string[],
): WoFilterRule[] {
  switch (section) {
    case 'escalations':
      return [
        { field: `fields.${DUE_DATE_KEY}`, op: 'lte', value: day },
        { field: 'status', op: 'not_in', value: ESCALATION_EXEMPT_STATUSES },
      ];
    case 'scheduled':
      return [{ field: `fields.${SCHEDULED_DATE_KEY}`, op: 'eq', value: day }];
    case 'parts':
      return [{ field: `fields.${PARTS_ARRIVAL_KEY}`, op: 'eq', value: day }];
    case 'quote':
      return [
        { field: `fields.${QUOTE_DUE_KEY}`, op: includeOverdue ? 'lte' : 'eq', value: day },
        // No status owes a quote → match nothing. (An empty `in` would be
        // dropped as a half-written rule and the section would show every
        // dated row instead; the sentinel is a status name nobody has.)
        { field: 'status', op: 'in', value: owedStatuses.length ? owedStatuses : ['(no status owes a quote)'] },
      ];
  }
}

/**
 * The filter set the API receives. `day` is the target day; `includeOverdue`
 * is true when that day is today (the Quote list then reaches back to what
 * was missed). `extra` is whatever the quick-filter chips wrote (plain AND
 * rules); each is repeated inside every OR group.
 */
export function dueTodayFilters(
  section: DueSection,
  day: string,
  includeOverdue: boolean,
  owedStatuses: string[],
  extra: WoFilterRule[] = [],
): WoFilterSet {
  const sections = section === 'all' ? REAL_SECTIONS : [section];
  const rules: WoFilterRule[] = [];
  sections.forEach((s, gi) => {
    const group = [...groupFor(s, day, includeOverdue, owedStatuses), ...extra];
    group.forEach((r, ri) => {
      const join: WoFilterRule['join'] | undefined = ri === 0 ? (gi === 0 ? undefined : 'or') : 'and';
      rules.push(join ? { ...r, join } : { ...r, join: undefined });
    });
  });
  return { match: 'all', rules };
}
