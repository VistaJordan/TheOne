/**
 * Planned maintenance (0051) — work that happens on a calendar, not on a call.
 *
 * A schedule says WHAT (client, site, trade, description, NTE, who dispatches
 * it) and HOW OFTEN (every N days / weeks / months / years from a start
 * date, until an end date). The app raises one work order per due date, a
 * few days ahead (`lead_days`), in the "PM Sched" status, and records each
 * raise as an occurrence so a date is never raised twice and the schedule
 * has a history.
 *
 * Everything that decides WHEN the next work order is due is a pure function
 * here, so the API and the browser agree and the arithmetic is pinned by
 * tests (tests/planned-maintenance.test.ts) — a wrong answer is a missed
 * visit on a contract.
 */

export const PM_PERM_KEY = 'planned_maintenance';

export const PM_UNITS = ['day', 'week', 'month', 'year'] as const;
export type PmUnit = (typeof PM_UNITS)[number];

export const PM_UNIT_LABELS: Record<PmUnit, { one: string; many: string }> = {
  day: { one: 'day', many: 'days' },
  week: { one: 'week', many: 'weeks' },
  month: { one: 'month', many: 'months' },
  year: { one: 'year', many: 'years' },
};

/** "Every 3 months", "Every week". */
export function frequencyLabel(every: number, unit: PmUnit): string {
  const u = PM_UNIT_LABELS[unit];
  return every === 1 ? `Every ${u.one}` : `Every ${every} ${u.many}`;
}

/** The status a raised work order starts in, when it exists; the ordinary
    start status otherwise (services/plannedMaintenance.ts falls back). */
export const PM_START_STATUS_NAME = 'PM Sched';

export interface PmSchedule {
  id: string;
  /** PM-0001 — the prefix of every work order it raises. */
  code: string;
  name: string;
  client: string | null;
  billing_entity: string | null;
  store: string | null;
  site_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  description: string | null;
  nte: number | null;
  /** Display name of the person the work orders are assigned to. */
  assignee: string | null;
  every: number;
  unit: PmUnit;
  starts_on: string;
  ends_on: string | null;
  /** Raise the work order this many days before it is due. */
  lead_days: number;
  active: boolean;
  created_by: { id: string; display_name: string } | null;
  created_at: string;
  updated_at: string;
  /** The last due date raised or skipped; null before the first. */
  last_due_on: string | null;
  /** The next date a work order is due; null once the schedule has ended. */
  next_due_on: string | null;
  /** How many work orders it has raised. */
  raised_count: number;
  /** The most recent raise, for the list. */
  last_wo: { task_id: string; wo_number: string; due_on: string } | null;
}

export interface PmOccurrence {
  id: string;
  schedule_id: string;
  due_on: string;
  /** 'raised' | 'skipped' */
  status: 'raised' | 'skipped';
  task_id: string | null;
  wo_number: string | null;
  /** The work order's status name today, when raised. */
  wo_status: string | null;
  created_at: string;
}

export interface PmScheduleInput {
  name: string;
  client?: string | null;
  billing_entity?: string | null;
  store?: string | null;
  site_name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  trade?: string | null;
  description?: string | null;
  nte?: number | null;
  assignee?: string | null;
  every: number;
  unit: PmUnit;
  starts_on: string;
  ends_on?: string | null;
  lead_days?: number;
  active?: boolean;
}

export interface PmSchedulesResponse {
  items: PmSchedule[];
}

// ── Date arithmetic ──────────────────────────────────────────────────────────
// All in whole days on YYYY-MM-DD strings, in UTC, so nothing here depends on
// the machine's time zone. A month step keeps the start's day-of-month and
// clamps to the last day of a shorter month (Jan 31 → Feb 28 → Mar 31: each
// step is taken from the ANCHOR, not the previous date, so the day never
// drifts down permanently).

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number);
  return [y, m, d];
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `n` periods after the anchor date. */
export function addPeriods(anchor: string, n: number, unit: PmUnit): string {
  const [y, m, d] = parts(anchor);
  if (unit === 'day' || unit === 'week') {
    const t = Date.UTC(y, m - 1, d) + n * (unit === 'week' ? 7 : 1) * 86_400_000;
    const x = new Date(t);
    return fmt(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
  }
  const months = unit === 'year' ? n * 12 : n;
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** Whole days from a to b (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function addDays(day: string, n: number): string {
  return addPeriods(day, n, 'day');
}

export interface PmRhythm {
  every: number;
  unit: PmUnit;
  starts_on: string;
  ends_on?: string | null;
}

/**
 * The first due date strictly AFTER `after` (or the start itself when
 * `after` is null), or null when the schedule has run out. Due dates are the
 * start plus whole multiples of the period, so a schedule edited mid-life
 * keeps the same anchor and the same rhythm.
 */
export function nextDueOn(r: PmRhythm, after: string | null): string | null {
  const every = Math.max(1, Math.floor(r.every));
  let k = 0;
  if (after !== null && after >= r.starts_on) {
    // Jump close, then walk: the month arithmetic is not linear in days.
    const approxDays = { day: 1, week: 7, month: 30.4375, year: 365.25 }[r.unit] * every;
    k = Math.max(0, Math.floor(daysBetween(r.starts_on, after) / approxDays) - 1);
    while (addPeriods(r.starts_on, k * every, r.unit) <= after) k += 1;
  }
  const due = addPeriods(r.starts_on, k * every, r.unit);
  if (r.ends_on && due > r.ends_on) return null;
  return due;
}

/** True when a due date should be raised today: it is within `lead_days`. */
export function isDueToRaise(dueOn: string, today: string, leadDays: number): boolean {
  return daysBetween(today, dueOn) <= Math.max(0, leadDays);
}

/** The WO # a schedule's occurrence gets: the code plus the due date, so it
    is unique per date and reads as what it is on the list. */
export function pmWoNumber(code: string, dueOn: string): string {
  return `${code}-${dueOn}`;
}
