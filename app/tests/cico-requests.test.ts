/* Check-in / check-out requests and the four check-out outcomes (Elise,
 * 2026-11-18). Someone who requests status changes requests the check-in and
 * the check-out too; approving stamps the visit, then moves the status. A
 * check-out says how the visit ended, and that decides where the work order
 * goes. Pure checks and source pins: no database. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECK_OUT_OUTCOMES,
  CHECK_OUT_OUTCOME_LABEL,
  CHECK_OUT_STATUS_NAME,
  checkOutStatusName,
  isCheckOutOutcome,
  visitRequestLabel,
} from '../packages/shared/src/visitStatus';
import { PHASE_BY_STATUS_NAME } from '../packages/shared/src/index';

const APP = join(__dirname, '..');
const src = (p: string) => readFileSync(join(APP, p), 'utf8');
function fn(text: string, sig: string): string {
  const a = text.indexOf(sig);
  expect(a, sig).toBeGreaterThanOrEqual(0);
  const b = text.indexOf('\nexport ', a + sig.length);
  return text.slice(a, b === -1 ? undefined : b);
}

describe('the four ways to check out', () => {
  it('reads as Elise wrote them', () => {
    expect(CHECK_OUT_OUTCOMES.map((o) => CHECK_OUT_OUTCOME_LABEL[o])).toEqual([
      'Check out - Completed',
      'Check out - Quote',
      'Check out - Return',
      'Check out - Parts',
    ]);
  });

  it('moves the work order to the status each one names', () => {
    expect(checkOutStatusName('completed')).toBe('Done / Incurred');
    expect(checkOutStatusName('quote')).toBe('Waiting for Quote');
    expect(checkOutStatusName('return')).toBe('Return Trip Needed');
    expect(checkOutStatusName('parts')).toBe('Waiting for Parts');
    expect(checkOutStatusName(null)).toBeNull();
  });

  it('names statuses that exist', () => {
    for (const name of Object.values(CHECK_OUT_STATUS_NAME)) expect(PHASE_BY_STATUS_NAME[name], name).toBeDefined();
  });

  it('knows its own values only', () => {
    expect(isCheckOutOutcome('quote')).toBe(true);
    expect(isCheckOutOutcome('rtn')).toBe(false);
    expect(isCheckOutOutcome(null)).toBe(false);
  });

  it('the migration, the route and the vocabulary agree', () => {
    const mig = src('packages/db/migrations/0157_visit_checkout_outcome.sql');
    const route = src('apps/api/src/routes/visits.ts');
    for (const o of CHECK_OUT_OUTCOMES) {
      expect(mig).toContain(`'${o}'`);
      expect(route).toContain(`'${o}'`);
    }
  });

  it('labels a request by the visit it is about', () => {
    expect(visitRequestLabel({ action: 'check_in', outcome: null, visit_seq: 2, visit_type: 'Job' })).toBe('Check in · Visit 2 (Job)');
    expect(visitRequestLabel({ action: 'check_out', outcome: 'parts', visit_seq: 1, visit_type: 'Assessment' })).toBe(
      'Check out - Parts · Visit 1 (Assessment)',
    );
  });
});

describe('the visit service', () => {
  const visits = src('apps/api/src/services/visits.ts');

  it('a new check-out must say how the visit ended', () => {
    expect(fn(visits, 'export async function createVisit(')).toContain('requireOutcome(c.checkout_outcome)');
    expect(fn(visits, 'export async function updateVisit(')).toContain('requireOutcome(c.checkout_outcome)');
  });

  it('a status-request person raises a request instead of stamping', () => {
    for (const sig of ['export async function createVisit(', 'export async function updateVisit(']) {
      const body = fn(visits, sig);
      expect(body, sig).toContain('requestModeOf(actor)');
      expect(body, sig).toContain('visitRequestPlan(');
      expect(body, sig).toContain('raiseVisitRequest(');
      // Asked before anything is written.
      expect(body.indexOf('visitRequestPlan('), sig).toBeLessThan(body.indexOf('withTransaction('));
    }
    expect(visits).toContain('return isStatusRequestMode(actor.perms, actor.isSuperAdmin);');
  });

  it('a direct check-out moves the status by its outcome', () => {
    expect(fn(visits, 'export async function updateVisit(')).toContain('moveAfterCheckOut(cur.task_id, outcome, actor)');
    expect(visits).toContain('return moveForVisit(taskId, checkOutStatusName(outcome), actor);');
  });

  it('an approved request takes the stamps asked for, signed by the requester', () => {
    const apply = fn(visits, 'export async function applyVisitRequest(');
    expect(apply).toContain('inBy = requesterId;');
    expect(apply).toContain('outBy = requesterId;');
    expect(apply).toContain('next.checkout_outcome = d.outcome;');
    expect(apply).toContain("next.return_trip_needed = d.outcome === 'return';");
    expect(apply).toContain("logVisitEvent(tx, approverId, cur.task_id, 'visit_updated'");
  });
});

describe('the approval', () => {
  const appr = src('apps/api/src/services/approvals.ts');

  it('a check-out request is asked what a status request for its target is asked', () => {
    const plan = fn(appr, 'export async function visitRequestPlan(');
    expect(plan).toContain('assertNoOtherVisitRequest(taskId, visitId)');
    expect(plan).toContain('describeRequestHidden(target.name)');
    expect(plan).toContain("if (action === 'check_out') await assertCheckOutGate({ query }, taskId, target.name);");
    expect(plan).toContain('assertEcotrakAllowsMove(taskId, target.name)');
    expect(plan).toContain('assertStatusOrder({ query }, taskId, target.name)');
  });

  it('the Done gate counts the check-out being requested', () => {
    const gate = fn(src('apps/api/src/services/statusGates.ts'), 'export async function assertCheckOutGate(');
    expect(gate).toContain("missing.filter((m) => m !== 'visit')");
  });

  it('approving stamps the visit before it moves the status', () => {
    const decide = appr.slice(appr.indexOf('async function decide('), appr.indexOf('export interface DecideOptions'));
    expect(decide).toContain('await assertVisitRequestLive(visitAsk);');
    const applied = decide.indexOf('await applyVisitRequest(visitToApply');
    const moved = decide.indexOf('await changeStatus(cur.task_id, moveTo');
    expect(applied).toBeGreaterThan(0);
    expect(applied).toBeLessThan(moved);
  });

  it('a pending check-in / check-out is never silently replaced', () => {
    expect(fn(appr, 'export async function requestStatusChange(')).toContain('assertNoOtherVisitRequest(taskId, null)');
  });

  it('reconcile settles a visit request by its visit, not by the status', () => {
    const rec = appr.slice(appr.indexOf('async function reconcileStatusChange('), appr.indexOf('async function cancelTask('));
    expect(rec.indexOf('visitRequestStaleReason')).toBeLessThan(rec.indexOf("if (!r.to_id) return;"));
  });
});

describe('the CICO card', () => {
  const card = src('apps/web/src/components/wo/CicoCard.tsx');
  it('offers the four check-outs and the request wording', () => {
    expect(card).toContain('...CHECK_OUT_OUTCOMES.map((o) => ({');
    expect(card).toContain("'Request check-in'");
    expect(card).toContain("const requestMode = can(STATUS_PERM_KEY, 'create') && !can(STATUS_PERM_KEY, 'edit') && wo.oa_interim !== true;");
    expect(card).toContain('disabled={busy || statusLocked}');
  });
});
