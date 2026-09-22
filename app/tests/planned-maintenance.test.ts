/* 0051 — planned maintenance, the date arithmetic. A wrong next-due date is a
 * missed contract visit, so every rule about stepping a calendar is pinned:
 * whole periods from the anchor, month ends clamped without drifting, the end
 * date honoured, and the lead window that decides when a work order is raised.
 */

import { describe, it, expect } from 'vitest';
import {
  addPeriods,
  daysBetween,
  frequencyLabel,
  isDueToRaise,
  nextDueOn,
  pmWoNumber,
} from '../packages/shared/src/plannedMaintenance';

describe('planned maintenance dates (0051)', () => {
  it('steps days, weeks, months and years', () => {
    expect(addPeriods('2026-01-31', 1, 'day')).toBe('2026-02-01');
    expect(addPeriods('2026-01-01', 2, 'week')).toBe('2026-01-15');
    expect(addPeriods('2026-01-15', 1, 'month')).toBe('2026-02-15');
    expect(addPeriods('2026-11-15', 3, 'month')).toBe('2027-02-15');
    expect(addPeriods('2024-02-29', 1, 'year')).toBe('2025-02-28');
  });

  it('clamps a month-end anchor without drifting down for good', () => {
    expect(addPeriods('2026-01-31', 1, 'month')).toBe('2026-02-28');
    // The third step is taken from the anchor, so March gets its 31st back.
    expect(addPeriods('2026-01-31', 2, 'month')).toBe('2026-03-31');
    expect(addPeriods('2026-01-31', 3, 'month')).toBe('2026-04-30');
  });

  it('finds the first due date after a given date, on the anchor rhythm', () => {
    const quarterly = { every: 3, unit: 'month' as const, starts_on: '2026-01-15' };
    expect(nextDueOn(quarterly, null)).toBe('2026-01-15');
    expect(nextDueOn(quarterly, '2026-01-15')).toBe('2026-04-15');
    expect(nextDueOn(quarterly, '2026-05-01')).toBe('2026-07-15');
    // Years later it is still on the 15th, in the same months.
    expect(nextDueOn(quarterly, '2031-02-02')).toBe('2031-04-15');
    // A date before the start answers the start.
    expect(nextDueOn(quarterly, '2020-01-01')).toBe('2026-01-15');
  });

  it('stops at the end date', () => {
    const r = { every: 1, unit: 'week' as const, starts_on: '2026-09-01', ends_on: '2026-09-20' };
    expect(nextDueOn(r, '2026-09-08')).toBe('2026-09-15');
    expect(nextDueOn(r, '2026-09-15')).toBeNull();
  });

  it('raises inside the lead window and not before', () => {
    expect(isDueToRaise('2026-10-01', '2026-09-22', 7)).toBe(false);
    expect(isDueToRaise('2026-10-01', '2026-09-24', 7)).toBe(true);
    expect(isDueToRaise('2026-10-01', '2026-10-05', 0)).toBe(true); // overdue still raises
    expect(daysBetween('2026-09-22', '2026-10-01')).toBe(9);
  });

  it('names things the way the list will read them', () => {
    expect(frequencyLabel(1, 'month')).toBe('Every month');
    expect(frequencyLabel(2, 'week')).toBe('Every 2 weeks');
    expect(pmWoNumber('PM-0007', '2026-10-01')).toBe('PM-0007-2026-10-01');
  });
});
