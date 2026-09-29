/* 0055 — Client Updates, the pure half. The database half
 * (services/clientUpdates.ts) runs the list and sends the mail; these pin the
 * decisions that, wrong, would show a client the wrong rows or the wrong
 * columns, or email them at 3am: how a chart click narrows an "any of"
 * filter, when a schedule next fires across daylight saving, which pasted
 * addresses are real, how a cell reads in the email, and that the email
 * escapes what our team typed.
 */

import { describe, it, expect } from 'vitest';
import {
  AGE_BANDS,
  ageBandOf,
  andFilters,
  bucketRule,
  describeSchedule,
  formatClientValue,
  isShareTokenShape,
  nextRunAt,
  parseRecipients,
  shareLinkLive,
  sharedColumns,
  trackerFilters,
  zonedTimeToUtc,
  DEFAULT_CLIENT_UPDATE_COLUMNS,
  type ClientUpdateSchedule,
} from '../packages/shared/src/clientUpdates';
import { buildClientUpdateEmail, escapeHtml, sectionRows } from '../apps/api/src/lib/clientUpdateEmail';

describe('combining a tracker filter with a drill', () => {
  const x = { field: 'status', op: 'eq' as const, value: 'Waiting for Approval' };

  it('ANDs onto an all-of filter as one group', () => {
    const out = andFilters({ match: 'all', rules: [{ field: 'trade', op: 'eq', value: 'HVAC' }] }, [x]);
    expect(out).toEqual({ match: 'all', rules: [{ field: 'trade', op: 'eq', value: 'HVAC' }, x] });
  });

  it('distributes over an any-of filter: (a OR b) AND x = (a AND x) OR (b AND x)', () => {
    const a = { field: 'trade', op: 'eq' as const, value: 'HVAC' };
    const b = { field: 'trade', op: 'eq' as const, value: 'Plumbing' };
    const out = andFilters({ match: 'any', rules: [a, b] }, [x]);
    expect(out.rules).toEqual([a, { ...x, join: 'and' }, { ...b, join: 'or' }, { ...x, join: 'and' }]);
  });

  it('keeps explicit join groups and appends the drill to each', () => {
    const a = { field: 'trade', op: 'eq' as const, value: 'HVAC' };
    const b = { field: 'nte', op: 'gt' as const, value: 1000, join: 'and' as const };
    const c = { field: 'trade', op: 'eq' as const, value: 'Roofing', join: 'or' as const };
    const out = andFilters({ match: 'all', rules: [a, b, c] }, [x]);
    expect(out.rules.map((r) => [r.field, r.join ?? null])).toEqual([
      ['trade', null], ['nte', 'and'], ['status', 'and'],
      ['trade', 'or'], ['status', 'and'],
    ]);
  });

  it('an empty tracker filter is just the drill; no drill leaves the filter alone', () => {
    expect(andFilters(null, [x])).toEqual({ match: 'all', rules: [x] });
    const f = { match: 'any' as const, rules: [x] };
    expect(andFilters(f, [])).toEqual(f);
  });

  it('adds the client first, then the drill', () => {
    const out = trackerFilters({ client: ' SUN Holdings ', filters: { match: 'all', rules: [] } }, [bucketRule('trade', null)]);
    expect(out.rules).toEqual([
      { field: 'client', op: 'eq', value: 'SUN Holdings' },
      { field: 'trade', op: 'is_not_set' },
    ]);
  });
});

describe('schedules run on Chicago time', () => {
  const weekly: ClientUpdateSchedule = { enabled: true, frequency: 'weekly', weekdays: [1], day_of_month: 1, time: '08:00' };

  it('8:00 on a Monday is 13:00 UTC in summer and 14:00 UTC in winter', () => {
    // Tue 2026-09-29 → next Monday 2026-10-05 (CDT, UTC-5).
    expect(nextRunAt(weekly, new Date('2026-09-29T15:00:00Z'))?.toISOString()).toBe('2026-10-05T13:00:00.000Z');
    // After DST ends (Nov 1): Monday 2026-11-02 (CST, UTC-6).
    expect(nextRunAt(weekly, new Date('2026-10-28T15:00:00Z'))?.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('is strictly after: at the exact minute it moves to the next occurrence', () => {
    const daily: ClientUpdateSchedule = { ...weekly, frequency: 'daily' };
    expect(nextRunAt(daily, new Date('2026-09-29T13:00:00Z'))?.toISOString()).toBe('2026-09-30T13:00:00.000Z');
    expect(nextRunAt(daily, new Date('2026-09-29T12:59:00Z'))?.toISOString()).toBe('2026-09-29T13:00:00.000Z');
  });

  it('weekdays skips the weekend', () => {
    const wd: ClientUpdateSchedule = { ...weekly, frequency: 'weekdays', time: '17:30' };
    // Fri 2026-10-02 after 17:30 CT → Mon 2026-10-05 17:30 CDT = 22:30Z.
    expect(nextRunAt(wd, new Date('2026-10-02T23:00:00Z'))?.toISOString()).toBe('2026-10-05T22:30:00.000Z');
  });

  it('monthly fires on its day, and off / malformed never fires', () => {
    const m: ClientUpdateSchedule = { ...weekly, frequency: 'monthly', day_of_month: 1 };
    expect(nextRunAt(m, new Date('2026-09-29T15:00:00Z'))?.toISOString()).toBe('2026-10-01T13:00:00.000Z');
    expect(nextRunAt({ ...weekly, enabled: false }, new Date())).toBeNull();
    expect(nextRunAt({ ...weekly, time: '25:00' }, new Date())).toBeNull();
    expect(nextRunAt(null, new Date())).toBeNull();
  });

  it('converts a wall-clock time across the spring gap without drifting', () => {
    expect(zonedTimeToUtc(2026, 3, 9, 8, 0, 'America/Chicago').toISOString()).toBe('2026-03-09T13:00:00.000Z');
    expect(zonedTimeToUtc(2026, 1, 15, 8, 0, 'America/Chicago').toISOString()).toBe('2026-01-15T14:00:00.000Z');
  });

  it('reads back in words', () => {
    expect(describeSchedule(weekly)).toBe('Every Mon at 8:00 AM CT');
    expect(describeSchedule({ ...weekly, enabled: false })).toBe('Not scheduled');
  });
});

describe('recipients', () => {
  it('parses pasted lists, names, duplicates and junk', () => {
    const { recipients, invalid } = parseRecipients(
      'Ann Lee <ann@sunholdings.com>, bob@sunholdings.com; BOB@sunholdings.com\nnot-an-email, mailto:carol@x.io',
    );
    expect(recipients).toEqual([
      { email: 'ann@sunholdings.com', name: 'Ann Lee' },
      { email: 'bob@sunholdings.com', name: null },
      { email: 'carol@x.io', name: null },
    ]);
    expect(invalid).toEqual(['not-an-email']);
  });
});

describe('what the client sees', () => {
  it('only the shared columns travel', () => {
    const shared = sharedColumns(DEFAULT_CLIENT_UPDATE_COLUMNS).map((c) => c.key);
    expect(shared).not.toContain('fields.34. Cost');
    expect(shared).not.toContain('wo_number');
    expect(shared[0]).toBe('ext_name');
  });

  it('formats cells the way the sheet did', () => {
    expect(formatClientValue(5724.09, 'money')).toBe('$5,724.09');
    expect(formatClientValue('1000', 'money')).toBe('$1,000.00');
    expect(formatClientValue('2026-06-12', 'date')).toBe('06/12/2026');
    expect(formatClientValue('2026-07-21T14:30:00', 'datetime')).toBe('07/21/2026');
    expect(formatClientValue('true', 'boolean')).toBe('Yes');
    expect(formatClientValue(null, 'text')).toBe('');
    expect(formatClientValue(1, 'number', 'age_days')).toBe('1 day');
    expect(formatClientValue(45, 'number', 'age_days')).toBe('45 days');
  });

  it('bands ages youngest to oldest', () => {
    expect([0, 7, 8, 14, 15, 30, 31, 60, 61].map(ageBandOf)).toEqual([
      AGE_BANDS[0], AGE_BANDS[0], AGE_BANDS[1], AGE_BANDS[1], AGE_BANDS[2], AGE_BANDS[2], AGE_BANDS[3], AGE_BANDS[3], AGE_BANDS[4],
    ]);
    expect(ageBandOf(null)).toBeNull();
  });
});

describe('the read-only link', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const token = 'abcdefghijklmnopqrstuvwxyz012345';

  it('accepts only a 32-character url-safe token', () => {
    expect(isShareTokenShape(token)).toBe(true);
    expect(isShareTokenShape(token.slice(1))).toBe(false);
    expect(isShareTokenShape(token.slice(1) + '/')).toBe(false);
  });

  it('is live only while on, with a token, before its expiry', () => {
    expect(shareLinkLive({ enabled: true, token, expires_at: null }, now)).toBe(true);
    expect(shareLinkLive({ enabled: false, token, expires_at: null }, now)).toBe(false);
    expect(shareLinkLive({ enabled: true, token: null, expires_at: null }, now)).toBe(false);
    expect(shareLinkLive({ enabled: true, token, expires_at: '2026-09-29T11:59:59Z' }, now)).toBe(false);
    expect(shareLinkLive({ enabled: true, token, expires_at: '2026-10-29T00:00:00Z' }, now)).toBe(true);
  });
});

describe('the email', () => {
  it('sections rows by the group column in first-seen order', () => {
    const rows = [['A', 'Open'], ['B', 'Waiting'], ['C', 'Open'], ['D', '']];
    expect(sectionRows(rows, 1).map((s) => [s.title, s.rows.length])).toEqual([
      ['Open', 2], ['Waiting', 1], ['(not set)', 1],
    ]);
    expect(sectionRows(rows, null)).toEqual([{ title: null, rows }]);
  });

  it('escapes everything our team typed', () => {
    const { html, text } = buildClientUpdateEmail({
      trackerName: 'Tracking',
      client: 'SUN <Holdings>',
      intro: 'Hi <b>team</b>\nline two',
      generatedAt: new Date('2026-09-29T13:00:00Z'),
      headers: ['WO #', 'Client Notes'],
      sections: [{ title: 'Waiting for Approval', rows: [['SUN-1', '<script>alert(1)</script>']] }],
      rowCount: 1,
      truncated: false,
      summary: [{ label: 'Open', value: '1' }],
      charts: [{ label: 'Status', total: 1, buckets: [{ label: 'Waiting', n: 1 }] }],
      link: 'https://example.com/share/client-updates/x?a=1&b=2',
      fromName: 'Seamless FM',
      fromAddress: 'contact@seamlessfm.com',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('SUN &lt;Holdings&gt;');
    expect(html).toContain('Hi &lt;b&gt;team&lt;/b&gt;<br>line two');
    expect(html).toContain('href="https://example.com/share/client-updates/x?a=1&amp;b=2"');
    expect(html).toContain('contact@seamlessfm.com');
    expect(text).toContain('== Waiting for Approval (1) ==');
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });

  it('says so when nothing matches', () => {
    const { html } = buildClientUpdateEmail({
      trackerName: 'T', client: null, intro: null, generatedAt: new Date(), headers: ['WO #'],
      sections: [{ title: null, rows: [] }], rowCount: 0, truncated: false, summary: null, charts: [],
      link: null, fromName: 'Seamless FM', fromAddress: 'contact@seamlessfm.com',
    });
    expect(html).toContain('No work orders match');
    expect(html).not.toContain('Open the live tracker');
  });
});
