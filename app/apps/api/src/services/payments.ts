// Technician payment request service (S4) — the PPR replacement.
//
// One `payment_request` row per submission. Since 0016 the row moves:
//
//   requested ──approve──▶ approved ──send──▶ sent_to_yoda ──paid──▶ paid
//       │                     │
//       └───────reject────────┘──▶ rejected
//
// Yoda is the tool the money actually leaves from, so "send to Yoda" is a
// hand-off recorded here (who, when, the reference Yoda gave back) and "paid"
// is the confirmation. Two gates, both from the permission tree (0015):
//   payments:approve        approve / reject
//   payments/process:edit   send to Yoda / mark paid
// Anyone who can see the work order can request a payment; the Payments tab
// is the control point.
//
// The payee is EITHER a vendor record OR a manual name+phone pair (a tech who
// is not in the vendor list). The DB does not CHECK across the two shapes — the
// rule is enforced here, where a useful 400 can be produced.

import { query, withTransaction } from '../db.js';
import type {
  ActivityActor,
  PaymentListItem,
  PaymentListResponse,
  PaymentRequest,
  PaymentRequestStatus,
  PaymentRequestsResponse,
} from '@theone/shared';
import { PAYMENT_PROCESS_PERM_KEY } from '@theone/shared';
import { ApiError, badRequest } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { evaluateForTask } from './obligations.js';
import { Params } from './woFields.js';
import { woScopeSql } from './woScope.js';
import { requirePerm } from './permissions.js';
import { assertNoOpenNteOverride } from './approvals.js';

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

interface PaymentRow {
  id: string;
  task_id: string;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_phone: string | null;
  payee_name: string | null;
  payee_phone: string | null;
  purpose: string;
  amount: number | null;
  method: string;
  note: string | null;
  recipient_name: string | null;
  status: PaymentRequestStatus;
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
  wo_number: string;
  title: string | null;
  client: string | null;
  nte_override_open: boolean;
  wo_due: string | null;
  wo_nte: number | string | null;
  wo_cost: string | null;
  wo_emergency: boolean | null;
  wo_escalated: boolean | null;
}

const SELECT_SQL = `
  SELECT pr.id::text        AS id,
         pr.task_id::text   AS task_id,
         pr.vendor_id::text AS vendor_id,
         v.name             AS vendor_name,
         v.phone            AS vendor_phone,
         pr.payee_name, pr.payee_phone, pr.purpose,
         pr.amount::float8  AS amount,
         pr.method, pr.note, pr.recipient_name, pr.status,
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
         t.wo_number, t.title, t.client,
         t.fields->>'Due Date'   AS wo_due,
         t.nte::float8           AS wo_nte,
         t.fields->>'34. Cost'   AS wo_cost,
         COALESCE(t.fields->'Emergency' = 'true'::jsonb, false) AS wo_emergency,
         COALESCE(t.fields->'Escalated' = 'true'::jsonb, false) AS wo_escalated,
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

/**
 * A vendor-linked request shows the VENDOR's current name and phone (the record
 * is the source of truth — "Auto-filled from vendor record" in the comp); a
 * manual one shows what the dispatcher typed.
 */
function mapPayment(r: PaymentRow): PaymentRequest {
  return {
    id: r.id,
    task_id: r.task_id,
    payee: {
      vendor_id: r.vendor_id,
      name: r.vendor_id ? r.vendor_name : r.payee_name,
      phone: r.vendor_id ? (r.vendor_phone ?? r.payee_phone) : r.payee_phone,
    },
    purpose: r.purpose,
    amount: Number(r.amount ?? 0),
    method: r.method,
    note: r.note,
    recipient_name: r.recipient_name,
    status: r.status,
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
  };
}

function mapListItem(r: PaymentRow): PaymentListItem {
  return {
    ...mapPayment(r),
    wo_number: r.wo_number,
    title: r.title,
    client: r.client,
    nte_override_open: Boolean(r.nte_override_open),
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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Every payment request on a work order, newest first, with the two totals the
 * comp shows: `total_paid` ("Total paid on this WO") counts only `paid` rows;
 * `total_requested` ("Payables total") counts everything not rejected — money
 * that is either out the door or on its way.
 */
export async function listPaymentRequests(taskId: string): Promise<PaymentRequestsResponse> {
  const res = await query<PaymentRow>(
    `${SELECT_SQL} WHERE pr.task_id = $1 ORDER BY pr.created_at DESC, pr.id DESC`,
    [taskId],
  );
  const items = res.rows.map(mapPayment);
  return {
    items,
    total: items.length,
    total_paid: round2(
      items.filter((i) => i.status === 'paid').reduce((sum, i) => sum + i.amount, 0),
    ),
    total_requested: round2(
      items.filter((i) => i.status !== 'rejected').reduce((sum, i) => sum + i.amount, 0),
    ),
  };
}

const STATUSES: PaymentRequestStatus[] = ['requested', 'approved', 'sent_to_yoda', 'paid', 'rejected'];

/**
 * The Payments tab: every request across every live work order, the ones
 * still waiting on somebody first, then newest first. Deleted work orders keep
 * their rows but leave the queue — nobody should be paying against a WO that
 * is in Trash.
 */
export async function listAllPaymentRequests(
  limit = 500,
  viewer?: ActingPrincipal,
): Promise<PaymentListResponse> {
  // 0026: a scoped viewer's queue holds the payables on their work orders only.
  const p = new Params();
  const scope = viewer ? woScopeSql(viewer, p) : null;
  const res = await query<PaymentRow>(
    `${SELECT_SQL}
      WHERE t.deleted_at IS NULL ${scope ? `AND ${scope}` : ''}
      ORDER BY CASE pr.status
                 WHEN 'requested' THEN 0
                 WHEN 'approved' THEN 1
                 WHEN 'sent_to_yoda' THEN 2
                 ELSE 3
               END,
               pr.created_at DESC, pr.id DESC
      LIMIT ${p.add(limit)}`,
    p.values,
  );
  const items = res.rows.map(mapListItem);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<PaymentRequestStatus, number>;
  for (const i of items) counts[i.status] += 1;
  return { items, total: items.length, counts };
}

async function getPaymentRequest(id: string): Promise<PaymentRequest> {
  const res = await query<PaymentRow>(`${SELECT_SQL} WHERE pr.id = $1`, [id]);
  if (res.rows.length === 0) throw new ApiError('NOT_FOUND', 'Payment request not found');
  return mapPayment(res.rows[0]);
}

export interface PaymentRequestInput {
  vendor_id?: string | null;
  payee_name?: string | null;
  payee_phone?: string | null;
  purpose: string;
  amount: number;
  method: string;
  note?: string | null;
  recipient_name?: string | null;
}

/**
 * Submit a request. No role gate (see the header): the Payments tab is the
 * control point. The insert and its activity row share one transaction, so a
 * request that exists is always a request the audit trail knows about.
 */
export async function createPaymentRequest(
  taskId: string,
  input: PaymentRequestInput,
  actor: ActingPrincipal,
): Promise<PaymentRequest> {
  const vendorId = input.vendor_id ?? null;
  const payeeName = input.payee_name?.trim() || null;
  const payeePhone = input.payee_phone?.trim() || null;

  if (!vendorId && !(payeeName && payeePhone)) {
    throw badRequest(
      'A payment request needs either a vendor_id or both payee_name and payee_phone',
      { required: 'vendor_id | (payee_name + payee_phone)' },
    );
  }
  if (vendorId) {
    const v = await query<{ id: string }>(`SELECT id FROM vendor WHERE id = $1`, [vendorId]);
    if (v.rows.length === 0) throw badRequest('Unknown vendor_id', { vendor_id: vendorId });
  }

  let createdId: string | null = null;

  await withTransaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO payment_request
         (task_id, vendor_id, payee_name, payee_phone, purpose, amount, method, note,
          recipient_name, status, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'requested', $10)
       RETURNING id::text AS id`,
      [
        taskId,
        vendorId,
        payeeName,
        payeePhone,
        input.purpose,
        input.amount,
        input.method,
        input.note ?? null,
        input.recipient_name ?? null,
        actor.id,
      ],
    );
    createdId = ins.rows[0].id;

    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'payment_requested', 'payment_request.status', NULL, $3::jsonb)`,
      [
        actor.id,
        taskId,
        JSON.stringify({
          payment_request_id: createdId,
          status: 'requested',
          amount: input.amount,
          method: input.method,
        }),
      ],
    );
  });

  if (!createdId) throw new ApiError('INTERNAL', 'Payment request insert produced no row');

  // S5 · a request entering the queue starts the payment_processing clock
  // (2 business days), owed by AP until a decision lands.
  await evaluateForTask(taskId);

  return getPaymentRequest(createdId);
}

// ═══════════════════════════════════════════════════════════════════════════
// Decisions (0016)
// ═══════════════════════════════════════════════════════════════════════════

interface Decision {
  from: PaymentRequestStatus[];
  to: PaymentRequestStatus;
  /** Activity-log action; the web's audit vocabulary names each one. */
  action: string;
  /** Appended to the UPDATE's SET list. $1 = new status, $2 = row id, $3 =
      actor id, $4 = the decision's text (note / reference), when it has one. */
  set: string;
}

const DECISIONS = {
  approve: {
    from: ['requested'],
    to: 'approved',
    action: 'payment_approved',
    set: 'approved_by = $3, approved_at = now()',
  },
  reject: {
    from: ['requested', 'approved'],
    to: 'rejected',
    action: 'payment_rejected',
    set: 'rejected_by = $3, rejected_at = now(), rejection_note = $4',
  },
  send_to_yoda: {
    from: ['approved'],
    to: 'sent_to_yoda',
    action: 'payment_sent_to_yoda',
    set: 'sent_to_yoda_by = $3, sent_to_yoda_at = now(), yoda_ref = $4',
  },
  // Paid straight from approved is allowed: money sometimes goes out by hand,
  // and a queue that cannot record the truth gets worked around.
  mark_paid: {
    from: ['approved', 'sent_to_yoda'],
    to: 'paid',
    action: 'payment_paid',
    set: 'paid_by = $3, paid_at = now()',
  },
} satisfies Record<string, Decision>;

type DecisionKind = keyof typeof DECISIONS;

const LABEL: Record<PaymentRequestStatus, string> = {
  requested: 'requested',
  approved: 'approved',
  sent_to_yoda: 'sent to Yoda',
  paid: 'paid',
  rejected: 'rejected',
};

/**
 * One decision on one request. The status, its stamps, the activity row and
 * (for a rejection) the internal comment all land in one transaction, so the
 * ledger, the audit trail and the WO feed can never disagree about what
 * happened to the money.
 */
async function decide(
  id: string,
  kind: DecisionKind,
  actor: ActingPrincipal,
  text: string | null,
  /** Rule 1.5.2: the moves that let money out are refused while an NTE
      override waits on a manager. Checked before the transaction opens. */
  progression: string | null = null,
): Promise<PaymentRequest> {
  const d: Decision = DECISIONS[kind];
  const cur = await getPaymentRequest(id);
  if (!d.from.includes(cur.status)) {
    throw badRequest(`This payment request is already ${LABEL[cur.status]}; it cannot be ${LABEL[d.to]} now`, {
      status: cur.status,
      allowed_from: d.from,
    });
  }
  if (progression) await assertNoOpenNteOverride(cur.task_id, progression);

  const params: unknown[] = [d.to, id, actor.id];
  if (d.set.includes('$4')) params.push(text);

  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE payment_request SET status = $1, ${d.set}, updated_at = now() WHERE id = $2`,
      params,
    );
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, $3, 'payment_request.status', $4::jsonb, $5::jsonb)`,
      [
        actor.id,
        cur.task_id,
        d.action,
        JSON.stringify({ payment_request_id: id, status: cur.status }),
        JSON.stringify({
          payment_request_id: id,
          status: d.to,
          amount: cur.amount,
          payee: cur.payee.name,
          ...(kind === 'reject' ? { note: text } : {}),
          ...(kind === 'send_to_yoda' && text ? { yoda_ref: text } : {}),
        }),
      ],
    );
    // The reason a payment was refused is feedback for the dispatcher who
    // raised it — an INTERNAL comment on the WO, never client-visible.
    if (kind === 'reject') {
      const who = cur.payee.name ?? 'the technician';
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO comment (task_id, author_principal_id, body, client_visible)
         VALUES ($1, $2, $3, false) RETURNING id::text AS id`,
        [
          cur.task_id,
          actor.id,
          `Payment request of ${money(cur.amount)} to ${who} (${cur.purpose}) rejected — ${text}`,
        ],
      );
      await tx.query(
        `INSERT INTO activity_log
           (actor_principal_id, entity_type, entity_id, action, field, before, after)
         VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
        [
          actor.id,
          cur.task_id,
          JSON.stringify({ comment_id: ins.rows[0].id, client_visible: false, payment_request_id: id }),
        ],
      );
    }
  });

  return getPaymentRequest(id);
}

/** requested → approved (payments:approve). Refused (409) while an NTE
    override waits on a manager — rule 1.5.2. */
export async function approvePaymentRequest(id: string, actor: ActingPrincipal): Promise<PaymentRequest> {
  requirePerm(actor, 'payments', 'approve', 'You cannot approve payment requests');
  return decide(id, 'approve', actor, null, 'Approving this payment');
}

/** requested | approved → rejected, with the reason (payments:approve). */
export async function rejectPaymentRequest(
  id: string,
  note: string,
  actor: ActingPrincipal,
): Promise<PaymentRequest> {
  requirePerm(actor, 'payments', 'approve', 'You cannot reject payment requests');
  return decide(id, 'reject', actor, note);
}

/** approved → sent_to_yoda, with Yoda's reference if there is one (payments/process:edit). */
export async function sendPaymentRequestToYoda(
  id: string,
  yodaRef: string | null,
  actor: ActingPrincipal,
): Promise<PaymentRequest> {
  requirePerm(actor, PAYMENT_PROCESS_PERM_KEY, 'edit', 'You cannot send payments to Yoda');
  return decide(id, 'send_to_yoda', actor, yodaRef, 'Sending this payment to Yoda');
}

/** approved | sent_to_yoda → paid (payments/process:edit). */
export async function markPaymentRequestPaid(id: string, actor: ActingPrincipal): Promise<PaymentRequest> {
  requirePerm(actor, PAYMENT_PROCESS_PERM_KEY, 'edit', 'You cannot mark payments paid');
  return decide(id, 'mark_paid', actor, null);
}
