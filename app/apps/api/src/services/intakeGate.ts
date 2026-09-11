// Rules 11.1.1 / 11.1.2 — the "Ready to Assign" gate, database half.
//
// The vocabulary (which fields, what "filled" means, the sentence) is in
// @theone/shared intakeGate.ts; this file answers the question against the
// row and throws the 409. Two paths assign a work order and both ask:
//
//   accept    a manager accepting a new work order from Incoming (rule
//             7.1.3 — services/approvals.ts `decide`, before the decision
//             commits, so a refused accept leaves the task open);
//   by hand   somebody filling the Assignee seat directly on a work order
//             that is still waiting in Incoming (updateWorkOrderFields and
//             bulkUpdate, against the bag AS THE PATCH LEAVES IT — filling
//             Address and Assignee in one save is fine).
//
// A work order nobody is waiting to accept (the seeded history, one already
// running) is never gated: the gate stands at intake, not on every edit.

import { describeIntakeGate, intakeMissing, INTAKE_GATE_ERROR_CODE } from '@theone/shared';
import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';

/** The intake fields still empty on ONE work order (labels, the rule's
    order). `bag` lets a caller that is about to write the fields check the
    merged bag instead of the stored one. */
export async function intakeMissingFor(
  q: Queryable,
  taskId: string,
  bag?: Record<string, unknown>,
): Promise<string[]> {
  const res = await q.query<{
    fields: Record<string, unknown> | null;
    date_received: string | null;
    description: string | null;
    nte: number | string | null;
  }>(
    `SELECT t.fields, t.date_received::text AS date_received, t.description, t.nte
       FROM task t WHERE t.id = $1 LIMIT 1`,
    [taskId],
  );
  const r = res.rows[0];
  if (!r) return [];
  return intakeMissing({
    fields: bag ?? r.fields,
    date_received: r.date_received,
    description: r.description,
    nte: r.nte,
  }).map((f) => f.label);
}

/** True while a `wo_acceptance` task is open on the work order — it is
    still in Incoming, so assigning it by hand is the same act as accepting. */
export async function awaitingAcceptance(q: Queryable, taskId: string): Promise<boolean> {
  const res = await q.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM approval_task
                     WHERE task_id = $1 AND type = 'wo_acceptance' AND status = 'open') AS ok`,
    [taskId],
  );
  return Boolean(res.rows[0]?.ok);
}

/** Throws the 409 (`details.code = INTAKE_GATE`, `details.missing`) when
    the work order is not ready to be assigned. */
export async function assertReadyToAssign(
  q: Queryable,
  taskId: string,
  bag?: Record<string, unknown>,
): Promise<void> {
  const missing = await intakeMissingFor(q, taskId, bag);
  if (missing.length > 0) {
    throw new ApiError('CONFLICT', describeIntakeGate(missing.map((label) => ({ label }))), {
      code: INTAKE_GATE_ERROR_CODE,
      missing,
    });
  }
}
