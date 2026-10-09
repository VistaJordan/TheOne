// Technician payment request service — the PPR replacement, at Yoda parity.
//
// Lifecycle (Yoda PaymentEngine, on top of 0016's decision stamps):
//   requested ─approve→ approved ─pay→ paid         (Yoda "Verify" = pay; approve is optional)
//   requested | approved ─reject→ rejected
//   edit      : only while `requested` (Yoda: "cannot update verified payments")
//   delete    : a `requested` | `rejected` row deletes at once (owner | processor);
//               a processed row becomes pending_delete until an admin confirms
//               or keeps it; deleting a PAID row reverses the Cost roll-up.
//   pay       : adds the amount to the WO's '34. Cost' field (Yoda UpdateCostInClickUp).
//
// `sent_to_yoda` (0016) is RETIRED: this service IS the Yoda payment flow, so
// there is nothing to hand off to. Migration 0028 folds existing rows back to
// `approved`; the status stays in the type and the CHECK so old audit rows and
// snapshots still parse.
//
// Gates — all from the permission tree (0015), never from a role list:
//   payments:approve         approve / reject            (the quote approvers)
//   payments/process:edit    pay / change method / delete / see full payout details  (AP, admin)
//   payments/process:delete  confirm or keep a pending delete                         (admin)
// WHEN a work order allows a request is `assertWoAllows` (allowedWoActions);
// rule 1.5.2 (`assertNoOpenNteOverride`) refuses approve / pay while an NTE
// override waits on a manager.
//
// Rules carried over from Yoda: duplicate purpose on the same WO is a 409; a
// blacklisted vendor is a 409 (admin override); the W9 flag is the running-total
// window (> $599 per vendor + billing entity + year, non-credit); a manual payee
// becomes a vendor record keyed by phone (Yoda creates the Technician).
//
// The payee is EITHER a vendor record OR a manual name+phone pair. The DB does
// not CHECK across the two shapes — the rule is enforced here, where a useful
// 400 can be produced.

import { query, getDb } from '../db.js';
import type {
  ActivityActor,
  PaymentAddress,
  PaymentListItem,
  PaymentListResponse,
  PaymentMethod,
  PaymentRequest,
  PaymentRequestStatus,
  PaymentRequestsResponse,
  VendorYtd,
} from '@theone/shared';
import { PAYMENT_METHOD_LABEL, PAYMENT_PROCESS_PERM_KEY, permAllows } from '@theone/shared';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { Params } from './woFields.js';
import { woScopeSql } from './woScope.js';
import { requirePerm } from './permissions.js';
import { assertNoOpenNteOverride } from './approvals.js';
import { assertWoAllows } from './woPolicy.js';
import { enqueueOutbox } from './outbox.js';

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/** Yoda: a running total above $599 per (technician, company, year) needs a W9. */
export const W9_THRESHOLD = 599;
const COST_FIELD = '34. Cost';

interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface PaymentRow {
  id: string;
  task_id: string;
  wo_number: string;
  billing_entity: string | null;
  title: string | null;
  client: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_phone: string | null;
  vendor_w9: boolean | null;
  vendor_blacklisted: boolean | null;
  vendor_insurance: string | null;
  payee_name: string | null;
  payee_phone: string | null;
  purpose: string;
  amount: number | null;
  method: PaymentMethod;
  payment_address: unknown;
  note: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  recipient_is_store: boolean;
  status: PaymentRequestStatus;
  needs_w9: boolean;
  pending_delete: boolean;
  delete_reason: string | null;
  attachment_id: string | null;
  requested_by_id: string | null;
  requested_by_name: string | null;
  requested_by_kind: 'human' | 'service' | null;
  created_at: string;
  updated_at: string;
  approved_by_id: string | null;
  approved_by_name: string | null;
  approved_by_kind: 'human' | 'service' | null;
  approved_at: string | null;
  rejected_by_id: string | null;
  rejected_by_name: string | null;
  rejected_by_kind: 'human' | 'service' | null;
  rejected_at: string | null;
  rejection_note: string | null;
  sent_by_id: string | null;
  sent_by_name: string | null;
  sent_by_kind: 'human' | 'service' | null;
  sent_to_yoda_at: string | null;
  yoda_ref: string | null;
  paid_by_id: string | null;
  paid_by_name: string | null;
  paid_by_kind: 'human' | 'service' | null;
  paid_at: string | null;
  nte_override_open: boolean;
  wo_due: string | null;
  wo_nte: number | string | null;
  wo_cost: string | null;
}

const SELECT_SQL = `
  SELECT pr.id::text        AS id,
         pr.task_id::text   AS task_id,
         t.wo_number, t.billing_entity, t.title, t.client,
         pr.vendor_id::text AS vendor_id,
         v.name             AS vendor_name,
         v.phone            AS vendor_phone,
         v.is_w9_present    AS vendor_w9,
         v.is_blacklisted   AS vendor_blacklisted,
         to_char(v.insurance_expires_on, 'YYYY-MM-DD') AS vendor_insurance,
         pr.payee_name, pr.payee_phone, pr.purpose,
         pr.amount::float8  AS amount,
         pr.method, pr.payment_address, pr.note,
         pr.recipient_name, pr.recipient_phone, pr.recipient_is_store,
         pr.status, pr.needs_w9, pr.pending_delete, pr.delete_reason,
         pr.attachment_id::text AS attachment_id,
         rb.id::text        AS requested_by_id,
         rb.display_name    AS requested_by_name,
         rb.kind::text      AS requested_by_kind,
         ${ISO('pr.created_at')} AS created_at,
         ${ISO('pr.updated_at')} AS updated_at,
         ab.id::text AS approved_by_id, ab.display_name AS approved_by_name, ab.kind::text AS approved_by_kind,
         ${ISO('pr.approved_at')} AS approved_at,
         rj.id::text AS rejected_by_id, rj.display_name AS rejected_by_name, rj.kind::text AS rejected_by_kind,
         ${ISO('pr.rejected_at')} AS rejected_at,
         pr.rejection_note,
         sb.id::text AS sent_by_id, sb.display_name AS sent_by_name, sb.kind::text AS sent_by_kind,
         ${ISO('pr.sent_to_yoda_at')} AS sent_to_yoda_at,
         pr.yoda_ref,
         pb.id::text AS paid_by_id, pb.display_name AS paid_by_name, pb.kind::text AS paid_by_kind,
         ${ISO('pr.paid_at')} AS paid_at,
         t.fields->>'Due Date'   AS wo_due,
         t.nte::float8           AS wo_nte,
         t.fields->>'34. Cost'   AS wo_cost,
         EXISTS (SELECT 1 FROM approval_task a
                  WHERE a.task_id = pr.task_id AND a.type = 'nte_override' AND a.status = 'open')
                            AS nte_override_open
    FROM payment_request pr
    JOIN task t            ON t.id = pr.task_id
    LEFT JOIN vendor v     ON v.id = pr.vendor_id
    LEFT JOIN principal rb ON rb.id = pr.requested_by
    LEFT JOIN principal ab ON ab.id = pr.approved_by
    LEFT JOIN principal rj ON rj.id = pr.rejected_by
    LEFT JOIN principal sb ON sb.id = pr.sent_to_yoda_by
    LEFT JOIN principal pb ON pb.id = pr.paid_by
`;

function actorOf(
  id: string | null,
  name: string | null,
  kind: 'human' | 'service' | null,
): ActivityActor | null {
  return id === null ? null : { id, display_name: name ?? '', kind: kind ?? 'human' };
}

function parseAddress(v: unknown): PaymentAddress | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as PaymentAddress;
    } catch {
      return null;
    }
  }
  return v as PaymentAddress;
}

/** ACH account numbers never leave the API in a list — only the last four. */
function maskAddress(a: PaymentAddress | null): PaymentAddress | null {
  if (!a) return null;
  if (a.method === 'ach') {
    const acct = a.account_number ?? '';
    return { ...a, account_number: acct.length > 4 ? `••••${acct.slice(-4)}` : '••••', routing_number: a.routing_number };
  }
  return a;
}

// ── Gates ───────────────────────────────────────────────────────────────────

/** payments/process:edit — pay, change method, delete, read full payout details. */
export function canProcessPayments(actor: ActingPrincipal): boolean {
  return permAllows(actor.perms, PAYMENT_PROCESS_PERM_KEY, 'edit', actor.isSuperAdmin);
}

/** payments:approve — approve / reject (the quote approvers, 0016). */
export function canApprovePayments(actor: ActingPrincipal): boolean {
  return permAllows(actor.perms, 'payments', 'approve', actor.isSuperAdmin);
}

/** payments/process:delete — the second person on a processed row's delete (0028). */
export function canAdminPayments(actor: ActingPrincipal): boolean {
  return permAllows(actor.perms, PAYMENT_PROCESS_PERM_KEY, 'delete', actor.isSuperAdmin);
}

function assertCanProcess(actor: ActingPrincipal, what = 'Processing payments'): void {
  requirePerm(actor, PAYMENT_PROCESS_PERM_KEY, 'edit', `${what} requires AP`);
}

function assertCanApprove(actor: ActingPrincipal, what: string): void {
  requirePerm(actor, 'payments', 'approve', `You cannot ${what} payment requests`);
}

function assertCanAdmin(actor: ActingPrincipal): void {
  requirePerm(actor, PAYMENT_PROCESS_PERM_KEY, 'delete', 'Confirming or rejecting a payment delete requires admin');
}

/**
 * A vendor-linked request shows the VENDOR's current name and phone (the record
 * is the source of truth — "Auto-filled from vendor record" in the comp); a
 * manual one shows what the dispatcher typed.
 */
function mapPayment(r: PaymentRow, opts: { fullAddress: boolean } = { fullAddress: false }): PaymentRequest {
  const address = parseAddress(r.payment_address);
  return {
    id: r.id,
    task_id: r.task_id,
    wo_number: r.wo_number,
    billing_entity: r.billing_entity,
    payee: {
      vendor_id: r.vendor_id,
      name: r.vendor_id ? r.vendor_name : r.payee_name,
      phone: r.vendor_id ? (r.vendor_phone ?? r.payee_phone) : r.payee_phone,
      is_w9_present: r.vendor_id ? r.vendor_w9 === true : null,
      is_blacklisted: r.vendor_id ? r.vendor_blacklisted === true : null,
      insurance_expires_on: r.vendor_id ? r.vendor_insurance : null,
    },
    purpose: r.purpose,
    amount: Number(r.amount ?? 0),
    method: r.method,
    payment_address: opts.fullAddress ? address : maskAddress(address),
    note: r.note,
    recipient_name: r.recipient_name,
    recipient_phone: r.recipient_phone,
    recipient_is_store: r.recipient_is_store === true,
    status: r.status,
    needs_w9: r.needs_w9 === true,
    pending_delete: r.pending_delete === true,
    delete_reason: r.delete_reason,
    attachment_id: r.attachment_id,
    requested_by: actorOf(r.requested_by_id, r.requested_by_name, r.requested_by_kind),
    created_at: r.created_at,
    updated_at: r.updated_at,
    approved_by: actorOf(r.approved_by_id, r.approved_by_name, r.approved_by_kind),
    approved_at: r.approved_at,
    rejected_by: actorOf(r.rejected_by_id, r.rejected_by_name, r.rejected_by_kind),
    rejected_at: r.rejected_at,
    rejection_note: r.rejection_note,
    sent_to_yoda_by: actorOf(r.sent_by_id, r.sent_by_name, r.sent_by_kind),
    sent_to_yoda_at: r.sent_to_yoda_at,
    yoda_ref: r.yoda_ref,
    paid_by: actorOf(r.paid_by_id, r.paid_by_name, r.paid_by_kind),
    paid_at: r.paid_at,
    nte_override_open: Boolean(r.nte_override_open),
  };
}

function mapListItem(r: PaymentRow, opts?: { fullAddress: boolean }): PaymentListItem {
  return {
    ...mapPayment(r, opts),
    title: r.title,
    client: r.client,
    wo_due: r.wo_due,
    wo_nte: moneyNum(r.wo_nte),
    wo_cost: moneyNum(r.wo_cost),
  };
}

/** A bag/column value as a finite number ("$1,610" → 1610), else null. */
function moneyNum(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const digits = String(v).replace(/[^0-9.-]/g, '');
  if (!/^-?\d*\.?\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Every payment request on a work order, newest first, with the two totals the
 * comp shows: `total_paid` ("Total paid on this WO") counts only `paid` rows;
 * `total_requested` ("Payables total") counts everything not rejected — money
 * that is either out the door or on its way. Soft-deleted rows are omitted.
 */
export async function listPaymentRequests(taskId: string): Promise<PaymentRequestsResponse> {
  const res = await query<PaymentRow>(
    `${SELECT_SQL} WHERE pr.task_id = $1 AND pr.deleted_at IS NULL ORDER BY pr.created_at DESC, pr.id DESC`,
    [taskId],
  );
  const items = res.rows.map((r) => mapPayment(r));
  return {
    items,
    total: items.length,
    total_paid: round2(items.filter((i) => i.status === 'paid').reduce((sum, i) => sum + i.amount, 0)),
    total_requested: round2(
      items.filter((i) => i.status !== 'rejected').reduce((sum, i) => sum + i.amount, 0),
    ),
  };
}

/** One request. The full payout address is served only to a processor. */
export async function getPaymentRequest(id: string, actor: ActingPrincipal): Promise<PaymentRequest> {
  const res = await query<PaymentRow>(`${SELECT_SQL} WHERE pr.id = $1 AND pr.deleted_at IS NULL`, [id]);
  if (res.rows.length === 0) throw notFound('Payment request not found');
  return mapPayment(res.rows[0], { fullAddress: canProcessPayments(actor) });
}

const STATUSES: PaymentRequestStatus[] = ['requested', 'approved', 'sent_to_yoda', 'paid', 'rejected'];

export interface QueueFilters {
  status?: PaymentRequestStatus | null;
  billing_entity?: string | null;
  vendor_id?: string | null;
  q?: string | null;
  pending_delete?: boolean | null;
  needs_w9?: boolean | null;
  page: number;
  page_size: number;
}

/**
 * The Payments tab / AP queue (Yoda Payment/All): every request across every
 * live work order the viewer may see (0026 scope), filtered and paged. Pending
 * deletes pin to the top, then the rows still waiting on somebody, then newest
 * first. Deleted work orders keep their rows but leave the queue — nobody
 * should be paying against a WO that is in Trash.
 */
export async function listAllPaymentRequests(f: QueueFilters, viewer: ActingPrincipal): Promise<PaymentListResponse> {
  const p = new Params();
  const scope = woScopeSql(viewer, p);
  const base: string[] = ['pr.deleted_at IS NULL', 't.deleted_at IS NULL'];
  if (scope) base.push(scope);
  const baseWhere = `WHERE ${base.join(' AND ')}`;

  // Counts are over the whole (scoped) queue so the status chips stay honest
  // while a status filter is applied.
  const countRes = await query<{ status: PaymentRequestStatus; n: number | string; pd: number | string }>(
    `SELECT pr.status, count(*) AS n, count(*) FILTER (WHERE pr.pending_delete) AS pd
       FROM payment_request pr JOIN task t ON t.id = pr.task_id
       ${baseWhere}
      GROUP BY pr.status`,
    p.values,
  );
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<PaymentRequestStatus, number>;
  let pendingDelete = 0;
  for (const r of countRes.rows) {
    if (r.status in counts) counts[r.status] += Number(r.n);
    pendingDelete += Number(r.pd);
  }

  const where = [...base];
  if (f.status) where.push(`pr.status = ${p.add(f.status)}`);
  if (f.billing_entity) where.push(`t.billing_entity = ${p.add(f.billing_entity)}`);
  if (f.vendor_id) where.push(`pr.vendor_id = ${p.add(f.vendor_id)}`);
  if (f.pending_delete === true) where.push('pr.pending_delete = true');
  if (f.needs_w9 === true) where.push('pr.needs_w9 = true');
  if (f.q && f.q.trim()) {
    const q = p.add(`%${f.q.trim()}%`);
    where.push(`(t.wo_number ILIKE ${q} OR pr.purpose ILIKE ${q} OR v.name ILIKE ${q} OR pr.payee_name ILIKE ${q} OR pr.recipient_name ILIKE ${q})`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const total = await query<{ n: number | string }>(
    `SELECT count(*) AS n FROM payment_request pr JOIN task t ON t.id = pr.task_id LEFT JOIN vendor v ON v.id = pr.vendor_id ${whereSql}`,
    p.values,
  );
  const rows = await query<PaymentRow>(
    `${SELECT_SQL} ${whereSql}
      ORDER BY pr.pending_delete DESC,
               CASE pr.status WHEN 'requested' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
               pr.created_at DESC, pr.id DESC
      LIMIT ${p.add(f.page_size)} OFFSET ${p.add((f.page - 1) * f.page_size)}`,
    p.values,
  );
  return {
    items: rows.rows.map((r) => mapListItem(r)),
    total: Number(total.rows[0]?.n ?? 0),
    counts,
    page: f.page,
    page_size: f.page_size,
    pending_delete_count: pendingDelete,
  };
}

/** Yoda GetReciepientTotal: this calendar year's non-credit technician payments. */
export async function vendorYtd(vendorId: string, billingEntity: string | null): Promise<VendorYtd> {
  const res = await query<{ total: number | string | null }>(
    `SELECT COALESCE(sum(pr.amount), 0)::float8 AS total
       FROM payment_request pr JOIN task t ON t.id = pr.task_id
      WHERE pr.vendor_id = $1 AND pr.deleted_at IS NULL AND pr.status <> 'rejected'
        AND pr.method <> 'credit' AND pr.recipient_name IS NULL
        AND ($2::text IS NULL OR t.billing_entity = $2)
        AND date_part('year', pr.created_at) = date_part('year', now())`,
    [vendorId, billingEntity],
  );
  return {
    vendor_id: vendorId,
    year: new Date().getUTCFullYear(),
    billing_entity: billingEntity,
    total: round2(Number(res.rows[0]?.total ?? 0)),
    w9_threshold: W9_THRESHOLD,
  };
}

// ── Bookkeeping inside a transaction ────────────────────────────────────────

/**
 * Yoda SetNeedsW9ForTechnicianAsync: recompute `needs_w9` on every live payment
 * of this vendor — a running total (per billing entity, per year, non-credit,
 * technician-receiver) above $599 flags the row that crossed it and all later ones.
 */
async function recomputeNeedsW9(tx: Queryable, vendorId: string): Promise<void> {
  await tx.query(
    `UPDATE payment_request SET needs_w9 = false WHERE vendor_id = $1 AND deleted_at IS NULL`,
    [vendorId],
  );
  await tx.query(
    `WITH running AS (
       SELECT pr.id,
              sum(pr.amount) OVER (
                PARTITION BY pr.vendor_id, t.billing_entity, date_part('year', pr.created_at)
                ORDER BY pr.created_at ASC, pr.id ASC
                ROWS UNBOUNDED PRECEDING
              ) AS total
         FROM payment_request pr JOIN task t ON t.id = pr.task_id
        WHERE pr.vendor_id = $1 AND pr.deleted_at IS NULL AND pr.status <> 'rejected'
          AND pr.method <> 'credit' AND pr.recipient_name IS NULL
     )
     UPDATE payment_request p SET needs_w9 = true
       FROM running r WHERE p.id = r.id AND r.total > $2`,
    [vendorId, W9_THRESHOLD],
  );
}

/** Yoda UpdateCostInClickUp: '34. Cost' on the WO += / −= the paid amount. */
async function rollCost(tx: Queryable, taskId: string, actorId: string, delta: number): Promise<void> {
  const cur = await tx.query<{ cost: string | null }>(
    `SELECT fields ->> $2 AS cost FROM task WHERE id = $1`,
    [taskId, COST_FIELD],
  );
  const raw = cur.rows[0]?.cost ?? null;
  const before = raw !== null && /^[\d.]+$/.test(raw.replace(/[$,\s]/g, '')) ? Number(raw.replace(/[$,\s]/g, '')) : 0;
  const after = Math.max(0, round2(before + delta));
  await tx.query(
    `UPDATE task SET fields = jsonb_set(COALESCE(fields,'{}'::jsonb), ARRAY[$2]::text[], to_jsonb($3::text), true), updated_at = now()
      WHERE id = $1`,
    [taskId, COST_FIELD, String(after)],
  );
  // entity_id is TEXT since 0017 — the task id is bound once, as text.
  await tx.query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'field_changed', $3, $4::jsonb, $5::jsonb)`,
    [actorId, taskId, `fields.${COST_FIELD}`, JSON.stringify({ value: before, via: 'payment' }), JSON.stringify({ value: after, via: 'payment' })],
  );
}

async function logPayment(
  tx: Queryable,
  actorId: string,
  taskId: string,
  action: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx.query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, $3, 'payment_request.status', $4::jsonb, $5::jsonb)`,
    [actorId, taskId, action, before === null ? null : JSON.stringify(before), JSON.stringify(after)],
  );
}

/** The Yoda Teams post, as plain text — stored on the row for audit / export. */
function postedMessage(p: PaymentRequest, actor: ActingPrincipal): string {
  const lines = [
    `Payment request — ${p.wo_number}${p.billing_entity ? ` (${p.billing_entity})` : ''}`,
    `Technician: ${p.payee.name ?? '—'}${p.payee.phone ? ` · ${p.payee.phone}` : ''}`,
  ];
  if (p.recipient_name) {
    lines.push(`Pay to: ${p.recipient_name}${p.recipient_phone ? ` · ${p.recipient_phone}` : ''}${p.recipient_is_store ? ' (store)' : ''}`);
  }
  lines.push(`Purpose: ${p.purpose}`);
  lines.push(`Amount: ${money(p.amount)} via ${PAYMENT_METHOD_LABEL[p.method] ?? p.method}`);
  const a = maskAddress(p.payment_address);
  if (a) {
    const payout =
      a.method === 'zelle' ? a.zelle_handle
      : a.method === 'ach' ? `${a.bank_name ?? 'bank'} · routing ${a.routing_number} · acct ${a.account_number}`
      : a.method === 'cashapp' ? a.cashtag
      : a.method === 'check' ? `${a.payable_to} — ${a.mailing_address}`
      : a.note ?? '';
    if (payout) lines.push(`Payout: ${payout}`);
  }
  if (p.needs_w9) lines.push('W9: NEEDED — technician crossed $599 this year');
  if (p.note) lines.push(`Note: ${p.note}`);
  lines.push(`Requested by: ${actor.name}`);
  return lines.join('\n');
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface PaymentRequestInput {
  vendor_id?: string | null;
  payee_name?: string | null;
  payee_phone?: string | null;
  purpose: string;
  amount: number;
  method: PaymentMethod;
  payment_address?: PaymentAddress | null;
  note?: string | null;
  recipient_name?: string | null;
  recipient_phone?: string | null;
  recipient_is_store?: boolean;
  attachment_id?: string | null;
  /** Admin only: pay a blacklisted vendor anyway. */
  override_blacklist?: boolean;
}

async function loadRow(id: string): Promise<PaymentRow> {
  const res = await query<PaymentRow>(`${SELECT_SQL} WHERE pr.id = $1 AND pr.deleted_at IS NULL`, [id]);
  if (res.rows.length === 0) throw notFound('Payment request not found');
  return res.rows[0];
}

async function assertUniquePurpose(taskId: string, purpose: string, exceptId: string | null): Promise<void> {
  const dup = await query<{ id: string }>(
    `SELECT id::text AS id FROM payment_request
      WHERE task_id = $1 AND deleted_at IS NULL AND status <> 'rejected'
        AND lower(trim(purpose)) = lower(trim($2)) AND ($3::uuid IS NULL OR id <> $3)
      LIMIT 1`,
    [taskId, purpose, exceptId],
  );
  if (dup.rows.length > 0) {
    throw conflict('A payment with this purpose already exists on this work order', {
      code: 'DUPLICATE_PURPOSE',
      purpose,
      payment_request_id: dup.rows[0].id,
    });
  }
}

function assertAddressMatches(method: PaymentMethod, address: PaymentAddress | null | undefined): void {
  if (address && address.method !== method) {
    throw badRequest('payment_address.method must match method', { method, address_method: address.method });
  }
}

/**
 * Submit a request (payments:create is checked by the route). The WO status
 * must allow it. The insert, the W9 recompute and the activity row share one
 * transaction, so a request that exists is always a request the audit trail
 * knows about.
 */
export async function createPaymentRequest(
  taskId: string,
  input: PaymentRequestInput,
  actor: ActingPrincipal,
): Promise<PaymentRequest> {
  await assertWoAllows(taskId, 'payment.request');

  let vendorId = input.vendor_id ?? null;
  const payeeName = input.payee_name?.trim() || null;
  const payeePhone = input.payee_phone?.trim() || null;

  if (!vendorId && !(payeeName && payeePhone)) {
    throw badRequest(
      'A payment request needs either a vendor_id or both payee_name and payee_phone',
      { required: 'vendor_id | (payee_name + payee_phone)' },
    );
  }
  assertAddressMatches(input.method, input.payment_address);
  await assertUniquePurpose(taskId, input.purpose, null);

  // Yoda resolves the Technician by phone and creates one when unknown, so the
  // W9 / YTD bookkeeping has a record to hang off. Same here: a manual payee
  // whose phone matches a vendor links to it; an unknown one becomes a vendor.
  if (!vendorId && payeePhone) {
    const digits = payeePhone.replace(/\D/g, '');
    const match = await query<{ id: string }>(
      `SELECT id::text AS id FROM vendor WHERE regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $1 AND $1 <> '' LIMIT 1`,
      [digits],
    );
    vendorId = match.rows[0]?.id ?? null;
  }

  if (vendorId) {
    const v = await query<{ id: string; is_blacklisted: boolean; blacklist_reason: string | null }>(
      `SELECT id::text AS id, is_blacklisted, blacklist_reason FROM vendor WHERE id = $1`,
      [vendorId],
    );
    if (v.rows.length === 0) throw badRequest('Unknown vendor_id', { vendor_id: vendorId });
    const vendor = v.rows[0];
    if (vendor.is_blacklisted && !(input.override_blacklist && canAdminPayments(actor))) {
      throw conflict('This technician is blacklisted — payments are blocked', {
        code: 'VENDOR_BLACKLISTED',
        vendor_id: vendorId,
        reason: vendor.blacklist_reason,
      });
    }
  }

  const db = getDb();
  let createdId: string | null = null;

  await db.transaction(async (tx) => {
    if (!vendorId && payeeName && payeePhone) {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO vendor (name, phone, trades) VALUES ($1, $2, '{}') RETURNING id::text AS id`,
        [payeeName, payeePhone],
      );
      vendorId = created.rows[0].id;
    }
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO payment_request
         (task_id, vendor_id, payee_name, payee_phone, purpose, amount, method, payment_address, note,
          recipient_name, recipient_phone, recipient_is_store, attachment_id, status, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, 'requested', $14)
       RETURNING id::text AS id`,
      [
        taskId,
        vendorId,
        payeeName,
        payeePhone,
        input.purpose.trim(),
        input.amount,
        input.method,
        input.payment_address ? JSON.stringify(input.payment_address) : null,
        input.note ?? null,
        input.recipient_name?.trim() || null,
        input.recipient_phone?.trim() || null,
        input.recipient_is_store === true,
        input.attachment_id ?? null,
        actor.id,
      ],
    );
    createdId = ins.rows[0].id;
    if (vendorId) await recomputeNeedsW9(tx, vendorId);

    const row = await tx.query<PaymentRow>(`${SELECT_SQL} WHERE pr.id = $1`, [createdId]);
    const full = mapPayment(row.rows[0], { fullAddress: true });
    const plain = postedMessage(full, actor);
    await tx.query(`UPDATE payment_request SET posted_message_plain = $2 WHERE id = $1`, [createdId, plain]);

    await logPayment(tx, actor.id, taskId, 'payment_requested', null, {
      payment_request_id: createdId,
      status: 'requested',
      amount: input.amount,
      method: input.method,
      needs_w9: full.needs_w9,
    });
    await enqueueOutbox(tx, 'payment.requested', 'payment_request', createdId, {
      task_id: taskId,
      billing_entity: full.billing_entity,
      message: plain,
    });
  });

  if (!createdId) throw new ApiError('INTERNAL', 'Payment request insert produced no row');
  return mapPayment(await loadRow(createdId), { fullAddress: canProcessPayments(actor) });
}

export interface PaymentEditInput {
  purpose?: string;
  amount?: number;
  method?: PaymentMethod;
  payment_address?: PaymentAddress | null;
  note?: string | null;
  recipient_name?: string | null;
  recipient_phone?: string | null;
  recipient_is_store?: boolean;
}

/** Yoda UpdatePayment: only while `requested`; the requester or a processor. */
export async function updatePaymentRequest(
  id: string,
  input: PaymentEditInput,
  actor: ActingPrincipal,
): Promise<PaymentRequest> {
  const row = await loadRow(id);
  if (row.status !== 'requested') {
    throw badRequest('A processed payment can no longer be edited — delete it and request again', {
      status: row.status,
    });
  }
  if (!(canProcessPayments(actor) || row.requested_by_id === actor.id)) {
    throw forbidden('Only the requester or AP can edit this payment request');
  }
  const method = input.method ?? row.method;
  const address = input.payment_address === undefined ? parseAddress(row.payment_address) : input.payment_address;
  assertAddressMatches(method, address);
  if (input.method && input.method !== row.method && input.payment_address === undefined) {
    // A method change invalidates the old payout details.
    input.payment_address = null;
  }
  if (input.purpose !== undefined) await assertUniquePurpose(row.task_id, input.purpose, id);

  const db = getDb();
  await db.transaction(async (tx) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown, cast = '') => {
      params.push(v);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (input.purpose !== undefined) set('purpose', input.purpose.trim());
    if (input.amount !== undefined) set('amount', input.amount);
    if (input.method !== undefined) set('method', input.method);
    if (input.payment_address !== undefined) set('payment_address', input.payment_address ? JSON.stringify(input.payment_address) : null, '::jsonb');
    if (input.note !== undefined) set('note', input.note);
    if (input.recipient_name !== undefined) set('recipient_name', input.recipient_name?.trim() || null);
    if (input.recipient_phone !== undefined) set('recipient_phone', input.recipient_phone?.trim() || null);
    if (input.recipient_is_store !== undefined) set('recipient_is_store', input.recipient_is_store);
    if (sets.length > 0) {
      params.push(id);
      await tx.query(`UPDATE payment_request SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    if (row.vendor_id) await recomputeNeedsW9(tx, row.vendor_id);
    await logPayment(tx, actor.id, row.task_id, 'payment_updated', null, {
      payment_request_id: id,
      fields: Object.keys(input),
    });
  });
  return mapPayment(await loadRow(id), { fullAddress: canProcessPayments(actor) });
}

const LABEL: Record<PaymentRequestStatus, string> = {
  requested: 'requested',
  approved: 'approved',
  sent_to_yoda: 'approved',
  paid: 'paid',
  rejected: 'rejected',
};

/**
 * One status move on one request. The status, its stamps, the activity row
 * and whatever the move carries (comment, cost roll-up, outbox) land in one
 * transaction, so the ledger, the audit trail and the WO feed can never
 * disagree about what happened to the money.
 */
async function setStatus(
  row: PaymentRow,
  from: PaymentRequestStatus[],
  to: PaymentRequestStatus,
  action: string,
  actor: ActingPrincipal,
  extraSet: string,
  extraParams: unknown[],
  extra?: (tx: Queryable) => Promise<void>,
): Promise<PaymentRequest> {
  if (!from.includes(row.status)) {
    throw badRequest(`This payment request is already ${LABEL[row.status]}; it cannot be ${LABEL[to]} now`, {
      status: row.status,
      allowed_from: from,
    });
  }
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE payment_request SET status = $1${extraSet ? `, ${extraSet}` : ''} WHERE id = $2`,
      [to, row.id, ...extraParams],
    );
    if (extra) await extra(tx);
    await logPayment(tx, actor.id, row.task_id, action, { payment_request_id: row.id, status: row.status }, {
      payment_request_id: row.id,
      status: to,
      amount: Number(row.amount ?? 0),
      payee: row.vendor_id ? row.vendor_name : row.payee_name,
    });
  });
  return mapPayment(await loadRow(row.id), { fullAddress: canProcessPayments(actor) });
}

/** requested → approved (payments:approve). Refused (409) while an NTE
    override waits on a manager — rule 1.5.2. */
export async function approvePaymentRequest(id: string, actor: ActingPrincipal): Promise<PaymentRequest> {
  assertCanApprove(actor, 'approve');
  const row = await loadRow(id);
  await assertNoOpenNteOverride(row.task_id, 'Approving this payment');
  return setStatus(row, ['requested'], 'approved', 'payment_approved', actor,
    'approved_by = $3, approved_at = now()', [actor.id],
    async (tx) => {
      await enqueueOutbox(tx, 'payment.approved', 'payment_request', id, { task_id: row.task_id });
    });
}

/**
 * requested | approved → paid (payments/process:edit) — Yoda VerifyPayment:
 * stamps the payer (and the approver, when nobody approved first), rolls the
 * amount into the WO's Cost field and queues the confirmation post. Paid
 * straight from requested is allowed: money sometimes goes out by hand, and a
 * queue that cannot record the truth gets worked around. Rule 1.5.2 applies.
 */
export async function payPaymentRequest(id: string, actor: ActingPrincipal): Promise<PaymentRequest> {
  assertCanProcess(actor, 'Paying');
  const row = await loadRow(id);
  await assertNoOpenNteOverride(row.task_id, 'Paying this request');
  const amount = Number(row.amount ?? 0);
  return setStatus(row, ['requested', 'approved', 'sent_to_yoda'], 'paid', 'payment_paid', actor,
    'approved_by = COALESCE(approved_by, $3), approved_at = COALESCE(approved_at, now()), paid_by = $3, paid_at = now()', [actor.id],
    async (tx) => {
      await rollCost(tx, row.task_id, actor.id, amount);
      await enqueueOutbox(tx, 'payment.paid', 'payment_request', id, {
        task_id: row.task_id,
        amount,
        paid_by: actor.name,
      });
    });
}

/** requested | approved → rejected (payments:approve) with the reason for the requester. */
export async function rejectPaymentRequest(id: string, reason: string, actor: ActingPrincipal): Promise<PaymentRequest> {
  assertCanApprove(actor, 'reject');
  const row = await loadRow(id);
  const note = reason.trim();
  return setStatus(row, ['requested', 'approved', 'sent_to_yoda'], 'rejected', 'payment_rejected', actor,
    'rejected_by = $3, rejected_at = now(), rejection_note = $4', [actor.id, note],
    async (tx) => {
      // The reason a payment was refused is feedback for the dispatcher who
      // raised it — an INTERNAL comment on the WO, never client-visible.
      const who = (row.vendor_id ? row.vendor_name : row.payee_name) ?? 'the technician';
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO comment (task_id, author_principal_id, body, client_visible)
         VALUES ($1, $2, $3, false) RETURNING id::text AS id`,
        [row.task_id, actor.id, `Payment request of ${money(Number(row.amount ?? 0))} to ${who} (${row.purpose}) rejected — ${note}`],
      );
      await tx.query(
        `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
         VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
        [actor.id, row.task_id, JSON.stringify({ comment_id: ins.rows[0].id, client_visible: false, payment_request_id: id })],
      );
      if (row.vendor_id) await recomputeNeedsW9(tx, row.vendor_id);
      await enqueueOutbox(tx, 'payment.rejected', 'payment_request', id, { task_id: row.task_id, reason: note });
    });
}

/** Yoda ConvertToAch, generalised: a processor changes the method; old payout details are dropped. */
export async function convertPaymentMethod(id: string, method: PaymentMethod, actor: ActingPrincipal): Promise<PaymentRequest> {
  assertCanProcess(actor, 'Changing the payment method');
  const row = await loadRow(id);
  if (row.status === 'paid') throw badRequest('A paid payment cannot change method');
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE payment_request SET method = $2, payment_address = NULL WHERE id = $1`, [id, method]);
    if (row.vendor_id) await recomputeNeedsW9(tx, row.vendor_id);
    await logPayment(tx, actor.id, row.task_id, 'payment_method_changed', { payment_request_id: id, method: row.method }, {
      payment_request_id: id,
      method,
    });
  });
  return mapPayment(await loadRow(id), { fullAddress: true });
}

async function hardDelete(tx: Queryable, row: PaymentRow, reason: string, actor: ActingPrincipal): Promise<void> {
  await tx.query(
    `UPDATE payment_request SET deleted_at = now(), deleted_by = $2, delete_reason = $3, pending_delete = false WHERE id = $1`,
    [row.id, actor.id, reason],
  );
  if (row.status === 'paid') await rollCost(tx, row.task_id, actor.id, -Number(row.amount ?? 0));
  if (row.vendor_id) await recomputeNeedsW9(tx, row.vendor_id);
  await logPayment(tx, actor.id, row.task_id, 'payment_deleted', { payment_request_id: row.id, status: row.status }, {
    payment_request_id: row.id,
    reason,
    amount: Number(row.amount ?? 0),
  });
  await enqueueOutbox(tx, 'payment.deleted', 'payment_request', row.id, { task_id: row.task_id, reason });
}

/**
 * Yoda MarkPaymentAsDeleted (D10): a `requested` | `rejected` row deletes at
 * once for its requester or a processor; a processed row (approved / paid)
 * deletes at once only for an admin, otherwise it is flagged pending_delete
 * for an admin to confirm. Returns null when the row is gone, the row when it
 * is flagged.
 */
export async function deletePaymentRequest(id: string, reason: string, actor: ActingPrincipal): Promise<PaymentRequest | null> {
  const row = await loadRow(id);
  const owner = row.requested_by_id === actor.id;
  const trimmed = reason.trim();
  const db = getDb();

  if (row.status === 'requested' || row.status === 'rejected') {
    if (!(owner || canProcessPayments(actor))) {
      throw forbidden('Only the requester or AP can delete this payment request');
    }
    await db.transaction((tx) => hardDelete(tx, row, trimmed, actor));
    return null;
  }

  if (!canProcessPayments(actor) && !owner) {
    throw forbidden('Deleting a processed payment requires AP');
  }
  if (canAdminPayments(actor)) {
    await db.transaction((tx) => hardDelete(tx, row, trimmed, actor));
    return null;
  }
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE payment_request SET pending_delete = true, delete_requested_by = $2, delete_reason = $3 WHERE id = $1`,
      [id, actor.id, trimmed],
    );
    await logPayment(tx, actor.id, row.task_id, 'payment_delete_requested', { payment_request_id: id, status: row.status }, {
      payment_request_id: id,
      reason: trimmed,
    });
    await enqueueOutbox(tx, 'payment.delete_requested', 'payment_request', id, { task_id: row.task_id, reason: trimmed });
  });
  return mapPayment(await loadRow(id), { fullAddress: canProcessPayments(actor) });
}

/** Admin confirms a pending delete (second person). */
export async function confirmDeletePaymentRequest(id: string, actor: ActingPrincipal): Promise<void> {
  assertCanAdmin(actor);
  const row = await loadRow(id);
  if (!row.pending_delete) throw badRequest('This payment has no pending delete to confirm');
  const db = getDb();
  await db.transaction((tx) => hardDelete(tx, row, row.delete_reason ?? 'Confirmed by admin', actor));
}

/** Yoda RejectDeletePayment: admin keeps the row, the flag clears. */
export async function rejectDeletePaymentRequest(id: string, actor: ActingPrincipal): Promise<PaymentRequest> {
  assertCanAdmin(actor);
  const row = await loadRow(id);
  if (!row.pending_delete) throw badRequest('This payment has no pending delete to reject');
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE payment_request SET pending_delete = false, delete_requested_by = NULL, delete_reason = NULL WHERE id = $1`,
      [id],
    );
    await logPayment(tx, actor.id, row.task_id, 'payment_delete_rejected', null, { payment_request_id: id });
  });
  return mapPayment(await loadRow(id), { fullAddress: true });
}
