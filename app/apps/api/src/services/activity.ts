// Activity + actor resolution service.
// - resolveActorId: X-Actor-Id header (if it names a real principal) else the
//   seeded Jordan Brown admin principal (§5). Cached after first lookup.
// - getActivity: a WO's activity_log newest-first, joined to its actor.

import { query } from '../db.js';
import type { ActivityEntry, FeedActor } from '@theone/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ISO-8601 UTC render so the JSON is deterministic regardless of PGlite's date parsing.
const CREATED_AT_SQL = `to_char((a.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

let defaultActorId: string | null = null;

/** The seeded Jordan Brown human principal — default write actor (§5, open-question #5). */
async function getDefaultActorId(): Promise<string> {
  if (defaultActorId) return defaultActorId;
  const res = await query<{ id: string }>(
    `SELECT id FROM principal WHERE display_name = 'Jordan Brown' AND kind = 'human' LIMIT 1`,
  );
  if (res.rows.length === 0) {
    throw new Error('Default actor "Jordan Brown" not found — is the DB seeded?');
  }
  defaultActorId = res.rows[0].id;
  return defaultActorId;
}

/**
 * Resolve the acting principal id. Uses X-Actor-Id when it is a uuid naming a
 * real principal; otherwise falls back to the default admin. Guarantees a valid
 * FK for activity_log.actor_principal_id.
 */
export async function resolveActorId(headerVal: string | undefined): Promise<string> {
  if (headerVal && UUID_RE.test(headerVal)) {
    const res = await query<{ id: string }>(`SELECT id FROM principal WHERE id = $1`, [headerVal]);
    if (res.rows.length > 0) return res.rows[0].id;
  }
  return getDefaultActorId();
}

/**
 * Same resolution as resolveActorId, but returns the whole principal so a write
 * can echo the actor back without a second round-trip (S2 POST /comments needs
 * the name + kind for the FeedItem it returns).
 */
export async function resolveActor(headerVal: string | undefined): Promise<FeedActor> {
  const id = await resolveActorId(headerVal);
  const res = await query<{ id: string; display_name: string; kind: 'human' | 'service' }>(
    `SELECT id, display_name, kind FROM principal WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (res.rows.length === 0) throw new Error(`Principal ${id} vanished`);
  const p = res.rows[0];
  return { id: p.id, name: p.display_name, kind: p.kind };
}

/**
 * S4 · the acting principal WITH its role — the whole permission system until
 * auth lands (S5). `role` is `principal.role` verbatim; the quote gates compare
 * it against QUOTE_EDIT_ROLES / QUOTE_APPROVE_ROLES.
 */
export interface ActingPrincipal {
  id: string;
  name: string;
  kind: 'human' | 'service';
  role: string | null;
}

/**
 * Same resolution as resolveActor (X-Actor-Id → real principal, else the seeded
 * Jordan Brown admin), plus the role. Every role-gated route resolves through
 * this — and ALWAYS before a db.transaction() opens (PGlite is single-connection).
 */
export async function resolveActingPrincipal(
  headerVal: string | undefined,
): Promise<ActingPrincipal> {
  const id = await resolveActorId(headerVal);
  const res = await query<{
    id: string;
    display_name: string;
    kind: 'human' | 'service';
    role: string | null;
  }>(`SELECT id, display_name, kind, role FROM principal WHERE id = $1 LIMIT 1`, [id]);
  if (res.rows.length === 0) throw new Error(`Principal ${id} vanished`);
  const p = res.rows[0];
  return { id: p.id, name: p.display_name, kind: p.kind, role: p.role };
}

interface ActivityRow {
  id: number | string;
  action: string;
  field: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_id: string;
  actor_name: string;
  actor_kind: 'human' | 'service';
  created_at: string;
}

function mapActivity(r: ActivityRow): ActivityEntry {
  return {
    id: Number(r.id),
    action: r.action,
    field: r.field,
    before: r.before,
    after: r.after,
    actor: { id: r.actor_id, display_name: r.actor_name, kind: r.actor_kind },
    created_at: r.created_at,
  };
}

/** Resolve a task uuid from a uuid-or-wo_number identifier; null if not found. */
export async function resolveTaskId(idOrWo: string): Promise<string | null> {
  const col = UUID_RE.test(idOrWo) ? 'id' : 'wo_number';
  const res = await query<{ id: string }>(
    `SELECT id FROM task WHERE ${col} = $1 AND deleted_at IS NULL LIMIT 1`,
    [idOrWo],
  );
  return res.rows.length > 0 ? res.rows[0].id : null;
}

/** A task's activity newest-first (§5 GET /api/activity). */
export async function getActivityForTask(taskId: string, limit: number): Promise<ActivityEntry[]> {
  const res = await query<ActivityRow>(
    `SELECT a.id, a.action, a.field, a.before, a.after,
            p.id AS actor_id, p.display_name AS actor_name, p.kind AS actor_kind,
            ${CREATED_AT_SQL} AS created_at
       FROM activity_log a
       JOIN principal p ON p.id = a.actor_principal_id
      WHERE a.entity_type = 'task' AND a.entity_id = $1
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $2`,
    [taskId, limit],
  );
  return res.rows.map(mapActivity);
}

export { UUID_RE, CREATED_AT_SQL };
