/* Pending acceptance queue (0036, rules 7.1.1 – 7.1.4) — the pure parts.
 *
 *   7.1.1  a new work order the system created waits for a manager
 *   7.1.2  Reject → reason → "Cancelled / Postponed"
 *   7.1.3  Accept → pick the assignee by hand
 *   7.1.4  assigned → out of the queue, into that dispatcher's list
 *
 * The queue is an approval_task of type wo_acceptance in the inbox section
 * `intake`, gated by the permission path approvals/intake. These tests lock
 * the vocabulary the API and the browser share, and the permission shape
 * migration 0036 writes, without a database. */

import { describe, it, expect } from 'vitest';
import {
  ACCEPTANCE_REJECT_STATUS_NAME,
  ACCEPTANCE_SOURCE_LABEL,
  APPROVAL_SECTIONS,
  APPROVAL_TASK_LABEL,
  APPROVAL_TASK_TYPES,
  approvalSectionOf,
  approvalSectionPermKey,
} from '../packages/shared/src/index';
import { buildPermissionTree, permAllows } from '../packages/shared/src/permissions';

/** What 0036 leaves on a manager role (TL / ATL / AM / Admin) on top of 0031. */
const MANAGER_PERMS = {
  approvals: { view: true },
  'approvals/status': { view: true, approve: true },
  'approvals/intake': { view: true, approve: true },
};

/** An OM tier: the parent `approvals` grant only (view from 0020, no approve). */
const OM_PERMS = {
  approvals: { view: true, approve: false },
  'work_orders/status': { edit: false, create: true },
};

describe('pending acceptance — vocabulary', () => {
  it('wo_acceptance lives in the intake section, first in the inbox', () => {
    expect(approvalSectionOf('wo_acceptance')).toBe('intake');
    expect(approvalSectionPermKey('intake')).toBe('approvals/intake');
    expect(APPROVAL_SECTIONS[0]).toEqual({ key: 'intake', label: 'Pending acceptance', decides: true });
  });

  it('the other kinds keep their sections', () => {
    expect(approvalSectionOf('nte_override')).toBe('nte');
    expect(approvalSectionOf('status_change')).toBe('status');
    expect(approvalSectionOf('manager_review')).toBe('reviews');
  });

  it('has a label, a reject target and a source vocabulary', () => {
    expect(APPROVAL_TASK_LABEL.wo_acceptance).toBe('Work order acceptance');
    expect(ACCEPTANCE_REJECT_STATUS_NAME).toBe('Cancelled / Postponed');
    expect(Object.keys(ACCEPTANCE_SOURCE_LABEL).sort()).toEqual(['ecotrak', 'import', 'manual']);
  });

  it('is raised by the system, never offered to the automation builder', () => {
    expect(APPROVAL_TASK_TYPES.map((t) => t.code)).not.toContain('wo_acceptance');
    expect(APPROVAL_TASK_TYPES.map((t) => t.code)).not.toContain('status_change');
  });

  it('the permission tree draws the section under Approvals', () => {
    const approvals = buildPermissionTree([]).find((n) => n.key === 'approvals');
    const intake = approvals?.children?.find((c) => c.key === 'approvals/intake');
    expect(intake?.label).toBe('Pending acceptance');
    expect(intake?.actions).toEqual(['view', 'approve']);
  });
});

describe('pending acceptance — who decides (migration 0036)', () => {
  it('a manager role sees the section and may accept / reject', () => {
    const set = { role: MANAGER_PERMS, overrides: {} };
    expect(permAllows(set, 'approvals/intake', 'view')).toBe(true);
    expect(permAllows(set, 'approvals/intake', 'approve')).toBe(true);
  });

  it('an OM tier inherits the parent grant: sees the inbox, cannot decide', () => {
    const set = { role: OM_PERMS, overrides: {} };
    expect(permAllows(set, 'approvals/intake', 'view')).toBe(true);
    expect(permAllows(set, 'approvals/intake', 'approve')).toBe(false);
  });

  it('a per-person override can hand one OM the queue', () => {
    const set = { role: OM_PERMS, overrides: { 'approvals/intake': { approve: true } } };
    expect(permAllows(set, 'approvals/intake', 'approve')).toBe(true);
    expect(permAllows(set, 'approvals/status', 'approve')).toBe(false);
  });

  it('a super admin always may', () => {
    expect(permAllows({ role: {}, overrides: {} }, 'approvals/intake', 'approve', true)).toBe(true);
  });
});
