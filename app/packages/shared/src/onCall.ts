// On call and After hours (Elise, 2026-11-17).
//
// A Google Sheet says who is on call on which day — an AM, TL, ATL or OP
// Admin (`ON_CALL_ROLE_CODES`). OBI reads it (services/onCall.ts) into
// `on_call_shift`, one row per (day, person). While a person's shift is
// running — `start_hour` to `end_hour`, America/Chicago, on the shift's day
// (12 AM to 3 PM by default) — the header shows them an **After hours**
// button. During the shift the wide view is ON by default: every work order
// they may open, every approval their role may see, every notification
// addressed to them, not only the jobs they sit on. A press switches back to
// their own jobs (and another press to everything again); each press is an
// audit row, and the choice ends with the shift.
//
// Pure: no database, no clock of its own (the caller passes `now`).

/** The roles the sheet may name. */
export const ON_CALL_ROLE_CODES = ['am', 'tl', 'atl', 'oa'] as const;

export function isOnCallRole(role: string | null | undefined): boolean {
  return !!role && (ON_CALL_ROLE_CODES as readonly string[]).includes(role);
}

export const ON_CALL_DEFAULT_START_HOUR = 0;
export const ON_CALL_DEFAULT_END_HOUR = 15;
/** How often the sheet is read again when somebody asks (minutes). */
export const ON_CALL_SYNC_MINUTES = 15;
/** The longest span one "start – end" row may cover (days). */
export const ON_CALL_MAX_SPAN_DAYS = 62;

export interface OnCallSettings {
  /** The spreadsheet id (the part of its URL after /d/). */
  sheet_id: string | null;
  /** The tab, by its name; null = the first tab (or the URL's gid). */
  tab: string | null;
  /** The tab's gid from a pasted URL, resolved to its name when read. */
  gid: string | null;
  start_hour: number;
  end_hour: number;
}

export const ON_CALL_DEFAULT_SETTINGS: OnCallSettings = {
  sheet_id: null,
  tab: null,
  gid: null,
  start_hour: ON_CALL_DEFAULT_START_HOUR,
  end_hour: ON_CALL_DEFAULT_END_HOUR,
};

/** A pasted Google Sheets URL (or a bare id) → id + gid. */
export function parseSheetRef(input: string): { sheet_id: string | null; gid: string | null } {
  const s = input.trim();
  if (!s) return { sheet_id: null, gid: null };
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  const gid = /[#?&]gid=(\d+)/.exec(s)?.[1] ?? null;
  if (m) return { sheet_id: m[1], gid };
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? { sheet_id: s, gid: null } : { sheet_id: null, gid: null };
}

// ── Dates ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

function validDay(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * A sheet cell as a day (YYYY-MM-DD), or null. Reads 2026-11-17, 11/17/2026,
 * 11/17/26, "Nov 17, 2026", "Monday, November 17, 2026", "17 Nov 2026", and a
 * date with a time after it. `defaultYear` fills "11/17" / "Nov 17".
 */
export function parseSheetDate(cell: string, defaultYear?: number): string | null {
  const s = cell.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  if (!s || s.length > 60) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t\s].*)?$/.exec(s);
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = /^(?:[a-z]+,?\s+)?(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?(?:\s.*)?$/.exec(s);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : defaultYear;
    return y ? validDay(y, +m[1], +m[2]) : null;
  }
  m = /^(?:[a-z]+,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2}),?(?:\s+(\d{4}))?(?:\s.*)?$/.exec(s);
  if (m && MONTHS[m[1].slice(0, 4) === 'sept' ? 'sept' : m[1].slice(0, 3)]) {
    const y = m[3] ? +m[3] : defaultYear;
    return y ? validDay(y, MONTHS[m[1].slice(0, 3)], +m[2]) : null;
  }
  m = /^(?:[a-z]+,?\s+)?(\d{1,2})\s+([a-z]{3,9})\.?,?(?:\s+(\d{4}))?$/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3)]) {
    const y = m[3] ? +m[3] : defaultYear;
    return y ? validDay(y, MONTHS[m[2].slice(0, 3)], +m[1]) : null;
  }
  return null;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// ── Reading the sheet ───────────────────────────────────────────────────────

export interface OnCallPerson {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
}

export interface OnCallShiftRow {
  day: string;
  principal_id: string;
  name: string;
  /** 1-based row of the sheet it came from. */
  row: number;
}

export interface OnCallParseResult {
  shifts: OnCallShiftRow[];
  /** Names on a dated row that match no AM / TL / ATL / OP Admin on file. */
  unmatched: { row: number; text: string }[];
}

/** Lower case, punctuation to spaces — dots kept only inside an email. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(s.includes('@') ? /[^a-z0-9@.]+/g : /[^a-z0-9]+/g, ' ')
    .trim();

/** Role words a header-ish cell may hold on a dated row ("AM", "On call"). */
const IGNORED_WORDS = new Set(['am', 'tl', 'atl', 'oa', 'op admin', 'on call', 'oncall', 'none', 'n a', 'tbd', 'off', 'x']);

/**
 * Who is on call, from the sheet's rows (the cells as text). The layout is
 * read loosely so the team's sheet works as it is: a row with one date is
 * that day, a row with two dates is every day from the first to the second;
 * every other cell on the row is split on commas, slashes, "&", "and" and new
 * lines, and each piece is matched to an on-call person by display name, by
 * email, by first name or by first name + last initial (only when exactly one
 * person answers to it). Rows with no date (headers, notes) are skipped.
 */
export function parseOnCallSheet(rows: string[][], people: OnCallPerson[], defaultYear?: number): OnCallParseResult {
  const pool = people.filter((p) => isOnCallRole(p.role));
  const byName = new Map<string, OnCallPerson[]>();
  const add = (k: string, p: OnCallPerson) => {
    if (!k) return;
    const list = byName.get(k) ?? [];
    if (!list.includes(p)) list.push(p);
    byName.set(k, list);
  };
  for (const p of pool) {
    const full = norm(p.name);
    add(full, p);
    if (p.email) {
      add(norm(p.email), p);
      add(norm(p.email.split('@')[0]), p);
    }
    const parts = full.split(' ').filter(Boolean);
    if (parts.length > 0) add(parts[0], p);
    if (parts.length > 1) {
      add(`${parts[0]} ${parts[parts.length - 1][0]}`, p);
      add(`${parts[0]} ${parts[parts.length - 1]}`, p);
    }
  }
  const match = (text: string): OnCallPerson | null => {
    const k = norm(text);
    const exact = byName.get(k);
    if (exact?.length === 1) return exact[0];
    // "Jordan B." / "Jordan Brown (AM)" → drop the bracket and the dot.
    const k2 = norm(text.replace(/\(.*?\)/g, ' '));
    const hit = byName.get(k2);
    return hit?.length === 1 ? hit[0] : null;
  };

  const shifts: OnCallShiftRow[] = [];
  const unmatched: OnCallParseResult['unmatched'] = [];
  const seen = new Set<string>();
  rows.forEach((cells, i) => {
    const row = i + 1;
    const dates: string[] = [];
    const others: string[] = [];
    for (const raw of cells) {
      const c = String(raw ?? '').trim();
      if (!c) continue;
      const d = parseSheetDate(c, defaultYear);
      if (d) dates.push(d);
      else others.push(c);
    }
    if (dates.length === 0) return;
    let days: string[] = [dates[0]];
    if (dates.length >= 2 && dates[1] > dates[0]) {
      days = [];
      for (let d = dates[0]; d <= dates[1] && days.length < ON_CALL_MAX_SPAN_DAYS; d = addDays(d, 1)) days.push(d);
    }
    for (const cell of others) {
      for (const piece of cell.split(/[,/&\n;+]|\band\b/i)) {
        const text = piece.trim();
        if (!/[a-z]/i.test(text) || IGNORED_WORDS.has(norm(text))) continue;
        // Weekday names next to the date ("Monday") are not people.
        if (/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|nesday|rsday|urday)?\.?$/i.test(text)) continue;
        const p = match(text);
        if (!p) {
          unmatched.push({ row, text });
          continue;
        }
        for (const day of days) {
          const key = `${day}|${p.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          shifts.push({ day, principal_id: p.id, name: p.name, row });
        }
      }
    }
  });
  return { shifts, unmatched };
}

// ── The shift's window ──────────────────────────────────────────────────────

const ZONE = 'America/Chicago';

/** The Chicago wall clock of an instant. */
export function chicagoWall(now: Date): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { day: `${get('year')}-${pad(get('month'))}-${pad(get('day'))}`, minutes: (get('hour') % 24) * 60 + get('minute') };
}

/** The instant a Chicago wall time names (DST handled by two corrections). */
export function chicagoInstant(day: string, hour: number): Date {
  const [y, m, d] = day.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hour);
  let t = target;
  for (let i = 0; i < 2; i++) {
    const w = chicagoWall(new Date(t));
    const [wy, wm, wd] = w.day.split('-').map(Number);
    const seen = Date.UTC(wy, wm - 1, wd) + w.minutes * 60_000;
    t += target - seen;
  }
  return new Date(t);
}

export interface OnCallNow {
  /** The day of the shift running now, or null. */
  day: string | null;
  starts_at: string | null;
  ends_at: string | null;
}

/**
 * Which of the person's shift days is running at `now`. A shift on day D runs
 * from D at start_hour to D at end_hour (Chicago); an end at or before the
 * start runs past midnight into D + 1.
 */
export function onCallShiftNow(days: readonly string[], now: Date, s: Pick<OnCallSettings, 'start_hour' | 'end_hour'>): OnCallNow {
  const overnight = s.end_hour <= s.start_hour;
  const t = now.getTime();
  const today = chicagoWall(now).day;
  for (const day of [today, addDays(today, -1)]) {
    if (!days.includes(day)) continue;
    const start = chicagoInstant(day, s.start_hour);
    // end_hour 24 = midnight at the end of the day (Date.UTC rolls it over).
    const end = chicagoInstant(overnight ? addDays(day, 1) : day, s.end_hour);
    if (t >= start.getTime() && t < end.getTime()) {
      return { day, starts_at: start.toISOString(), ends_at: end.toISOString() };
    }
  }
  return { day: null, starts_at: null, ends_at: null };
}

/** What the header button reads. */
export interface AfterHoursState {
  /** A shift is running for this person now: the button shows. */
  on_call: boolean;
  /** The day of that shift (YYYY-MM-DD), else null. */
  shift_day: string | null;
  /** When the shift ends (the button goes away), else null. */
  ends_at: string | null;
  /** The wide view is on: every work order they may open. On by default
      during a shift; a press turns it off until the next press. */
  wide: boolean;
}

export const AFTER_HOURS_OFF: AfterHoursState = { on_call: false, shift_day: null, ends_at: null, wide: false };

/**
 * The wide view during a shift: on, unless the person's latest press made
 * during THIS shift turned it off. `lastPress` is that press (null = none).
 */
export function afterHoursWide(onCall: boolean, lastPress: 'opened' | 'closed' | null): boolean {
  return onCall && lastPress !== 'closed';
}

/** "12 AM to 3 PM" for the settings card. */
export function hourLabel(h: number): string {
  const x = ((h % 24) + 24) % 24;
  if (x === 0) return '12 AM';
  if (x === 12) return '12 PM';
  return x < 12 ? `${x} AM` : `${x - 12} PM`;
}
