// Cost and Total Invoiced, kept by the system (shared/moneyRules.ts has the
// two rules and why a field is only locked while its source exists).
//
//   addToCost              called by payments.ts inside the transaction of a
//                          pay (+amount) or of deleting a paid request
//                          (−amount) — the Yoda rule, 0076.
//   syncCostFromPayments   the pre-0076 rule (Cost = sum of accepted
//                          requests); no longer called.
//   setInvoicedFromInvoice called by invoices.ts inside the transaction that
//                          sends an invoice (0083, #10): Total Invoiced := the
//                          invoice's total. syncInvoicedFromQuote (the
//                          pre-0083 stamp from the quote on a move to
//                          Invoiced) is no longer called.
//   assertMoneyNotLocked   called by the field editor, bulk edit and the
//                          create paths: Cost and Total Invoiced are never
//                          typed (Cost since 2026-11-16, UAT #24).
//
// A system write is an ordinary field change: one `field_updated` row stamped
// `via: 'payment'` or `via: 'invoice'`, Profit re-derived, and the automations
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
  // Locked FOR NO KEY UPDATE on the caller's transaction (the strength is
  // explained in woFieldValues.ts): the merge below is over the row as it is.
  const t = await q.query<{ fields: Record<string, unknown> | null }>(
    `SELECT fields FROM task WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`,
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
 * Pre-0076 (unused): Cost := the sum of the accepted, undeleted payment requests. Runs INSIDE the caller's
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
    `SELECT status, amount FROM payment_request WHERE task_id = $1 AND deleted_at IS NULL`,
    [taskId],
  );
  const d = costDecision(rows.rows, justUnaccepted);
  if (d.action === 'keep') return [];
  return writeField(tx, taskId, actorId, COST_FIELD_KEY, d.action === 'set' ? d.cost : null, 'payment');
}

/**
 * Yoda UpdateCostInClickUp (0076, Jeff's rules): Cost += the amount when AP
 * pays a request, −= it when a paid request is deleted. Whatever Cost already
 * held (typed, imported) is the starting point, never overwritten; it does
 * not go below zero. Runs INSIDE the caller's transaction and writes through
 * writeField, so it is an ordinary audited field change stamped
 * `via: 'payment'` (which also arms the lock) and re-derives Profit. The
 * caller dispatches automations with the returned changes after it commits.
 */
export async function addToCost(
  tx: Queryable,
  taskId: string,
  actorId: string,
  delta: number,
): Promise<TaskChange[]> {
  const t = await tx.query<{ cost: unknown }>(
    `SELECT fields -> $2 AS cost FROM task WHERE id = $1 AND deleted_at IS NULL`,
    [taskId, COST_FIELD_KEY],
  );
  if (!t.rows[0]) return [];
  const raw = t.rows[0].cost;
  const parsed = raw === null || raw === undefined || raw === '' ? 0 : Number(String(raw).replace(/[$,\s"]/g, ''));
  const before = Number.isFinite(parsed) ? parsed : 0;
  const after = Math.max(0, Math.round((before + delta + Number.EPSILON) * 100) / 100);
  return writeField(tx, taskId, actorId, COST_FIELD_KEY, after, 'payment');
}

/**
 * 0083 (#10): Total Invoiced := the total of the invoice being sent. Runs
 * INSIDE the send's transaction, so the invoice and the figure it implies
 * commit together; an ordinary audited field change stamped `via: 'invoice'`.
 * The caller dispatches automations with the returned changes after it commits.
 */
export async function setInvoicedFromInvoice(
  tx: Queryable,
  taskId: string,
  actorId: string,
  total: number,
): Promise<TaskChange[]> {
  if (!Number.isFinite(total) || total <= 0) return [];
  return writeField(tx, taskId, actorId, TOTAL_INVOICED_FIELD_KEY, Math.round(total * 100) / 100, 'invoice');
}

/**
 * Pre-0083 (unused): Total Invoiced := the quote's total. Was called after a status move to an
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
 * 400 when a hand edit (the field editor, bulk edit, an automation's action,
 * the create paths) names Total Invoiced — it comes only from the invoice
 * that was sent (0083, #10) — or Cost, which only the payments write (Elise,
 * 2026-11-16, UAT #24 / #45; the expected figure goes in Projected Cost).
 * Until 2026-11-16 a typed Cost stood until the system first wrote one.
 *
 * `_q` stays so the callers that hold the task row lock keep passing their
 * transaction; the check no longer reads anything.
 */
export async function assertMoneyNotLocked(taskIds: string[], jsonKeys: string[], _q: Queryable = { query }): Promise<void> {
  if (taskIds.length === 0) return;
  if (jsonKeys.includes(TOTAL_INVOICED_FIELD_KEY)) {
    throw new ApiError('BAD_REQUEST', INVOICED_LOCKED_MESSAGE, { money_locked_field: TOTAL_INVOICED_FIELD_KEY });
  }
  if (jsonKeys.includes(COST_FIELD_KEY)) {
    throw new ApiError('BAD_REQUEST', COST_LOCKED_MESSAGE, { money_locked_field: COST_FIELD_KEY });
  }
}
