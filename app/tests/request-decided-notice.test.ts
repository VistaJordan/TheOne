/**
 * Request decisions in Notifications (Elise, 2026-11-14): when a manager
 * approves or rejects an approval task, the requester and the work order's
 * assigned dispatcher(s) get a `request_decided` notice.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTICE_TYPES, REQUEST_DECIDED_NOTICE_KIND, requestDecidedNoticeTitle } from '@theone/shared';

const root = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

describe('request decision notices', () => {
  it('is a named type in the Approvals & requests group', () => {
    expect(NOTICE_TYPES[REQUEST_DECIDED_NOTICE_KIND]).toEqual({ label: 'Request decisions', group: 'approvals' });
  });

  it('titles the decision with the type, the WO # and who decided', () => {
    expect(requestDecidedNoticeTitle('Status change', 'approved', 'WO-12', 'Jordan')).toBe(
      'Status change approved on WO-12 by Jordan',
    );
    expect(requestDecidedNoticeTitle('Snooze request', 'rejected', 'WO-12', null)).toBe('Snooze request rejected on WO-12');
  });

  it('decide() tells the requester and the Assignee seat after the commit', () => {
    const approvals = read('apps/api/src/services/approvals.ts');
    expect(approvals).toMatch(/notifyRequestDecided\(decided, to, note/);
    const svc = read('apps/api/src/services/requestNotices.ts');
    expect(svc).toMatch(/task\.type === 'wo_acceptance'\) return/);
    expect(svc).toMatch(/fields->>\$2 AS assignee/);
    expect(svc).toMatch(/\[requester, \.\.\.seat\.rows/);
    expect(svc).toMatch(/dedupeKey: `\$\{REQUEST_DECIDED_NOTICE_KIND\}:\$\{task\.id\}`/);
  });
});
