// Cost and Total Invoiced, kept by the system (shared/moneyRules.ts has the
// two rules and why a field is only locked while its source exists).
//
//   syncCostFromPayments   called by payments.ts inside the transaction of
//                          every payment-request decision.
//   syncInvoicedFromQuote  called by workOrders.changeStatus after a move to
//                          Invoiced / Invoiced Not Paid commits.
//   assertMoneyNotLocked   called by the field editor and bulk edit, beside
//                          the visit-owned guard.
//
// A system write is an ordinary field change: one `field_updated` row stamped
// `via: 'payment'` or `via: 'quote'`, Profit re-derived, and the automations
// dispatched after the commit — so a payment that takes Cost past the NTE
// raises the NTE override exactly as typing the cost does (rule 1.5.2).
//
// This module must not import payments.ts, quotes.ts or workOrders.ts at the
// top level for anything but types: they call into it.

import {
  COST_FIELD_KEY,
  COST_LOCKED_MESSAGE,
  INVOICED_LOCKED_MESSAGE,
  TOTAL_INVOICED_FIELD_KEY,
  costDecision,
  invoicedFromQuote,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import { applyProfitFormula } from './money.js';
import { changed, logTaskChanges, type ChangeSource, type TaskChange } from './woAudit.js';

/** Write one bag key as the system. Returns the change, or [] when the field
    already held the value. `value` null clears the key. */
async function writeField(
  q: Queryable,
  taskId: string,
  actorId: string,
  key: string,
  value: number | null,
  source: ChangeSource,
): Promise<TaskChange[]> {
  const t = await q.query<{ fields: Record<string, unknown> | null }>(
    `SELECT fields FROM task WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [taskId],
  );
  if (!t.rows[0]) return [];
  const fields = t.rows[0].fields ?? {};
  const before = fields[key] ?? null;
  // Compared as numbers: the bag may hold "250", 250 or "250.00".
  const same =
    value === null
      ? before === null || before === ''
      : before !== null && before !== '' && Number(String(before).replace(/[$,\s]/g, '')) === value;
  if (same || !changed(before, value)) return [];

  const merged: Record<string, unknown> = { ...fields };
  if (value === null) delete merged[key];
  else merged[key] = value;
  applyProfitFormula(merged);
  await q.query(`UPDATE task SET fields = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(merged), taskId]);
  const changes: TaskChange[] = [{ field: `fields.${key}`, before, after: value }];
  await logTaskChanges(q, actorId, taskId, changes, source);
  return changes;
}

/**
 * Cost := the sum of the accepted payment requests. Runs INSIDE the caller's
 * transaction, so the decision and the figure it implies commit together.
 * `justUnaccepted` = this decision took back a request that had counted.
 * The caller dispatches automations with the returned changes after it commits.
 */
export async function syncCostFromPayments(
  tx: Queryable,
  taskId: string,
  actorId: string,
  justUnaccepted: boolean,
): Promise<TaskChange[]> {
  const rows = await tx.query<{ status: string; amount: string | number | null }>(
    `SELECT status, amount FROM payment_request WHERE task_id = $1`,
    [taskId],
  );
  const d = costDecision(rows.rows, justUnaccepted);
  if (d.action === 'keep') return [];
  return writeField(tx, taskId, actorId, COST_FIELD_KEY, d.action === 'set' ? d.cost : null, 'payment');
}

/**
 * Total Invoiced := the quote's total. Called after a status move to an
 * invoiced status has committed; `quoteTotal` is read by the caller (the
 * quote service imports this module's callers, not the other way round).
 * A work order with no quote, or a quote totalling nothing, is left alone.
 */
export async function syncInvoicedFromQuote(taskId: string, actorId: string, quoteTotal: number | null): Promise<TaskChange[]> {
  const total = invoicedFromQuote(quoteTotal);
  if (total === null) return [];
  let changes: TaskChange[] = [];
  await withTransaction(async (tx) => {
    changes = await writeField(tx, taskId, actorId, TOTAL_INVOICED_FIELD_KEY, total, 'quote');
  });
  return changes;
}

// ── The write guard ──────────────────────────────────────────────────────────

/**
 * 400 when a hand edit (the field editor, bulk edit, an automation's action)
 * names Cost or Total Invoiced on a work order where the SYSTEM put the
 * current figure there: the field's latest change in the audit log is stamped
 * `via: 'payment'` / `via: 'quote'` and holds a value. A figure somebody
 * typed — every work order from before these rules, and any with no accepted
 * payment or no quote — stays correctable by hand until the system writes it.
 */
export async function assertMoneyNotLocked(taskIds: string[], jsonKeys: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const checks: [string, string, string][] = [
    [COST_FIELD_KEY, 'payment', COST_LOCKED_MESSAGE],
    [TOTAL_INVOICED_FIELD_KEY, 'quote', INVOICED_LOCKED_MESSAGE],
  ];
  for (const [key, via, message] of checks) {
    if (!jsonKeys.includes(key)) continue;
    const res = await query<{ wo_number: string }>(
      `SELECT t.wo_number
         FROM task t
         JOIN LATERAL (SELECT a.after
                         FROM activity_log a
                        WHERE a.entity_type = 'task' AND a.entity_id = t.id::text
                          AND a.action = 'field_updated' AND a.field = $2
                        ORDER BY a.id DESC LIMIT 1) last ON true
        WHERE t.id = ANY($1::uuid[])
          AND last.after->>'via' = $3
          AND last.after->>'value' IS NOT NULL
        ORDER BY t.wo_number LIMIT 6`,
      [taskIds, `fields.${key}`, via],
    );
    if (res.rows.length > 0) throw locked(key, message, res.rows, taskIds.length);
  }
}

function locked(key: string, message: string, rows: { wo_number: string }[], selected: number): ApiError {
  // One work order: the message is about "this work order". A selection: name
  // the ones in the way, so the rest can be edited without them.
  const text =
    selected === 1
      ? message
      : `${message} In this selection: ${rows.slice(0, 5).map((r) => r.wo_number).join(', ')}${rows.length > 5 ? ' and more' : ''}.`;
  return new ApiError('BAD_REQUEST', text, { money_locked_field: key, work_orders: rows.map((r) => r.wo_number) });
}
