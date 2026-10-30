/* Elise, 2026-10-30 — "in the activity log, show us who changed the status
 * and who accepted the change", in the work order's Audit trail and in
 * Admin › Audit.
 *
 * A status change approved from a request is ONE `status_changed` row signed
 * by the approver with `via: 'approval_task'` + `approval_task_id`. Both
 * readers add `requested_by` from the request (AFTER_WITH_REQUESTER_SQL), so
 * rows written before today read the same; both screens and the CSV print
 * "requested by A · approved by B".
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AFTER_WITH_REQUESTER_SQL } from '../apps/api/src/lib/actorName';
import { statusRequesterName } from '../apps/web/src/lib/auditFormat';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('who asked and who approved a status change', () => {
  it('adds the requester only to an approved status-change row', () => {
    expect(AFTER_WITH_REQUESTER_SQL).toContain(`a.action = 'status_changed'`);
    expect(AFTER_WITH_REQUESTER_SQL).toContain(`a.after ->> 'via' = 'approval_task'`);
    expect(AFTER_WITH_REQUESTER_SQL).toContain(`rt.type = 'status_change'`);
    expect(AFTER_WITH_REQUESTER_SQL).toContain('rq.id = rt.created_by');
  });

  it('both readers select it', () => {
    expect(read('apps/api/src/services/activity.ts')).toContain('${AFTER_WITH_REQUESTER_SQL} AS after');
    expect(read('apps/api/src/services/auditLog.ts')).toContain('${AFTER_WITH_REQUESTER_SQL} AS after');
  });

  it('reads the requester name off a row', () => {
    expect(statusRequesterName({ via: 'approval_task', requested_by: { id: 'x', name: 'Sam OM' } })).toBe('Sam OM');
    expect(statusRequesterName({ via: 'approval_task', requested_by: null })).toBeNull();
    expect(statusRequesterName({ status_name: 'Open' })).toBeNull();
    expect(statusRequesterName(null)).toBeNull();
  });

  it('both screens and the CSV name the two people', () => {
    for (const f of ['apps/web/src/components/wo/AuditTrail.tsx', 'apps/web/src/pages/admin/AdminAuditPage.tsx']) {
      const src = read(f);
      expect(src).toContain('statusRequesterName(e.after)');
      expect(src).toContain('· requested by <b>{requester}</b> · approved by <b>');
    }
    expect(read('apps/api/src/services/auditLog.ts')).toContain('(requested by ${rq.name}, approved by ${e.actor.display_name})');
  });
});
