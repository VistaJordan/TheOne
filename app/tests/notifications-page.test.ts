/**
 * The Notifications page (Elise, 2026-11-04): the sidebar inbox that replaced
 * the bell. Pins the type vocabulary (every kind `notify()` raises has a name
 * and a group, so nothing new lands under "Other" unnoticed), the day bands,
 * the cursor, and the wiring: the sidebar item, the route, no bell.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MENTION_NOTICE_KIND,
  NOTICE_TYPES,
  PULSE_RULE_LABELS,
  WO_ASSIGNED_NOTICE_KIND,
  kindsInGroup,
  noticeCursor,
  noticeDayBand,
  noticeType,
  parseNoticeCursor,
} from '@theone/shared';

const root = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

/** The literal kinds handed to notify() across the API's services. */
function raisedKinds(): string[] {
  const dir = join(root, 'apps', 'api', 'src', 'services');
  const kinds = new Set<string>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    let at = src.indexOf('await notify(');
    while (at !== -1) {
      const m = src.slice(at, at + 600).match(/kind:\s*'([a-z_]+)'/);
      if (m) kinds.add(m[1]);
      at = src.indexOf('await notify(', at + 1);
    }
  }
  return [...kinds];
}

describe('notice types', () => {
  it('every kind notify() raises has a name and a group', () => {
    const kinds = [...raisedKinds(), WO_ASSIGNED_NOTICE_KIND, MENTION_NOTICE_KIND, 'vendor_expiry'];
    expect(kinds.length).toBeGreaterThan(10);
    for (const k of kinds) expect(NOTICE_TYPES[k], `kind "${k}" — add it to NOTICE_TYPES`).toBeDefined();
  });

  it('a Pulse ping is typed by its rule; an unknown kind falls under Other, tidied', () => {
    expect(noticeType('pulse.quote_owed')).toEqual({ kind: 'pulse.quote_owed', label: PULSE_RULE_LABELS.quote_owed, group: 'pulse' });
    expect(noticeType('something_new')).toEqual({ kind: 'something_new', label: 'Something new', group: 'other' });
    expect(kindsInGroup('pulse', ['wo_mention', 'pulse.sla_blown'])).toEqual(['pulse.sla_blown']);
  });

  it('the Pulse page and the inbox share one set of rule names', () => {
    expect(read('apps', 'web', 'src', 'lib', 'obligations.ts')).toMatch(/const RULE_FULL_LABEL: Record<string, string> = PULSE_RULE_LABELS;/);
  });
});

describe('day bands and the cursor', () => {
  const now = new Date(2026, 10, 4, 15, 0);
  it('bands on the viewer’s own calendar', () => {
    expect(noticeDayBand(new Date(2026, 10, 4, 0, 5).toISOString(), now)).toBe('Today');
    expect(noticeDayBand(new Date(2026, 10, 3, 23, 59).toISOString(), now)).toBe('Yesterday');
    expect(noticeDayBand(new Date(2026, 10, 1, 12).toISOString(), now)).toBe('Earlier this week');
    expect(noticeDayBand(new Date(2026, 9, 20).toISOString(), now)).toBe('Earlier');
  });

  it('round-trips, microseconds included, and refuses anything else', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const c = noticeCursor({ created_at: '2026-11-04T12:00:00.123456Z', source: 'pulse', id });
    expect(parseNoticeCursor(c)).toEqual({ at: '2026-11-04T12:00:00.123456Z', key: `pulse:${id}` });
    expect(parseNoticeCursor('nonsense')).toBeNull();
    expect(parseNoticeCursor(`2026-11-04T12:00:00Z|other:${id}`)).toBeNull();
    expect(parseNoticeCursor(`2026-11-04T12:00:00Z|notice:1; DROP TABLE x`)).toBeNull();
  });
});

describe('wiring', () => {
  it('the sidebar has Notifications with its unread badge, and the top bar has no bell', () => {
    const shell = read('apps', 'web', 'src', 'components', 'AppShell.tsx');
    expect(shell).toMatch(/\{ label: 'Notifications', icon: 'bell', to: '\/notifications', badge: 'notifications' \}/);
    expect(shell).not.toMatch(/PulseBell/);
    expect(shell).not.toMatch(/Notifications:/); // no NAV_PERM entry: everyone's own
  });

  it('the route is behind sign-in only', () => {
    expect(read('apps', 'web', 'src', 'App.tsx')).toMatch(/<Route path="\/notifications" element=\{<RequireAuth><NotificationsPage \/><\/RequireAuth>\} \/>/);
  });

  it('every inbox route reads the acting person’s own rows', () => {
    const routes = read('apps', 'api', 'src', 'routes', 'notices.ts');
    for (const path of ['/notices/inbox', '/notices/count', '/notices/mark']) expect(routes).toContain(`'${path}'`);
    expect(routes).not.toMatch(/principal_id|principalId:/);
    const svc = read('apps', 'api', 'src', 'services', 'notices.ts');
    // Mark unread is read_at back to NULL, only on rows whose state differs, and only the person's.
    expect(svc).toMatch(/const set = input\.read \? 'now\(\)' : 'NULL';/);
    expect(svc).toMatch(/UPDATE app_notice SET read_at = \$\{set\} WHERE principal_id = \$1 AND id = ANY/);
    expect(svc).toMatch(/UPDATE notification SET read_at = \$\{set\} WHERE principal_id = \$1 AND id = ANY/);
  });
});
