// Previous Assignees — kept by the system, not by hand.
//
// The ClickUp import brought the 'Previous Assignees' seat (People card) but
// nothing maintained it: reassigning a work order left it empty. Now every
// change of 'Assignee', on any write path, appends the names that left the
// seat — dispatchAutomations' post-commit housekeeping calls this with the
// changes it was handed, so a field edit, a bulk edit, an acceptance and a
// rule's auto-assign all keep the history the same way. Names are
// comma-joined like every `users` field; a name is listed once, in the order
// it was first replaced. The current assignee is never removed from the
// history — being assigned again does not erase that you once handed it on.

import { query, withTransaction } from '../db.js';
import { changed, logTaskChanges, type TaskChange } from './woAudit.js';

export const ASSIGNEE_FIELD = 'fields.Assignee';
const K_PREVIOUS = 'Previous Assignees';

const names = (v: unknown): string[] =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** The names in `before` that are not in `after`: who left the seat. */
export function departedAssignees(before: unknown, after: unknown): string[] {
  const now = new Set(names(after).map((n) => n.toLowerCase()));
  return names(before).filter((n) => !now.has(n.toLowerCase()));
}

/** Append `departed` to the history. Returns the change written, if any. */
export function mergePreviousAssignees(current: unknown, departed: string[]): { before: string | null; after: string } | null {
  const list = names(current);
  const seen = new Set(list.map((n) => n.toLowerCase()));
  let added = false;
  for (const n of departed) {
    if (seen.has(n.toLowerCase())) continue;
    list.push(n);
    seen.add(n.toLowerCase());
    added = true;
  }
  if (!added) return null;
  return { before: names(current).length ? names(current).join(', ') : null, after: list.join(', ') };
}

/**
 * Post-commit: when `changes` moved the Assignee seat, record who left it.
 * Returns the change it wrote so the caller can hand it to the rules engine.
 */
export async function recordPreviousAssignees(taskId: string, changes: TaskChange[], actorId: string): Promise<TaskChange[]> {
  const departed = changes.flatMap((c) => (c.field === ASSIGNEE_FIELD ? departedAssignees(c.before, c.after) : []));
  if (departed.length === 0) return [];
  const t = await query<{ fields: Record<string, unknown> | null }>(`SELECT fields FROM task WHERE id = $1 AND deleted_at IS NULL`, [taskId]);
  const fields = t.rows[0]?.fields ?? {};
  const merged = mergePreviousAssignees(fields[K_PREVIOUS], departed);
  if (!merged || !changed(merged.before, merged.after)) return [];
  const change: TaskChange = { field: `fields.${K_PREVIOUS}`, before: merged.before, after: merged.after };
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE task SET fields = $2::jsonb, updated_at = now() WHERE id = $1`, [
      taskId,
      JSON.stringify({ ...fields, [K_PREVIOUS]: merged.after }),
    ]);
    await logTaskChanges(tx, actorId, taskId, [change], 'assignment');
  });
  return [change];
}
