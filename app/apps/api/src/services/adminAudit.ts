// Admin-side audit rows — the counterpart of woAudit.ts for everything that is
// NOT a work order: custom-field definitions, statuses and phase groups,
// roles, users and automation rules. Same activity_log table, same reader
// (auditLog.ts), so Admin › Audit log lists them next to the work-order edits
// and the CSV export carries them too.
//
// Row shape, for the readers:
//   entity_type  'field_def' | 'status' | 'status_group' | 'role'
//                | 'principal' | 'automation'
//   entity_id    the row's id — a uuid, or the phase group's text code (0017)
//   action       '<entity>_<verb>', e.g. 'field_def_created', 'status_renamed'
//   field        'fields.<key>' on field_def rows, so filtering the log by a
//                field key shows its definition changes beside its value edits
//   before/after SNAPSHOTS of the row (never a {value} wrapper): every snapshot
//                carries a `name` so the log can print what was touched even
//                after it is renamed or deleted. Deletes leave `after` null;
//                creates leave `before` null.
//
// Called AFTER the write, outside any transaction, like restoreTask — a failed
// log row must not undo an admin change, and the admin services are not
// transactional either.

import { query } from '../db.js';

export type AdminEntity =
  | 'field_def'
  | 'status'
  | 'status_group'
  | 'role'
  | 'principal'
  | 'automation'
  | 'fm_cico_method'
  // Saved views of the work-order list (views.ts) — user-owned, not admin, but
  // a "system button" all the same (rule 1.2.1).
  | 'saved_view'
  // A CSV download: one row per file, keyed to the person who pulled it.
  | 'export';

export type Snapshot = Record<string, unknown> & { name: string };

/**
 * Rule 1.2.1 counts a download as a button. The row names the file, how many
 * rows it held and the criteria it was pulled with — the file itself is not
 * kept. entity_id is the actor: an export belongs to nobody else.
 */
export async function logExport(
  actorId: string,
  action: 'work_orders_exported' | 'audit_log_exported',
  after: Snapshot,
): Promise<void> {
  await logAdminEvent({ actorId, entity: 'export', entityId: actorId, action, after });
}

export interface AdminEvent {
  actorId: string;
  entity: AdminEntity;
  entityId: string;
  action: string;
  field?: string | null;
  before?: Snapshot | null;
  after?: Snapshot | null;
}

export async function logAdminEvent(e: AdminEvent): Promise<void> {
  await query(
    `INSERT INTO activity_log
       (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      e.actorId,
      e.entity,
      e.entityId,
      e.action,
      e.field ?? null,
      e.before ? JSON.stringify(e.before) : null,
      e.after ? JSON.stringify(e.after) : null,
    ],
  );
}

/** True when two snapshots differ anywhere — so a no-op PATCH logs nothing. */
export function snapshotsDiffer(a: Snapshot | null, b: Snapshot | null): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}
