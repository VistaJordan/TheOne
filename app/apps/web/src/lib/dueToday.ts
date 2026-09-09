// The built-in "Due Today" view (rules 2.3.3 and 4.1, 0024).
//
// Not a saved view: it cannot be renamed or deleted, and its filters are
// rebuilt every render from TODAY (business time zone) and the live status
// list. Under it the toolbar shows four date sections instead of the status
// groups — All is their union:
//
//   Due date        'Due Date'           is today
//   Scheduled       'Scheduled Date'     is today
//   Quote           'Quote Due Date'     is today OR EARLIER, and the status
//                                        is still before Quote Ready — a
//                                        missed quote must not vanish the day
//                                        after it was due
//   Parts arriving  'Parts Arrival Date' is today
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

export type DueSection = 'all' | 'due' | 'scheduled' | 'quote' | 'parts';

export const DUE_SECTIONS: { key: DueSection; label: string; hint: string }[] = [
  { key: 'all', label: 'All', hint: 'Everything on the four lists' },
  { key: 'due', label: 'Due date', hint: 'Due Date is today' },
  { key: 'scheduled', label: 'Scheduled', hint: 'Scheduled Date is today' },
  { key: 'quote', label: 'Quote', hint: 'Quote due today or overdue, and still not Quote Ready' },
  { key: 'parts', label: 'Parts arriving', hint: 'Parts Arrival Date is today' },
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

const REAL_SECTIONS: Exclude<DueSection, 'all'>[] = ['due', 'scheduled', 'quote', 'parts'];

function groupFor(section: Exclude<DueSection, 'all'>, today: string, owedStatuses: string[]): WoFilterRule[] {
  switch (section) {
    case 'due':
      return [{ field: `fields.${DUE_DATE_KEY}`, op: 'eq', value: today }];
    case 'scheduled':
      return [{ field: `fields.${SCHEDULED_DATE_KEY}`, op: 'eq', value: today }];
    case 'parts':
      return [{ field: `fields.${PARTS_ARRIVAL_KEY}`, op: 'eq', value: today }];
    case 'quote':
      return [
        { field: `fields.${QUOTE_DUE_KEY}`, op: 'lte', value: today },
        // No status owes a quote → match nothing. (An empty `in` would be
        // dropped as a half-written rule and the section would show every
        // dated row instead; the sentinel is a status name nobody has.)
        { field: 'status', op: 'in', value: owedStatuses.length ? owedStatuses : ['(no status owes a quote)'] },
      ];
  }
}

/**
 * The filter set the API receives. `extra` is whatever the quick-filter chips
 * wrote (plain AND rules); each is repeated inside every OR group.
 */
export function dueTodayFilters(
  section: DueSection,
  today: string,
  owedStatuses: string[],
  extra: WoFilterRule[] = [],
): WoFilterSet {
  const sections = section === 'all' ? REAL_SECTIONS : [section];
  const rules: WoFilterRule[] = [];
  sections.forEach((s, gi) => {
    const group = [...groupFor(s, today, owedStatuses), ...extra];
    group.forEach((r, ri) => {
      const join: WoFilterRule['join'] | undefined = ri === 0 ? (gi === 0 ? undefined : 'or') : 'and';
      rules.push(join ? { ...r, join } : { ...r, join: undefined });
    });
  });
  return { match: 'all', rules };
}
