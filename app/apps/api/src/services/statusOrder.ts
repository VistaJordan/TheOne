// BRD 2.7 (Elise, 2026-11-04): each client follows its portal's steps. The
// tables and the rules are pure in packages/shared/src/statusOrder.ts; this is
// the database half — read where the work order sits and which portal it is
// on, and refuse a move the portal's steps do not allow (409 STATUS_ORDER).
//
// Asked by changeStatus (a person's move, a check-in, an approved request,
// Cancel / Reopen — not an automation, not the quote's own moves), bulk edit,
// a status request and its approval. Not asked: the CSV import (a data load)
// and work orders with no portal (on hold).

import {
  CLIENT_PORTAL_TYPE_KEY,
  STATUS_ORDER_CODE,
  checkStatusOrder,
  describeStatusOrderRefusal,
  statusOrderRefused,
  type StatusOrderVerdict,
} from '@theone/shared';
import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';

export function statusOrderError(v: StatusOrderVerdict): ApiError {
  return new ApiError('CONFLICT', describeStatusOrderRefusal(v), {
    code: STATUS_ORDER_CODE,
    portal: v.portal,
    from: v.from,
    to: v.to,
  });
}

/** Throws the 409 when the work order's portal does not allow the move from
    its current status (or `currentName`, when the caller already read it). */
export async function assertStatusOrder(
  q: Queryable,
  taskId: string,
  targetName: string,
  currentName?: string,
): Promise<void> {
  const res = await q.query<{ cur: string; portal: string | null }>(
    `SELECT s.name AS cur, t.fields->>'${CLIENT_PORTAL_TYPE_KEY}' AS portal
       FROM task t JOIN status s ON s.id = t.status_id
      WHERE t.id = $1 LIMIT 1`,
    [taskId],
  );
  const row = res.rows[0];
  if (!row) return;
  const v = checkStatusOrder(row.portal, currentName ?? row.cur, targetName);
  if (statusOrderRefused(v)) throw statusOrderError(v);
}
