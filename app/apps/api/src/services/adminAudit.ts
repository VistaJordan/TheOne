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
  | 'automation';

export type Snapshot = Record<string, unknown> & { name: string };

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
