// Activity + actor resolution service.
//
// S5 CHANGED THE TRUST MODEL HERE. Until auth landed, the acting principal came
// from an X-Actor-Id request header with a fallback to the seeded Jordan Brown
// admin — i.e. the caller chose their own identity and therefore their own
// permissions. The actor is now taken from the session the auth guard attached
// to the request (plugins/authGuard.ts) and the header is ignored entirely.
//
// Impersonation note: when a super admin is viewing as somebody else, writes are
// attributed to `actingAs` so the app behaves as that role — but the session
// still records the real human, and impersonation start/stop are their own
// activity_log events. Nothing is anonymous.

import type { FastifyRequest } from 'fastify';
import { query } from '../db.js';
import { unauthorized, type Capabilities } from './auth.js';
import type { ActivityEntry, FeedActor, PermissionSet } from '@theone/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ISO-8601 UTC render so the JSON is deterministic regardless of PGlite's date parsing.
const CREATED_AT_SQL = `to_char((a.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/**
 * The principal a write is attributed to. Sourced from `req.auth`, which only
 * exists once the auth guard has validated a session cookie.
 *
 * Throwing on a missing session is deliberate: a write that cannot name its
 * author must not reach the database. The old header fallback silently
 * attributed orphaned writes to an admin, which is exactly the behaviour that
 * made the activity log untrustworthy.
 */
export function actorFromRequest(req: FastifyRequest): FeedActor {
  if (!req.auth) throw unauthorized();
  const p = req.auth.actingAs;
  return { id: p.id, name: p.name, kind: p.kind };
}

export function actorIdFromRequest(req: FastifyRequest): string {
  if (!req.auth) throw unauthorized();
  return req.auth.actingAs.id;
}

/**
 * S4 · the acting principal WITH its role — what the quote gates compare
 * against QUOTE_EDIT_ROLES / QUOTE_APPROVE_ROLES.
 *
 * Still resolved BEFORE any db.transaction() opens: PGlite is single-connection,
 * so a lookup inside a transaction deadlocks.
 */
export interface ActingPrincipal {
  id: string;
  name: string;
  kind: 'human' | 'service';
  role: string | null;
  roleLabel: string | null;
  isSuperAdmin: boolean;
  /** The permission tree (0015) — what every gate resolves against. */
  perms: PermissionSet;
  /** Resolved from the `role` table, not from a hardcoded list (0005). */
  can: Capabilities;
}

export function actingPrincipalFromRequest(req: FastifyRequest): ActingPrincipal {
  if (!req.auth) throw unauthorized();
  const p = req.auth.actingAs;
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    role: p.role,
    roleLabel: p.roleLabel,
    isSuperAdmin: p.isSuperAdmin,
    perms: p.perms,
    can: p.can,
  };
}

/** Sign-in, sign-out and impersonation, written to the same log as everything else. */
export async function recordAuthEvent(
  principalId: string,
  action: 'signed_in' | 'signed_out' | 'impersonation_started' | 'impersonation_ended',
  after: Record<string, unknown> | null,
): Promise<void> {
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, after)
     VALUES ($1, 'principal', $1, $2, $3)`,
    [principalId, action, after ? JSON.stringify(after) : null],
  );
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
