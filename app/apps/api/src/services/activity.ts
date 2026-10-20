// Activity + actor resolution service.
//
// S5 CHANGED THE TRUST MODEL HERE. Until auth landed, the acting principal came
// from an X-Actor-Id request header with a fallback to the seeded Jordan Brown
// admin — i.e. the caller chose their own identity and therefore their own
// permissions. The actor is now taken from the session the auth guard attached
// to the request (plugins/authGuard.ts) and the header is ignored entirely.
//
// Impersonation note: when a super admin is viewing as somebody else, the app
// acts as `actingAs` — their rights, their scope, their name on the records
// they create — and every activity_log row the request writes is re-signed to
// the real human with `viewing_as_id` naming whom they were viewing as
// (plugins/authGuard.ts runs the request in the audit context, migration
// 0088's trigger does the re-signing). Start / stop are their own events.
// Nothing is anonymous.

import type { FastifyRequest } from 'fastify';
import { query } from '../db.js';
import { ACTOR_NAME_SQL } from '../lib/actorName.js';
import { unauthorized, type Capabilities, type SessionPrincipal } from './auth.js';
import { Params } from './woFields.js';
import { outOfScope, woScopeSql } from './woScope.js';
import type { ActivityEntry, FeedActor, PermissionSet } from '@theone/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ISO-8601 UTC render so the JSON is deterministic regardless of the driver's date parsing.
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
 * Built from the session the auth guard loaded before the handler ran, so it
 * is resolved once per request and never inside a transaction: a read that
 * needs no lock belongs on the pool.
 */
export interface ActingPrincipal {
  id: string;
  name: string;
  kind: 'human' | 'service';
  role: string | null;
  roleLabel: string | null;
  isSuperAdmin: boolean;
  /** 0062 · restricted to the sites listed for them in `principal_site`.
      Optional: a principal built outside a request (the engine, a test) is
      not restricted. */
  siteRestricted?: boolean;
  /** 0072 · has clients assigned to them in Admin › Users (`principal_client`);
      their work orders count as theirs under "Only theirs". Optional for the
      same reason as `siteRestricted`. */
  hasClients?: boolean;
  /** UAT T1 · a test sign-in account: refused on user and role writes
      (the Share dialog's role grants and per-person ticks included). */
  isTestAccount?: boolean;
  /** The permission tree (0015) — what every gate resolves against. */
  perms: PermissionSet;
  /** Resolved from the `role` table, not from a hardcoded list (0005). */
  can: Capabilities;
}

export function actingPrincipalFromRequest(req: FastifyRequest): ActingPrincipal {
  if (!req.auth) throw unauthorized();
  return actingFromPrincipal(req.auth.actingAs);
}

/** The same shape from a loaded principal (services/auth.ts loadPrincipalById). */
export function actingFromPrincipal(p: SessionPrincipal): ActingPrincipal {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    role: p.role,
    roleLabel: p.roleLabel,
    isSuperAdmin: p.isSuperAdmin,
    siteRestricted: p.siteRestricted,
    hasClients: p.clients.length > 0,
    isTestAccount: p.isTestAccount,
    perms: p.perms,
    can: p.can,
  };
}

/**
 * D6 (UAT round 1, Wave B) · whose rights a gate reads. While a super admin
 * is viewing as someone it is that person — the Admin console, the admin
 * routes and the audit export answer as they would answer them — and
 * otherwise the signed-in user (`actingAs` is the user then). It can never
 * widen anything: only a super admin can view as anyone, and since 0088 what
 * they change while viewing as is gated as the viewed person and logged under
 * themselves (viewing_as_id). The one thing it does NOT decide is
 * starting and stopping a view (routes/auth.ts reads `req.auth.user`), so a
 * super admin can always stop viewing as.
 */
export function permissionSubject(req: FastifyRequest): SessionPrincipal {
  if (!req.auth) throw unauthorized();
  return req.auth.actingAs;
}

/** Sign-in, sign-out and impersonation, written to the same log as everything else. */
export async function recordAuthEvent(
  principalId: string,
  action: 'signed_in' | 'signed_out' | 'impersonation_started' | 'impersonation_ended',
  after: Record<string, unknown> | null,
): Promise<void> {
  // The id is passed twice on purpose: one $1 feeding a uuid column AND a text
  // column (entity_id is text since 0023) makes Postgres refuse to type it.
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, after)
     VALUES ($1, 'principal', $2, $3, $4)`,
    [principalId, principalId, action, after ? JSON.stringify(after) : null],
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

/**
 * Resolve a task uuid from a uuid-or-wo_number identifier; null if not found.
 * With an actor, the row scope (0026) is checked too: a work order that exists
 * but is outside what they may see throws the scope 403 — every per-work-order
 * route resolves through here, so none of them can leak a row the list hides.
 */
export async function resolveTaskId(idOrWo: string, actor?: ActingPrincipal): Promise<string | null> {
  const col = UUID_RE.test(idOrWo) ? 't.id' : 't.wo_number';
  const p = new Params();
  const hole = p.add(idOrWo);
  const scope = actor ? woScopeSql(actor, p) : null;
  const res = await query<{ id: string; in_scope: boolean }>(
    `SELECT t.id, ${scope ?? 'TRUE'} AS in_scope
       FROM task t WHERE ${col} = ${hole} AND t.deleted_at IS NULL LIMIT 1`,
    p.values,
  );
  if (res.rows.length === 0) return null;
  if (!res.rows[0].in_scope) throw outOfScope();
  return res.rows[0].id;
}

/** A task's activity newest-first (§5 GET /api/activity). */
export async function getActivityForTask(taskId: string, limit: number): Promise<ActivityEntry[]> {
  const res = await query<ActivityRow>(
    `SELECT a.id, a.action, a.field, a.before, a.after,
            p.id AS actor_id, ${ACTOR_NAME_SQL} AS actor_name, p.kind AS actor_kind,
            ${CREATED_AT_SQL} AS created_at
       FROM activity_log a
       JOIN principal p ON p.id = a.actor_principal_id
      WHERE a.entity_type = 'task' AND a.entity_id = $1::text
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $2`,
    [taskId, limit],
  );
  return res.rows.map(mapActivity);
}

export { UUID_RE, CREATED_AT_SQL };
