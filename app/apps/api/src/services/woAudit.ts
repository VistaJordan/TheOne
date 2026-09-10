// The one place a change to a work order becomes an activity_log row.
//
// Every write path — the status button, bulk "Set fields", the CSV import, and
// any per-field editor built later — describes what it changed as a list of
// {field, before, after} and hands it here. Nothing else inserts task rows into
// activity_log, so a change that is not logged is a change that did not go
// through the service layer, and that is the bug to fix.
//
// Row shapes, so the feed and the audit tab can rely on them:
//   status_changed  field='status_id'     before/after = { status_id, status_name }
//   routed          field='home_list_id'  before/after = { list_id, list_name }
//   field_updated   field=<column> | 'fields.<custom key>'
//                                         before = { value }, after = { value, via? }
// `via` names a non-interactive source ('import', 'bulk', 'automation') so the
// trail can say "via import" — the actor is still the person who ran it. An
// automation also stamps `automation_id`/`automation_name`, so the trail can
// name the rule that fired and link to it; the name is copied rather than
// looked up later so a renamed or deleted rule still reads truthfully.

type Tx = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export interface TaskChange {
  field: string;
  before: unknown;
  after: unknown;
}

// 'visit': a mirror of the latest visit, written by the visit log (0021).
// An approval task (0025): the status moved because a manager approved a
// status-change request — the actor is the manager, the stamp names the task.
export type ChangeSource = 'import' | 'bulk' | 'visit' | AutomationSource | ApprovalSource;

/** The rule that made this change, when an automation did. */
export interface AutomationSource {
  kind: 'automation';
  id: string;
  name: string;
}

/** The approved request behind this change (rule 2.4.3). */
export interface ApprovalSource {
  kind: 'approval_task';
  id: string;
}

/** The `via` stamp merged into `after`. Automations carry the rule with them. */
function viaStamp(source: ChangeSource | undefined): Record<string, unknown> {
  if (!source) return {};
  if (typeof source === 'string') return { via: source };
  if (source.kind === 'approval_task') return { via: 'approval_task', approval_task_id: source.id };
  return { via: 'automation', automation_id: source.id, automation_name: source.name };
}

export function actionFor(field: string): 'status_changed' | 'routed' | 'field_updated' {
  if (field === 'status_id') return 'status_changed';
  if (field === 'home_list_id') return 'routed';
  return 'field_updated';
}

/** Text comparison on purpose: numerics arrive as strings from PGlite and dates
    as 'YYYY-MM-DD', so a typed comparison would log phantom changes. */
export function changed(before: unknown, after: unknown): boolean {
  return String(before ?? '') !== String(after ?? '');
}

export async function logTaskChanges(
  tx: Tx,
  actorId: string,
  taskId: string,
  changes: TaskChange[],
  source?: ChangeSource,
): Promise<void> {
  const stamp = viaStamp(source);
  for (const c of changes) {
    const action = actionFor(c.field);
    const before = action === 'field_updated' ? { value: c.before ?? null } : c.before;
    // status_changed / routed carry their own object; the stamp rides along
    // with it so those rows name the rule too, not only field edits.
    const after =
      action === 'field_updated'
        ? { value: c.after ?? null, ...stamp }
        : c.after && typeof c.after === 'object'
          ? { ...(c.after as Record<string, unknown>), ...stamp }
          : c.after;
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [actorId, taskId, action, c.field, JSON.stringify(before ?? null), JSON.stringify(after ?? null)],
    );
  }
}
