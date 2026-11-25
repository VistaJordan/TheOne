/**
 * On call and After hours in the header (Elise, 2026-11-17, migration 0155):
 * the Google Sheet is read loosely (a date or a start / end date, then names),
 * a shift runs start_hour → end_hour Chicago on its day, and the wide view is
 * on by default during it. Plus #35: the AM's approval of a payment above the
 * NTE also settles the over-quote (negative margin) hold. Hermetic.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ON_CALL_DEFAULT_SETTINGS,
  afterHoursWide,
  chicagoInstant,
  onCallShiftNow,
  parseOnCallSheet,
  parseSheetDate,
  parseSheetRef,
} from '@theone/shared';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('reading the sheet', () => {
  it('reads the usual date spellings', () => {
    expect(parseSheetDate('2026-11-17')).toBe('2026-11-17');
    expect(parseSheetDate('11/17/2026')).toBe('2026-11-17');
    expect(parseSheetDate('11/17/26')).toBe('2026-11-17');
    expect(parseSheetDate('Nov 17, 2026')).toBe('2026-11-17');
    expect(parseSheetDate('Monday, November 17, 2026')).toBe('2026-11-17');
    expect(parseSheetDate('17 Nov 2026')).toBe('2026-11-17');
    expect(parseSheetDate('11/17', 2026)).toBe('2026-11-17');
    expect(parseSheetDate('Jordan Brown')).toBeNull();
    expect(parseSheetDate('2/30/2026')).toBeNull();
  });

  it('takes a pasted link or a bare id', () => {
    expect(parseSheetRef('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=123')).toEqual({
      sheet_id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      gid: '123',
    });
    expect(parseSheetRef('not a link').sheet_id).toBeNull();
  });

  it('matches the on-call roles only (not AR); spans a start – end row; reports the rest', () => {
    const people = [
      { id: 'a', name: 'Jordan Brown', email: 'jordanb@byblosvista.com', role: 'am' },
      { id: 'b', name: 'Jeff Soren', email: null, role: 'tl' },
      { id: 'c', name: 'Jack Smith', email: null, role: 'atl' },
      { id: 'd', name: 'Rita Oa', email: null, role: 'oa' },
      { id: 'e', name: 'Omar Om', email: null, role: 'ar' },
    ];
    const r = parseOnCallSheet(
      [
        ['Date', 'AM', 'TL', 'ATL', 'OA'],
        ['11/17/2026', 'Jordan', 'Jeff Soren', 'Jack S.', 'Rita'],
        ['11/18/2026', 'Monday', 'Omar Om', 'Nobody Here'],
        ['11/20/2026', '11/22/2026', 'Jordan B / Jeff'],
      ],
      people,
    );
    expect(r.shifts.map((s) => `${s.day}:${s.principal_id}`).sort()).toEqual(
      [
        '2026-11-17:a', '2026-11-17:b', '2026-11-17:c', '2026-11-17:d',
        '2026-11-20:a', '2026-11-20:b', '2026-11-21:a', '2026-11-21:b', '2026-11-22:a', '2026-11-22:b',
      ].sort(),
    );
    expect(r.unmatched.map((u) => u.text)).toEqual(['Omar Om', 'Nobody Here']);
  });

  it('reads the Vista calendar: dates across, duty rows by role, the year nearest today', () => {
    const people = [
      { id: 'am1', name: 'Antonio Reyes', email: null, role: 'am' },
      { id: 'om1', name: 'Nate Cole', email: null, role: 'om' },
      { id: 'om2', name: 'John Park', email: null, role: 'senior_om' },
      { id: 'om3', name: 'Nora Diaz', email: null, role: 'om' },
      { id: 'oa1', name: 'Dean Ross', email: null, role: 'oa' },
      { id: 'pay', name: 'Lana Fox', email: null, role: 'ap' },
      // Same first name as the AM, but a dispatcher: never matched on the manager row.
      { id: 'om4', name: 'Antonio Silva', email: null, role: 'om' },
      { id: 'om5', name: 'Fady Haddad', email: null, role: 'om' },
    ];
    const blank = (n: number) => Array.from({ length: n }, () => '');
    const r = parseOnCallSheet(
      [
        ['', '', ...blank(3), '30 Dec', '31 Dec', '1 Jan'],
        ['', '', ...blank(3), 'Jordan trip', '', ''],
        ['Night Manager', '', ...blank(3), 'Antonio Reyes', 'Fady', ''],
        ['Night Dispatcher 1', '', ...blank(3), 'Nate', 'Nate', 'Antonio'],
        ['Night Dispatcher 2', '', ...blank(3), 'John', '', ''],
        ['Night Dispatcher 3', '', ...blank(3), 'Nora', '', ''],
        ['Night Dispatcher 4', '', ...blank(3), '', '', ''],
        ['Night Payer', '', ...blank(3), 'Lana', 'Lana', ''],
        ['Night Admin', '', ...blank(3), 'Dean', '', ''],
        ['', 'Bernard', ...blank(3), 'Remote', 'PTO', ''],
      ],
      people,
      2026,
      '2026-12-30',
    );
    expect(r.shifts.map((s) => `${s.day}:${s.principal_id}`).sort()).toEqual(
      ['2026-12-30:am1', '2026-12-30:om1', '2026-12-30:om2', '2026-12-30:om3', '2026-12-30:oa1', '2026-12-31:om1', '2027-01-01:om4'].sort(),
    );
    // Fady is an OM, not an AM: refused on the Night Manager row and reported.
    expect(r.unmatched.map((u) => u.text)).toEqual(['Night Manager · 2026-12-31: Fady']);
  });

  it('reads the whole tab, far past column Z', () => {
    expect(read('apps/api/src/lib/googleSheets.ts')).not.toContain('A1:Z3000');
  });
});

describe('the shift', () => {
  it('defaults to 12 AM – 3 PM Chicago', () => {
    expect(ON_CALL_DEFAULT_SETTINGS.start_hour).toBe(0);
    expect(ON_CALL_DEFAULT_SETTINGS.end_hour).toBe(15);
  });

  it('runs on its day in Chicago time, DST included', () => {
    const s = { start_hour: 0, end_hour: 15 };
    expect(chicagoInstant('2026-11-17', 0).toISOString()).toBe('2026-11-17T06:00:00.000Z');
    expect(chicagoInstant('2026-07-17', 0).toISOString()).toBe('2026-07-17T05:00:00.000Z');
    expect(onCallShiftNow(['2026-11-17'], new Date('2026-11-17T05:59:00Z'), s).day).toBeNull();
    expect(onCallShiftNow(['2026-11-17'], new Date('2026-11-17T06:30:00Z'), s).day).toBe('2026-11-17');
    expect(onCallShiftNow(['2026-11-17'], new Date('2026-11-17T20:59:00Z'), s).day).toBe('2026-11-17');
    expect(onCallShiftNow(['2026-11-17'], new Date('2026-11-17T21:00:00Z'), s).day).toBeNull();
  });

  it('an end before the start runs into the next morning', () => {
    const s = { start_hour: 18, end_hour: 8 };
    expect(onCallShiftNow(['2026-11-17'], new Date('2026-11-18T13:00:00Z'), s).day).toBe('2026-11-17');
    expect(onCallShiftNow(['2026-11-17'], new Date('2026-11-18T14:30:00Z'), s).day).toBeNull();
  });

  it('wide by default during a shift; a press during it turns it off', () => {
    expect(afterHoursWide(true, null)).toBe(true);
    expect(afterHoursWide(true, 'closed')).toBe(false);
    expect(afterHoursWide(true, 'opened')).toBe(true);
    expect(afterHoursWide(false, 'opened')).toBe(false);
  });

  it('only presses made during the running shift count', () => {
    const svc = read('apps/api/src/services/afterHours.ts');
    expect(svc).toContain("AND after ->> 'shift' = $2 AND created_at >= $3::timestamptz");
    expect(svc).toContain("after: { name: actor.name, page: 'all', shift: now.shift_day }");
  });
});

describe('#35 · the AM approves a payment far over the NTE', () => {
  it('settles the over-quote hold in the same act', () => {
    const svc = read('apps/api/src/services/payments.ts');
    expect(svc).toContain('const decidesQuote = mayDecideOverQuote(actor.role, actor.isSuperAdmin);');
    expect(svc).toContain("await assertPaymentNotHeld(row, actor, 'Approving this payment', true, decidesQuote);");
    expect(svc).toContain('if (quoteOver) await approveOverQuote(tx, row, projected, quoteOver, reason, actor);');
    expect(svc).toContain('opts.viewer && mayDecideOverQuote(opts.viewer.role, opts.viewer.isSuperAdmin) ? null : moneyHoldOf(r, quotes, true)');
  });
});
