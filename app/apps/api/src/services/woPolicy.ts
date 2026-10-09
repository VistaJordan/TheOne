// WO-status action policy (gap analysis G-W01).
//
// ONE place answers "may this work order take this quote / payment action right
// now?". The table itself lives in @theone/shared (allowedWoActions) so the
// contract documents it; this module binds it to a task row and turns a "no"
// into the 403 the routes return. The web never re-derives the rule — it reads
// `actions` off the WO detail / quote payload and renders blocked controls
// locked with the reason.

import { query } from '../db.js';
import type { Phase, WoAction, WoActionMap } from '@theone/shared';
import { PHASE_BY_STATUS_NAME, allowedWoActions } from '@theone/shared';
import { ApiError } from '../errors.js';

export interface WoStatusSnapshot {
  task_id: string;
  status_name: string;
  phase: Phase | null;
  actions: WoActionMap;
}

export function phaseOf(statusName: string): Phase | null {
  return PHASE_BY_STATUS_NAME[statusName] ?? PHASE_BY_STATUS_NAME[statusName.trim().toLowerCase()] ?? null;
}

/** The task's current status + the action map derived from it. */
export async function woStatusSnapshot(taskId: string): Promise<WoStatusSnapshot> {
  const res = await query<{ task_id: string; status_name: string }>(
    `SELECT t.id::text AS task_id, s.name AS status_name
       FROM task t JOIN status s ON s.id = t.status_id
      WHERE t.id = $1 AND t.deleted_at IS NULL
      LIMIT 1`,
    [taskId],
  );
  if (res.rows.length === 0) throw new ApiError('NOT_FOUND', 'Work order not found');
  const statusName = res.rows[0].status_name;
  const phase = phaseOf(statusName);
  return { task_id: taskId, status_name: statusName, phase, actions: allowedWoActions(statusName, phase) };
}

/** 403 WO_STATUS_BLOCKED when the WO's status does not allow `action`. */
export async function assertWoAllows(taskId: string, action: WoAction): Promise<WoStatusSnapshot> {
  const snap = await woStatusSnapshot(taskId);
  const state = snap.actions[action];
  if (!state.allowed) {
    throw new ApiError('FORBIDDEN', state.reason ?? `Action ${action} is not allowed on this work order`, {
      code: 'WO_STATUS_BLOCKED',
      action,
      status: snap.status_name,
      phase: snap.phase,
    });
  }
  return snap;
}
