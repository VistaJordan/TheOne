/* Elise, 2026-10-30 — "we should receive a notification when someone assigns
 * a work order to us". The person ADDED to a work order's Assignee seat gets
 * a bell notice, whichever path assigned it (every path reports to
 * dispatchAutomations after its commit); the assigner is never told about
 * their own act; one notice per assignment (dedupe key = the audit row).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WO_ASSIGNED_NOTICE_KIND, assignedNoticeTitle } from '../packages/shared/src/index';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('assigned to you', () => {
  it('says who assigned it, or that it was assigned', () => {
    expect(WO_ASSIGNED_NOTICE_KIND).toBe('wo_assigned');
    expect(assignedNoticeTitle('WO-1234', 'Josh Ramirez')).toBe('Josh Ramirez assigned you WO-1234');
    expect(assignedNoticeTitle('WO-1234', null)).toBe('WO-1234 was assigned to you');
    expect(assignedNoticeTitle('WO-1234', '  ')).toBe('WO-1234 was assigned to you');
  });

  it('runs on every write path, after the commit', () => {
    const auto = read('apps/api/src/services/automations.ts');
    expect(auto).toContain("const { notifyAssignment } = await import('./assignmentNotices.js');");
    expect(auto).toContain('await notifyAssignment(event);');
  });

  it('tells only the names added, once per assignment, never the assigner', () => {
    const src = read('apps/api/src/services/assignmentNotices.ts');
    expect(src).toContain('addedAssignees(seat.before, seat.after)');
    expect(src).toContain('actorId: row.actor_id');
    expect(src).toContain('dedupeKey: `${WO_ASSIGNED_NOTICE_KIND}:${event.taskId}:${row.id}`');
    expect(src).toContain('link: `/work-orders/${encodeURIComponent(row.wo_number)}`');
    const notices = read('apps/api/src/services/notices.ts');
    expect(notices).toContain('ON CONFLICT (principal_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,\n      [to, n.kind');
  });
});
