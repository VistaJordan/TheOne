/* Who's available? — the two lists behind the Assignee pickers and the sort.
 *
 * The part worth pinning: "for this client" is the people Admin › Users lists
 * on the client, nothing to do with their role; "all dispatchers" is the role
 * tiers and folds everyone else in only on request; and the load that sorts
 * them is the one number the server sent — every client, not this one.
 */

import { describe, it, expect } from 'vitest';
import {
  DISPATCHER_ROLE_CODES,
  filterAvailability,
  isDispatcherRole,
  othersCount,
  sortAvailability,
  type AvailabilityPerson,
} from '@theone/shared';

const person = (over: Partial<AvailabilityPerson> & Pick<AvailabilityPerson, 'id' | 'name'>): AvailabilityPerson => ({
  role: 'om',
  role_label: 'OM',
  dispatcher: true,
  for_client: false,
  active: 0,
  by_status: [],
  ...over,
});

const team: AvailabilityPerson[] = [
  person({ id: '1', name: 'Adam Keller', active: 7, for_client: true }),
  person({ id: '2', name: 'Bea Ortiz', active: 2, for_client: true, role: 'senior_om', role_label: 'Senior OM' }),
  person({ id: '3', name: 'Cal Reyes', active: 2 }),
  person({ id: '4', name: 'Dana Fox', active: 0, role: 'ops_coord', role_label: 'Ops Coordinator' }),
  person({ id: '5', name: 'Eli Stone', active: 4, dispatcher: false, role: 'tl', role_label: 'Team Lead', for_client: true }),
  person({ id: '6', name: 'Fay Nguyen', active: 1, dispatcher: false, role: 'sales', role_label: 'Sales' }),
];

describe('isDispatcherRole', () => {
  it('names the four dispatcher tiers and nothing else', () => {
    for (const code of DISPATCHER_ROLE_CODES) expect(isDispatcherRole(code)).toBe(true);
    expect(isDispatcherRole('tl')).toBe(false);
    expect(isDispatcherRole('admin')).toBe(false);
    expect(isDispatcherRole(null)).toBe(false);
    expect(isDispatcherRole(undefined)).toBe(false);
  });
});

describe('filterAvailability', () => {
  it('"for this client" is whoever Admin › Users lists on the client, whatever their role', () => {
    expect(filterAvailability(team, 'client').map((p) => p.name)).toEqual(['Adam Keller', 'Bea Ortiz', 'Eli Stone']);
  });

  it('"all dispatchers" is the dispatcher tiers only…', () => {
    expect(filterAvailability(team, 'all').map((p) => p.name)).toEqual(['Adam Keller', 'Bea Ortiz', 'Cal Reyes', 'Dana Fox']);
  });

  it('…until everyone else is folded in', () => {
    expect(filterAvailability(team, 'all', true)).toHaveLength(team.length);
    expect(othersCount(team)).toBe(2);
  });
});

describe('sortAvailability', () => {
  it('fewest active first, ties by name', () => {
    expect(sortAvailability(filterAvailability(team, 'all'), 'freest').map((p) => p.name)).toEqual([
      'Dana Fox',
      'Bea Ortiz',
      'Cal Reyes',
      'Adam Keller',
    ]);
  });

  it('most active first keeps the same tie-break', () => {
    expect(sortAvailability(filterAvailability(team, 'all'), 'busiest').map((p) => p.name)).toEqual([
      'Adam Keller',
      'Bea Ortiz',
      'Cal Reyes',
      'Dana Fox',
    ]);
  });

  it('does not touch the input', () => {
    const before = team.map((p) => p.id);
    sortAvailability(team, 'busiest');
    expect(team.map((p) => p.id)).toEqual(before);
  });
});
