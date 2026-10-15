// Vendor bills (0047) — the bill FROM the vendor, the AP half of invoicing.
//
// Mirrors services/invoices.ts on purpose: the same integer-cent arithmetic,
// the same "a document that has been agreed is not edited" lock, the same
// snapshot of lines. Two differences worth knowing:
//
//   there is no number to issue — the bill carries the VENDOR's number, and
//   two vendors can both send "INV-001";
//   approving is gated twice — `payments:approve` (may this person approve
//   vendor money at all) and the approval tier for the amount (rule 6.2.3,
//   services/approvalTiers.ts), so a $4,000 bill needs a team lead even when
//   an account manager could have approved a $400 one.
//
// 0083 (UAT round 1, Wave A, #20): a bill totals more than nothing; a
// vendor's bill number is on file once (409 VENDOR_BILL_DUPLICATE, backed by
// a partial unique index); whoever recorded a bill does not approve it (D2);
// a bill above what is still owed on the work order — the approved quote's
// cost side less what was paid and the other live bills — raises a
// `bill_over_owed` hold that refuses Approve until a manager decides it
// (D1b); every move is one conditional UPDATE on the status it was read in.

import {
  BILL_OVER_OWED_CODE,
  MONEY_MAX,
  SELF_APPROVAL_CODE,
  VALIDATION_CODE,
  billOverOwed,
  selfApprovalMessage,
  selfApprovalVerdict,
  vendorOwed,
  VENDOR_BILL_LOCKED_CODE,
  PAYMENT_PROCESS_PERM_KEY,
  vendorBillEditable,
  vendorBillLineAmount,
  vendorBillNextActions,
  vendorBillTotals,
  type VendorBill,
  type VendorBillCreateInput,
  type VendorBillLine,
  type VendorBillLineInput,
  type VendorBillStatus,
  type VendorBillUpdateInput,
  type VendorBillsResponse,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { approvedCover, openMoneyHold, raiseMoneyHold } from './approvals.js';
import { requirePerm } from './permissions.js';
import { woScopeSql } from './woScope.js';
import { Params } from './woFields.js';
import type { ActingPrincipal } from './activity.js';
import { assertTierAllows, listApprovalTiers, tierSummary } from './approvalTiers.js';

const PERM = 'payments';

function requireView(p: ActingPrincipal): void {
  requirePerm(p, PERM, 'view', 'You cannot see vendor bills');
}
function requireRecord(p: ActingPrincipal): void {
  requireView(p);
  requirePerm(p, PERM, 'create', 'You cannot record vendor bills');
}
function requireApprove(p: ActingPrincipal): void {
  requireView(p);
  requirePerm(p, PERM, 'approve', 'You cannot approve vendor bills');
}
function requireProcess(p: ActingPrincipal): void {
  requireView(p);
  requirePerm(p, PAYMENT_PROCESS_PERM_KEY, 'edit', 'You cannot mark vendor bills paid');
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  task_id: string;
  wo_number: string;
  client: string | null;
  vendor_id: string | null;
  vendor_name: string;
  bill_number: string | null;
  received_on: string;
  due_on: string | null;
  status: string;
  subtotal: string | number;
  tax: string | number;
  total: string | number;
  note: string | null;
  dispute_note: string | null;
  approved_by_id: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  paid_by_id: string | null;
  paid_by_name: string | null;
  paid_at: string | null;
  paid_reference: string | null;
  payment_request_id: string | null;
  contract_id: string | null;
  contract_name: string | null;
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  overdue_days: number | null;
}

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const SELECT = `
  SELECT b.id::text AS id, b.task_id::text AS task_id, t.wo_number, t.client,
         b.vendor_id::text AS vendor_id, b.vendor_name, b.bill_number,
         to_char(b.received_on, 'YYYY-MM-DD') AS received_on,
         to_char(b.due_on, 'YYYY-MM-DD') AS due_on,
         b.status, b.subtotal, b.tax, b.total, b.note, b.dispute_note,
         b.approved_by::text AS approved_by_id, ab.display_name AS approved_by_name,
         ${ISO('b.approved_at')} AS approved_at,
         b.paid_by::text AS paid_by_id, pb.display_name AS paid_by_name,
         ${ISO('b.paid_at')} AS paid_at, b.paid_reference,
         b.payment_request_id::text AS payment_request_id,
         b.contract_id::text AS contract_id, c.name AS contract_name,
         b.created_by::text AS created_by_id, cb.display_name AS created_by_name,
         ${ISO('b.created_at')} AS created_at,
         ${ISO('b.updated_at')} AS updated_at,
         CASE WHEN b.status IN ('received', 'approved', 'disputed') AND b.due_on IS NOT NULL AND b.due_on < now()::date
              THEN (now()::date - b.due_on) END AS overdue_days
    FROM vendor_bill b
    JOIN task t ON t.id = b.task_id
    LEFT JOIN principal ab ON ab.id = b.approved_by
    LEFT JOIN principal pb ON pb.id = b.paid_by
    LEFT JOIN principal cb ON cb.id = b.created_by
    LEFT JOIN contract c ON c.id = b.contract_id`;

const n = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

function mapRow(
  r: Row,
  lines: VendorBillLine[],
  tier: VendorBill['tier'],
): VendorBill {
  return {
    id: r.id,
    task_id: r.task_id,
    wo_number: r.wo_number,
    client: r.client,
    vendor_id: r.vendor_id,
    vendor_name: r.vendor_name,
    bill_number: r.bill_number,
    received_on: r.received_on,
    due_on: r.due_on,
    status: r.status as VendorBillStatus,
    subtotal: n(r.subtotal),
    tax: n(r.tax),
    total: n(r.total),
    note: r.note,
    dispute_note: r.dispute_note,
    approved_by: r.approved_by_id ? { id: r.approved_by_id, display_name: r.approved_by_name ?? '—' } : null,
    approved_at: r.approved_at,
    paid_by: r.paid_by_id ? { id: r.paid_by_id, display_name: r.paid_by_name ?? '—' } : null,
    paid_at: r.paid_at,
    paid_reference: r.paid_reference,
    payment_request_id: r.payment_request_id,
    contract_id: r.contract_id,
    contract_name: r.contract_name,
    created_by: r.created_by_id ? { id: r.created_by_id, display_name: r.created_by_name ?? '—' } : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    lines,
    overdue_days: r.overdue_days === null ? null : Number(r.overdue_days),
    tier,
  };
}

interface LineRow {
  id: string;
  bill_id: string;
  kind: string;
  description: string;
  quantity: string | number;
  unit_price: string | number;
  amount: string | number;
  position: number;
}

async function linesFor(ids: string[]): Promise<Map<string, VendorBillLine[]>> {
  const out = new Map<string, VendorBillLine[]>();
  if (ids.length === 0) return out;
  const res = await query<LineRow>(
    `SELECT id::text AS id, bill_id::text AS bill_id, kind, description, quantity, unit_price, amount, position
       FROM vendor_bill_line WHERE bill_id = ANY($1::uuid[]) ORDER BY position, created_at`,
    [ids],
  );
  for (const r of res.rows) {
    const list = out.get(r.bill_id) ?? [];
    list.push({
      id: r.id,
      kind: r.kind,
      description: r.description,
      quantity: n(r.quantity),
      unit_price: n(r.unit_price),
      amount: n(r.amount),
      position: r.position,
    });
    out.set(r.bill_id, list);
  }
  return out;
}

async function hydrate(rows: Row[], actor: ActingPrincipal): Promise<VendorBill[]> {
  const lines = await linesFor(rows.map((r) => r.id));
  const tiers = await listApprovalTiers();
  const bills = rows.map((r) =>
    mapRow(r, lines.get(r.id) ?? [], tierSummary(tiers, 'vendor_bill', n(r.total), actor)),
  );
  // 0083 (#20): an open over-what-is-owed hold on the bill's work order.
  const held = await query<{ bill_id: string; title: string }>(
    `SELECT a.detail->>'vendor_bill_id' AS bill_id, a.title FROM approval_task a
      WHERE a.type = 'bill_over_owed' AND a.status = 'open' AND a.task_id = ANY($1::uuid[])`,
    [[...new Set(rows.map((r) => r.task_id))]],
  );
  for (const b of bills) {
    const h = held.rows.find((x) => x.bill_id === b.id);
    b.money_hold = h ? `On hold — ${h.title}. A manager decides it under Approvals › Money holds.` : null;
  }
  // 0066 · the invoicing-rule warnings and the credit notes. Read-only
  // decoration: if it fails, the bills still come back as they always did.
  try {
    const { billExtrasFor } = await import('./vendorExtras.js');
    const extras = await billExtrasFor(bills.map((b) => ({ id: b.id, total: b.total, status: b.status })));
    for (const b of bills) Object.assign(b, extras.get(b.id) ?? {});
  } catch (err) {
    console.error('[vendor bills] could not read the rule warnings', err);
  }
  return bills;
}

export async function listVendorBills(actor: ActingPrincipal): Promise<VendorBillsResponse> {
  requireView(actor);
  const p = new Params();
  const scope = woScopeSql(actor, p);
  const res = await query<Row>(
    `${SELECT} WHERE t.deleted_at IS NULL${scope ? ` AND ${scope}` : ''}
      ORDER BY CASE b.status WHEN 'received' THEN 0 WHEN 'disputed' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
               b.received_on DESC, b.created_at DESC
      LIMIT 500`,
    p.values,
  );
  const items = await hydrate(res.rows, actor);
  const totals = {
    received: items.filter((b) => b.status === 'received').reduce((s, b) => s + b.total, 0),
    approved: items.filter((b) => b.status === 'approved').reduce((s, b) => s + b.total, 0),
    overdue: items.filter((b) => (b.overdue_days ?? 0) > 0).reduce((s, b) => s + b.total, 0),
    paid_30d: items
      .filter((b) => b.status === 'paid' && b.paid_at !== null && Date.now() - Date.parse(b.paid_at) < 30 * 86_400_000)
      .reduce((s, b) => s + b.total, 0),
  };
  return { items, totals };
}

export async function listVendorBillsForTask(taskId: string, actor: ActingPrincipal): Promise<VendorBill[]> {
  requireView(actor);
  const res = await query<Row>(`${SELECT} WHERE b.task_id = $1 ORDER BY b.received_on DESC, b.created_at DESC`, [taskId]);
  return hydrate(res.rows, actor);
}

export async function getVendorBill(id: string, actor: ActingPrincipal): Promise<VendorBill> {
  requireView(actor);
  const res = await query<Row>(`${SELECT} WHERE b.id = $1`, [id]);
  if (!res.rows[0]) throw notFound('No such vendor bill');
  return (await hydrate(res.rows, actor))[0];
}

// ── Recording and editing ────────────────────────────────────────────────────

function cleanLines(lines: VendorBillLineInput[]): Required<VendorBillLineInput>[] {
  return lines
    .map((l) => ({
      kind: l.kind ?? 'service',
      description: String(l.description ?? '').trim(),
      quantity: Number(l.quantity ?? 1),
      unit_price: Number(l.unit_price ?? 0),
    }))
    .filter((l) => l.description !== '');
}

async function writeLines(
  tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  billId: string,
  lines: Required<VendorBillLineInput>[],
): Promise<void> {
  await tx.query(`DELETE FROM vendor_bill_line WHERE bill_id = $1`, [billId]);
  let position = 0;
  for (const l of lines) {
    await tx.query(
      `INSERT INTO vendor_bill_line (bill_id, kind, description, quantity, unit_price, amount, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [billId, l.kind, l.description, l.quantity, l.unit_price, vendorBillLineAmount(l.quantity, l.unit_price), position++],
    );
  }
}

/** #20: a bill is money owed — more than nothing, and no more than a column holds. */
function assertBillTotal(total: number): void {
  if (!(total > 0)) throw badRequest('A bill has to total more than $0.00', { code: 'VENDOR_BILL_TOTAL' });
  if (total > MONEY_MAX) {
    throw badRequest(`A bill can total at most ${MONEY_MAX.toLocaleString('en-US')}`, { code: VALIDATION_CODE });
  }
}

/** #20: the same vendor's bill number once (void bills do not count). Asked
    on the caller's transaction after it locked the task row. */
async function assertBillNumberFree(
  tx: { query: <R = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> },
  vendorId: string | null,
  vendorName: string,
  billNumber: string | null,
  exceptId: string | null,
): Promise<void> {
  if (!billNumber) return;
  const dup = await tx.query<{ id: string; wo_number: string }>(
    `SELECT b.id::text AS id, t.wo_number FROM vendor_bill b JOIN task t ON t.id = b.task_id
      WHERE b.status <> 'void' AND lower(btrim(b.bill_number)) = lower(btrim($3))
        AND COALESCE(b.vendor_id::text, lower(btrim(b.vendor_name))) = COALESCE($1::text, lower(btrim($2)))
        AND ($4::uuid IS NULL OR b.id <> $4::uuid)
      LIMIT 1`,
    [vendorId, vendorName, billNumber, exceptId],
  );
  if (dup.rows[0]) {
    throw conflict(`${vendorName}'s bill ${billNumber} is already on file (on ${dup.rows[0].wo_number})`, {
      code: 'VENDOR_BILL_DUPLICATE',
      vendor_bill_id: dup.rows[0].id,
    });
  }
}

export async function createVendorBill(input: VendorBillCreateInput, actor: ActingPrincipal): Promise<VendorBill> {
  requireRecord(actor);
  const vendorName = String(input.vendor_name ?? '').trim();
  if (vendorName === '') throw badRequest('A bill needs the vendor it came from');
  const lines = cleanLines(input.lines ?? []);
  if (lines.length === 0) throw badRequest('A bill needs at least one line');
  const tax = Number(input.tax ?? 0);
  if (tax < 0) throw badRequest('Tax cannot be negative');
  const { subtotal, total } = vendorBillTotals(lines, tax);
  assertBillTotal(total);

  const task = await query<{ id: string }>(`SELECT id::text AS id FROM task WHERE id = $1 AND deleted_at IS NULL`, [input.task_id]);
  if (!task.rows[0]) throw notFound('Work order not found');

  let id = '';
  await withTransaction(async (tx) => {
    // The task row first (parent-first), then the duplicate check under it.
    await tx.query(`SELECT 1 FROM task WHERE id = $1 FOR NO KEY UPDATE`, [input.task_id]);
    await assertBillNumberFree(tx, input.vendor_id ?? null, vendorName, input.bill_number?.trim() || null, null);
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO vendor_bill
         (task_id, vendor_id, vendor_name, bill_number, received_on, due_on, status, subtotal, tax, total, note, created_by, contract_id)
       VALUES ($1, $2::uuid, $3, $4, COALESCE($5::date, CURRENT_DATE), $6::date, 'received', $7, $8, $9, $10, $11, $12::uuid)
       RETURNING id::text AS id`,
      [
        input.task_id, input.vendor_id ?? null, vendorName, input.bill_number?.trim() || null,
        input.received_on ?? null, input.due_on ?? null, subtotal, tax, total, input.note?.trim() || null, actor.id,
        input.contract_id ?? null,
      ],
    );
    id = ins.rows[0].id;
    await writeLines(tx, id, lines);
    await tx.query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'vendor_bill_created', $3, NULL, $4::jsonb)`,
      [actor.id, input.task_id, `vendor_bill:${id}`, JSON.stringify({ vendor: vendorName, bill_number: input.bill_number ?? null, total, lines: lines.length })],
    );
  });
  return getVendorBill(id, actor);
}

export async function updateVendorBill(id: string, input: VendorBillUpdateInput, actor: ActingPrincipal): Promise<VendorBill> {
  requireRecord(actor);
  const cur = await getVendorBill(id, actor);
  if (!vendorBillEditable(cur.status)) {
    throw conflict(`This bill is ${cur.status}, so its figures are fixed`, { code: VENDOR_BILL_LOCKED_CODE, status: cur.status });
  }
  const lines = input.lines ? cleanLines(input.lines) : cur.lines.map((l) => ({ kind: l.kind, description: l.description, quantity: l.quantity, unit_price: l.unit_price }));
  if (lines.length === 0) throw badRequest('A bill needs at least one line');
  const tax = input.tax ?? cur.tax;
  if (tax < 0) throw badRequest('Tax cannot be negative');
  const { subtotal, total } = vendorBillTotals(lines, tax);
  assertBillTotal(total);
  const billNumber = input.bill_number === undefined ? cur.bill_number : (input.bill_number?.trim() || null);

  await withTransaction(async (tx) => {
    await tx.query(`SELECT 1 FROM task WHERE id = $1 FOR NO KEY UPDATE`, [cur.task_id]);
    await assertBillNumberFree(tx, cur.vendor_id, input.vendor_name?.trim() || cur.vendor_name, billNumber, id);
    if (input.lines) await writeLines(tx, id, lines);
    const kept = await tx.query(
      `UPDATE vendor_bill
          SET vendor_name = COALESCE($2, vendor_name), bill_number = $3,
              received_on = COALESCE($4::date, received_on), due_on = $5::date,
              tax = $6, subtotal = $7, total = $8, note = $9
        WHERE id = $1 AND status IN ('received', 'disputed') RETURNING id`,
      [
        id, input.vendor_name?.trim() || null,
        billNumber,
        input.received_on ?? null,
        input.due_on === undefined ? cur.due_on : input.due_on,
        tax, subtotal, total,
        input.note === undefined ? cur.note : (input.note?.trim() || null),
      ],
    );
    if (!kept.rows[0]) throw conflict(`This bill was approved while you were editing it, so its figures are fixed`, { code: VENDOR_BILL_LOCKED_CODE });
    await tx.query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'vendor_bill_updated', $3, $4::jsonb, $5::jsonb)`,
      [actor.id, cur.task_id, `vendor_bill:${id}`, JSON.stringify({ total: cur.total, tax: cur.tax }), JSON.stringify({ total, tax })],
    );
  });
  return getVendorBill(id, actor);
}

// ── The status moves ─────────────────────────────────────────────────────────

async function move(
  id: string,
  to: VendorBillStatus,
  actor: ActingPrincipal,
  extra: { note?: string | null; reference?: string | null; payment_request_id?: string | null } = {},
): Promise<VendorBill> {
  const cur = await getVendorBill(id, actor);
  const verb =
    to === 'approved' ? 'approve' : to === 'paid' ? 'mark_paid' : to === 'disputed' ? 'dispute' : to === 'void' ? 'void' : 'resolve';
  if (!vendorBillNextActions(cur.status).includes(verb)) {
    throw conflict(`A bill that is ${cur.status} cannot become ${to}`, { from: cur.status, to });
  }

  let selfApproved = false;
  if (to === 'approved') {
    requireApprove(actor);
    // D2: whoever recorded the bill does not approve it.
    const verdict = selfApprovalVerdict(cur.created_by?.id ?? null, actor.id, actor.isSuperAdmin);
    if (verdict === 'blocked') {
      throw forbidden(selfApprovalMessage('this vendor bill'), { code: SELF_APPROVAL_CODE, vendor_bill_id: id });
    }
    selfApproved = verdict === 'self_approved';
    // Rule 6.2.3: the amount's band may exclude this role.
    await assertTierAllows('vendor_bill', cur.total, actor, 'Approving a vendor bill');
    await assertBillWithinOwed(cur, actor);
  } else if (to === 'paid') {
    requireProcess(actor);
  } else {
    requireRecord(actor);
  }
  if (to === 'disputed' && !(extra.note ?? '').trim()) {
    throw badRequest('Say what is being disputed');
  }

  await withTransaction(async (tx) => {
    // #25: one conditional statement on the status it was read in.
    const moved = await tx.query(
      `UPDATE vendor_bill
          SET status = $2,
              approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid ELSE approved_by END,
              approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
              paid_by = CASE WHEN $2 = 'paid' THEN $3::uuid ELSE paid_by END,
              paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END,
              paid_reference = CASE WHEN $2 = 'paid' THEN $4 ELSE paid_reference END,
              payment_request_id = CASE WHEN $2 = 'paid' THEN COALESCE($5::uuid, payment_request_id) ELSE payment_request_id END,
              dispute_note = CASE WHEN $2 = 'disputed' THEN $6 ELSE dispute_note END
        WHERE id = $1 AND status = $7
        RETURNING id`,
      [id, to, actor.id, extra.reference ?? null, extra.payment_request_id ?? null, extra.note ?? null, cur.status],
    );
    if (!moved.rows[0]) {
      throw conflict('This bill changed while you were looking at it — reload it', { code: 'VENDOR_BILL_MOVED', from: cur.status, to });
    }
    await tx.query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'vendor_bill_status_changed', $3, $4::jsonb, $5::jsonb)`,
      [
        actor.id, cur.task_id, `vendor_bill:${id}`,
        JSON.stringify({ status: cur.status }),
        JSON.stringify({ status: to, vendor: cur.vendor_name, bill_number: cur.bill_number, total: cur.total, ...(extra.note ? { note: extra.note } : {}), ...(cur.tier ? { tier: cur.tier.label } : {}), ...(selfApproved ? { self_approved: true } : {}) }),
      ],
    );
    // A dispute is feedback for whoever deals with the vendor: an internal
    // comment on the work order, never client-visible.
    if (to === 'disputed') {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO comment (task_id, author_principal_id, body, client_visible)
         VALUES ($1, $2, $3, false) RETURNING id::text AS id`,
        [cur.task_id, actor.id, `Vendor bill ${cur.bill_number ?? ''} from ${cur.vendor_name} disputed — ${extra.note}`],
      );
      await tx.query(
        `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
         VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
        [actor.id, cur.task_id, JSON.stringify({ comment_id: ins.rows[0].id, client_visible: false, vendor_bill_id: id })],
      );
    }
  });
  return getVendorBill(id, actor);
}

/**
 * #20 (D1b): what is still owed to vendors on the work order — the approved
 * quote's cost side, less the payment requests already paid and the other
 * live bills — and a bill above it raises a `bill_over_owed` hold that refuses
 * Approve until a manager decides it. No approved quote cost = no ceiling.
 */
async function assertBillWithinOwed(cur: VendorBill, actor: ActingPrincipal): Promise<void> {
  const open = await openMoneyHold(cur.task_id, 'bill_over_owed');
  if (open) {
    throw conflict(`Approving this bill is on hold: ${open.title}. A manager decides it under Approvals first.`, {
      code: BILL_OVER_OWED_CODE,
      approval_task_id: open.id,
    });
  }
  const q = await query<{ cost: string | null; tbd: boolean }>(
    `SELECT total_cost AS cost, is_cost_tbd AS tbd FROM quote
      WHERE task_id = $1 AND status IN ('approved', 'sent', 'client_approved') LIMIT 1`,
    [cur.task_id],
  );
  const quoteCost = q.rows[0] && !q.rows[0].tbd && q.rows[0].cost !== null ? Number(q.rows[0].cost) : null;
  if (quoteCost === null) return;
  const sums = await query<{ paid: string | number; bills: string | number }>(
    `SELECT
       (SELECT COALESCE(sum(amount), 0) FROM payment_request
         WHERE task_id = $1 AND deleted_at IS NULL AND status = 'paid') AS paid,
       (SELECT COALESCE(sum(total), 0) FROM vendor_bill
         WHERE task_id = $1 AND id <> $2 AND status IN ('approved', 'paid')) AS bills`,
    [cur.task_id, cur.id],
  );
  const owed = vendorOwed(quoteCost, Number(sums.rows[0]?.paid ?? 0), Number(sums.rows[0]?.bills ?? 0));
  const cover = await approvedCover(cur.task_id, 'bill_over_owed', cur.id);
  if (!billOverOwed(cur.total, owed, cover?.covers)) return;
  const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await raiseMoneyHold({
    taskId: cur.task_id,
    type: 'bill_over_owed',
    actorId: actor.id,
    title: `${cur.vendor_name}'s bill${cur.bill_number ? ` ${cur.bill_number}` : ''} for ${usd(cur.total)} is more than the ${usd(Math.max(owed ?? 0, 0))} still owed against the approved quote`,
    detail: { vendor_bill_id: cur.id, total: cur.total, owed, quote_cost: quoteCost, covers: cur.total },
    move: 'Approving this bill',
    code: BILL_OVER_OWED_CODE,
  });
}

export const approveVendorBill = (id: string, actor: ActingPrincipal) => move(id, 'approved', actor);
export const disputeVendorBill = (id: string, note: string, actor: ActingPrincipal) => move(id, 'disputed', actor, { note });
export const resolveVendorBill = (id: string, actor: ActingPrincipal) => move(id, 'received', actor);
export const voidVendorBill = (id: string, actor: ActingPrincipal) => move(id, 'void', actor);
export const markVendorBillPaid = (
  id: string,
  actor: ActingPrincipal,
  reference?: string | null,
  paymentRequestId?: string | null,
) => move(id, 'paid', actor, { reference, payment_request_id: paymentRequestId });
