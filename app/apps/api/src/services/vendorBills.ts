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

import {
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
import { badRequest, conflict, notFound } from '../errors.js';
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
         b.created_by::text AS created_by_id, cb.display_name AS created_by_name,
         ${ISO('b.created_at')} AS created_at,
         ${ISO('b.updated_at')} AS updated_at,
         CASE WHEN b.status IN ('received', 'approved', 'disputed') AND b.due_on IS NOT NULL AND b.due_on < now()::date
              THEN (now()::date - b.due_on) END AS overdue_days
    FROM vendor_bill b
    JOIN task t ON t.id = b.task_id
    LEFT JOIN principal ab ON ab.id = b.approved_by
    LEFT JOIN principal pb ON pb.id = b.paid_by
    LEFT JOIN principal cb ON cb.id = b.created_by`;

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
  return rows.map((r) =>
    mapRow(r, lines.get(r.id) ?? [], tierSummary(tiers, 'vendor_bill', n(r.total), actor)),
  );
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

export async function createVendorBill(input: VendorBillCreateInput, actor: ActingPrincipal): Promise<VendorBill> {
  requireRecord(actor);
  const vendorName = String(input.vendor_name ?? '').trim();
  if (vendorName === '') throw badRequest('A bill needs the vendor it came from');
  const lines = cleanLines(input.lines ?? []);
  if (lines.length === 0) throw badRequest('A bill needs at least one line');
  const tax = Number(input.tax ?? 0);
  if (tax < 0) throw badRequest('Tax cannot be negative');
  const { subtotal, total } = vendorBillTotals(lines, tax);

  const task = await query<{ id: string }>(`SELECT id::text AS id FROM task WHERE id = $1 AND deleted_at IS NULL`, [input.task_id]);
  if (!task.rows[0]) throw notFound('Work order not found');

  let id = '';
  await withTransaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO vendor_bill
         (task_id, vendor_id, vendor_name, bill_number, received_on, due_on, status, subtotal, tax, total, note, created_by)
       VALUES ($1, $2::uuid, $3, $4, COALESCE($5::date, CURRENT_DATE), $6::date, 'received', $7, $8, $9, $10, $11)
       RETURNING id::text AS id`,
      [
        input.task_id, input.vendor_id ?? null, vendorName, input.bill_number?.trim() || null,
        input.received_on ?? null, input.due_on ?? null, subtotal, tax, total, input.note?.trim() || null, actor.id,
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

  await withTransaction(async (tx) => {
    if (input.lines) await writeLines(tx, id, lines);
    await tx.query(
      `UPDATE vendor_bill
          SET vendor_name = COALESCE($2, vendor_name), bill_number = $3,
              received_on = COALESCE($4::date, received_on), due_on = $5::date,
              tax = $6, subtotal = $7, total = $8, note = $9
        WHERE id = $1`,
      [
        id, input.vendor_name?.trim() || null,
        input.bill_number === undefined ? cur.bill_number : (input.bill_number?.trim() || null),
        input.received_on ?? null,
        input.due_on === undefined ? cur.due_on : input.due_on,
        tax, subtotal, total,
        input.note === undefined ? cur.note : (input.note?.trim() || null),
      ],
    );
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

  if (to === 'approved') {
    requireApprove(actor);
    // Rule 6.2.3: the amount's band may exclude this role.
    await assertTierAllows('vendor_bill', cur.total, actor, 'Approving a vendor bill');
  } else if (to === 'paid') {
    requireProcess(actor);
  } else {
    requireRecord(actor);
  }
  if (to === 'disputed' && !(extra.note ?? '').trim()) {
    throw badRequest('Say what is being disputed');
  }

  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE vendor_bill
          SET status = $2,
              approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid ELSE approved_by END,
              approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
              paid_by = CASE WHEN $2 = 'paid' THEN $3::uuid ELSE paid_by END,
              paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END,
              paid_reference = CASE WHEN $2 = 'paid' THEN $4 ELSE paid_reference END,
              payment_request_id = CASE WHEN $2 = 'paid' THEN COALESCE($5::uuid, payment_request_id) ELSE payment_request_id END,
              dispute_note = CASE WHEN $2 = 'disputed' THEN $6 ELSE dispute_note END
        WHERE id = $1`,
      [id, to, actor.id, extra.reference ?? null, extra.payment_request_id ?? null, extra.note ?? null],
    );
    await tx.query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'vendor_bill_status_changed', $3, $4::jsonb, $5::jsonb)`,
      [
        actor.id, cur.task_id, `vendor_bill:${id}`,
        JSON.stringify({ status: cur.status }),
        JSON.stringify({ status: to, vendor: cur.vendor_name, bill_number: cur.bill_number, total: cur.total, ...(extra.note ? { note: extra.note } : {}), ...(cur.tier ? { tier: cur.tier.label } : {}) }),
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
