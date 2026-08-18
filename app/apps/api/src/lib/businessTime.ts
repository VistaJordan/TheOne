// businessTime — the clock arithmetic behind every obligation (S5).
//
// THE RULE (product decision, mirrored from the escalation bot):
//   Business hours are Mon–Fri 08:00–18:00 America/Chicago.
//   EMERGENCY clocks run 24/7. Every other clock PAUSES outside business hours.
//
// This module is PURE: zero imports, no DB, no I/O, no clock reads except the
// `now` you hand it. That is what makes `runSelfChecks()` at the bottom a real
// test — it exercises DST, weekends, and the pause/resume boundary without a
// database or a test runner.
//
// ── HOW THE ARITHMETIC WORKS ────────────────────────────────────────────────
// Everything happens in "wall space": a timestamp is converted to the number of
// milliseconds it WOULD be if Chicago local time were UTC. In wall space a day
// is exactly 86_400_000 ms and 08:00 is always 8h past midnight, so business
// windows are fixed offsets and no timezone reasoning leaks into the maths.
//
// DST is safe in wall space because both US transitions happen at 02:00 local
// (spring forward skips 02:00→03:00, fall back repeats 01:00→02:00) — always
// OUTSIDE the 08:00–18:00 window, so no business millisecond is ever created or
// destroyed by a transition. Only the wall↔instant conversion has to know about
// DST, and `offsetMsAt` asks Intl rather than guessing.
//
// NOTE ON OWNERSHIP: this file is also imported by packages/db/src/seed.ts
// (relative path, tsx-only, dev tooling) so the demo-state anchors are computed
// with EXACTLY this arithmetic. Keep it dependency-free.

export const BUSINESS_TZ = 'America/Chicago';
export const BUSINESS_OPEN_HOUR = 8;
export const BUSINESS_CLOSE_HOUR = 18;

const MS_SECOND = 1_000;
const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

const OPEN_MS = BUSINESS_OPEN_HOUR * MS_HOUR;
const CLOSE_MS = BUSINESS_CLOSE_HOUR * MS_HOUR;

/** One business DAY of clock time: 10 hours, not 24. `2 business days` = 20h. */
export const BUSINESS_DAY_MS = CLOSE_MS - OPEN_MS;
export const BUSINESS_HOUR_MS = MS_HOUR;

/** Epoch day 4 = 1970-01-05, a Monday. The origin every weekday sum counts from. */
const EPOCH_MONDAY_DAY = 4;

// ── Timezone conversion ─────────────────────────────────────────────────────

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** (Chicago wall clock − UTC) in ms at `instant`. −6h in CST, −5h in CDT. */
function offsetMsAt(instant: number): number {
  const parts = FMT.formatToParts(new Date(instant));
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const p of parts) {
    const n = Number(p.value);
    if (p.type === 'year') year = n;
    else if (p.type === 'month') month = n;
    else if (p.type === 'day') day = n;
    else if (p.type === 'hour') hour = n;
    else if (p.type === 'minute') minute = n;
    else if (p.type === 'second') second = n;
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Intl resolves to whole seconds; compare against the instant floored the same
  // way so sub-second precision rides along in toWall() instead of being lost.
  return asUtc - Math.floor(instant / MS_SECOND) * MS_SECOND;
}

/** UTC instant → wall-space ms (Chicago local time pretending to be UTC). */
export function toWall(instant: number): number {
  return instant + offsetMsAt(instant);
}

/**
 * Wall-space ms → UTC instant. Two passes: the first uses the wall value itself
 * as a seed (wrong by at most one offset, ≤6h), the second re-reads the offset
 * at the corrected instant. A third read is unnecessary because the correction
 * can only cross ONE transition and business boundaries never sit inside the
 * ambiguous 01:00–03:00 window.
 */
export function fromWall(wall: number): number {
  const seed = offsetMsAt(wall);
  let instant = wall - seed;
  const settled = offsetMsAt(instant);
  if (settled !== seed) instant = wall - settled;
  return instant;
}

/** Chicago wall-clock components → the UTC instant they name. */
export function chicagoWallToInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  return new Date(fromWall(Date.UTC(year, month - 1, day, hour, minute, second)));
}

// ── Weekday / window maths, all in wall space ───────────────────────────────

function wallDayIndex(wall: number): number {
  return Math.floor(wall / MS_DAY);
}

/** 0 = Monday … 6 = Sunday. Math.floor keeps this correct for pre-1970 too. */
function dayOfWeek(dayIndex: number): number {
  const k = dayIndex - EPOCH_MONDAY_DAY;
  return k - Math.floor(k / 7) * 7;
}

function isBusinessDayIndex(dayIndex: number): boolean {
  return dayOfWeek(dayIndex) <= 4;
}

/** Count of business days strictly BEFORE `dayIndex`, counted from epoch day 0. */
function businessDaysBefore(dayIndex: number): number {
  const k = dayIndex - EPOCH_MONDAY_DAY;
  const weeks = Math.floor(k / 7);
  const dow = k - weeks * 7;
  return weeks * 5 + Math.min(dow, 5);
}

/** Inverse of businessDaysBefore: the day index of the n-th business day (0-based). */
function nthBusinessDay(n: number): number {
  const weeks = Math.floor(n / 5);
  const rest = n - weeks * 5;
  return EPOCH_MONDAY_DAY + weeks * 7 + rest;
}

/**
 * Business milliseconds accumulated from the epoch up to `wall`. Every business
 * computation below is a difference of two of these, which is what makes
 * "the clock pauses at 18:00 and resumes at 08:00" fall out for free: any time
 * spent outside a window contributes zero.
 */
function cumulativeBusinessMs(wall: number): number {
  const day = wallDayIndex(wall);
  const base = businessDaysBefore(day) * BUSINESS_DAY_MS;
  if (!isBusinessDayIndex(day)) return base;
  const timeOfDay = wall - day * MS_DAY;
  const clamped = Math.min(Math.max(timeOfDay, OPEN_MS), CLOSE_MS);
  return base + (clamped - OPEN_MS);
}

/**
 * Inverse of cumulativeBusinessMs. When the total lands exactly on a window
 * boundary the CLOSE of the previous business day is returned rather than the
 * open of the next: "due at the end of Tuesday" reads truer on a deadline than
 * "due at the start of Wednesday", and both name the same business instant.
 */
function wallFromCumulative(total: number): number {
  const whole = Math.floor(total / BUSINESS_DAY_MS);
  const rest = total - whole * BUSINESS_DAY_MS;
  if (rest === 0 && whole > 0) {
    return nthBusinessDay(whole - 1) * MS_DAY + CLOSE_MS;
  }
  return nthBusinessDay(whole) * MS_DAY + OPEN_MS + rest;
}

function ms(value: Date | number): number {
  return typeof value === 'number' ? value : value.getTime();
}

// ── Public business-time API ────────────────────────────────────────────────

/** True when `at` sits inside a Mon–Fri 08:00–18:00 Chicago window. */
export function isBusinessOpen(at: Date | number): boolean {
  const wall = toWall(ms(at));
  const day = wallDayIndex(wall);
  if (!isBusinessDayIndex(day)) return false;
  const timeOfDay = wall - day * MS_DAY;
  return timeOfDay >= OPEN_MS && timeOfDay < CLOSE_MS;
}

/**
 * Business milliseconds between two instants. Negative when `to` precedes
 * `from` (callers that want a floor should clamp — the raw sign is useful for
 * "how far past due" arithmetic).
 */
export function diffBusinessMs(from: Date | number, to: Date | number): number {
  return cumulativeBusinessMs(toWall(ms(to))) - cumulativeBusinessMs(toWall(ms(from)));
}

/**
 * `start` advanced by `amount` business milliseconds. A start outside a window
 * is first normalised onto the boundary (a clock that starts at 19:00 Friday
 * starts ticking at 08:00 Monday), which is exactly the pause semantics.
 */
export function addBusinessMs(start: Date | number, amount: number): Date {
  const total = cumulativeBusinessMs(toWall(ms(start))) + amount;
  return new Date(fromWall(wallFromCumulative(Math.max(0, total))));
}

/** `end` rewound by `amount` business milliseconds. Used by the demo seed. */
export function subBusinessMs(end: Date | number, amount: number): Date {
  return addBusinessMs(end, -amount);
}

export function businessHours(n: number): number {
  return n * BUSINESS_HOUR_MS;
}

export function businessDays(n: number): number {
  return n * BUSINESS_DAY_MS;
}

// ── Clock dispatch — the two clock kinds an obligation can carry ────────────

export type ClockKind = 'business' | '24x7';

/** Advance `start` by `amount` on the given clock. */
export function addClockMs(clock: ClockKind, start: Date | number, amount: number): Date {
  return clock === '24x7' ? new Date(ms(start) + amount) : addBusinessMs(start, amount);
}

/** Elapsed time between two instants on the given clock. */
export function diffClockMs(clock: ClockKind, from: Date | number, to: Date | number): number {
  return clock === '24x7' ? ms(to) - ms(from) : diffBusinessMs(from, to);
}

/** Rewind `end` by `amount` on the given clock. */
export function subClockMs(clock: ClockKind, end: Date | number, amount: number): Date {
  return clock === '24x7' ? new Date(ms(end) - amount) : subBusinessMs(end, amount);
}

// ── Human rendering ─────────────────────────────────────────────────────────

/**
 * "2d 4h" / "45m". A business duration counts a DAY as 10 hours, because that
 * is what a business day is on this clock — printing 20 business hours as
 * "20h" when the operator will experience it as two working days is a lie the
 * Pulse cannot afford.
 */
export function humanizeClockMs(clock: ClockKind, amount: number): string {
  const abs = Math.abs(amount);
  const dayUnit = clock === '24x7' ? MS_DAY : BUSINESS_DAY_MS;

  const days = Math.floor(abs / dayUnit);
  const afterDays = abs - days * dayUnit;
  const hours = Math.floor(afterDays / MS_HOUR);
  const minutes = Math.floor((afterDays - hours * MS_HOUR) / MS_MINUTE);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'under a minute';
}

/** "business hours" / "24/7" — the phrase the card prints next to a duration. */
export function clockLabel(clock: ClockKind): string {
  return clock === '24x7' ? '24/7' : 'business hours';
}

// ── Self-checks ─────────────────────────────────────────────────────────────
// Pure assertions over the functions above. Run them with:
//   npx tsx apps/api/src/lib/businessTime.selftest.ts
// They touch NO database, so they are safe to run while the API holds pgdata.

export interface SelfCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

/** Chicago wall-clock string for an instant — the readable form in check output. */
export function formatChicago(instant: Date | number): string {
  const wall = toWall(ms(instant));
  const d = new Date(wall);
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dayOfWeek(wallDayIndex(wall))];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dow} ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function runSelfChecks(): SelfCheck[] {
  const checks: SelfCheck[] = [];
  const ct = chicagoWallToInstant;

  const expectInstant = (name: string, actual: Date, expected: Date) => {
    checks.push({
      name,
      ok: actual.getTime() === expected.getTime(),
      expected: formatChicago(expected),
      actual: formatChicago(actual),
    });
  };
  const expectNumber = (name: string, actual: number, expected: number) => {
    checks.push({
      name,
      ok: actual === expected,
      expected: String(expected),
      actual: String(actual),
    });
  };
  const expectBool = (name: string, actual: boolean, expected: boolean) => {
    checks.push({ name, ok: actual === expected, expected: String(expected), actual: String(actual) });
  };

  // 2026-08-04 is a Tuesday; 2026-08-07 a Friday; 2026-08-08/09 the weekend.

  // 1 — inside one window, the clock behaves like a plain clock.
  expectInstant(
    'Tue 09:00 + 2 business hours = Tue 11:00',
    addBusinessMs(ct(2026, 8, 4, 9, 0), businessHours(2)),
    ct(2026, 8, 4, 11, 0),
  );

  // 2 — it pauses at 18:00 and resumes at 08:00 the next business day.
  expectInstant(
    'Tue 17:00 + 2 business hours = Wed 09:00',
    addBusinessMs(ct(2026, 8, 4, 17, 0), businessHours(2)),
    ct(2026, 8, 5, 9, 0),
  );

  // 3 — the weekend is not on the clock at all.
  expectInstant(
    'Fri 17:00 + 2 business hours = Mon 09:00',
    addBusinessMs(ct(2026, 8, 7, 17, 0), businessHours(2)),
    ct(2026, 8, 10, 9, 0),
  );

  // 4 — a clock that starts outside a window starts at the next open.
  expectInstant(
    'Sat 12:00 + 1 business hour = Mon 09:00',
    addBusinessMs(ct(2026, 8, 8, 12, 0), businessHours(1)),
    ct(2026, 8, 10, 9, 0),
  );

  // 5 — the same gap measured backwards.
  expectNumber(
    'Fri 17:00 → Mon 09:00 is 2 business hours',
    diffBusinessMs(ct(2026, 8, 7, 17, 0), ct(2026, 8, 10, 9, 0)),
    businessHours(2),
  );

  // 6 — a whole calendar week is five 10-hour days.
  expectNumber(
    'Mon 08:00 → next Mon 08:00 is 50 business hours',
    diffBusinessMs(ct(2026, 8, 3, 8, 0), ct(2026, 8, 10, 8, 0)),
    businessHours(50),
  );

  // 7 — a weekend on its own contributes nothing.
  expectNumber(
    'Sat 09:00 → Sun 17:00 is 0 business ms',
    diffBusinessMs(ct(2026, 8, 8, 9, 0), ct(2026, 8, 9, 17, 0)),
    0,
  );

  // 8 — a boundary-exact deadline names the CLOSE of the last business day.
  expectInstant(
    'Mon 08:00 + 2 business days = Tue 18:00',
    addBusinessMs(ct(2026, 8, 3, 8, 0), businessDays(2)),
    ct(2026, 8, 4, 18, 0),
  );

  // 9 — DST spring-forward (2026-03-08). CST −6 before, CDT −5 after; the
  //     business gap across the weekend is unaffected.
  expectNumber(
    'Fri 2026-03-06 17:00 → Mon 2026-03-09 09:00 is 2 business hours (spring forward)',
    diffBusinessMs(ct(2026, 3, 6, 17, 0), ct(2026, 3, 9, 9, 0)),
    businessHours(2),
  );
  expectNumber(
    'spring-forward weekend is one real hour shorter than the 64h it looks',
    ct(2026, 3, 9, 9, 0).getTime() - ct(2026, 3, 6, 17, 0).getTime(),
    64 * MS_HOUR - MS_HOUR,
  );

  // 10 — DST fall-back (2026-11-01).
  expectNumber(
    'Fri 2026-10-30 17:00 → Mon 2026-11-02 09:00 is 2 business hours (fall back)',
    diffBusinessMs(ct(2026, 10, 30, 17, 0), ct(2026, 11, 2, 9, 0)),
    businessHours(2),
  );

  // 11 — add/diff are inverses across a weekend.
  {
    const start = ct(2026, 8, 6, 15, 30);
    const budget = businessDays(3) + businessHours(1);
    const due = addBusinessMs(start, budget);
    expectNumber('addBusinessMs and diffBusinessMs round-trip', diffBusinessMs(start, due), budget);
  }

  // 12 — subBusinessMs is the exact inverse (the demo seed depends on this).
  {
    const now = ct(2026, 8, 4, 10, 15);
    const back = subBusinessMs(now, businessHours(22));
    expectNumber('subBusinessMs rewinds exactly 22 business hours', diffBusinessMs(back, now), businessHours(22));
  }

  // 13 — the open/closed predicate.
  expectBool('Tue 09:00 is open', isBusinessOpen(ct(2026, 8, 4, 9, 0)), true);
  expectBool('Tue 18:00 is closed (window is half-open)', isBusinessOpen(ct(2026, 8, 4, 18, 0)), false);
  expectBool('Tue 07:59 is closed', isBusinessOpen(ct(2026, 8, 4, 7, 59)), false);
  expectBool('Sat 12:00 is closed', isBusinessOpen(ct(2026, 8, 8, 12, 0)), false);

  // 14 — the 24/7 clock ignores every window (emergencies do not sleep).
  expectNumber(
    'Sat 22:00 → Sun 00:00 is 2 hours on the 24/7 clock',
    diffClockMs('24x7', ct(2026, 8, 8, 22, 0), ct(2026, 8, 9, 0, 0)),
    2 * MS_HOUR,
  );
  expectInstant(
    'Sat 23:00 + 2h on the 24/7 clock = Sun 01:00',
    addClockMs('24x7', ct(2026, 8, 8, 23, 0), 2 * MS_HOUR),
    ct(2026, 8, 9, 1, 0),
  );

  // 15 — human rendering counts a business day as ten hours, not twenty-four.
  expectBool(
    `humanize: 20 business hours reads as 2d (got "${humanizeClockMs('business', businessHours(20))}")`,
    humanizeClockMs('business', businessHours(20)) === '2d',
    true,
  );
  expectBool(
    `humanize: 20 hours on the 24/7 clock reads as 20h (got "${humanizeClockMs('24x7', 20 * MS_HOUR)}")`,
    humanizeClockMs('24x7', 20 * MS_HOUR) === '20h',
    true,
  );

  return checks;
}
