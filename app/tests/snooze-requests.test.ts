/* Elise, 2026-10-22 — two asks from the UAT list.
 *
 *   1. An OM Under Probation does not change the Client or the FM on a work
 *      order (migration 0093: a permission, like the 0039 Assignee lock).
 *   2. A Pulse snooze by someone without `approvals/snooze` approve is a
 *      REQUEST a manager decides in the Approvals inbox; the snooze is
 *      applied as the decision commits.
 *
 * The pure half (snoozeMode, the section / label vocabulary) is exercised;
 * the wired half is pinned to the source so a refactor that drops a piece
 * fails here.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_SECTIONS,
  APPROVAL_TASK_LABEL,
  SNOOZE_PERM_KEY,
  approvalSectionOf,
  approvalSectionPermKey,
  snoozeMode,
} from '../packages/shared/src/index';
import { buildPermissionTree, fieldPermKey, type PermMap } from '../packages/shared/src/permissions';

const set = (role: PermMap, overrides: PermMap = {}) => ({ role, overrides });
import { PROBATION_FIELD_LOCKED_ROLES, PROBATION_LOCKED_FIELD_PATHS } from '../packages/shared/src/workflow';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ── 1 · Client and FM locked for probation ───────────────────────────────────

describe('0093 — an OM Under Probation cannot change the Client or the FM', () => {
  it('names the two fields under the Client section, and only the probation role', () => {
    expect([...PROBATION_LOCKED_FIELD_PATHS]).toEqual([
      'work_orders/fields/client/fields.Client',
      'work_orders/fields/client/fields.22. FM',
    ]);
    expect([...PROBATION_FIELD_LOCKED_ROLES]).toEqual(['om_probation']);
  });

  it('the paths are the ones the field editor checks (a typo would lock nothing)', () => {
    expect(PROBATION_LOCKED_FIELD_PATHS).toContain(fieldPermKey('fields.Client'));
    expect(PROBATION_LOCKED_FIELD_PATHS).toContain(fieldPermKey('fields.22. FM'));
  });

  it('migration 0093 sets edit false on exactly those paths for exactly that role', () => {
    const sql = read('packages/db/migrations/0093_probation_client_fm_lock.sql');
    for (const p of PROBATION_LOCKED_FIELD_PATHS) expect(sql).toContain(`'${p}'`);
    for (const r of PROBATION_FIELD_LOCKED_ROLES) expect(sql).toContain(`'${r}'`);
    expect(sql).toContain('{"edit": false}');
    for (const other of ['om', 'senior_om', 'vr_officer', 'oa']) {
      expect(sql, other).not.toMatch(new RegExp(`'${other}'`));
    }
  });
});

// ── 2 · Snooze as a request ──────────────────────────────────────────────────

describe('snoozeMode — who snoozes and who asks', () => {
  it('approve on approvals/snooze snoozes directly; a super admin always does', () => {
    expect(snoozeMode(set({ 'approvals/snooze': { approve: true } }))).toBe('direct');
    expect(snoozeMode(set({}), true)).toBe('direct');
    // A per-person Adjust wins over the role either way.
    expect(snoozeMode(set({ approvals: { approve: false } }, { 'approvals/snooze': { approve: true } }))).toBe('direct');
    expect(snoozeMode(set({ approvals: { approve: true } }, { 'approvals/snooze': { approve: false } }))).toBe('request');
  });

  it('inherits from approvals: a manager who decides the inbox snoozes, a viewer asks', () => {
    expect(snoozeMode(set({ approvals: { view: true, approve: true } }))).toBe('direct');
    expect(snoozeMode(set({ approvals: { view: true } }))).toBe('request');
    expect(snoozeMode(set({}))).toBe('request');
    expect(snoozeMode(set({ approvals: { approve: true }, 'approvals/snooze': { approve: false } }))).toBe('request');
  });

  it('the vocabulary: a snooze_request lives in the Snooze requests section, which decides', () => {
    expect(SNOOZE_PERM_KEY).toBe('approvals/snooze');
    expect(approvalSectionOf('snooze_request')).toBe('snooze');
    expect(approvalSectionPermKey('snooze')).toBe(SNOOZE_PERM_KEY);
    expect(APPROVAL_SECTIONS.find((s) => s.key === 'snooze')).toEqual({ key: 'snooze', label: 'Snooze requests', decides: true });
    expect(APPROVAL_TASK_LABEL.snooze_request).toBe('Snooze request');
    // The Roles screen draws the section.
    const tree = buildPermissionTree([]) as { key: string; children?: { key: string; actions: string[] }[] }[];
    const approvals = tree.find((n) => n.key === 'approvals');
    const node = approvals?.children?.find((c) => c.key === 'approvals/snooze');
    expect(node?.actions).toEqual(['view', 'approve']);
  });
});

describe('snooze requests are wired', () => {
  const obligations = read('apps/api/src/services/obligations.ts');
  const approvals = read('apps/api/src/services/approvals.ts');

  it('the route asks snoozeMode and raises a request instead of snoozing', () => {
    const route = read('apps/api/src/routes/obligations.ts');
    expect(route).toContain("snoozeMode(actor.perms, actor.isSuperAdmin) === 'request'");
    expect(route).toContain('requestSnooze(id, hours, reason, actor)');
    expect(route).toContain('requested: true');
  });

  it('requestSnooze checks what a direct snooze checks, needs a work order, and raises a preset task', () => {
    const fn = obligations.slice(obligations.indexOf('export async function requestSnooze'));
    expect(fn).toContain('SNOOZE_MAX_HOURS');
    expect(fn).toContain('A snooze needs a reason');
    expect(fn).toContain('throw outOfScope()');
    expect(fn).toContain('if (!ob.task_id)');
    expect(fn).toContain("type: 'snooze_request'");
    expect(fn).toContain('preset: {');
  });

  it('the obligation carries its open request (one subselect, newest first)', () => {
    expect(obligations).toMatch(/a\.type = 'snooze_request' AND a\.status = 'open'/);
    expect(obligations).toContain("a.detail ->> 'obligation_id' = o.id::text");
    expect(obligations).toContain('snooze_request: row.snooze_request');
  });

  it('approving applies the snooze after the commit, refuses a stale one first, and reconcile cancels stale ones', () => {
    expect(approvals).toContain("'snooze_request',");
    const decide = approvals.slice(approvals.indexOf('async function decide('), approvals.indexOf('export interface DecideOptions'));
    const stale = decide.indexOf("code: 'SNOOZE_REQUEST_STALE'");
    const commit = decide.indexOf('await withTransaction(async (tx) => {');
    const apply = decide.indexOf('applySnoozeFromRequest(');
    expect(stale).toBeGreaterThan(-1);
    expect(stale).toBeLessThan(commit);
    expect(apply).toBeGreaterThan(commit);
    expect(approvals).toContain('await reconcileSnoozeRequests(taskId, actorId);');
    expect(approvals).toContain("'snooze_request', 'manager_review'] as ApprovalTaskType[]");
    // A repeat ask replaces the open one and becomes the asker's, as a status request does.
    expect(approvals).toContain("input.type === 'status_change' || input.type === 'snooze_request'");
  });

  it('the applied snooze is the manager\'s act with the requester\'s reason, and says so on the trail', () => {
    const fn = obligations.slice(obligations.indexOf('export async function applySnoozeFromRequest'));
    expect(fn).toContain('if (await snoozeRequestStale(detail)) return null;');
    expect(fn).toContain('approverId');
    expect(fn).toContain('await evaluateNow();');
    expect(obligations).toContain("via: 'approval_task', approval_task_id: via.approval_task_id, requested_by: via.requested_by");
  });

  it('the web asks, says so, and the inbox has the lane', () => {
    const dialog = read('apps/web/src/components/obligations/SnoozeDialog.tsx');
    expect(dialog).toContain("const requestOnly = !can(SNOOZE_PERM_KEY, 'approve');");
    expect(dialog).toContain('`Request snooze ${span}`');
    for (const f of ['apps/web/src/pages/PulsePage.tsx', 'apps/web/src/components/obligations/ObligationsCard.tsx']) {
      const src = read(f);
      expect(src, f).toContain("ob.snooze_request ? 'Snooze requested' : 'Snooze'");
      expect(src, f).toContain('disabled={!!ob.snooze_request}');
    }
    const inbox = read('apps/web/src/pages/ApprovalsPage.tsx');
    expect(inbox).toContain("snooze: 'Snooze requests'");
    expect(inbox).toContain("'Approve this snooze?'");
    expect(inbox).toContain("'Reject this snooze request'");
  });
});
