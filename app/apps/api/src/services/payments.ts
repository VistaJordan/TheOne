// Technician payment request service — the PPR replacement, at Yoda parity.
//
// Lifecycle (Yoda PaymentEngine, on top of 0016's decision stamps):
//   requested ─approve→ approved ─pay→ paid         (0083 #4: pay only from approved)
//   requested | approved ─reject→ rejected
//   Every move is ONE conditional UPDATE on the status it was read in (#25):
//   two clicks race to one winner, the other gets a 409, Cost is added once.
//   Maker ≠ checker (D2): the requester neither approves nor pays their own
//   request; a super admin may, and the row says self_approved.
//   edit      : only while `requested` (Yoda: "cannot update verified payments")
//   delete    : a `requested` | `rejected` row deletes at once (owner | processor);
//               a processed row becomes pending_delete until an admin confirms
//               or keeps it; deleting a PAID row reverses the Cost roll-up.
//   pay       : adds the amount to the WO's '34. Cost' field (Yoda
//               UpdateCostInClickUp); deleting a paid row subtracts it. Written
//               through moneySync.addToCost, so it is an audited field change
//               with the same field lock and NTE automation as a typed cost.
//
// `sent_to_yoda` (0022) is RETIRED: this service IS the Yoda payment flow, so
// there is nothing to hand off to. Migration 0076 folds existing rows back to
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
// Rules carried over from Yoda: a blacklisted vendor is a 409 (admin
// override); the W9 flag is the running-total
// window (> $599 per vendor + billing entity + year, non-credit); a manual payee
// becomes a vendor record keyed by phone (Yoda creates the Technician).
// 0083 (#24): the purpose is a code — J (Job), M (Materials), A (Assessment) —
// and the server numbers repeats per work order (J, J1, J2…), replacing the
// old duplicate-purpose 409. Pre-0083 free-text purposes are left as they are.
// 0083 (#5 / #7): before approve and pay, a payment that would take Cost past
// the NTE or past the approved quote raises the hold (D1b) and is refused.
// 0090 (Elise, 2026-10-22): WHO has to say yes — `paymentApprovalVerdict`
// (shared) at create: an OM Under Probation's request always waits, an OM /
// Senior OM's under $500 lands `approved` as it is raised (`auto_approved`),
// and Approve asks the 6.2.3 amount bands again (`assertTierAllows`:
// $500–3,000 TL / ATL, $3,000 and over AM; the row carries `tier` so the
// button locks first). Pay is unchanged: approved, a second person, the holds.
//
// The payee is EITHER a vendor record OR a manual name+phone pair. The DB does
// not CHECK across the two shapes — the rule is enforced here, where a useful
// 400 can be produced.

import { query, withTransaction } from '../db.js';
import type { Queryable } from '../db.js';
import type {
  ActivityActor,
  PaymentAddress,
  PaymentListItem,
  PaymentListResponse,
  PaymentHistoryAction,
  PaymentHistoryResponse,
  PaymentMethod,
  PaymentRequest,
  PaymentRequestStatus,
  PaymentRequestsResponse,
  VendorYtd,
  ApprovalTier,
} from '@theone/shared';
import {
  NTE_APPROVAL_REASON_CODE,
  NTE_OVERRIDE_REQUIRED_CODE,
  NTE_PAYMENT_APPROVER_CODE,
  OVERAGE_REASON_MIN,
  OVER_QUOTE_CODE,
  PAYMENT_OVERAGE_REASON_CODE,
  PAYMENT_METHOD_LABEL,
  PAYMENT_PROCESS_PERM_KEY,
  SELF_APPROVAL_CODE,
  DEPOSIT_PURPOSE,
  PAYMENT_PURPOSE_CODES,
  isPaymentPurposeCode,
  mayApproveOverNtePayment,
  nextPurpose,
  overNte,
  overQuoteReason,
  paymentApprovalVerdict,
  paymentLockReason,
  paymentOverage,
  paymentOverageSentence,
  paymentAboveNte,
  permAllows,
  projectedCost,
  vendorMoneyOut,
  purposeBase,
  selfApprovalMessage,
  selfApprovalVerdict,
  formatUsPhone,
  usPhoneProblem,
} from '@theone/shared';
import type { PaymentOverage, PaymentPurposeCode } from '@theone/shared';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { Params } from './woFields.js';
import { ACTOR_NAME_SQL } from '../lib/actorName.js';
import { woScopeSql } from './woScope.js';
import { requirePerm } from './permissions.js';
import {
  approvedCover,
  assertNoOpenMoneyHold,
  assertNoOpenNteOverride,
  createApprovalTask,
  raiseMoneyHold,
  reconcileApprovalTasks,
} from './approvals.js';
import { assertTierAllows, listApprovalTiers, tierSummary } from './approvalTiers.js';
import { assertWoAllows } from './woPolicy.js';
import { enqueueOutbox } from './outbox.js';
import { evaluateForTask } from './obligations.js';
import { dispatchAutomations } from './automations.js';
import { addToCost } from './moneySync.js';
import type { TaskChange } from './woAudit.js';

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/** Yoda: a running total above $599 per (technician, company, year) needs a W9. */
export const W9_THRESHOLD = 599;

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
  /** 0090: landed approved as it was raised (a dispatcher's request under $500). */
  auto_approved: boolean | null;
  /** Elise, 2026-10-28: the requester's reason for an overage. */
  overage_reason: string | null;
  wo_due: string | null;
  wo_nte: number | string | null;
  wo_cost: string | null;
  /** "Paying twice": the approved and paid vendor bills on the work order. */
  wo_bills: number | string | null;
  wo_emergency: boolean | null;
  wo_escalated: boolean | null;
  /** 0083: the largest cost an approved NTE override lets through. */
  nte_covers: number | string | null;
  over_quote_open: boolean;
  /** UAT T5: the largest cost an approved over-quote hold lets through. */
  quote_covers: number | string | null;
}

const SELECT_SQL = `
  SELECT pr.id::text        AS id,
         pr.task_id::text   AS task_id,
         t.wo_number, t.billing_entity, t.title, t.client,
         pr.vendor_id::text AS vendor_id,
         v.name             AS vendor_name,
         v.phone            AS vendor_phone,
         (v.w9_received = 'YES') AS vendor_w9,
         v.blacklisted      AS vendor_blacklisted,
         (SELECT to_char(min(e.expires_on), 'YYYY-MM-DD') FROM vendor_expiry e WHERE e.vendor_id = v.id)
                            AS vendor_insurance,
         pr.payee_name, pr.payee_phone, pr.purpose,
         pr.amount::float8  AS amount,
         pr.method, pr.payment_address, pr.note,
         pr.recipient_name, pr.recipient_phone, pr.recipient_is_store,
         pr.status, pr.needs_w9, pr.pending_delete, pr.delete_reason,
         pr.auto_approved,
         pr.overage_reason,
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
         (SELECT COALESCE(sum(b.total), 0)::float8 FROM vendor_bill b
           WHERE b.task_id = pr.task_id AND b.status IN ('approved', 'paid'))
                            AS wo_bills,
         COALESCE(t.fields->'Emergency' = 'true'::jsonb, false) AS wo_emergency,
         COALESCE(t.fields->'Escalated' = 'true'::jsonb, false) AS wo_escalated,
         EXISTS (SELECT 1 FROM approval_task a
                  WHERE a.task_id = pr.task_id AND a.type = 'nte_override' AND a.status = 'open')
                            AS nte_override_open,
         (SELECT max((a.detail->>'covers')::numeric) FROM approval_task a
           WHERE a.task_id = pr.task_id AND a.type = 'nte_override' AND a.status = 'approved'
             AND jsonb_typeof(a.detail->'covers') = 'number')
                            AS nte_covers,
         EXISTS (SELECT 1 FROM approval_task a
                  WHERE a.task_id = pr.task_id AND a.type = 'over_quote' AND a.status = 'open')
                            AS over_quote_open,
         (SELECT max((a.detail->>'covers')::numeric) FROM approval_task a
           WHERE a.task_id = pr.task_id AND a.type = 'over_quote' AND a.status = 'approved'
             AND jsonb_typeof(a.detail->'covers') = 'number')
                            AS quote_covers
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
/** UAT T5: the approved quote's figures per work order, read in one batch
    (quotes.bindableQuoteFiguresFor) for the rows a lock could apply to. */
type QuoteFigures = Map<string, { total: number | null; cost: number | null }>;

async function quoteFiguresFor(rows: PaymentRow[]): Promise<QuoteFigures> {
  const waiting = rows.filter((r) => r.status === 'requested' || r.status === 'approved').map((r) => r.task_id);
  if (waiting.length === 0) return new Map();
  const { bindableQuoteFiguresFor } = await import('./quotes.js');
  return bindableQuoteFiguresFor(waiting);
}

/** 0090: what mapPayment needs to draw the amount's band for the viewer —
    the bands read once per call (one query, not one per row). Rows read with
    no viewer (a service, the obligations engine) carry `tier: null`. */
interface MapOpts {
  fullAddress: boolean;
  viewer?: ActingPrincipal | null;
  tiers?: ApprovalTier[];
}

async function withTiers(opts: MapOpts): Promise<MapOpts> {
  if (!opts.viewer || opts.tiers) return opts;
  return { ...opts, tiers: await listApprovalTiers() };
}

/** One request as the API returns it — read, created, edited or moved —
    with the same lock the queues draw: its work order's quote figures read
    through the same batched reader (one work order, one call). */
async function mapOne(r: PaymentRow, opts: MapOpts): Promise<PaymentRequest> {
  return mapPayment(r, await withTiers(opts), await quoteFiguresFor([r]));
}

function mapPayment(
  r: PaymentRow,
  opts: MapOpts = { fullAddress: false },
  quotes?: QuoteFigures,
): PaymentRequest {
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
    money_hold: moneyHoldOf(r, quotes),
    above_nte: aboveNteOf(r),
    approve_hold: moneyHoldOf(r, quotes, true),
    tier:
      opts.viewer && opts.tiers
        ? tierSummary(opts.tiers, 'payment', Number(r.amount ?? 0), opts.viewer)
        : null,
    auto_approved: r.auto_approved === true,
    overage_reason: r.overage_reason ?? null,
  };
}

/**
 * 0083 (#5 / #7), UAT T5: what holds approving or paying this request, for
 * the button's lock — the API asks the same questions (assertPaymentNotHeld)
 * and raises the hold when the click comes. `quotes` carries the approved
 * quote's figures when the caller read them (the queues do, in one batch);
 * without them only the open holds and the NTE projection are drawn.
 */
function moneyHoldOf(r: PaymentRow, quotes?: QuoteFigures, ignoreNte = false): string | null {
  return paymentLockReason({
    ignoreNte,
    status: r.status,
    overQuoteOpen: Boolean(r.over_quote_open),
    nteOverrideOpen: Boolean(r.nte_override_open),
    cost: vendorMoneyOut(moneyNum(r.wo_cost), moneyNum(r.wo_bills)),
    amount: Number(r.amount ?? 0),
    nte: moneyNum(r.wo_nte),
    nteCovers: moneyNum(r.nte_covers),
    quote: quotes?.get(r.task_id) ?? null,
    quoteCovers: moneyNum(r.quote_covers),
  });
}

/** 2026-11-03: a waiting request that takes Cost past the NTE — the AM
    approves it on the payment, with a reason. */
function aboveNteOf(r: PaymentRow): boolean {
  return r.status === 'requested'
    && paymentAboveNte(vendorMoneyOut(moneyNum(r.wo_cost), moneyNum(r.wo_bills)), Number(r.amount ?? 0), moneyNum(r.wo_nte));
}

function mapListItem(r: PaymentRow, opts?: MapOpts, quotes?: QuoteFigures): PaymentListItem {
  return {
    ...mapPayment(r, opts, quotes),
    title: r.title,
    client: r.client,
    wo_due: r.wo_due,
    wo_nte: moneyNum(r.wo_nte),
    wo_cost: moneyNum(r.wo_cost),
    wo_emergency: Boolean(r.wo_emergency),
    wo_escalated: Boolean(r.wo_escalated),
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

/** A phone as the vendor_phone index stores it: digits, US numbers with the 1. */
function phoneDigits(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.length < 7) return '';
  return d.length === 10 ? `1${d}` : d;
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
export async function listPaymentRequests(taskId: string, viewer?: ActingPrincipal): Promise<PaymentRequestsResponse> {
  const res = await query<PaymentRow>(
    `${SELECT_SQL} WHERE pr.task_id = $1 AND pr.deleted_at IS NULL ORDER BY pr.created_at DESC, pr.id DESC`,
    [taskId],
  );
  const quotes = await quoteFiguresFor(res.rows);
  const opts = await withTiers({ fullAddress: false, viewer: viewer ?? null });
  const items = res.rows.map((r) => mapPayment(r, opts, quotes));
  return {
    items,
    total: items.length,
    total_paid: round2(items.filter((i) => i.status === 'paid').reduce((sum, i) => sum + i.amount, 0)),
    total_requested: round2(
      items.filter((i) => i.status !== 'rejected').reduce((sum, i) => sum + i.amount, 0),
    ),
  };
}

const HISTORY_ACTIONS: PaymentHistoryAction[] = [
  'payment_requested', 'payment_updated', 'payment_approved', 'payment_paid', 'payment_rejected',
  'payment_method_changed', 'payment_delete_requested', 'payment_delete_rejected', 'payment_deleted',
];

interface HistoryRow {
  id: string;
  action: PaymentHistoryAction;
  at: string;
  actor_name: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  payment_request_id: string | null;
  payee: string | null;
  purpose: string | null;
  pr_amount: number | null;
  rejection_note: string | null;
  delete_reason: string | null;
  request_deleted: boolean | null;
}

/**
 * Every step of every payment request on the work order — requested,
 * edited, approved, paid, rejected, method changed, delete asked / refused /
 * done — newest first. Read off the audit log the actions already write
 * (`logPayment`), so it covers deleted requests too and needs no new table.
 */
export async function listPaymentHistory(taskId: string): Promise<PaymentHistoryResponse> {
  const res = await query<HistoryRow>(
    `SELECT a.id::text AS id, a.action, ${ISO('a.created_at')} AS at,
            ${ACTOR_NAME_SQL} AS actor_name, a.before, a.after,
            pr.id::text AS payment_request_id,
            COALESCE(v.name, pr.payee_name, a.after->>'payee') AS payee,
            COALESCE(a.after->>'purpose', pr.purpose) AS purpose,
            pr.amount::float8 AS pr_amount,
            pr.rejection_note, pr.delete_reason,
            (pr.deleted_at IS NOT NULL) AS request_deleted
       FROM activity_log a
       LEFT JOIN principal p ON p.id = a.actor_principal_id
       LEFT JOIN payment_request pr
              ON pr.id::text = COALESCE(a.after->>'payment_request_id', a.before->>'payment_request_id')
             AND pr.task_id = $1
       LEFT JOIN vendor v ON v.id = pr.vendor_id
      WHERE a.entity_type = 'task' AND a.entity_id = $1::text
        AND a.field = 'payment_request.status'
        AND a.action = ANY($2::text[])
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 500`,
    [taskId, HISTORY_ACTIONS],
  );
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    items: res.rows.map((r) => {
      const before = r.before ?? {};
      const after = r.after ?? {};
      const reason =
        str(after.reason) ??
        str(after.overage_reason) ??
        (r.action === 'payment_rejected' ? str(r.rejection_note) : null) ??
        (r.action === 'payment_delete_requested' || r.action === 'payment_deleted' ? str(r.delete_reason) : null);
      return {
        id: r.id,
        action: r.action,
        at: r.at,
        actor_name: r.actor_name ?? 'Someone',
        payment_request_id: r.payment_request_id ?? str(after.payment_request_id) ?? str(before.payment_request_id),
        payee: r.payee,
        purpose: r.purpose,
        amount: num(after.amount) ?? r.pr_amount,
        from_status: (str(before.status) as PaymentRequestStatus | null),
        to_status: (str(after.status) as PaymentRequestStatus | null),
        from_method: (str(before.method) as PaymentMethod | null),
        to_method: (str(after.method) as PaymentMethod | null),
        reason,
        fields: Array.isArray(after.fields) ? after.fields.filter((f): f is string => typeof f === 'string') : [],
        auto_approved: after.auto_approved === true,
        self_approved: after.self_approved === true,
        request_deleted: r.request_deleted === true,
      };
    }),
  };
}

/** One request. The full payout address is served only to a processor. */
export async function getPaymentRequest(id: string, actor: ActingPrincipal): Promise<PaymentRequest> {
  const res = await query<PaymentRow>(`${SELECT_SQL} WHERE pr.id = $1 AND pr.deleted_at IS NULL`, [id]);
  if (res.rows.length === 0) throw notFound('Payment request not found');
  return mapOne(res.rows[0], { fullAddress: canProcessPayments(actor), viewer: actor });
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
  const quotes = await quoteFiguresFor(rows.rows);
  const opts = await withTiers({ fullAddress: false, viewer });
  return {
    items: rows.rows.map((r) => mapListItem(r, opts, quotes)),
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
  // Elise, 2026-11-03: the form opens on the method this technician was last paid by.
  const last = await query<{ method: PaymentMethod }>(
    `SELECT pr.method FROM payment_request pr
      WHERE pr.vendor_id = $1 AND pr.deleted_at IS NULL AND pr.status <> 'rejected'
        AND pr.recipient_name IS NULL
      ORDER BY pr.created_at DESC, pr.id DESC
      LIMIT 1`,
    [vendorId],
  );
  return {
    vendor_id: vendorId,
    year: new Date().getUTCFullYear(),
    billing_entity: billingEntity,
    total: round2(Number(res.rows[0]?.total ?? 0)),
    w9_threshold: W9_THRESHOLD,
    last_method: last.rows[0]?.method ?? null,
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

/**
 * Yoda UpdateCostInClickUp: '34. Cost' on the WO += / −= the paid amount —
 * one `field_updated` row stamped `via: 'payment'`. The caller dispatches
 * automations with the returned changes after it commits (a Cost past the
 * NTE raises the override, rule 1.5.2).
 */
function rollCost(tx: Queryable, taskId: string, actorId: string, delta: number): Promise<TaskChange[]> {
  return addToCost(tx, taskId, actorId, delta);
}

async function afterCost(taskId: string, changes: TaskChange[]): Promise<void> {
  if (changes.length > 0) await dispatchAutomations({ taskId, kind: 'changed', changes });
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
  /** Elise, 2026-10-28: required (409 PAYMENT_OVERAGE_REASON otherwise)
      when the request takes Cost past the NTE or the approved quote. */
  overage_reason?: string | null;
  /** 0122: the form's one-time key. A request this person already filed
      under it is answered as it is, never filed a second time. */
  submit_key?: string | null;
}

/** 0122: the request `requestedBy` already filed under `key`, if any. */
async function filedUnderKey(q: Queryable, requestedBy: string, key: string): Promise<string | null> {
  const res = await q.query<{ id: string }>(
    `SELECT id::text AS id FROM payment_request WHERE requested_by = $1 AND submit_key = $2`,
    [requestedBy, key],
  );
  return res.rows[0]?.id ?? null;
}

async function loadRow(id: string): Promise<PaymentRow> {
  const res = await query<PaymentRow>(`${SELECT_SQL} WHERE pr.id = $1 AND pr.deleted_at IS NULL`, [id]);
  if (res.rows.length === 0) throw notFound('Payment request not found');
  return res.rows[0];
}

/** 0083 (#24): the purpose must be one of the codes; the stored value is numbered. */
function purposeCodeOf(raw: string): PaymentPurposeCode {
  const typed = raw.trim().toUpperCase();
  const code = typed === DEPOSIT_PURPOSE ? 'D' : typed;
  if (!isPaymentPurposeCode(code)) {
    throw badRequest('Purpose must be J (Job), D (Deposit), M (Materials) or A (Assessment)', {
      code: 'PURPOSE_CODE',
      purpose: raw,
      allowed: [...PAYMENT_PURPOSE_CODES],
    });
  }
  return code;
}

/**
 * The numbered purpose for a request of `code` on this work order: J, then
 * J1, J2… Read on the caller's transaction AFTER it locked the task row, so
 * two requests submitted at once take different numbers. Every live row
 * counts, rejected ones included, so a number is never handed out twice.
 */
async function numberPurpose(tx: Queryable, taskId: string, code: PaymentPurposeCode, exceptId: string | null): Promise<string> {
  const res = await tx.query<{ purpose: string }>(
    `SELECT purpose FROM payment_request
      WHERE task_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
    [taskId, exceptId],
  );
  return nextPurpose(code, res.rows.map((r) => r.purpose));
}

function assertAddressMatches(method: PaymentMethod, address: PaymentAddress | null | undefined): void {
  if (address && address.method !== method) {
    throw badRequest('payment_address.method must match method', { method, address_method: address.method });
  }
}

/** What the audit row keeps of an overage (the figures, not the sentence). */
function overageAudit(o: PaymentOverage): Record<string, unknown> {
  return {
    projected_cost: o.projected,
    ...(o.nte ? { nte: o.nte.nte, over_nte_by: o.nte.over_by } : {}),
    ...(o.quote ? { quote_total: o.quote.total, quote_cost: o.quote.cost } : {}),
  };
}

/**
 * Elise, 2026-10-28: the overage a request of `amount` would cause on this
 * work order — Cost past the NTE (less what an approved override covers) or
 * past the approved quote (less an approved over-quote hold). The same
 * questions assertPaymentNotHeld asks at Approve and Pay, asked as the
 * request is filed so the hold does not appear only afterwards.
 */
async function overageFor(taskId: string, amount: number): Promise<PaymentOverage | null> {
  const t = await query<{ cost: string | null; nte: number | string | null; bills: number | string | null }>(
    `SELECT fields->>'34. Cost' AS cost, nte::float8 AS nte,
            (SELECT COALESCE(sum(b.total), 0)::float8 FROM vendor_bill b
              WHERE b.task_id = task.id AND b.status IN ('approved', 'paid')) AS bills
       FROM task WHERE id = $1`,
    [taskId],
  );
  if (!t.rows[0]) return null;
  const [nteCover, quote, quoteCover] = await Promise.all([
    approvedCover(taskId, 'nte_override'),
    approvedQuoteFigures(taskId),
    approvedCover(taskId, 'over_quote'),
  ]);
  return paymentOverage({
    // "Paying twice" (2026-11-02): approved / paid vendor bills count too.
    cost: vendorMoneyOut(moneyNum(t.rows[0].cost), moneyNum(t.rows[0].bills)),
    amount,
    nte: moneyNum(t.rows[0].nte),
    nteCovers: nteCover?.covers ?? null,
    quote,
    quoteCovers: quoteCover?.covers ?? null,
  });
}

/** The reason, trimmed — or the 409 that asks for it (the form's popup). */
function requireOverageReason(o: PaymentOverage | null, raw: string | null | undefined): string | null {
  if (!o) return null;
  const reason = raw?.trim() ?? '';
  if (reason.length >= OVERAGE_REASON_MIN) return reason;
  throw conflict(paymentOverageSentence(o), {
    code: PAYMENT_OVERAGE_REASON_CODE,
    projected: o.projected,
    over_nte: o.nte,
    over_quote: o.quote,
    min_length: OVERAGE_REASON_MIN,
  });
}

/**
 * Raise (or refresh) the holds an overage needs, after the request committed:
 * the NTE override (section NTE — AM and the other managers decide it) and
 * the over-quote hold (Money holds — ATL and above, never OP Admin). Each
 * carries the requester's reason. Never throws: Approve and Pay ask again
 * (assertPaymentNotHeld) and raise whatever is missing.
 */
async function raiseOverageHolds(
  taskId: string,
  paymentId: string,
  o: PaymentOverage,
  reason: string,
  actor: ActingPrincipal,
  amount: number,
  payee: string,
): Promise<void> {
  try {
    if (o.nte) {
      await createApprovalTask({
        taskId,
        type: 'nte_override',
        actorId: actor.id,
        preset: {
          title: `Paying ${money(amount)} to ${payee} would take Cost to ${money(o.projected)}, over the client NTE ${money(o.nte.nte)}`,
          detail: {
            cost: o.projected,
            nte: o.nte.nte,
            over_by: o.nte.over_by,
            covers: o.projected,
            projected: true,
            payment_request_id: paymentId,
            reason,
            requested_by: actor.name,
          },
        },
      });
    }
    if (o.quote) {
      await createApprovalTask({
        taskId,
        type: 'over_quote',
        actorId: actor.id,
        preset: {
          title: `${o.quote.reason} (paying ${money(amount)} to ${payee})`,
          detail: {
            cost: o.projected,
            quote_total: o.quote.total,
            quote_cost: o.quote.cost,
            covers: o.projected,
            payment_request_id: paymentId,
            reason,
            requested_by: actor.name,
          },
        },
      });
    }
  } catch (err) {
    console.error('[payments] could not raise the overage hold for', paymentId, err);
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

  // 0122: a second Submit (double click, a retry) answers the first one.
  const submitKey = input.submit_key ?? null;
  if (submitKey) {
    const filed = await filedUnderKey({ query }, actor.id, submitKey);
    if (filed) return mapOne(await loadRow(filed), { fullAddress: canProcessPayments(actor), viewer: actor });
  }

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
  const purposeCode = purposeCodeOf(input.purpose);
  // 0090: who has to say yes. A dispatcher's request under $500 is cleared
  // for AP as it is raised; a probation dispatcher's, and anyone's at $500
  // or over, waits in the queue for the band's approver.
  const approval = paymentApprovalVerdict(actor.role, input.amount);
  // Elise, 2026-10-28: past the NTE or the approved quote the request is
  // still filed — with the requester's reason — and always waits in the
  // queue: the hold raised below is what a manager decides first.
  const overage = await overageFor(taskId, input.amount);
  const overageReason = requireOverageReason(overage, input.overage_reason);
  const autoApproved = !approval.needed && !overage;
  const startStatus: PaymentRequestStatus = autoApproved ? 'approved' : 'requested';

  // Yoda resolves the Technician by phone and creates one when unknown, so the
  // W9 / YTD bookkeeping has a record to hang off. Same here: a manual payee
  // whose phone matches a vendor links to it; an unknown one becomes a vendor.
  // The lookup is the vendor record's phone index (0057 vendor_phone).
  const payeeDigits = payeePhone ? phoneDigits(payeePhone) : '';
  if (!vendorId && payeeDigits) {
    const match = await query<{ id: string }>(
      `SELECT p.vendor_id::text AS id FROM vendor_phone p JOIN vendor v ON v.id = p.vendor_id
        WHERE p.digits = $1 AND v.deleted_at IS NULL ORDER BY p.position LIMIT 1`,
      [payeeDigits],
    );
    vendorId = match.rows[0]?.id ?? null;
  }
  // Elise, 2026-11-03: a payee that becomes a NEW vendor needs a real US
  // number, stored as (409) 555-0143; one matched above keeps its record.
  let newPayeePhone = payeePhone;
  if (!vendorId && payeePhone) {
    const problem = usPhoneProblem(payeePhone);
    if (problem) throw badRequest(problem, { code: 'VALIDATION', field: 'payee_phone' });
    newPayeePhone = formatUsPhone(payeePhone);
  }

  if (vendorId) {
    const v = await query<{ id: string; is_blacklisted: boolean; blacklist_reason: string | null }>(
      `SELECT id::text AS id, blacklisted AS is_blacklisted, blacklist_reason FROM vendor WHERE id = $1`,
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

  let createdId: string | null = null;
  let replayed = false;
  let payeeLabel = 'the technician';

  await withTransaction(async (tx) => {
    // The task row first (the parent-first order of every child insert, and
    // the lock the purpose numbering reads under). NO KEY: see woFieldValues.
    await tx.query(`SELECT 1 FROM task WHERE id = $1 FOR NO KEY UPDATE`, [taskId]);
    // 0122: two posts with one key that both passed the check above meet
    // here; the second waited on the lock and now sees the first's row.
    if (submitKey) {
      const filed = await filedUnderKey(tx, actor.id, submitKey);
      if (filed) {
        createdId = filed;
        replayed = true;
        return;
      }
    }
    const purpose = await numberPurpose(tx, taskId, purposeCode, null);
    if (!vendorId && payeeName && payeePhone) {
      // A technician record (0057 kind = tech), findable by phone next time.
      const created = await tx.query<{ id: string }>(
        `INSERT INTO vendor (name, phone, trades, kind, created_by) VALUES ($1, $2, '{}', 'tech', $3) RETURNING id::text AS id`,
        [payeeName, newPayeePhone, actor.id],
      );
      vendorId = created.rows[0].id;
      if (payeeDigits) {
        await tx.query(
          `INSERT INTO vendor_phone (vendor_id, digits, display) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [vendorId, payeeDigits, newPayeePhone],
        );
      }
    }
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO payment_request
         (task_id, vendor_id, payee_name, payee_phone, purpose, amount, method, payment_address, note,
          recipient_name, recipient_phone, recipient_is_store, attachment_id, status, requested_by,
          auto_approved, approved_at, overage_reason, submit_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $15, $14,
               $16, CASE WHEN $16 THEN now() ELSE NULL END, $17, $18)
       RETURNING id::text AS id`,
      [
        taskId,
        vendorId,
        payeeName,
        newPayeePhone,
        purpose,
        input.amount,
        input.method,
        input.payment_address ? JSON.stringify(input.payment_address) : null,
        input.note ?? null,
        input.recipient_name?.trim() || null,
        input.recipient_phone?.trim() || null,
        input.recipient_is_store === true,
        input.attachment_id ?? null,
        actor.id,
        startStatus,
        autoApproved,
        overageReason,
        submitKey,
      ],
    );
    createdId = ins.rows[0].id;
    if (vendorId) await recomputeNeedsW9(tx, vendorId);

    const row = await tx.query<PaymentRow>(`${SELECT_SQL} WHERE pr.id = $1`, [createdId]);
    const full = mapPayment(row.rows[0], { fullAddress: true });
    payeeLabel = full.payee.name ?? payeeLabel;
    const plain = postedMessage(full, actor);
    await tx.query(`UPDATE payment_request SET posted_message_plain = $2 WHERE id = $1`, [createdId, plain]);

    await logPayment(tx, actor.id, taskId, 'payment_requested', null, {
      payment_request_id: createdId,
      status: startStatus,
      amount: input.amount,
      method: input.method,
      purpose,
      needs_w9: full.needs_w9,
      ...(autoApproved ? { auto_approved: true, approval_reason: approval.reason } : {}),
      ...(overage ? { overage: overageAudit(overage), overage_reason: overageReason } : {}),
    });
    await enqueueOutbox(tx, 'payment.requested', 'payment_request', createdId, {
      task_id: taskId,
      billing_entity: full.billing_entity,
      message: plain,
    });
  });

  if (!createdId) throw new ApiError('INTERNAL', 'Payment request insert produced no row');
  if (replayed) return mapOne(await loadRow(createdId), { fullAddress: canProcessPayments(actor), viewer: actor });
  if (overage && overageReason) {
    await raiseOverageHolds(taskId, createdId, overage, overageReason, actor, input.amount, payeeLabel);
  }

  // S5 · a request entering the queue starts the payment_processing clock
  // (2 business days), owed by AP until a decision lands.
  await evaluateForTask(taskId);

  return mapOne(await loadRow(createdId), { fullAddress: canProcessPayments(actor), viewer: actor });
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
  /** Elise, 2026-10-28: the reason, when a new amount takes Cost past the
      NTE or the approved quote (the reason on file is kept otherwise). */
  overage_reason?: string | null;
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
  // A new code is numbered again; the same code keeps the number it has.
  const purposeCode = input.purpose !== undefined ? purposeCodeOf(input.purpose) : null;
  // Elise, 2026-10-28: a new amount is asked the overage question again.
  const amountChanged = input.amount !== undefined && input.amount !== Number(row.amount ?? 0);
  const overage = amountChanged ? await overageFor(row.task_id, input.amount as number) : null;
  const overageReason = requireOverageReason(overage, input.overage_reason ?? row.overage_reason);
  const { overage_reason: _reasonInput, ...fields } = input;

  await withTransaction(async (tx) => {
    await tx.query(`SELECT 1 FROM task WHERE id = $1 FOR NO KEY UPDATE`, [row.task_id]);
    const purpose =
      purposeCode === null ? null
      : purposeBase(row.purpose) === purposeCode ? row.purpose
      : await numberPurpose(tx, row.task_id, purposeCode, id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown, cast = '') => {
      params.push(v);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (purpose !== null) set('purpose', purpose);
    if (input.amount !== undefined) set('amount', input.amount);
    if (input.method !== undefined) set('method', input.method);
    if (input.payment_address !== undefined) set('payment_address', input.payment_address ? JSON.stringify(input.payment_address) : null, '::jsonb');
    if (input.note !== undefined) set('note', input.note);
    if (input.recipient_name !== undefined) set('recipient_name', input.recipient_name?.trim() || null);
    if (input.recipient_phone !== undefined) set('recipient_phone', input.recipient_phone?.trim() || null);
    if (input.recipient_is_store !== undefined) set('recipient_is_store', input.recipient_is_store);
    if (overageReason !== null) set('overage_reason', overageReason);
    if (sets.length > 0) {
      params.push(id);
      // Only while it is still requested, in the statement (#25).
      const kept = await tx.query(
        `UPDATE payment_request SET ${sets.join(', ')} WHERE id = $${params.length} AND status = 'requested' AND deleted_at IS NULL RETURNING id`,
        params,
      );
      if (!kept.rows[0]) throw conflict('This payment request was processed while you were editing it — reload it', { code: 'PAYMENT_MOVED' });
    }
    if (row.vendor_id) await recomputeNeedsW9(tx, row.vendor_id);
    await logPayment(tx, actor.id, row.task_id, 'payment_updated', null, {
      payment_request_id: id,
      fields: Object.keys(fields),
      ...(overage ? { overage: overageAudit(overage), overage_reason: overageReason } : {}),
    });
  });
  if (overage && overageReason) {
    const payee = (row.vendor_id ? row.vendor_name : row.payee_name) ?? 'the technician';
    await raiseOverageHolds(row.task_id, id, overage, overageReason, actor, input.amount as number, payee);
  }
  return mapOne(await loadRow(id), { fullAddress: canProcessPayments(actor), viewer: actor });
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
  extra?: (tx: Queryable) => Promise<TaskChange[] | void>,
  selfApproved = false,
  logExtra: Record<string, unknown> = {},
): Promise<PaymentRequest> {
  if (!from.includes(row.status)) {
    throw badRequest(`This payment request is already ${LABEL[row.status]}; it cannot be ${LABEL[to]} now`, {
      status: row.status,
      allowed_from: from,
    });
  }
  let costChanges: TaskChange[] = [];
  await withTransaction(async (tx) => {
    // #25: ONE conditional statement on the status the row was read in. Two
    // clicks on Pay race here; the second matches no row and is refused, so
    // the money and the Cost roll-up below happen exactly once.
    const moved = await tx.query(
      `UPDATE payment_request SET status = $1${extraSet ? `, ${extraSet}` : ''}
        WHERE id = $2 AND status = $${3 + extraParams.length} AND deleted_at IS NULL
        RETURNING id`,
      [to, row.id, ...extraParams, row.status],
    );
    if (!moved.rows[0]) {
      throw conflict(`This payment request changed while you were looking at it, so it was not ${LABEL[to]} — reload it`, {
        code: 'PAYMENT_MOVED',
        payment_request_id: row.id,
        status: row.status,
      });
    }
    if (extra) costChanges = (await extra(tx)) ?? [];
    await logPayment(tx, actor.id, row.task_id, action, { payment_request_id: row.id, status: row.status }, {
      payment_request_id: row.id,
      status: to,
      amount: Number(row.amount ?? 0),
      payee: row.vendor_id ? row.vendor_name : row.payee_name,
      ...(selfApproved ? { self_approved: true } : {}),
      ...logExtra,
    });
  });
  await afterCost(row.task_id, costChanges);
  return mapOne(await loadRow(row.id), { fullAddress: canProcessPayments(actor), viewer: actor });
}

/** D2: 403 SELF_APPROVAL when the requester decides their own request;
    true when a super admin does (logged self_approved). */
function assertNotOwnRequest(row: PaymentRow, actor: ActingPrincipal, verb: string): boolean {
  const verdict = selfApprovalVerdict(row.requested_by_id, actor.id, actor.isSuperAdmin);
  if (verdict === 'blocked') {
    throw forbidden(selfApprovalMessage('this payment request', verb), {
      code: SELF_APPROVAL_CODE,
      payment_request_id: row.id,
    });
  }
  return verdict === 'self_approved';
}

/** The approved quote's price and cost side, when the work order has one. */
async function approvedQuoteFigures(taskId: string): Promise<{ total: number | null; cost: number | null } | null> {
  const { getBindableQuoteTotal } = await import('./quotes.js');
  const total = await getBindableQuoteTotal(taskId);
  if (total === null) return null;
  const c = await query<{ cost: string | number | null; tbd: boolean }>(
    `SELECT total_cost AS cost, is_cost_tbd AS tbd FROM quote WHERE task_id = $1 LIMIT 1`,
    [taskId],
  );
  const cost = c.rows[0] && !c.rows[0].tbd && c.rows[0].cost !== null ? Number(c.rows[0].cost) : null;
  return { total, cost };
}

/**
 * 0083 (#5 / #7, D1b) — asked BEFORE approve and pay write anything: an open
 * NTE override or over-quote hold refuses the move (rule 1.5.2's pattern);
 * otherwise, if paying this would take Cost past the NTE (with no approved
 * override covering that much) or past the approved quote, the hold is raised
 * and the move refused with a 409 that names it. A manager's approval stores
 * the projected cost as `covers`, so the retry goes through.
 */
async function assertPaymentNotHeld(
  row: PaymentRow,
  actor: ActingPrincipal,
  move: string,
  /** 2026-11-03: the AM approving a payment above the NTE decides the NTE in
      the same act (approveOverNte), so only the quote is asked here. */
  nteDecidedHere = false,
): Promise<void> {
  if (!nteDecidedHere) await assertNoOpenNteOverride(row.task_id, move);
  await assertNoOpenMoneyHold(row.task_id, 'over_quote', move, OVER_QUOTE_CODE);
  const amount = Number(row.amount ?? 0);
  // "Paying twice" (2026-11-02): the approved and paid vendor bills are vendor
  // money too, though they never feed Cost — a request for work a bill
  // already paid is measured with them. Read fresh, not from the row.
  const billsRes = await query<{ bills: number | string | null }>(
    `SELECT COALESCE(sum(total), 0)::float8 AS bills FROM vendor_bill WHERE task_id = $1 AND status IN ('approved', 'paid')`,
    [row.task_id],
  );
  const bills = moneyNum(billsRes.rows[0]?.bills ?? null) ?? 0;
  const projected = projectedCost(vendorMoneyOut(moneyNum(row.wo_cost), bills), amount);
  const withBills = bills > 0 ? ` (with ${money(bills)} of vendor bills)` : '';
  const nte = moneyNum(row.wo_nte);
  const payee = (row.vendor_id ? row.vendor_name : row.payee_name) ?? 'the technician';
  const nteCover = nteDecidedHere ? null : await approvedCover(row.task_id, 'nte_override');
  if (!nteDecidedHere && overNte(projected, nte, nteCover?.covers)) {
    await raiseMoneyHold({
      taskId: row.task_id,
      type: 'nte_override',
      actorId: actor.id,
      title: `Paying ${money(amount)} to ${payee} would take Cost to ${money(projected)}${withBills}, over the client NTE ${money(nte ?? 0)}`,
      detail: {
        cost: projected,
        vendor_bills: bills,
        nte,
        over_by: Math.round((projected - (nte ?? 0)) * 100) / 100,
        covers: projected,
        projected: true,
        payment_request_id: row.id,
        ...(row.overage_reason ? { reason: row.overage_reason } : {}),
      },
      move,
      code: NTE_OVERRIDE_REQUIRED_CODE,
    });
  }
  const quote = await approvedQuoteFigures(row.task_id);
  const quoteCover = await approvedCover(row.task_id, 'over_quote');
  const reason = overQuoteReason(projected, quote, quoteCover?.covers);
  if (reason) {
    await raiseMoneyHold({
      taskId: row.task_id,
      type: 'over_quote',
      actorId: actor.id,
      title: `${reason} (paying ${money(amount)} to ${payee}${bills > 0 ? `, with ${money(bills)} of vendor bills` : ''})`,
      detail: {
        cost: projected,
        vendor_bills: bills,
        quote_total: quote?.total ?? null,
        quote_cost: quote?.cost ?? null,
        covers: projected,
        payment_request_id: row.id,
        ...(row.overage_reason ? { reason: row.overage_reason } : {}),
      },
      move,
      code: OVER_QUOTE_CODE,
    });
  }
}

/**
 * 2026-11-03 (Elise): the NTE half of approving a payment above the NTE, in
 * the payment's own transaction. The open NTE override is approved with the
 * AM's reason and made to cover the projected cost; with none open, an
 * approved one is filed. Either way the decision is logged and posted as an
 * internal comment, as an approval from the inbox would be.
 */
async function approveOverNte(
  tx: Queryable,
  row: PaymentRow,
  projected: number,
  reason: string,
  actor: ActingPrincipal,
): Promise<void> {
  const nte = moneyNum(row.wo_nte) ?? 0;
  const amount = Number(row.amount ?? 0);
  const payee = (row.vendor_id ? row.vendor_name : row.payee_name) ?? 'the technician';
  const title = `Paying ${money(amount)} to ${payee} takes Cost to ${money(projected)}, over the client NTE ${money(nte)}`;
  const facts = {
    cost: projected,
    nte,
    over_by: Math.round((projected - nte) * 100) / 100,
    projected: true,
    payment_request_id: row.id,
    ...(row.overage_reason ? { reason: row.overage_reason } : {}),
    approved_with_payment: true,
  };
  const open = await tx.query<{ id: string; detail: Record<string, unknown> | null }>(
    `SELECT id::text AS id, detail FROM approval_task
      WHERE task_id = $1 AND type = 'nte_override' AND status = 'open' LIMIT 1 FOR UPDATE`,
    [row.task_id],
  );
  let taskId: string;
  const cur = open.rows[0];
  if (cur) {
    const prev = typeof cur.detail?.covers === 'number' ? (cur.detail.covers as number) : 0;
    await tx.query(
      `UPDATE approval_task
          SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3,
              assigned_to = COALESCE(assigned_to, $2), updated_at = now(),
              detail = detail || $4::jsonb
        WHERE id = $1`,
      [cur.id, actor.id, reason, JSON.stringify({ ...facts, covers: Math.max(prev, projected) })],
    );
    taskId = cur.id;
  } else {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO approval_task
         (type, task_id, title, detail, status, created_by, decided_by, decided_at, decision_note, assigned_to)
       VALUES ('nte_override', $1, $2, $3::jsonb, 'approved', $4, $4, now(), $5, $4)
       RETURNING id::text AS id`,
      [row.task_id, title, JSON.stringify({ ...facts, covers: projected }), actor.id, reason],
    );
    taskId = ins.rows[0].id;
  }
  await tx.query(
    `INSERT INTO activity_log
       (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'approval_task_approved', 'approval_task.status', $3::jsonb, $4::jsonb)`,
    [
      actor.id,
      row.task_id,
      cur ? JSON.stringify({ approval_task_id: taskId, status: 'open' }) : null,
      JSON.stringify({ approval_task_id: taskId, type: 'nte_override', status: 'approved', title, detail: facts, note: reason }),
    ],
  );
  const c = await tx.query<{ id: string }>(
    `INSERT INTO comment (task_id, author_principal_id, body, client_visible)
     VALUES ($1, $2, $3, false) RETURNING id::text AS id`,
    [row.task_id, actor.id, `NTE override approved with the payment — ${title} — ${reason}`],
  );
  await tx.query(
    `INSERT INTO activity_log
       (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
    [
      actor.id,
      row.task_id,
      JSON.stringify({
        comment_id: c.rows[0].id,
        client_visible: false,
        approval_task_id: taskId,
        approval: { type: 'nte_override', title, detail: facts, status: 'approved', note: reason },
      }),
    ],
  );
}

/** What the NTE rule needs to know about a request right now. */
async function nteFacts(row: PaymentRow): Promise<{ amount: number; nte: number | null; cost: number; aboveNte: boolean }> {
  const amount = Number(row.amount ?? 0);
  const nte = moneyNum(row.wo_nte);
  const billsRes = await query<{ bills: number | string | null }>(
    `SELECT COALESCE(sum(total), 0)::float8 AS bills FROM vendor_bill WHERE task_id = $1 AND status IN ('approved', 'paid')`,
    [row.task_id],
  );
  const cost = vendorMoneyOut(moneyNum(row.wo_cost), moneyNum(billsRes.rows[0]?.bills ?? null));
  return { amount, nte, cost, aboveNte: row.status === 'requested' && paymentAboveNte(cost, amount, nte) };
}

/**
 * requested → approved (payments:approve); never by its own requester.
 * Within the NTE: the amount's band decides who (0090 / 0115), and an open
 * NTE override or a projection past the NTE / approved quote holds it (0083).
 * Above the NTE (2026-11-03, Elise): an Account Manager approves it here,
 * with a reason (409 NTE_APPROVAL_REASON until one is sent), whatever the
 * amount — and that approval decides the NTE override too. The approved
 * quote still holds it as before.
 */
export async function approvePaymentRequest(
  id: string,
  actor: ActingPrincipal,
  nteReason?: string | null,
): Promise<PaymentRequest> {
  assertCanApprove(actor, 'approve');
  const row = await loadRow(id);
  const selfApproved = assertNotOwnRequest(row, actor, 'approve');
  const { amount, nte, cost, aboveNte } = await nteFacts(row);

  if (!aboveNte) {
    // 0090 (rule 6.2.3): the amount's band says which roles may approve it —
    // $500–3,000 TL / ATL, $3,000 and over AM (Admin › Settings).
    await assertTierAllows('payment', amount, actor, 'Approving a payment');
    await assertPaymentNotHeld(row, actor, 'Approving this payment');
    return setStatus(row, ['requested'], 'approved', 'payment_approved', actor,
      'approved_by = $3, approved_at = now()', [actor.id],
      async (tx) => {
        await enqueueOutbox(tx, 'payment.approved', 'payment_request', id, { task_id: row.task_id });
      }, selfApproved);
  }

  const projected = projectedCost(cost, amount);
  const over = `Paying this takes Cost to ${money(projected)}, over the client NTE ${money(nte ?? 0)}`;
  if (!mayApproveOverNtePayment(actor.role, actor.isSuperAdmin)) {
    throw forbidden(`${over} — an Account Manager approves it`, {
      code: NTE_PAYMENT_APPROVER_CODE,
      payment_request_id: id,
    });
  }
  const reason = nteReason?.trim() ?? '';
  if (reason.length < OVERAGE_REASON_MIN) {
    throw conflict(`${over}. Say why you are approving it.`, {
      code: NTE_APPROVAL_REASON_CODE,
      payment_request_id: id,
      projected,
      nte,
      requester_reason: row.overage_reason,
      min_length: OVERAGE_REASON_MIN,
    });
  }
  await assertPaymentNotHeld(row, actor, 'Approving this payment', true);
  return setStatus(row, ['requested'], 'approved', 'payment_approved', actor,
    'approved_by = $3, approved_at = now()', [actor.id],
    async (tx) => {
      await approveOverNte(tx, row, projected, reason, actor);
      await enqueueOutbox(tx, 'payment.approved', 'payment_request', id, { task_id: row.task_id });
    }, selfApproved, { above_nte: true, reason, nte, projected_cost: projected });
}

/**
 * approved → paid (payments/process:edit) — Yoda VerifyPayment: stamps the
 * payer, rolls the amount into the WO's Cost field and queues the
 * confirmation post. 0083 (#4): only from approved — paying straight from
 * requested is retired, so every dollar out had a second person's yes — and
 * never by the requester (D2). Rule 1.5.2 and the 0083 holds apply.
 */
export async function payPaymentRequest(id: string, actor: ActingPrincipal): Promise<PaymentRequest> {
  assertCanProcess(actor, 'Paying');
  const row = await loadRow(id);
  if (row.status === 'requested') {
    throw conflict('Approve this payment request before paying it', {
      code: 'PAYMENT_NOT_APPROVED',
      payment_request_id: id,
    });
  }
  const selfApproved = assertNotOwnRequest(row, actor, 'pay');
  await assertPaymentNotHeld(row, actor, 'Paying this request');
  const amount = Number(row.amount ?? 0);
  return setStatus(row, ['approved', 'sent_to_yoda'], 'paid', 'payment_paid', actor,
    'approved_by = COALESCE(approved_by, $3), approved_at = COALESCE(approved_at, now()), paid_by = $3, paid_at = now()', [actor.id],
    async (tx) => {
      await enqueueOutbox(tx, 'payment.paid', 'payment_request', id, {
        task_id: row.task_id,
        amount,
        paid_by: actor.name,
      });
      return rollCost(tx, row.task_id, actor.id, amount);
    }, selfApproved);
}

/**
 * requested | approved → rejected (payments:approve) with the reason for the
 * requester. Elise, 2026-11-09: whoever may not approve it may not decline it
 * either: the amount's band, or above the NTE an Account Manager.
 */
export async function rejectPaymentRequest(id: string, reason: string, actor: ActingPrincipal): Promise<PaymentRequest> {
  assertCanApprove(actor, 'reject');
  const row = await loadRow(id);
  const facts = await nteFacts(row);
  if (!facts.aboveNte) {
    await assertTierAllows('payment', facts.amount, actor, 'Declining a payment');
  } else if (!mayApproveOverNtePayment(actor.role, actor.isSuperAdmin)) {
    throw forbidden('This payment is above the client NTE — an Account Manager declines it', {
      code: NTE_PAYMENT_APPROVER_CODE,
      payment_request_id: id,
    });
  }
  const note = reason.trim();
  const out = await setStatus(row, ['requested', 'approved', 'sent_to_yoda'], 'rejected', 'payment_rejected', actor,
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
  // 2026-10-28: a hold raised for this request (at request time, with the
  // reason) has nothing left to decide once the request is refused; left
  // open it would hold every other payment on the work order.
  await reconcileApprovalTasks(row.task_id, actor.id);
  return out;
}

/** Yoda ConvertToAch, generalised: a processor changes the method; old payout details are dropped. */
export async function convertPaymentMethod(id: string, method: PaymentMethod, actor: ActingPrincipal): Promise<PaymentRequest> {
  assertCanProcess(actor, 'Changing the payment method');
  const row = await loadRow(id);
  if (row.status === 'paid') throw badRequest('A paid payment cannot change method');
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE payment_request SET method = $2, payment_address = NULL WHERE id = $1`, [id, method]);
    if (row.vendor_id) await recomputeNeedsW9(tx, row.vendor_id);
    await logPayment(tx, actor.id, row.task_id, 'payment_method_changed', { payment_request_id: id, method: row.method }, {
      payment_request_id: id,
      method,
    });
  });
  return mapOne(await loadRow(id), { fullAddress: true, viewer: actor });
}

async function hardDelete(tx: Queryable, row: PaymentRow, reason: string, actor: ActingPrincipal): Promise<TaskChange[]> {
  await tx.query(
    `UPDATE payment_request SET deleted_at = now(), deleted_by = $2, delete_reason = $3, pending_delete = false WHERE id = $1`,
    [row.id, actor.id, reason],
  );
  const costChanges = row.status === 'paid' ? await rollCost(tx, row.task_id, actor.id, -Number(row.amount ?? 0)) : [];
  if (row.vendor_id) await recomputeNeedsW9(tx, row.vendor_id);
  await logPayment(tx, actor.id, row.task_id, 'payment_deleted', { payment_request_id: row.id, status: row.status }, {
    payment_request_id: row.id,
    reason,
    amount: Number(row.amount ?? 0),
  });
  await enqueueOutbox(tx, 'payment.deleted', 'payment_request', row.id, { task_id: row.task_id, reason });
  return costChanges;
}

/** Delete now, then announce a Cost that moved to the rules (after the commit). */
async function deleteNow(row: PaymentRow, reason: string, actor: ActingPrincipal): Promise<void> {
  let changes: TaskChange[] = [];
  await withTransaction(async (tx) => {
    changes = await hardDelete(tx, row, reason, actor);
  });
  await afterCost(row.task_id, changes);
  // Same as a rejection: the request's own hold is closed (never throws).
  await reconcileApprovalTasks(row.task_id, actor.id);
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

  if (row.status === 'requested' || row.status === 'rejected') {
    if (!(owner || canProcessPayments(actor))) {
      throw forbidden('Only the requester or AP can delete this payment request');
    }
    await deleteNow(row, trimmed, actor);
    return null;
  }

  if (!canProcessPayments(actor) && !owner) {
    throw forbidden('Deleting a processed payment requires AP');
  }
  if (canAdminPayments(actor)) {
    await deleteNow(row, trimmed, actor);
    return null;
  }
  await withTransaction(async (tx) => {
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
  return mapOne(await loadRow(id), { fullAddress: canProcessPayments(actor), viewer: actor });
}

/** Admin confirms a pending delete (second person). */
export async function confirmDeletePaymentRequest(id: string, actor: ActingPrincipal): Promise<void> {
  assertCanAdmin(actor);
  const row = await loadRow(id);
  if (!row.pending_delete) throw badRequest('This payment has no pending delete to confirm');
  await deleteNow(row, row.delete_reason ?? 'Confirmed by admin', actor);
}

/** Yoda RejectDeletePayment: admin keeps the row, the flag clears. */
export async function rejectDeletePaymentRequest(id: string, actor: ActingPrincipal): Promise<PaymentRequest> {
  assertCanAdmin(actor);
  const row = await loadRow(id);
  if (!row.pending_delete) throw badRequest('This payment has no pending delete to reject');
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE payment_request SET pending_delete = false, delete_requested_by = NULL, delete_reason = NULL WHERE id = $1`,
      [id],
    );
    await logPayment(tx, actor.id, row.task_id, 'payment_delete_rejected', null, { payment_request_id: id });
  });
  return mapOne(await loadRow(id), { fullAddress: true, viewer: actor });
}
