// #13 (UAT round 1, Wave B) · a record opened by its own id follows its work
// order's scope.
//
// The queues (Payments, Invoicing, Vendor bills, …) were scoped since 0026,
// but a record reached by its OWN id — /payment-requests/:pid, /invoices/:id
// (and the invoice print page that reads it), /vendor-bills/:id, a billing
// proposal, a credit note, an approval task, a visit — loaded the row and
// never asked whether its work order was one the caller may see. An OM who
// could not open a work order could still read its payee's bank details by
// pasting the link. Every such route now calls `assertRecordInScope` before
// the service runs; the work-order routes already resolve through
// `resolveTaskId(id, actor)` (services/activity.ts). tests/uat-wave-b.test.ts
// pins the list.
//
// A record that does not exist passes here (the service answers its own
// 404); a work order in Trash is still checked, so a trashed work order's
// money does not become everyone's.

import { query } from '../db.js';
import type { ActingPrincipal } from './activity.js';
import { Params } from './woFields.js';
import { outOfScope, woScopeSql } from './woScope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The records that hang on a work order, and how to find which one. */
export const RECORD_TASK_SQL = {
  payment_request: `SELECT task_id::text AS task_id FROM payment_request WHERE id = $1`,
  invoice: `SELECT task_id::text AS task_id FROM invoice WHERE id = $1`,
  vendor_bill: `SELECT task_id::text AS task_id FROM vendor_bill WHERE id = $1`,
  billing_proposal: `SELECT task_id::text AS task_id FROM billing_proposal WHERE id = $1`,
  vendor_credit_note: `SELECT task_id::text AS task_id FROM vendor_credit_note WHERE id = $1`,
  approval_task: `SELECT task_id::text AS task_id FROM approval_task WHERE id = $1`,
  wo_visit: `SELECT task_id::text AS task_id FROM wo_visit WHERE id = $1`,
} as const;

export type ScopedRecord = keyof typeof RECORD_TASK_SQL;

/** 403 (the scope's own) when the work order is outside what the actor may
    see. Trashed work orders are checked too. */
export async function assertTaskInScope(taskId: string | null | undefined, actor: ActingPrincipal): Promise<void> {
  if (!taskId || !UUID_RE.test(taskId)) return;
  const p = new Params();
  const hole = p.add(taskId);
  const scope = woScopeSql(actor, p);
  if (!scope) return;
  const res = await query<{ in_scope: boolean }>(
    `SELECT ${scope} AS in_scope FROM task t WHERE t.id = ${hole}`,
    p.values,
  );
  if (res.rows[0] && !res.rows[0].in_scope) throw outOfScope();
}

/** Find the record's work order and check it (see the head of this file). */
export async function assertRecordInScope(kind: ScopedRecord, id: string, actor: ActingPrincipal): Promise<void> {
  if (!UUID_RE.test(id)) return;
  const res = await query<{ task_id: string | null }>(RECORD_TASK_SQL[kind], [id]);
  await assertTaskInScope(res.rows[0]?.task_id ?? null, actor);
}
