/**
 * Notifications and approvals follow the people on the job; After hours shows
 * the rest and is logged; quotes due 48 working hours after Waiting for Quote
 * are reminded (Elise, 2026-11-16).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSIGNED_SEAT_KEYS,
  NOTICE_KINDS_ALWAYS_SHOWN,
  NOTICE_TYPES,
  QUOTE_DUE_AFTER_HOURS,
  QUOTE_DUE_NOTICE_KIND,
  isAssignedTo,
  quoteDueNoticeTitle,
  quoteDueState,
  QUOTE_DUE_ROLE_CODES,
  QUOTE_DUE_SEAT_KEYS,
} from '@theone/shared';
import { assignedToSql } from '../apps/api/src/services/woScope';
import { woNumberOfLink } from '../apps/api/src/services/notices';
import { addWorkingHours, wallStamp } from '../apps/api/src/lib/businessDays';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('who is on the job', () => {
  it('any assigned seat counts, names matched without case or spaces', () => {
    expect(ASSIGNED_SEAT_KEYS).toEqual(['Assignee', 'Support Trainee', 'TL', 'ATL', 'AM', 'Completion Assignee']);
    expect(isAssignedTo({ Assignee: 'Ana Ruiz, Bo Li' }, ' bo li ')).toBe(true);
    expect(isAssignedTo({ TL: 'Jordan Brown' }, 'Jordan Brown')).toBe(true);
    expect(isAssignedTo({ AM: 'Kim' }, 'Kim')).toBe(true);
    expect(isAssignedTo({ 'Completion Assignee': 'Rae' }, 'rae')).toBe(true);
    expect(isAssignedTo({ Assignee: 'Ana Ruiz' }, 'Bo Li')).toBe(false);
    expect(isAssignedTo({}, 'Bo Li')).toBe(false);
    expect(isAssignedTo({ Assignee: 'Ana' }, '')).toBe(false);
  });

  it('the legacy Assignee Name TXT counts only while the Assignee is blank', () => {
    expect(isAssignedTo({ 'Assignee Name TXT': 'Bo Li' }, 'Bo Li')).toBe(true);
    expect(isAssignedTo({ Assignee: 'Ana', 'Assignee Name TXT': 'Bo Li' }, 'Bo Li')).toBe(false);
  });

  it('the SQL asks the same seats as the pure twin', () => {
    const sql = assignedToSql('$1');
    for (const k of ASSIGNED_SEAT_KEYS) expect(sql).toContain(`'${k}'`);
    expect(sql).toContain("'Assignee Name TXT'");
  });

  it('a mention and the answer to your own request always show', () => {
    expect([...NOTICE_KINDS_ALWAYS_SHOWN].sort()).toEqual(['approval_reminder', 'payment_rejected', 'quote_due', 'request_decided', 'wo_mention']);
  });
});

describe('a notice knows its work order', () => {
  it('reads the WO # off every link shape notify() is given', () => {
    expect(woNumberOfLink('/work-orders/WO-12')).toBe('WO-12');
    expect(woNumberOfLink('/work-orders/WO-12?tab=messages&msg=x')).toBe('WO-12');
    expect(woNumberOfLink('/work-orders/WO-12#top')).toBe('WO-12');
    expect(woNumberOfLink('/work-orders/ECO%20123?tab=quotes')).toBe('ECO 123');
    expect(woNumberOfLink('/vendors/abc')).toBeNull();
    expect(woNumberOfLink(null)).toBeNull();
  });

  it('notify() stores task_id, and 0144 adds and back-fills it', () => {
    const svc = read('apps/api/src/services/notices.ts');
    expect(svc).toContain('INSERT INTO app_notice (principal_id, kind, title, body, link, actor_id, dedupe_key, task_id)');
    expect(svc).toContain('woNumberOfLink(n.link)');
    const mig = read('packages/db/migrations/0144_notice_task.sql');
    expect(mig).toContain('ADD COLUMN IF NOT EXISTS task_id uuid');
    expect(mig).toMatch(/UPDATE app_notice n\s+SET task_id = t.id/);
    expect(mig).not.toMatch(/REFERENCES task/);
  });
});

describe('the inbox and the badge', () => {
  const svc = read('apps/api/src/services/notices.ts');
  it('both halves of the inbox (notices and Pulse pings) ask who is on the job', () => {
    const cte = svc.slice(svc.indexOf('const INBOX_CTE'), svc.indexOf('export interface InboxOptions'));
    expect(cte.match(/\$\{ON_THE_JOB\('t'\)\}/g)?.length).toBe(2);
    expect(cte).toContain('n.task_id IS NULL OR t.id IS NULL OR n.kind IN (${ALWAYS_SHOWN})');
    expect(svc).toContain('const base: unknown[] = [principalId, o.withPulse, o.allWorkOrders, o.name];');
  });
  it('the badge counts what the page shows by default (wide while on call, 2026-11-17)', () => {
    expect(svc).toContain('[principalId, withPulse, allWorkOrders, name],');
    expect(read('apps/api/src/routes/notices.ts')).toContain('me.afterHoursWide === true');
  });
});

describe('After hours', () => {
  it('the wide view is decided on the server, from the on-call shift and the logged presses', () => {
    const notices = read('apps/api/src/routes/notices.ts');
    expect(notices).toContain('const all = me.afterHoursWide === true;');
    const approvals = read('apps/api/src/routes/approvals.ts');
    expect(approvals).toContain('listApprovalTasks(actor, 500, { allWorkOrders: actor.afterHoursWide === true })');
    const svc = read('apps/api/src/services/afterHours.ts');
    expect(svc).toContain("action: on ? 'after_hours_opened' : 'after_hours_closed'");
    expect(svc).toContain('entity: ENTITY');
    expect(read('apps/api/src/services/auth.ts')).toContain('afterHoursWide: await afterHoursWideFor(actingAs)');
  });

  it('approvals: acceptances and your own requests are never narrowed; the badge counts your jobs', () => {
    const svc = read('apps/api/src/services/approvals.ts');
    expect(svc).toContain("AND (a.type = 'wo_acceptance' OR a.created_by = ${p.add(viewer.id)} OR ${assignedToSql(p.add(viewer.name), 't')})");
    expect(svc).toContain("${opts.allWorkOrders ? '' : onTheJobSql(viewer, p)}");
    expect(svc).toContain('if (viewer.afterHoursWide) return');
    expect(svc).toContain('const moneyScope = woScopeSql({ ...viewer, assignedOnly: true }, qp);');
  });

  it('the quotes, payments, purchases and NTE-increase queues take ?assigned=1, lifted while wide', () => {
    for (const f of ['quotes', 'payments', 'purchasing', 'woRecord']) {
      expect(read(`apps/api/src/routes/${f}.ts`), f).toContain('withAssignedOnly(');
    }
    const scope = read('apps/api/src/services/woScope.ts');
    expect(scope).toContain('if (!actor.assignedOnly || actor.afterHoursWide) return base;');
    expect(scope).toContain('if (scope.all || actor.afterHoursWide) return sites;');
  });

  it('one button in the header, none on the pages; the audit log names the action', () => {
    expect(read('apps/web/src/components/AppShell.tsx')).toContain('<AfterHoursButton />');
    expect(read('apps/web/src/pages/NotificationsPage.tsx')).not.toContain('<AfterHoursToggle');
    expect(read('apps/web/src/pages/ApprovalsPage.tsx')).not.toContain('<AfterHoursToggle');
    expect(read('apps/web/src/lib/auditFormat.ts')).toContain("after_hours_opened: 'After hours: all work orders'");
  });
});

describe('quotes due', () => {
  it('is a notice type of its own', () => {
    expect(NOTICE_TYPES[QUOTE_DUE_NOTICE_KIND]).toEqual({ label: 'Quotes due', group: 'work_orders' });
  });

  it('48 working hours: Monday 10:00 → Wednesday; Friday 10:00 → Tuesday', () => {
    expect(QUOTE_DUE_AFTER_HOURS).toBe(48);
    // 2026-11-16 is a Monday; 16:00Z is 10:00 in Chicago.
    expect(wallStamp(addWorkingHours(new Date('2026-11-16T16:00:00Z'), 48, []))).toBe('2026-11-18T10:00');
    expect(wallStamp(addWorkingHours(new Date('2026-11-20T16:00:00Z'), 48, []))).toBe('2026-11-24T10:00');
    // Thanksgiving skipped when it is on the holiday table.
    expect(wallStamp(addWorkingHours(new Date('2026-11-25T16:00:00Z'), 48, ['2026-11-26']))).toBe('2026-11-30T10:00');
  });

  it('due today on the day, overdue after, nothing before', () => {
    expect(quoteDueState('2026-11-18', '2026-11-17')).toBe('not_yet');
    expect(quoteDueState('2026-11-18', '2026-11-18')).toBe('due_today');
    expect(quoteDueState('2026-11-18', '2026-11-19')).toBe('overdue');
    expect(quoteDueNoticeTitle('WO-9', 'due_today', '2026-11-18')).toBe('Quote due today on WO-9');
    expect(quoteDueNoticeTitle('WO-9', 'overdue', '2026-11-18')).toBe('Quote overdue on WO-9 (was due Nov 18)');
  });

  it('one reminder per work order per day, to its OM, TL, ATL and every OP Admin, while no quote is on its way', () => {
    expect([...QUOTE_DUE_SEAT_KEYS]).toEqual(['Assignee', 'TL', 'ATL']);
    expect([...QUOTE_DUE_ROLE_CODES]).toEqual(['oa']);
    expect(NOTICE_KINDS_ALWAYS_SHOWN).toContain('quote_due');
    const svc = read('apps/api/src/services/notices.ts');
    expect(svc).toContain('dedupeKey: `quote_due:${r.task_id}:${r.entered_at.getTime()}:${today}`');
    expect(svc).toContain("q.status IN ('pending_correction', 'pending_approval', 'approved', 'sent', 'client_approved')");
    expect(svc).toContain("unnest(ARRAY[${QUOTE_DUE_SEAT_SQL}]) AS seat(k)");
    expect(svc).toContain('OR p.role = ANY($2::text[])');
    expect(read('apps/api/src/routes/webhooks.ts')).toContain('await raiseQuoteDueNotifications(true)');
  });
});
