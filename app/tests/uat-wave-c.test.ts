/* UAT round 1, Wave C — workflow (migration 0085, docs/specs/uat-round-1.md).
 *
 * The house pattern: the pure vocabulary (packages/shared/src/workflow.ts and
 * the gate half in statusGates.ts) is exercised directly, the small API
 * decisions that need no database are called, and the wiring is pinned as
 * source text. No database is opened. A reformat of a pinned fragment turns a
 * test red without a behaviour change: update the fragment the failing
 * assertion names.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CANCEL_BILLED_CODE,
  CLIENT_APPROVAL_EVIDENCE_CODE,
  DISPATCHER_LOCKED_FIELD_PATHS,
  DISPATCHER_ROLE_CODES,
  DONE_OR_LATER_STATUS_NAMES,
  FIELD_LOCKED_ROLES,
  INVOICING_GATED_STATUS_NAMES,
  LIFECYCLE_LOCKED_ROLES,
  LIFECYCLE_PERM_KEY,
  PHASE_BY_STATUS_NAME,
  QUOTE_EVENT_STATUS_NAME,
  REQUEST_MODE_DISPATCHER_ROLES,
  STATUS_GATE_ERROR_CODE,
  buildPermissionTree,
  cancelBlockedReason,
  fieldPermKey,
  gateHoldingField,
  isDoneOrLaterStatus,
  isStatusRequestMode,
  nextVisitStamps,
  quoteEventStatusName,
  statusBeforeCancel,
  statusGateFor,
  statusHoldsQuote,
  type PermissionSet,
} from '@theone/shared';
import { migrationFileProblems } from '../packages/db/src/migrateLedger';
import { ApiError } from '../apps/api/src/errors';
import { assertGateHoldsFields } from '../apps/api/src/services/statusGates';

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = src('packages/db/migrations/0085_uat_workflow.sql');

/** The body of one exported function: from its signature to the next export. */
function fn(file: string, signature: string): string {
  const start = file.indexOf(signature);
  expect(start, `${signature} exists`).toBeGreaterThan(-1);
  const next = file.indexOf('\nexport ', start + signature.length);
  return file.slice(start, next === -1 ? undefined : next);
}

function refusal(f: () => void): ApiError {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error('expected a refusal');
}

// ── #2 · the billing statuses ask the Done gate ──────────────────────────────

describe('#2 · Ready to Invoice / Invoiced Not Paid / Invoiced need the job done', () => {
  it('lists exactly the statuses of the Done and Invoiced phases as "done or later"', () => {
    const fromMap = Object.entries(PHASE_BY_STATUS_NAME)
      .filter(([, phase]) => phase === 'Done' || phase === 'Invoiced')
      .map(([name]) => name)
      .sort();
    expect([...DONE_OR_LATER_STATUS_NAMES].sort()).toEqual(fromMap);
  });

  it('gates each billing status with the Done gate from before Done', () => {
    for (const name of INVOICING_GATED_STATUS_NAMES) {
      expect(PHASE_BY_STATUS_NAME[name], name).toBeDefined();
      expect(statusGateFor(name)).toBe('done');
      expect(statusGateFor(name, 'On Site (Job)')).toBe('done');
      expect(statusGateFor(name.toUpperCase(), 'Approved')).toBe('done');
    }
  });

  it('opens them to a work order already done or later', () => {
    expect(statusGateFor('Invoiced', 'Done / Incurred')).toBeNull();
    expect(statusGateFor('Invoiced Not Paid', 'Ready to Invoice')).toBeNull();
    expect(statusGateFor('Invoiced', 'Invoiced Not Paid')).toBeNull();
    // Done / Incurred itself stays gated from Ready to Invoice, as before.
    expect(statusGateFor('Done / Incurred', 'Ready to Invoice')).toBe('done');
  });

  it('every path that moves a status hands the gate the current status or lets it read one', () => {
    const gates = src('apps/api/src/services/statusGates.ts');
    expect(fn(gates, 'export async function statusGateBlocker(')).toContain('INVOICING_GATED_STATUS_NAMES.some');
    expect(fn(gates, 'export async function statusGateBlocker(')).toContain('statusGateFor(targetStatusName, current)');
    const wo = src('apps/api/src/services/workOrders.ts');
    expect(fn(wo, 'export async function changeStatus(')).toContain('assertStatusGate(tx, task_id, newStatusName, undefined, currentStatusName)');
    const bulk = src('apps/api/src/services/woBulk.ts');
    expect(bulk).toContain('statusGateFor(target.name, r.status_name)');
    const approvals = src('apps/api/src/services/approvals.ts');
    expect(fn(approvals, 'export async function requestStatusChange(')).toContain('assertStatusGate(');
    expect(approvals).toContain("await assertStatusGate({ query }, cur.task_id, hit.rows[0].name);");
    const menu = src('apps/web/src/components/StatusChangeMenu.tsx');
    expect(menu).toContain('statusGateFor(s.name, current.name)');
  });
});

// ── M3 · a gated status holds its field ──────────────────────────────────────

describe('M3 · what a gate asked for is not emptied while the work order sits there', () => {
  it('holds Parts Required in the parts statuses', () => {
    expect(gateHoldingField('Waiting for Parts', 'Parts Required', null)).toBe('parts');
    expect(gateHoldingField('Please Order Parts', 'Parts Required', '   ')).toBe('parts');
    expect(gateHoldingField('Waiting for Parts', 'Parts Required', 'Compressor')).toBeNull();
    expect(gateHoldingField('Job Sched', 'Parts Required', null)).toBeNull();
  });

  it('holds the Cost from Done / Incurred on', () => {
    for (const s of DONE_OR_LATER_STATUS_NAMES) expect(gateHoldingField(s, '34. Cost', null), s).toBe('done');
    expect(gateHoldingField('Invoiced', '34. Cost', 'TBD')).toBe('done');
    expect(gateHoldingField('Invoiced', '34. Cost', 0)).toBeNull();
    expect(gateHoldingField('On Site (Job)', '34. Cost', null)).toBeNull();
    expect(gateHoldingField('Done / Incurred', 'Admin Comment', null)).toBeNull();
  });

  it('holds the quote in Quote Ready and from Done on', () => {
    expect(statusHoldsQuote('Quote Ready')).toBe(true);
    expect(statusHoldsQuote('Invoiced')).toBe(true);
    expect(statusHoldsQuote('Waiting for Quote')).toBe(false);
    expect(statusHoldsQuote(null)).toBe(false);
  });

  it('refuses with 409 STATUS_GATE, held, naming the field', () => {
    const e = refusal(() => assertGateHoldsFields('Waiting for Parts', [{ jsonKey: 'Parts Required', value: null }], () => 'Parts Required'));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toMatchObject({ code: STATUS_GATE_ERROR_CODE, gate: 'parts', held: true, field: 'Parts Required' });
    expect(e.message).toContain('"Parts Required" cannot be emptied while the work order is in Waiting for Parts');
    expect(() => assertGateHoldsFields('Waiting for Parts', [{ jsonKey: 'Parts Required', value: 'Belt' }])).not.toThrow();
  });

  it('runs in the field editor under the row lock, in bulk edit and on the quote', () => {
    const fv = src('apps/api/src/services/woFieldValues.ts');
    const body = fn(fv, 'export async function updateWorkOrderFields(');
    expect(body.indexOf('FOR NO KEY UPDATE')).toBeLessThan(body.indexOf('assertGateHoldsFields('));
    const bulk = src('apps/api/src/services/woBulk.ts');
    expect(bulk.split('assertGateHoldsFields(').length - 1).toBe(2); // the pre-check and again under the lock
    const quotes = src('apps/api/src/services/quotes.ts');
    const upd = fn(quotes, 'export async function updateQuote(');
    expect(upd).toContain('if (input.sections !== undefined) await assertQuoteHeld(tx, taskId);');
    expect(upd.indexOf('assertQuoteHeld')).toBeGreaterThan(upd.indexOf('withTransaction'));
  });
});

// ── #15 / #16 · request mode ─────────────────────────────────────────────────

describe('#15 / #16 · people who request status changes have no side doors', () => {
  const requester: PermissionSet = { role: { work_orders: { view: true, edit: true }, 'work_orders/status': { edit: false, create: true } }, overrides: {} };
  const manager: PermissionSet = { role: { work_orders: { view: true, edit: true }, 'work_orders/status': { edit: true, create: true } }, overrides: {} };

  it('knows who is in request mode', () => {
    expect(isStatusRequestMode(requester)).toBe(true);
    expect(isStatusRequestMode(manager)).toBe(false);
    expect(isStatusRequestMode(requester, true)).toBe(false);
    expect(isStatusRequestMode({ role: {}, overrides: {} })).toBe(false);
  });

  it('the request-mode dispatchers are the D3 list', () => {
    expect([...REQUEST_MODE_DISPATCHER_ROLES].sort()).toEqual([...DISPATCHER_ROLE_CODES].sort());
  });

  it('the Roles screen carries the lifecycle row under Work orders', () => {
    const tree = buildPermissionTree([]);
    const wo = tree.find((n) => n.key === 'work_orders');
    const node = wo?.children?.find((n) => n.key === LIFECYCLE_PERM_KEY);
    expect(node?.actions).toEqual(['edit']);
  });

  it('the locked field paths are real field paths', () => {
    expect(DISPATCHER_LOCKED_FIELD_PATHS).toContain(fieldPermKey('nte'));
    expect(DISPATCHER_LOCKED_FIELD_PATHS).toContain(fieldPermKey('fields.16. Client NTE 🔴'));
    expect(DISPATCHER_LOCKED_FIELD_PATHS).toContain(fieldPermKey('fields.SLA Due Date'));
    expect(DISPATCHER_LOCKED_FIELD_PATHS).toContain(fieldPermKey('fields.Due Date'));
    expect(DISPATCHER_LOCKED_FIELD_PATHS).toContain('work_orders/fields/ar');
  });

  it('migration 0085 grants what shared says, and applies cleanly', () => {
    expect(migrationFileProblems(MIGRATION)).toEqual([]);
    const requestModeLine = MIGRATION.slice(MIGRATION.indexOf("'work_orders/status', '{\"edit\": false, \"create\": true}'"));
    for (const r of REQUEST_MODE_DISPATCHER_ROLES) expect(requestModeLine.slice(0, 200), r).toContain(`'${r}'`);
    const lifecycle = MIGRATION.slice(MIGRATION.indexOf("'work_orders/lifecycle'"));
    for (const r of LIFECYCLE_LOCKED_ROLES) expect(lifecycle.slice(0, 200), r).toContain(`'${r}'`);
    for (const r of FIELD_LOCKED_ROLES) expect(MIGRATION, r).toContain(`'${r}'`);
    for (const p of DISPATCHER_LOCKED_FIELD_PATHS) expect(MIGRATION, p).toContain(`'${p}'`);
    // oa types the NTE and SLA at intake: it keeps those fields.
    expect(FIELD_LOCKED_ROLES as readonly string[]).not.toContain('oa');
  });

  it('cancel, reopen, pause, resume and complete all need the lifecycle grant', () => {
    const rec = src('apps/api/src/services/woRecord.ts');
    for (const sig of [
      'export async function pauseWo(',
      'export async function resumeWo(',
      'export async function cancelWo(',
      'export async function reopenWo(',
      'export async function completeWoService(',
      'export async function clearWoCompletion(',
    ]) {
      expect(fn(rec, sig), sig).toContain('requireLifecycle(actor);');
    }
    expect(rec).toContain('LIFECYCLE_PERM_KEY,\n    \'edit\'');
    const bar = src('apps/web/src/components/wo/record/RecordParts.tsx');
    expect(bar).toContain('const lifecycle = record.can.lifecycle;');
  });

  it('a request-mode check-in raises a status request; anyone else moves it', () => {
    const visits = src('apps/api/src/services/visits.ts');
    const move = visits.slice(visits.indexOf('async function moveOnSite('), visits.indexOf('// ── Writes'));
    expect(move).toContain('if (isStatusRequestMode(actor.perms, actor.isSuperAdmin)) {');
    expect(move).toContain('requestStatusChange(taskId, row.target, actor)');
    expect(move).toContain("changeStatus(taskId, row.target, actorId, undefined, 'visit')");
    expect(move.indexOf('requestStatusChange')).toBeLessThan(move.indexOf('changeStatus('));
    const card = src('apps/web/src/components/wo/CicoCard.tsx');
    expect(card).toContain('if (m?.requested) {');
  });
});

// ── M5 / M6 / M4 · the quote ─────────────────────────────────────────────────

describe('M5 · the status follows the quote', () => {
  it('names real statuses', () => {
    for (const name of Object.values(QUOTE_EVENT_STATUS_NAME)) expect(PHASE_BY_STATUS_NAME[name], name).toBeDefined();
  });

  it('moves forward from the quote and approval statuses only', () => {
    expect(quoteEventStatusName('sent', 'Quote Ready')).toBe('Waiting for Approval');
    expect(quoteEventStatusName('sent', 'Waiting for Quote')).toBe('Waiting for Approval');
    expect(quoteEventStatusName('sent', 'Waiting for Approval')).toBeNull();
    expect(quoteEventStatusName('sent', 'On Site (Job)')).toBeNull();
    expect(quoteEventStatusName('client_approved', 'Waiting for Approval')).toBe('Approved');
    expect(quoteEventStatusName('client_approved', 'Job Sched')).toBeNull();
    expect(quoteEventStatusName('client_declined', 'Waiting for Approval')).toBe('Waiting for Quote');
    expect(quoteEventStatusName('client_declined', 'Cancelled / Postponed')).toBeNull();
    expect(quoteEventStatusName('client_declined', null)).toBeNull();
  });

  it('runs after each of the three quote acts, through changeStatus with source quote', () => {
    const q = src('apps/api/src/services/quotes.ts');
    expect(q).toContain("await changeStatus(taskId, st.rows[0].id, actor.id, undefined, 'quote');");
    expect(fn(q, 'export async function sendQuote(')).toContain("return withStatusMove(taskId, sent, 'sent', actor);");
    expect(fn(q, 'export async function clientApproveQuote(')).toContain("return withStatusMove(taskId, approved, 'client_approved', actor);");
    // 0109: a challenged decline follows 'client_declined', a BFI one 'client_declined_bfi'.
    expect(fn(q, 'export async function clientDeclineQuote(')).toContain('return withStatusMove(taskId, declined, quoteDeclineEvent(kind), actor);');
  });
});

describe('M6 · the client approval has evidence', () => {
  it('refuses a recorded approval with neither a note nor a file', () => {
    const q = fn(src('apps/api/src/services/quotes.ts'), 'export async function clientApproveQuote(');
    expect(q).toContain('if (!evidenceNote && !evidenceFile) {');
    expect(q).toContain('CLIENT_APPROVAL_EVIDENCE_CODE');
    expect(q.indexOf('if (!evidenceNote && !evidenceFile) {')).toBeLessThan(q.indexOf('await transition('));
    expect(CLIENT_APPROVAL_EVIDENCE_CODE).toBe('CLIENT_APPROVAL_EVIDENCE');
    expect(src('apps/api/src/routes/quotes.ts')).toContain('attachment_id: z.string().uuid().nullable().optional(),');
    expect(src('apps/web/src/pages/QuoteBuilderPage.tsx')).toContain("(decision.kind === 'approve' && decisionNote.trim() === '' && !decisionFile)");
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS client_decision_attachment_id uuid');
  });
});

describe('M4 · the client message goes on send', () => {
  it('only Send posts the client-visible quote message, and approving no longer sends', () => {
    const q = src('apps/api/src/services/quotes.ts');
    expect(fn(q, 'export async function submitQuote(')).not.toContain('addComment');
    expect(fn(q, 'export async function approveQuote(')).not.toContain('addComment');
    expect(fn(q, 'export async function sendQuote(')).toContain('sent to the client for approval');
    const builder = src('apps/web/src/pages/QuoteBuilderPage.tsx');
    const approve = builder.slice(builder.indexOf('const approveMutation'), builder.indexOf('const sendMutation'));
    expect(approve).not.toContain('sendQuote');
    // 2026-10-27 (Elise): outside the builder the manager's one click sends
    // (the API approves on the way).
    expect(src('apps/web/src/components/quote/QuoteDecision.tsx')).toContain('sendQuote');
    expect(fn(q, 'export async function sendQuote(')).toContain('QUOTE_APPROVABLE_FROM.includes(cur.status)) await approveQuote(');
  });
});

// ── M8 · visit stamps ────────────────────────────────────────────────────────

describe('M8 · a visit\'s status follows its stamps', () => {
  const NOW = '2026-10-15T15:00:00Z';
  const planned = { status: 'planned' as const, checked_in_at: null, checked_out_at: null };
  const inAt9 = { status: 'checked_in' as const, checked_in_at: '2026-10-15T09:00:00Z', checked_out_at: null };

  it('a typed check-in time checks the visit in; a typed check-out checks it out', () => {
    expect(nextVisitStamps(planned, { checked_in_at: '2026-10-15T08:00:00Z' }, NOW)).toEqual({ status: 'checked_in', checked_in_at: '2026-10-15T08:00:00Z', checked_out_at: null });
    expect(nextVisitStamps(inAt9, { checked_out_at: '2026-10-15T11:00:00Z' }, NOW).status).toBe('checked_out');
    expect(nextVisitStamps(inAt9, { checked_in_at: null }, NOW).status).toBe('planned');
  });

  it('a status move never overwrites a typed time', () => {
    // Moving back to checked in keeps the 9:00 check-in (it used to become now).
    const out = { status: 'checked_out' as const, checked_in_at: '2026-10-15T09:00:00Z', checked_out_at: '2026-10-15T10:00:00Z' };
    expect(nextVisitStamps(out, { status: 'checked_in' }, NOW)).toEqual(inAt9);
    // Checking out with a typed time keeps it; without one it stamps now.
    expect(nextVisitStamps(inAt9, { status: 'checked_out', checked_out_at: '2026-10-15T12:00:00Z' }, NOW).checked_out_at).toBe('2026-10-15T12:00:00Z');
    expect(nextVisitStamps(inAt9, { status: 'checked_out' }, NOW).checked_out_at).toBe(NOW);
    expect(nextVisitStamps(planned, { status: 'checked_in' }, NOW).checked_in_at).toBe(NOW);
    expect(nextVisitStamps(inAt9, { status: 'planned' }, NOW)).toEqual(planned);
  });

  it('createVisit and updateVisit both go through it', () => {
    const visits = src('apps/api/src/services/visits.ts');
    expect(fn(visits, 'export async function createVisit(')).toContain('nextVisitStamps(');
    expect(fn(visits, 'export async function updateVisit(')).toContain('nextVisitStamps(');
    expect(fn(visits, 'export async function updateVisit(')).toContain("const checkedInNow = next.status === 'checked_in' && cur.status !== 'checked_in';");
  });
});

// ── M9 · honest progress, no cancel once billed ──────────────────────────────

describe('M9 · the phase bar and Cancel tell the truth', () => {
  it('Cancel is refused once billed or paid', () => {
    expect(cancelBlockedReason({ invoiceStatuses: [], paidPayments: 0 })).toBeNull();
    expect(cancelBlockedReason({ invoiceStatuses: ['sent'], paidPayments: 0 })).toContain('sent');
    expect(cancelBlockedReason({ invoiceStatuses: ['paid'], paidPayments: 0 })).toContain('paid');
    expect(cancelBlockedReason({ invoiceStatuses: [], paidPayments: 1 })).toContain('payment');
    const rec = src('apps/api/src/services/woRecord.ts');
    expect(fn(rec, 'export async function cancelWo(')).toContain('throw conflict(blocked, { code: CANCEL_BILLED_CODE });');
    expect(CANCEL_BILLED_CODE).toBe('CANCEL_BILLED');
    expect(src('apps/web/src/components/wo/record/RecordParts.tsx')).toContain('!record.can.cancel_blocked && (');
  });

  it('the phase bar ticks only phases the work order was in', () => {
    const wo = src('apps/api/src/services/workOrders.ts');
    expect(fn(wo, 'export async function getWorkOrderDetail(')).toContain('phases_visited: [...visited],');
    const bar = src('apps/web/src/components/wo/PhaseBar.tsx');
    expect(bar).toContain('const isDone = before && (!visited || visited.includes(phase));');
    expect(src('apps/web/src/components/wo/WoHeader.tsx')).toContain('visited={wo.phases_visited}');
  });
});

// ── M31 · reopen ─────────────────────────────────────────────────────────────

describe('M31 · Reopen says why and goes back', () => {
  it('finds the status the cancel moved the work order out of', () => {
    const rows = [
      { before: { status_id: 'b', status_name: 'Job Sched' }, after: { status_name: 'On Site (Job)' } },
      { before: { status_id: 'a', status_name: 'Approved' }, after: { status_name: 'Cancelled / Postponed' } },
    ];
    expect(statusBeforeCancel(rows)).toEqual({ status_id: 'a', status_name: 'Approved' });
    expect(statusBeforeCancel([rows[0]])).toBeNull();
  });

  it('needs a reason, stores the status on cancel and moves back through changeStatus', () => {
    const rec = src('apps/api/src/services/woRecord.ts');
    const reopen = fn(rec, 'export async function reopenWo(');
    expect(reopen).toContain("if (!why) throw badRequest('Say why it is reopened', { field: 'reason' });");
    expect(reopen).toContain('moveStatus(taskId, st.rows[0].id, st.rows[0].name, actor)');
    expect(fn(rec, 'export async function cancelWo(')).toContain('cancelled_from_status_id = status_id');
    expect(rec).toContain('await changeStatus(taskId, statusId, actor.id);');
    const route = src('apps/api/src/routes/woRecord.ts');
    expect(route).toContain('return reopenWo(taskId, reason ?? null, actor);');
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS cancelled_from_status_id uuid');
    expect(src('apps/web/src/api/client.ts')).toContain("recordPath(woRef, '/reopen'), { reason }");
  });
});

// ── helpers that must stay pure ──────────────────────────────────────────────

describe('Wave C helpers', () => {
  it('isDoneOrLaterStatus reads case-insensitively', () => {
    expect(isDoneOrLaterStatus('invoiced')).toBe(true);
    expect(isDoneOrLaterStatus('Approved')).toBe(false);
    expect(isDoneOrLaterStatus(undefined)).toBe(false);
  });
});
