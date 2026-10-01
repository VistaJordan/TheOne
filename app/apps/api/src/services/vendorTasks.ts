// 0058 · Vendor tasks and the "missing information" rule — the small core the
// record service (vendors.ts) and the workflow service (vendorWork.ts) both
// stand on, kept apart so neither has to import the other.
//
// A REVIEW task (duplicate, missing information, COI review) has no assignee:
// it sits in one queue that anyone holding `vendors/review` works. There is at
// most one open review task per (type, vendor, company), so raising one twice
// is a no-op. A COI fix and a manual task belong to one person.

import { VENDOR_REVIEW_TASK_TYPES, missingFields, requiredFieldKeys } from '@theone/shared';
import type { FieldProblem, VendorTaskType } from '@theone/shared';
import { query } from '../db.js';
import { notify, vendorReviewerIds } from './notices.js';

export interface OpenTaskInput {
  type: VendorTaskType;
  title: string;
  vendorId: string | null;
  entity?: string | null;
  assignedTo?: string | null;
  createdBy: string | null;
}

/** Raise a task. For the review types an open one for the same vendor (and
    company) is reused; returns the task id either way. */
export async function openVendorTask(t: OpenTaskInput): Promise<string> {
  const review = (VENDOR_REVIEW_TASK_TYPES as readonly string[]).includes(t.type);
  if (review && t.vendorId) {
    const cur = await query<{ id: string }>(
      `SELECT id::text AS id FROM vendor_task
        WHERE status = 'OPEN' AND type = $1 AND vendor_id = $2 AND COALESCE(entity, '') = COALESCE($3, '')
        LIMIT 1`,
      [t.type, t.vendorId, t.entity ?? null],
    );
    if (cur.rows[0]) return cur.rows[0].id;
  }
  const ins = await query<{ id: string }>(
    `INSERT INTO vendor_task (type, title, vendor_id, entity, assigned_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
    [t.type, t.title.slice(0, 500), t.vendorId, t.entity ?? null, review ? null : (t.assignedTo ?? null), t.createdBy],
  );
  // 0059 · tell whoever now has something to do: the reviewers for a review,
  // the assignee for a task somebody else gave them.
  const link = t.vendorId ? `/vendors/${t.vendorId}` : '/vendors?view=tasks';
  if (review) {
    await notify(await vendorReviewerIds(), { kind: 'vendor_review', title: `To review: ${t.title}`, link: '/vendors?view=tasks', actorId: t.createdBy });
  } else if (t.assignedTo) {
    await notify([t.assignedTo], { kind: 'vendor_task', title: `New task: ${t.title}`, link, actorId: t.createdBy });
  }
  return ins.rows[0].id;
}

/** Close every open task of a type on a vendor without anyone deciding it —
    the thing it asked about is no longer true. */
export async function autoCloseTasks(vendorId: string, type: VendorTaskType, entity?: string | null): Promise<void> {
  await query(
    `UPDATE vendor_task SET status = 'DONE', outcome = 'auto', completed_at = now()
      WHERE status = 'OPEN' AND vendor_id = $1 AND type = $2
        AND ($3::text IS NULL OR COALESCE(entity, '') = $3)`,
    [vendorId, type, entity ?? null],
  );
}

// ── Required fields ──────────────────────────────────────────────────────────

export async function requiredOverrides(): Promise<Record<string, boolean>> {
  const res = await query<{ field_key: string; is_required: boolean }>(`SELECT field_key, is_required FROM vendor_required_field`);
  return Object.fromEntries(res.rows.map((r) => [r.field_key, r.is_required]));
}

export async function requiredKeys(): Promise<string[]> {
  return requiredFieldKeys(await requiredOverrides());
}

/** The required-field problems of one saved vendor. Technicians are never checked. */
export async function vendorProblems(vendorId: string, required?: string[]): Promise<FieldProblem[]> {
  const res = await query<Record<string, unknown> & { kind: string }>(
    `SELECT v.kind, v.name, v.email, v.owner_id::text AS owner_id, v.city, v.state, v.primary_trade, v.legal_name,
            v.dba_name, v.primary_contact_name, v.dispatch_phone, v.billing_email,
            v.regular_hourly_rate, v.after_hours_rate, v.weekend_emergency_rate, v.trip_charge,
            v.diagnostic_fee, v.minimum_charge,
            ARRAY(SELECT display FROM vendor_phone ph WHERE ph.vendor_id = v.id ORDER BY position) AS phones
       FROM vendor v WHERE v.id = $1`,
    [vendorId],
  );
  const v = res.rows[0];
  if (!v || v.kind !== 'vendor') return [];
  return missingFields(v as never, required ?? (await requiredKeys()));
}

/**
 * Re-read whether a vendor is missing something required: set the flag, and
 * close its review task once nothing is missing (the task asked a question
 * the record now answers).
 */
export async function recomputeMissing(vendorId: string): Promise<FieldProblem[]> {
  const problems = await vendorProblems(vendorId);
  const missing = problems.some((p) => p.problem === 'missing');
  await query(`UPDATE vendor SET flagged_missing = $2 WHERE id = $1 AND flagged_missing IS DISTINCT FROM $2`, [vendorId, missing]);
  if (!missing) await autoCloseTasks(vendorId, 'MISSING_INFO_REVIEW');
  return problems;
}
