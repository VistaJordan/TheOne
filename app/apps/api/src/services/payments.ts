// Technician payment request service (S4) — the PPR replacement.
//
// Flat by design: one `payment_request` row per submission, status
// requested → approved → paid (or rejected). There is no approval chain yet —
// product/quotes-payments.md §4.3 defers the routing to the real project's
// import, which is why the payment screen's ATL tooltip reads "AP approval —
// routing TBD" and NOT "Requires ATL or above". Anyone who can see the work
// order can request a payment; the gate lives downstream in AP.
//
// The payee is EITHER a vendor record OR a manual name+phone pair (a tech who
// is not in the vendor list). The DB does not CHECK across the two shapes — the
// rule is enforced here, where a useful 400 can be produced.

import { query, getDb } from '../db.js';
import type { PaymentRequest, PaymentRequestsResponse } from '@theone/shared';
import { ApiError, badRequest } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { evaluateForTask } from './obligations.js';

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
  status: PaymentRequest['status'];
  requested_by_id: string | null;
  requested_by_name: string | null;
  requested_by_kind: 'human' | 'service' | null;
  created_at: string;
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
         ${ISO('pr.created_at')} AS created_at
    FROM payment_request pr
    LEFT JOIN vendor v    ON v.id = pr.vendor_id
    LEFT JOIN principal rb ON rb.id = pr.requested_by
`;

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
    requested_by:
      r.requested_by_id === null
        ? null
        : {
            id: r.requested_by_id,
            display_name: r.requested_by_name ?? '',
            kind: r.requested_by_kind ?? 'human',
          },
    created_at: r.created_at,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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
 * Submit a request. No role gate (see the header): the AP queue is the control
 * point. The insert and its activity row share one transaction, so a request
 * that exists is always a request the audit trail knows about.
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

  const db = getDb();
  let createdId: string | null = null;

  await db.transaction(async (tx) => {
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

  // S5 · a request entering the AP queue starts the payment_processing clock
  // (2 business days), owed by the admin desk until the routing lands (§4.3).
  await evaluateForTask(taskId);

  const res = await query<PaymentRow>(`${SELECT_SQL} WHERE pr.id = $1`, [createdId]);
  if (res.rows.length === 0) throw new ApiError('INTERNAL', 'Payment request vanished after insert');
  return mapPayment(res.rows[0]);
}
