// Rule 7.3.2 · escalations that arrive from the external email tool.
//
// The tool is standalone today; this is the receiver it will post to once it
// is wired up. One call = one email judged an escalation for one work order:
//
//   1. the work order is looked up by its number (WO-12345);
//   2. the `Escalated` flag (0038) is set through the ordinary field write —
//      so the audit row reads `via: 'webhook'`, the promoted mirrors stay in
//      step and the rules engine sees the change like any other;
//   3. the raw payload is logged as its own `escalation_received` row on the
//      work order, whether or not the flag moved — a second email about an
//      already-escalated work order is still evidence someone wrote in;
//   4. a number nobody has is logged `escalation_unmatched` (entity
//      `webhook`, keyed by the number as sent) and answered 404, so the email
//      tool can retry or alert and Admin › Audit still shows the attempt.
//
// The receiver never CLEARS the flag: a manager's untick sticks until the
// next email (the override rule the Emergency flag settled).
//
// The actor on every row is the 'Email escalations' service principal — not
// a person, and not the rules engine.

import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { serviceActorId } from './serviceActors.js';
import { updateWorkOrderFields } from './woFieldValues.js';

/** Bag key of the flag (0038). The web's FIELD.escalated is the same string. */
export const ESCALATED_KEY = 'Escalated';

export interface EmailEscalation {
  /** The work order number as the email tool read it, e.g. 'WO-39422'. */
  wo_number: string;
  /** Why the tool judged it an escalation (its own words, or the email's). */
  reason?: string | null;
  /** Who wrote in. */
  source_email?: string | null;
  /** The email's subject line. */
  subject?: string | null;
  /** The tool's own id for the message, for de-duplication on their side. */
  message_id?: string | null;
}

export interface EmailEscalationResult {
  task_id: string;
  wo_number: string;
  /** True when this call raised the flag; false when it was already up. */
  changed: boolean;
}

function emailActorId(): Promise<string> {
  return serviceActorId('Email escalations', 'EE');
}

/** The payload as it is kept on the audit row — nothing added, nothing
    dropped, so the trail is the contract. */
function snapshot(e: EmailEscalation): Record<string, unknown> {
  return {
    source: 'email',
    wo_number: e.wo_number,
    reason: e.reason ?? null,
    source_email: e.source_email ?? null,
    subject: e.subject ?? null,
    message_id: e.message_id ?? null,
  };
}

export async function escalateFromEmail(e: EmailEscalation): Promise<EmailEscalationResult> {
  const woNumber = e.wo_number.trim();
  const actorId = await emailActorId();

  const found = await query<{ id: string; wo_number: string }>(
    `SELECT t.id, t.wo_number FROM task t
      WHERE t.wo_number = $1 AND t.deleted_at IS NULL LIMIT 1`,
    [woNumber],
  );
  const task = found.rows[0];

  if (!task) {
    await query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'webhook', $2, 'escalation_unmatched', NULL, NULL, $3::jsonb)`,
      [actorId, woNumber, JSON.stringify(snapshot(e))],
    );
    throw new ApiError('NOT_FOUND', `No work order numbered "${woNumber}"`, { wo_number: woNumber });
  }

  // The ordinary field write: audit row (via: 'webhook'), mirrors, automations.
  // Saving true over true is a no-op there, which is what `changed` reports.
  const res = await updateWorkOrderFields(
    task.id,
    { [`fields.${ESCALATED_KEY}`]: true },
    actorId,
    { depth: 0, fired: new Set(), by: 'webhook' },
  );
  const changed = res.changed > 0;

  // No `field` on the receipt row on purpose: the per-field history panel
  // selects by field name and would show this payload as a value change.
  // The flag's own change is the field_updated row the write above made.
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'escalation_received', NULL, NULL, $3::jsonb)`,
    [actorId, task.id, JSON.stringify({ ...snapshot(e), changed })],
  );

  return { task_id: task.id, wo_number: task.wo_number, changed };
}
