/* UAT 2026-11-16 · #48 Send reminder to managers, #6 the NTE increase notice
   opens where it is decided, #39 Create paints what is missing, #29 the quote
   rail order. Pure functions and source-text pins; no database. */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_REMINDER_COOLDOWN_MINUTES,
  APPROVAL_REMINDER_NOTICE_KIND,
  approvalReminderTitle,
  mayRemindApprovals,
  nextReminderAt,
} from '../packages/shared/src/approvalReminders';
import { NOTICE_KINDS_ALWAYS_SHOWN, NOTICE_TYPES, noticeOpenLink, nteRequestsLink } from '../packages/shared/src/notices';

const ROOT = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

describe('#48 reminders to managers', () => {
  it('the dispatchers and the OP Admin send them; a super admin always may', () => {
    for (const r of ['om_probation', 'om', 'senior_om', 'oa']) expect(mayRemindApprovals(r, false)).toBe(true);
    for (const r of ['tl', 'atl', 'am', 'admin', 'ar', null]) expect(mayRemindApprovals(r, false)).toBe(false);
    expect(mayRemindApprovals('tl', true)).toBe(true);
  });
  it('one reminder per approval per hour', () => {
    const now = new Date('2026-11-16T12:00:00Z');
    expect(nextReminderAt(null, now)).toBeNull();
    expect(nextReminderAt('2026-11-16T11:30:00Z', now)).toBe('2026-11-16T12:30:00.000Z');
    expect(nextReminderAt(new Date(now.getTime() - APPROVAL_REMINDER_COOLDOWN_MINUTES * 60_000).toISOString(), now)).toBeNull();
  });
  it('is a notice type that always shows, named for the approval', () => {
    expect(NOTICE_TYPES[APPROVAL_REMINDER_NOTICE_KIND]?.group).toBe('approvals');
    expect(NOTICE_KINDS_ALWAYS_SHOWN).toContain(APPROVAL_REMINDER_NOTICE_KIND);
    expect(approvalReminderTitle('Sam', 'NTE increase to $900.00', 'WO-1')).toBe(
      'Sam reminds you: NTE increase to $900.00 on WO-1 is waiting for your decision',
    );
  });
  it('the API checks the sender, the cool-down, logs the reminder and leaves intake out', () => {
    const src = read('apps/api/src/services/approvalReminders.ts');
    expect(src).toContain("throw forbidden('Reminders are sent by the dispatchers and the OP Admin')");
    expect(src).toContain("code: 'REMINDER_TOO_SOON'");
    expect(src).toContain("a.type <> 'wo_acceptance'");
    expect(src).toContain('APPROVAL_REMINDER_ACTION');
    const routes = read('apps/api/src/routes/workOrders.ts');
    expect(routes).toContain("app.get('/work-orders/:id/pending-approvals'");
    expect(routes).toContain("app.post('/work-orders/:id/approval-reminders'");
  });
  it('the header draws Send reminder', () => {
    expect(read('apps/web/src/components/wo/WoHeader.tsx')).toContain('<ApprovalReminderButton woId={wo.id} woNumber={wo.wo_number} />');
  });
});

describe('#6 the NTE increase notice opens Approvals › NTE increase requests', () => {
  it('new notices link there', () => {
    expect(nteRequestsLink('WO 7')).toBe('/approvals?view=nte-requests&wo=WO%207');
    expect(read('apps/api/src/services/woRecord.ts')).toContain('link: nteRequestsLink(t.wo_number),');
  });
  it('old notices on file are sent there too', () => {
    expect(noticeOpenLink('nte_increase', '/work-orders/WO%207?tab=costs')).toBe('/approvals?view=nte-requests&wo=WO%207');
    expect(noticeOpenLink('wo_assigned', '/work-orders/WO-7?tab=costs')).toBe('/work-orders/WO-7?tab=costs');
    expect(noticeOpenLink('nte_increase', 'https://elsewhere')).toBeNull();
  });
  it('the Approvals page opens the lane from the link', () => {
    expect(read('apps/web/src/pages/ApprovalsPage.tsx')).toContain("searchParams.get('view') === 'nte-requests'");
  });
});

describe('#39 Add work order: Create shows what is missing', () => {
  const src = read('apps/web/src/components/wo/list/CreateWorkOrderDialog.tsx');
  it('a click with fields missing paints them red instead of creating', () => {
    expect(src).toContain('setTriedCreate(true)');
    expect(src).toContain("isFlagged(f.key) ? ' is-missing' : ''");
    expect(src).toContain('onClick={tryCreate}');
  });
  it('hovering a blocked Create lists them', () => {
    expect(src).toContain('Still needed before you can create:');
  });
});

describe('#29 the quote rail reads Money · Labor rates · Document', () => {
  it('in that order', () => {
    const src = read('apps/web/src/pages/QuoteBuilderPage.tsx');
    const money = src.indexOf('<MoneyRail');
    const labor = src.indexOf('Labor rate card</h2>');
    const doc = src.indexOf('>Document</h2>');
    expect(money).toBeGreaterThan(0);
    expect(labor).toBeGreaterThan(money);
    expect(doc).toBeGreaterThan(labor);
  });
});
