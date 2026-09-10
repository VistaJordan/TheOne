// businessDays — the quote clock's arithmetic (rule 2.3.2).
//
//   Quote_Due_Date = Check-Out + 48 hours, and IF that span crosses a
//   Saturday, a Sunday or a System_Holiday_Table day, THEN pause for those
//   days and push the due date forward.
//
// So the clock counts WALL-CLOCK hours on working days only: a Friday 15:00
// check-out owes 9 hours on Friday, skips Saturday and Sunday whole, spends 24
// on Monday and the last 15 on Tuesday → due Tuesday 15:00. Hours are not
// business hours (08:00–18:00) — the rule says 48 hours, pausing for days.
//
// PURE: no DB, no I/O, no clock reads. Everything happens in "wall space" —
// the timestamp as it reads on a Chicago clock, stored as a UTC millisecond
// count so a day is exactly 86 400 000 ms and midnight is a multiple of it.
// DST cannot bite: both US transitions happen at 02:00 local, and the only
// wall↔instant conversions are at the two ends, where `offsetMinutesAt` asks
// Intl for the real offset instead of guessing.

import { BUSINESS_TIME_ZONE } from '@theone/shared';

const DAY_MS = 86_400_000;

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The instant as Chicago wall time, as a UTC-millisecond count. */
function toWall(instant: Date): number {
  const p: Record<string, number> = {};
  for (const part of PARTS.formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** Zone offset (wall − UTC, in ms) in force at `instant`. */
function offsetMsAt(instant: Date): number {
  return toWall(instant) - instant.getTime();
}

/** Chicago wall time back to an instant. Two passes: the offset in force at
    the answer may differ from the one at the guess when the span straddles a
    DST change; the second pass lands on the right side. */
function fromWall(wall: number): Date {
  const guess = new Date(wall - offsetMsAt(new Date(wall)));
  return new Date(wall - offsetMsAt(guess));
}

/** 'YYYY-MM-DD' of a wall-space millisecond count. */
function dayOf(wall: number): string {
  return new Date(wall).toISOString().slice(0, 10);
}

/** Saturday / Sunday in wall space (getUTCDay reads the wall date). */
function isWeekend(wall: number): boolean {
  const d = new Date(wall).getUTCDay();
  return d === 0 || d === 6;
}

/**
 * `start` + `hours` working hours, skipping weekends and `holidays`
 * ('YYYY-MM-DD' in the business zone) as whole days. A start that falls on a
 * skipped day begins counting at the next working midnight.
 */
export function addWorkingHours(start: Date, hours: number, holidays: Iterable<string>): Date {
  const skip = new Set(holidays);
  const isOff = (wall: number) => isWeekend(wall) || skip.has(dayOf(wall));

  let wall = toWall(start);
  let left = Math.max(0, hours) * 3_600_000;

  // Guard against a pathological holiday table (every day off) — 400 days is
  // more than a year of consecutive days off, which no calendar has.
  for (let guard = 0; guard < 400; guard++) {
    const midnight = Math.floor(wall / DAY_MS) * DAY_MS;
    if (isOff(wall)) {
      wall = midnight + DAY_MS;
      continue;
    }
    const untilMidnight = midnight + DAY_MS - wall;
    if (left <= untilMidnight) return fromWall(wall + left);
    left -= untilMidnight;
    wall = midnight + DAY_MS;
  }
  return fromWall(wall);
}

/** Self-check, run by hand (`tsx apps/api/src/lib/businessDays.ts`): prints
    the worked examples from the rule and throws on a wrong answer. */
export function runSelfChecks(): void {
  const chicago = (iso: string) => fromWall(Date.parse(`${iso}Z`));
  const show = (d: Date) => PARTS.format(d);
  const cases: [string, string[], string][] = [
    // Wed 10:00 → Fri 10:00: no skipped day.
    ['2026-09-09T10:00:00', [], '2026-09-11T10:00:00'],
    // Fri 15:00 → Tue 15:00: 9h Fri + 24h Mon + 15h Tue.
    ['2026-09-11T15:00:00', [], '2026-09-15T15:00:00'],
    // Saturday check-out: counting starts Monday 00:00 → Wed 00:00.
    ['2026-09-12T11:30:00', [], '2026-09-16T00:00:00'],
    // Thu 09:00 with Friday a holiday: 15h Thu, skip Fri/Sat/Sun, 24h Mon, 9h Tue.
    ['2026-09-10T09:00:00', ['2026-09-11'], '2026-09-15T09:00:00'],
    // Across the November 1 2026 fall-back: wall hours, not elapsed hours.
    ['2026-10-30T12:00:00', [], '2026-11-03T12:00:00'],
  ];
  for (const [start, hols, want] of cases) {
    const got = toWall(addWorkingHours(chicago(start), 48, hols));
    const gotIso = new Date(got).toISOString().slice(0, 19);
    console.log(`${start} + 48h → ${show(fromWall(got))}`);
    if (gotIso !== want) throw new Error(`businessDays: ${start} gave ${gotIso}, wanted ${want}`);
  }
  console.log('businessDays: self-checks passed');
}

if (process.argv[1] && /businessDays\.ts$/.test(process.argv[1])) runSelfChecks();
