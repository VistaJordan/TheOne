/* AUDIT.md Must-fix · W1-8 — purchasing's award and every DELETE-then-INSERT
 * line rewrite run inside one transaction (architect decision D5).
 *
 * The database is pooled Postgres: `query()` runs each statement on whatever
 * connection is free, so a DELETE on one connection and the INSERTs that
 * follow on others were separate commits (a crash between them lost the
 * lines), and two people awarding the same request for quotation at once both
 * passed the status check on the pool and both drafted a purchase order. The
 * fix puts each act on one `withTransaction`; `awardQuote` locks the RFQ row
 * FOR UPDATE and reads its status again under the lock before it writes.
 *
 * The skeptic round widened it to the sibling writers on the same rows:
 * `saveVendorQuote` and `deleteVendorQuote` take the same row lock and re-check
 * the status under it; the award and the quote price their lines from a read
 * made UNDER the lock, not from the pool read before it; `saveRfq` and
 * `receiveOrder` run on one transaction (the RFQ's and the order's rows are
 * locked first); cancelling a request for quotation is one conditional
 * statement that refuses a request awarded since it was read.
 *
 * These are source-text assertions, in the house pattern (tests/docs.test.ts
 * reads AppShell.tsx the same way): no database is opened and no API module is
 * imported. They pin literal fragments — `withTransaction(`, the `tx` name of
 * the transaction parameter, `… FOR UPDATE`, and the leading words of each
 * statement (`tx.query(\`DELETE FROM job_plan_step …`). A reformat of either
 * service file (a renamed `tx`, a reflowed template string, a re-indented
 * block) turns them red without a behavioural change: update the fragment
 * here, which the failing assertion names. Every one of them fails on the tree
 * before its fix.
 *
 * The 2026-10-14 follow-up (FIX-RUNBOOK section 10) covers the sibling paths
 * the fix left out, at the foot of this file: `actOnRfq` send / close / reopen
 * as one conditional UPDATE each, `actOnOrder` cancel under the order's row
 * lock, `saveDocTemplate`'s default flip in one transaction, and `awardQuote`'s
 * blacklist check moved under the RFQ lock. Its skeptic round added the last
 * of the class: `actOnRequest`'s four moves, `actOnOrder` close and reopen
 * and the rewrites in `saveRequest` / `saveOrder` as conditional statements on
 * the status they move from, `actOnOrder` issue under the order's row lock,
 * and `saveDocTemplate` saved as "not the default" clearing that template only.
 * The third round (rule 1.2.1, "every button"): RFQ close and reopen, PO
 * reopen and a request's way back to draft write their audit row once their
 * conditional statement went through, so every move in the three act
 * functions logs exactly once.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const purchasing = readFileSync(new URL('../apps/api/src/services/purchasing.ts', import.meta.url), 'utf8');
const maintenance = readFileSync(new URL('../apps/api/src/services/maintenance.ts', import.meta.url), 'utf8');

/** The text of one top-level function: from its header to the first `}` at
 *  column 0 after it (both files close every function that way). */
function fn(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start < 0) throw new Error(`${header} is not in the file`);
  const end = src.indexOf('\n}', start);
  if (end < 0) throw new Error(`${header} never closes`);
  return src.slice(start, end + 2);
}

/** The `withTransaction(async (tx) => { … });` block that starts at or after `from`. */
function txBlock(body: string, from = 0): { start: number; end: number; inside: string } {
  const start = body.indexOf('withTransaction(', from);
  if (start < 0) throw new Error('no withTransaction( in the body');
  // The block closes with `});` at the indentation of the line that opened it.
  const lineStart = body.lastIndexOf('\n', start) + 1;
  const indent = body.slice(lineStart, start).match(/^\s*/)![0];
  const end = body.indexOf(`\n${indent}});`, start);
  if (end < 0) throw new Error('the withTransaction( block never closes');
  return { start, end, inside: body.slice(start, end) };
}

/** A statement sent straight to the pool. */
const bareQuery = /\bawait query[<(]/;

describe('awardQuote (purchasing.ts)', () => {
  it('runs inside one transaction', () => {
    expect(fn(purchasing, 'export async function awardQuote(')).toContain('withTransaction(');
  });

  it('locks the RFQ row FOR UPDATE and re-checks its status under the lock before awarding it', () => {
    const body = fn(purchasing, 'export async function awardQuote(');
    const { start, inside } = txBlock(body);
    const lock = inside.indexOf('FROM rfq WHERE id = $1 FOR UPDATE');
    const award = inside.indexOf("UPDATE rfq SET status = 'awarded'");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(award).toBeGreaterThan(lock);
    const recheck = inside.slice(lock, award);
    expect(recheck).toContain("=== 'awarded'");
    expect(recheck).toContain("=== 'cancelled'");
    expect(recheck).toContain('conflict(');
    // Nothing is written before the lock is taken.
    expect(body.slice(0, start)).not.toMatch(/await (tx\.)?query[<(]`UPDATE/);
  });

  it('writes the quote statuses, the RFQ, the order and the request through the transaction, never the pool', () => {
    const { inside } = txBlock(fn(purchasing, 'export async function awardQuote('));
    expect(inside).not.toMatch(bareQuery);
    expect(inside).toContain('tx.query(`UPDATE vendor_quote SET status');
    expect(inside).toContain("tx.query(`UPDATE rfq SET status = 'awarded'");
    expect(inside).toMatch(/createOrder\(\s*tx,/);
    expect(inside).toContain("tx.query(`UPDATE purchase_request SET status = 'ordered'");
  });

  it('logs the two audit rows and reads the RFQ and the order back only after the commit', () => {
    const body = fn(purchasing, 'export async function awardQuote(');
    const { end } = txBlock(body);
    const after = body.slice(end);
    expect(after.match(/logWo\(/g)?.length).toBe(2);
    expect(after).toContain("'Purchase order'");
    expect(after).toContain("'Request for quotation'");
    expect(after).toContain('loadRfq(');
    expect(after).toContain('getOrder(');
    expect(body.slice(0, end)).not.toContain('logWo(');
  });

  // Skeptic round: the lines and the winning prices were read on the pool
  // BEFORE the lock, so a quote or a line rewritten in between priced the order
  // from stale data. They are read again under the lock now.
  it('reads the winning quote, the lines and the prices through the transaction, after the lock and before any write', () => {
    const body = fn(purchasing, 'export async function awardQuote(');
    const { start, inside } = txBlock(body);
    const lock = inside.indexOf('FOR UPDATE');
    const firstWrite = inside.indexOf('tx.query(`UPDATE');
    const quote = inside.indexOf('FROM vendor_quote WHERE id = $1 AND rfq_id = $2');
    const lines = inside.indexOf('FROM rfq_line WHERE rfq_id = $1');
    const prices = inside.indexOf('FROM vendor_quote_line WHERE quote_id = $1');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeGreaterThan(lock);
    for (const at of [quote, lines, prices]) {
      expect(at).toBeGreaterThan(lock);
      expect(at).toBeLessThan(firstWrite);
    }
    // The order's lines are built inside the block, never from the pool read above it.
    expect(inside).toContain('unit_cost:');
    expect(body.slice(0, start)).not.toContain('unit_cost:');
    expect(body.slice(0, start)).not.toContain('.prices');
  });

  it('logs the amount the locked read found, not the one read on the pool', () => {
    const body = fn(purchasing, 'export async function awardQuote(');
    const after = body.slice(txBlock(body).end);
    expect(after).toContain('won.total.toFixed(2)');
    expect(after).not.toContain('win.total');
  });
});

describe('the line rewrites run on the caller’s transaction (purchasing.ts)', () => {
  it.each([
    ['writeRequestLines', 'purchase_request_line'],
    ['writeOrderLines', 'purchase_order_line'],
  ])('%s takes a Queryable and never touches the pool', (name, table) => {
    const body = fn(purchasing, `async function ${name}(`);
    expect(body).toContain(`async function ${name}(q: Queryable,`);
    expect(body).toContain(`q.query(\`DELETE FROM ${table} WHERE`);
    expect(body).toContain(`q.query(\`INSERT INTO ${table}`);
    expect(body).not.toMatch(bareQuery);
  });

  it('createOrder takes a Queryable, writes through it, and leaves the audit row and the read-back to the caller', () => {
    const body = fn(purchasing, 'async function createOrder(');
    expect(body).toContain('async function createOrder(q: Queryable,');
    expect(body).not.toMatch(bareQuery);
    expect(body).toContain('q.query<{ id: string; po_number: string }>(');
    expect(body).toContain('writeOrderLines(q,');
    expect(body).not.toContain('getOrder(');
    expect(body).not.toContain('logWo(');
  });

  it.each(['export async function saveOrder(', 'export async function awardQuote('])('%s calls createOrder inside a transaction and logs the draft after it', (header) => {
    const body = fn(purchasing, header);
    const call = body.search(/createOrder\(\s*tx,/);
    expect(call).toBeGreaterThanOrEqual(0);
    const { start, end } = txBlock(body, body.lastIndexOf('withTransaction(', call));
    expect(start).toBeLessThan(call);
    expect(end).toBeGreaterThan(call);
    const drafted = body.indexOf("'Purchase order', `${", end);
    expect(drafted).toBeGreaterThan(end);
    expect(body.slice(drafted, drafted + 80)).toContain('drafted for');
  });
});

describe('saveRequest and saveVendorQuote (purchasing.ts)', () => {
  it('saveRequest writes the request and its lines in one transaction, then logs and reads back', () => {
    const body = fn(purchasing, 'export async function saveRequest(');
    const { inside, end } = txBlock(body);
    expect(inside).not.toMatch(bareQuery);
    expect(inside).toContain('tx.query(');
    expect(inside).toContain('UPDATE purchase_request SET');
    expect(inside).toContain('INSERT INTO purchase_request (');
    expect(inside).toContain('writeRequestLines(tx,');
    const after = body.slice(end);
    expect(after).toContain('logWo(');
    expect(after).toContain('loadRequest(');
    expect(body.slice(0, end)).not.toContain('logWo(');
  });

  it('saveVendorQuote records the vendor, the quote and its prices in one transaction', () => {
    const body = fn(purchasing, 'export async function saveVendorQuote(');
    const { inside, end } = txBlock(body);
    expect(inside).not.toMatch(bareQuery);
    expect(inside).toContain('tx.query(`INSERT INTO rfq_vendor');
    expect(inside).toContain('INSERT INTO vendor_quote (');
    expect(inside).toContain('tx.query(`DELETE FROM vendor_quote_line WHERE quote_id = $1`');
    expect(inside).toContain('tx.query(`INSERT INTO vendor_quote_line');
    expect(body).not.toContain('await query(`DELETE FROM vendor_quote_line');
    const after = body.slice(end);
    expect(after).toContain('logWo(');
    expect(after).toContain('loadRfq(');
  });

  // Skeptic round: the status was checked on the pool only, so a quote could
  // land on a request awarded or cancelled a moment later, priced against
  // lines read before the lock.
  it('saveVendorQuote locks the RFQ row, re-checks its status and prices the lines as they stand under the lock', () => {
    const body = fn(purchasing, 'export async function saveVendorQuote(');
    const { start, inside } = txBlock(body);
    const lock = inside.indexOf('FROM rfq WHERE id = $1 FOR UPDATE');
    const firstWrite = inside.indexOf('tx.query(`INSERT INTO rfq_vendor');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeGreaterThan(lock);
    const recheck = inside.slice(lock, firstWrite);
    expect(recheck).toContain("'awarded'");
    expect(recheck).toContain("'cancelled'");
    expect(recheck).toContain('conflict(');
    expect(recheck).toContain('FROM rfq_line WHERE rfq_id = $1');
    expect(recheck).toContain('quoteTotalFromLines(');
    expect(body.slice(0, start)).not.toContain('quoteTotalFromLines(');
    expect(body.slice(0, start)).not.toMatch(/await (tx\.)?query[<(]`(INSERT|UPDATE|DELETE)/);
  });
});

// Skeptic round: the other writers on an RFQ's rows.
describe('deleteVendorQuote and cancelling an RFQ (purchasing.ts)', () => {
  it('deleteVendorQuote removes the quote under the RFQ row lock, after re-checking it is not awarded', () => {
    const body = fn(purchasing, 'export async function deleteVendorQuote(');
    const { inside, end } = txBlock(body);
    expect(inside).not.toMatch(bareQuery);
    const lock = inside.indexOf('FROM rfq WHERE id = $1 FOR UPDATE');
    const del = inside.indexOf('tx.query(`DELETE FROM vendor_quote WHERE id = $1 AND rfq_id = $2');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(lock);
    const recheck = inside.slice(lock, del);
    expect(recheck).toContain("=== 'awarded'");
    expect(recheck).toContain('conflict(');
    expect(body).not.toContain('await query(`DELETE FROM vendor_quote');
    expect(body.slice(end)).toContain('loadRfq(');
  });

  it('cancelling refuses, in the same statement, a request awarded since it was read', () => {
    const body = fn(purchasing, 'export async function actOnRfq(');
    const cancel = body.indexOf("UPDATE rfq SET status = 'cancelled'");
    expect(cancel).toBeGreaterThanOrEqual(0);
    const stmt = body.slice(cancel, body.indexOf('`', cancel));
    expect(stmt).toContain("AND status <> 'awarded'");
    expect(stmt).toContain('RETURNING id');
    const log = body.indexOf('logWo(', cancel);
    expect(log).toBeGreaterThan(cancel);
    expect(body.slice(cancel, log)).toContain('conflict(');
  });
});

describe('saveRfq (purchasing.ts)', () => {
  it('writes the request for quotation, its lines and its vendors in one transaction, then logs and reads back', () => {
    const body = fn(purchasing, 'export async function saveRfq(');
    const { start, inside, end } = txBlock(body);
    expect(inside).not.toMatch(bareQuery);
    expect(inside).toContain('tx.query(`UPDATE rfq SET task_id');
    expect(inside).toContain('INSERT INTO rfq (');
    expect(inside).toContain('tx.query(`UPDATE rfq_line SET');
    expect(inside).toContain('tx.query(`INSERT INTO rfq_line');
    expect(inside).toContain('tx.query(`DELETE FROM rfq_line WHERE');
    expect(inside).toContain('tx.query(`DELETE FROM rfq_vendor WHERE');
    expect(inside).toContain('INSERT INTO rfq_vendor (rfq_id, vendor_id) SELECT');
    expect(body.slice(0, start)).not.toMatch(bareQuery);
    const after = body.slice(end);
    expect(after).not.toMatch(bareQuery);
    expect(after).toContain('logWo(');
    expect(after).toContain('loadRfq(');
    expect(body.slice(0, end)).not.toContain('logWo(');
  });

  it('locks an existing request, re-checks its status under the lock and reads its lines there', () => {
    const body = fn(purchasing, 'export async function saveRfq(');
    const { inside } = txBlock(body);
    const lock = inside.indexOf('FROM rfq WHERE id = $1 FOR UPDATE');
    const update = inside.indexOf('tx.query(`UPDATE rfq SET task_id');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(update).toBeGreaterThan(lock);
    const recheck = inside.slice(lock, update);
    expect(recheck).toContain("'awarded'");
    expect(recheck).toContain("'cancelled'");
    expect(recheck).toContain('conflict(');
    expect(inside).toContain('FROM rfq_line WHERE rfq_id = $1');
    expect(inside).not.toContain('before?.lines');
    expect(inside).not.toContain('before.lines');
  });
});

describe('receiveOrder (purchasing.ts)', () => {
  it('writes the received quantities and the derived status in one transaction, under the order’s row lock', () => {
    const body = fn(purchasing, 'export async function receiveOrder(');
    const { start, inside, end } = txBlock(body);
    expect(inside).not.toMatch(bareQuery);
    const lock = inside.indexOf('FROM purchase_order WHERE id = $1 FOR UPDATE');
    const qty = inside.indexOf('tx.query(`UPDATE purchase_order_line SET received_qty');
    const status = inside.indexOf('tx.query(`UPDATE purchase_order SET status = $2');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(qty).toBeGreaterThan(lock);
    expect(status).toBeGreaterThan(qty);
    expect(inside.slice(lock, qty)).toContain('conflict(');
    expect(inside).toContain('poStatusAfterReceipt(');
    expect(body.slice(0, start)).not.toMatch(bareQuery);
    const after = body.slice(end);
    expect(after).toContain('logWo(');
    expect(after).toContain('getOrder(');
    expect(body.slice(0, end)).not.toContain('logWo(');
  });
});

describe('saveJobPlan (maintenance.ts)', () => {
  it('imports withTransaction', () => {
    expect(maintenance).toMatch(/import \{[^}]*\bwithTransaction\b[^}]*\} from '\.\.\/db\.js'/);
  });

  it('writes the plan, its steps and its services in one transaction', () => {
    const body = fn(maintenance, 'export async function saveJobPlan(');
    const { inside } = txBlock(body);
    expect(inside).not.toMatch(bareQuery);
    expect(inside).toContain('UPDATE job_plan SET');
    expect(inside).toContain('INSERT INTO job_plan (');
    expect(inside).toContain('tx.query(`DELETE FROM job_plan_step WHERE plan_id = $1`');
    expect(inside).toContain('tx.query(`INSERT INTO job_plan_step');
    expect(inside).toContain('tx.query(`DELETE FROM job_plan_service WHERE plan_id = $1`');
    expect(inside).toContain('INSERT INTO job_plan_service');
    expect(body).not.toContain('await query(`DELETE FROM job_plan_step');
    expect(body).not.toContain('await query(`DELETE FROM job_plan_service');
  });

  it('reads the plan back and logs the admin change after the commit', () => {
    const body = fn(maintenance, 'export async function saveJobPlan(');
    const { end } = txBlock(body);
    const after = body.slice(end);
    expect(after).toContain('loadPlans(');
    expect(after).toContain('logAdminEvent(');
    expect(after).toContain('listJobPlans(actor)');
  });
});

// 2026-10-14 follow-up (FIX-RUNBOOK section 10): the sibling paths W1-8 left
// out. `actOnRfq` send, close and reopen were single pool UPDATEs with no
// status guard (a reopen racing an award wrote 'sent' over 'awarded');
// `actOnOrder` cancel was two pool statements, the order and then its request;
// `saveDocTemplate` cleared the old default and set the new one in two
// commits; and `awardQuote` asked whether the vendor was blacklisted on the
// pool, before it took the lock.

describe('actOnRfq send, close and reopen (purchasing.ts)', () => {
  const body = fn(purchasing, 'export async function actOnRfq(');

  it.each([
    ['send', "UPDATE rfq SET status = 'sent'", "AND status = 'draft'", 'Only a draft can be marked as sent'],
    ['close', "UPDATE rfq SET status = 'closed'", "AND status = 'sent'", 'Only a request that is out to vendors can be closed'],
    ['reopen', 'UPDATE rfq SET status = $2', 'AND status = $3', 'Only a closed or cancelled request can be reopened'],
  ])('%s is one conditional UPDATE on the status it moves from, refused when no row comes back', (_action, head, guard, message) => {
    const at = body.indexOf(head);
    expect(at).toBeGreaterThanOrEqual(0);
    const stmt = body.slice(at, body.indexOf('`', at));
    expect(stmt).toContain(`WHERE id = $1 ${guard} RETURNING id`);
    // The refusal follows the statement, inside the same branch.
    const branch = body.slice(at, body.indexOf('\n  }', at));
    expect(branch).toContain('if (!done.rows[0]) throw conflict(');
    expect(branch).toContain(message);
  });

  it('reopen must still find the request in the status it was read in', () => {
    const at = body.indexOf('UPDATE rfq SET status = $2');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(body.slice(at, body.indexOf('\n', at))).toContain("[id, cur.sent_at ? 'sent' : 'draft', cur.status]");
  });

  it('never moves a request for quotation unconditionally', () => {
    expect(body).not.toMatch(/UPDATE rfq SET[^`]*WHERE id = \$1`/);
  });

  it('send logs its audit row only once the conditional statement went through', () => {
    const at = body.indexOf("UPDATE rfq SET status = 'sent'");
    const log = body.indexOf('logWo(', at);
    expect(log).toBeGreaterThan(at);
    expect(body.slice(at, log)).toContain('conflict(');
  });
});

describe('actOnOrder cancel (purchasing.ts)', () => {
  const body = fn(purchasing, 'export async function actOnOrder(');
  const cancel = () => txBlock(body, body.indexOf("action === 'cancel'"));

  it('locks the order, re-checks it under the lock, and cancels it and frees its request in one transaction', () => {
    const { inside } = cancel();
    expect(inside).not.toMatch(bareQuery);
    const lock = inside.indexOf('SELECT status FROM purchase_order WHERE id = $1 FOR UPDATE');
    const off = inside.indexOf("tx.query(`UPDATE purchase_order SET status = 'cancelled'");
    const free = inside.indexOf("tx.query(`UPDATE purchase_request SET status = 'approved'");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(off).toBeGreaterThan(lock);
    expect(free).toBeGreaterThan(off);
    const recheck = inside.slice(lock, off);
    expect(recheck).toContain("'cancelled'");
    expect(recheck).toContain("'closed'");
    expect(recheck).toContain('conflict(');
    // The grant depends on the status, and a receipt moves the order while
    // holding the same lock: both are asked again there.
    expect(recheck).toContain('requirePerm(');
    expect(recheck).toContain('FROM purchase_order_line WHERE po_id = $1');
    expect(body).not.toContain("await query(`UPDATE purchase_order SET status = 'cancelled'");
    expect(body).not.toContain("await query(`UPDATE purchase_request SET status = 'approved'");
  });

  it('logs the cancellation after the commit, never inside it', () => {
    const { inside, end } = cancel();
    expect(inside).not.toContain('logWo(');
    expect(body.indexOf('`${cur.po_number} cancelled`')).toBeGreaterThan(end);
  });
});

describe('saveDocTemplate (purchasing.ts)', () => {
  const body = fn(purchasing, 'export async function saveDocTemplate(');

  it('making a template the default clears the kind’s old default and sets this one in one transaction, then logs', () => {
    const { inside, end } = txBlock(body);
    expect(inside).not.toMatch(bareQuery);
    expect(inside).toContain('tx.query(`UPDATE doc_template SET is_default = false WHERE kind = $1 AND is_default`');
    expect(inside).toContain('tx.query(`UPDATE doc_template SET is_default = true, is_active = true WHERE id = $1`');
    expect(body.slice(end)).toContain('logAdminEvent(');
    expect(body.slice(0, end)).not.toContain('logAdminEvent(');
  });

  // Skeptic round two: saved as "not the default", the old code cleared
  // whichever template of the kind WAS the default — and the Admin card sends
  // `is_default` with every save, so editing any other template of the kind
  // silently unset the one in use.
  it('saved as not the default, clears this template only', () => {
    const { start, end } = txBlock(body);
    const branch = body.slice(body.lastIndexOf('if (input.is_default) {', start), body.indexOf('\n  }', end));
    expect(branch).toContain('await withTransaction(');
    expect(branch).toContain('} else {');
    expect(branch).toContain('await query(`UPDATE doc_template SET is_default = false WHERE id = $1`, [rowId])');
    // The kind-wide clear runs only on the way to setting a new default.
    expect(body.split('WHERE kind = $1 AND is_default').length - 1).toBe(1);
    expect(body).not.toContain('if (input.is_default) await tx.query(');
  });
});

describe('awardQuote asks about the blacklist under the lock (purchasing.ts)', () => {
  it('reads the vendor’s blacklist flag through the transaction, after the lock and before any write, never on the pool', () => {
    const body = fn(purchasing, 'export async function awardQuote(');
    const { start, inside } = txBlock(body);
    const lock = inside.indexOf('FOR UPDATE');
    const firstWrite = inside.indexOf('tx.query(`UPDATE');
    const flag = inside.indexOf('tx.query<{ blacklisted: boolean }>(`SELECT blacklisted FROM vendor WHERE id = $1`');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(flag).toBeGreaterThan(lock);
    expect(flag).toBeLessThan(firstWrite);
    expect(inside.slice(flag, firstWrite)).toContain('is blacklisted and cannot be awarded an order');
    // Nothing is asked of the pool before the lock, the blacklist least of all.
    expect(body.slice(0, start)).not.toMatch(bareQuery);
    expect(body.slice(0, start)).not.toContain('SELECT blacklisted');
  });
});

// Skeptic round two: the last of the class, listed as open by the follow-up.
// `actOnRequest`'s four moves and `actOnOrder` issue / close / reopen were an
// unconditional UPDATE after a pool pre-check (an issue racing a cancel wrote
// 'issued' over 'cancelled'; an approve racing a cancel wrote 'approved' over
// it), and the rewrites in `saveRequest` and `saveOrder` could land on a
// request or an order that had moved since it was read.

describe('actOnRequest (purchasing.ts)', () => {
  const body = fn(purchasing, 'export async function actOnRequest(');

  it('moves a request in one conditional statement on the status it was read in, refused when no row comes back', () => {
    const at = body.indexOf('UPDATE purchase_request SET status = $2');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(body.slice(at, body.indexOf('`', at))).toContain('WHERE id = $1 AND status = $3 RETURNING id');
    expect(body.slice(at, body.indexOf('\n', at))).toContain('[id, status, cur.status, ...params]');
    const helper = body.slice(body.indexOf('const set = async ('), body.indexOf('\n  };'));
    expect(helper).toContain('if (!done.rows[0]) throw conflict(refused)');
  });

  it('never moves a request unconditionally', () => {
    expect(body).not.toMatch(/UPDATE purchase_request SET[^`]*WHERE id = \$1`/);
  });

  it('numbers the columns a move sets after the status guard', () => {
    expect(body).toContain('requested_by = COALESCE(requested_by, $4)');
    expect(body).toContain('decided_by = $4, decided_at = now(), decision_note = $5');
    expect(body).not.toContain('COALESCE(requested_by, $3)');
    expect(body).not.toContain('decided_by = $3');
  });

  it.each([
    ['submit', "set('submitted', 'Only a draft can be submitted', "],
    ['approve / reject', "set(action === 'approve' ? 'approved' : 'rejected', 'This request is not waiting for a decision', "],
    ['cancel', "set('cancelled', 'The request moved on since it was opened: reload it')"],
    ['back to draft', "set('draft', 'Only a rejected or a cancelled request can go back to draft')"],
  ])('%s names the refusal the statement raises when the request has moved', (_action, call) => {
    expect(body).toContain(call);
  });
});

describe('saveRequest and saveOrder rewrite only a record that has not moved (purchasing.ts)', () => {
  it('saveRequest updates a request only while it is a draft or rejected, in the statement, before its lines are rewritten', () => {
    const body = fn(purchasing, 'export async function saveRequest(');
    const { inside } = txBlock(body);
    const guard = inside.indexOf("WHERE id = $1 AND status IN ('draft', 'rejected') RETURNING id`");
    const lines = inside.indexOf('writeRequestLines(tx,');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(lines).toBeGreaterThan(guard);
    expect(inside.slice(guard, lines)).toContain("throw conflict('Only a draft or a rejected request can be changed')");
  });

  it('saveOrder updates an order only while it is a draft, in the statement, before its lines are rewritten', () => {
    const body = fn(purchasing, 'export async function saveOrder(');
    const { inside } = txBlock(body, body.indexOf('const before = await getOrder('));
    const guard = inside.indexOf("WHERE id = $1 AND status = 'draft' RETURNING id`");
    const lines = inside.indexOf('writeOrderLines(tx,');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(lines).toBeGreaterThan(guard);
    expect(inside.slice(guard, lines)).toContain('throw conflict(');
    expect(inside.slice(guard, lines)).toContain('Only a draft purchase order can be changed');
  });

  // The award moves the request with `AND status = 'approved'`; raising an
  // order from a request by hand moved it unconditionally, so a request
  // cancelled in between was written over and an order drafted from it.
  it('saveOrder, raising an order from a request, moves the request to ordered only while it is approved or ordered, in the statement', () => {
    const body = fn(purchasing, 'export async function saveOrder(');
    const { inside } = txBlock(body);
    const at = inside.indexOf("tx.query(`UPDATE purchase_request SET status = 'ordered'");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(inside.slice(at, inside.indexOf('`', at + 10))).toContain("WHERE id = $1 AND status IN ('approved', 'ordered') RETURNING id");
    expect(inside.slice(at)).toContain("throw conflict('Only an approved request can be ordered')");
    expect(body).not.toContain("UPDATE purchase_request SET status = 'ordered', updated_at = now() WHERE id = $1`");
  });
});

describe('actOnOrder issue, close and reopen (purchasing.ts)', () => {
  const body = fn(purchasing, 'export async function actOnOrder(');
  const issue = () => txBlock(body, body.indexOf("action === 'issue'"));

  it('issue locks the order, re-checks under the lock that it is still a draft with lines and a value, and issues it through the transaction', () => {
    const { inside, end } = issue();
    expect(end).toBeLessThan(body.indexOf("action === 'close'"));
    expect(inside).not.toMatch(bareQuery);
    const lock = inside.indexOf('FROM purchase_order WHERE id = $1 FOR UPDATE');
    const write = inside.indexOf("tx.query(`UPDATE purchase_order SET status = 'issued'");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(lock);
    const recheck = inside.slice(lock, write);
    expect(recheck).toContain("!== 'draft'");
    expect(recheck).toContain('Only a draft can be issued');
    expect(recheck).toContain('FROM purchase_order_line WHERE po_id = $1');
    expect(recheck).toContain('List what is being ordered first.');
    expect(recheck).toContain('The order has no value yet');
    expect(body).not.toContain("await query(`UPDATE purchase_order SET status = 'issued'");
  });

  it('issue logs and notifies after the commit, with the figures the locked read found', () => {
    const { inside, end } = issue();
    expect(inside).not.toContain('logWo(');
    expect(inside).not.toContain('notify(');
    const after = body.slice(end, body.indexOf("action === 'close'"));
    expect(after).toContain('logWo(');
    expect(after).toContain('notify(');
    expect(after).toContain('issued.total.toFixed(2)');
    expect(after).toContain('issued.vendorName');
    expect(after).not.toContain('cur.total');
    expect(after).not.toContain('cur.vendor.name');
  });

  it.each([
    ['close', "UPDATE purchase_order SET status = 'closed'", "AND status IN ('issued', 'partially_received', 'received')", 'Only an issued order can be closed'],
    ['reopen', 'UPDATE purchase_order SET status = $2', "AND status = 'closed'", 'Only a closed order can be reopened'],
  ])('%s is one conditional UPDATE on the status it moves from, refused when no row comes back', (_action, head, guard, message) => {
    const at = body.indexOf(head);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(body.slice(at, body.indexOf('`', at))).toContain(`WHERE id = $1 ${guard} RETURNING id`);
    const branch = body.slice(at, body.indexOf('\n  }', at));
    expect(branch).toContain('if (!done.rows[0]) throw conflict(');
    expect(branch).toContain(message);
  });

  it('never moves an order unconditionally on the pool', () => {
    expect(body).not.toMatch(/await query\(`UPDATE purchase_order SET[^`]*WHERE id = \$1`/);
  });
});

// Skeptic round three (rule 1.2.1, "every button"): RFQ close and reopen, PO
// reopen and a purchase request's way back to draft moved the record and
// wrote no audit row. Each logs now, after its conditional statement went
// through: a refused move (no row came back) throws first and logs nothing.

describe('every move writes its audit row once its statement went through (purchasing.ts)', () => {
  it.each([
    ['actOnRfq close', 'export async function actOnRfq(', "UPDATE rfq SET status = 'closed'", 'if (!done.rows[0]) throw conflict(', '`${cur.rfq_number} closed`'],
    ['actOnRfq reopen', 'export async function actOnRfq(', 'UPDATE rfq SET status = $2', 'if (!done.rows[0]) throw conflict(', '`${cur.rfq_number} reopened'],
    ['actOnRequest back to draft', 'export async function actOnRequest(', "await set('draft', ", "await set('draft', ", '`${cur.pr_number} back to draft`'],
    ['actOnOrder reopen', 'export async function actOnOrder(', 'UPDATE purchase_order SET status = $2', 'if (!done.rows[0]) throw conflict(', '`${cur.po_number} reopened`'],
  ])('%s logs after its statement and its refusal, inside the same branch', (_name, header, stmt, refusal, row) => {
    const body = fn(purchasing, header);
    const at = body.indexOf(stmt);
    expect(at).toBeGreaterThanOrEqual(0);
    const branch = body.slice(at, body.indexOf('\n  }', at));
    const log = branch.indexOf('logWo(');
    expect(log).toBeGreaterThan(0);
    expect(branch.slice(0, log)).toContain(refusal);
    expect(branch.slice(log, branch.indexOf('\n', log))).toContain(row);
  });

  // Each act function is one if / else-if chain with one move per branch,
  // and every branch logs: no move is silent.
  it.each([
    ['actOnRequest', 'export async function actOnRequest('],
    ['actOnRfq', 'export async function actOnRfq('],
    ['actOnOrder', 'export async function actOnOrder('],
  ])('%s logs exactly once per branch', (_name, header) => {
    const body = fn(purchasing, header);
    const branches = body.split('\n  } else').length;
    expect(branches).toBe(4);
    expect(body.split('logWo(').length - 1).toBe(branches);
  });
});
