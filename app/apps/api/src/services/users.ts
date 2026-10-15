// User administration — the data layer behind Admin › Users.
//
// "Inviting" somebody is just inserting a principal row with status 'invited'.
// There is no email sent and no token issued: the invitation IS the row, and
// Entra proves the person owns the mailbox at first sign-in. That keeps the
// trust boundary in one place (services/auth.ts) instead of splitting it across
// an invite-token scheme we would then have to secure separately.

import type { PermMap, PermissionSet, UserClient } from '@theone/shared';
import {
  ADVISORY_LOCKS,
  GRANT_EXCEEDS_OWN_CODE,
  SELF_EDIT_CODE,
  SELF_EDIT_MESSAGE,
  describeGrants,
  grantsExceeding,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { ApiError } from '../errors.js';
import { destroySessionsFor } from './auth.js';
import { parsePermMap } from './permissions.js';
import { getRolePermissionsByCode } from './roles.js';
import { logAdminEvent, snapshotsDiffer, type Snapshot } from './adminAudit.js';

/** The columns the audit log keeps of an account row — also what updateUser's
    locked read SELECTs and its UPDATE RETURNs, so both of its snapshots come
    from the transaction, never from a pool read a change committed in between
    could leave one step stale. */
type AccountRow = Pick<AdminUser, 'name' | 'email' | 'role' | 'status' | 'is_super_admin'>;

/** What the audit log keeps of an account row. */
function snapshot(u: AccountRow): Snapshot {
  return {
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    is_super_admin: u.is_super_admin,
  };
}

export interface AdminUser {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  role_label: string | null;
  initials: string | null;
  status: 'invited' | 'active' | 'disabled';
  is_super_admin: boolean;
  last_login_at: string | null;
  has_signed_in: boolean;
  /** True when a super admin has adjusted this person beyond their role (0015). */
  has_overrides: boolean;
  /** 0072 · the clients assigned to this person (`principal_client`). */
  clients: UserClient[];
}

const SELECT_USER = `
  SELECT p.id,
         p.display_name AS name,
         p.email,
         p.role,
         r.label AS role_label,
         p.initials,
         p.status,
         p.is_super_admin,
         p.last_login_at,
         (p.entra_oid IS NOT NULL) AS has_signed_in,
         (p.permission_overrides <> '{}'::jsonb) AS has_overrides,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id::text, 'name', c.name) ORDER BY lower(c.name))
                     FROM principal_client pc
                     JOIN client c ON c.id = pc.client_id AND c.deleted_at IS NULL
                    WHERE pc.principal_id = p.id), '[]'::jsonb) AS clients
    FROM principal p
    LEFT JOIN role r ON r.code = p.role`;

export async function listUsers(): Promise<AdminUser[]> {
  const res = await query<AdminUser>(
    `${SELECT_USER}
      WHERE p.kind = 'human'
      ORDER BY p.is_super_admin DESC, p.status = 'disabled', p.display_name ASC`,
  );
  return res.rows;
}

async function getUser(id: string): Promise<AdminUser> {
  const res = await query<AdminUser>(`${SELECT_USER} WHERE p.id = $1 LIMIT 1`, [id]);
  if (!res.rows[0]) throw new ApiError('NOT_FOUND', 'No such user');
  return res.rows[0];
}

/** The picker on the dev sign-in screen. Never exposed in Entra mode. */
export async function listSignInCandidates(): Promise<
  { id: string; name: string; email: string | null; role: string | null; is_super_admin: boolean }[]
> {
  const res = await query<{
    id: string;
    name: string;
    email: string | null;
    role: string | null;
    is_super_admin: boolean;
  }>(
    `SELECT id, display_name AS name, email, role, is_super_admin
       FROM principal
      WHERE kind = 'human' AND status <> 'disabled'
      ORDER BY is_super_admin DESC, display_name ASC`,
  );
  return res.rows;
}

/** Roles live in the `role` table as of 0005, so validation is a lookup, not a
    membership test against a compiled-in list. A role created five minutes ago
    in the Roles tab is assignable immediately. */
async function assertRole(role: string): Promise<void> {
  const res = await query<{ code: string }>(`SELECT code FROM role WHERE code = $1`, [role]);
  if (!res.rows[0]) {
    const all = await query<{ code: string }>(`SELECT code FROM role ORDER BY position`);
    throw new ApiError('BAD_REQUEST', `Unknown role "${role}"`, {
      allowed: all.rows.map((r) => r.code),
    });
  }
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (parts[0][0] + last).toUpperCase();
}

export interface InviteInput {
  email: string;
  name: string;
  role: string;
  is_super_admin?: boolean;
}

export async function inviteUser(
  input: InviteInput,
  actorId: string,
  /** Whether the REAL signed-in user is a super admin (routes/admin.ts passes
      it). Required, never defaulted: a default of true was a fail-open
      security check. A caller with no session in hand passes false; the
      route is the first check, this the second. */
  actorIsSuperAdmin: boolean,
  /** #18 · the inviter's own tree: the role handed out may not grant more. */
  actorPerms: PermissionSet,
): Promise<AdminUser> {
  assertMaySetSuperAdmin(input, actorIsSuperAdmin);
  await assertRole(input.role);
  assertGrantWithinOwn(actorPerms, actorIsSuperAdmin, await getRolePermissionsByCode(input.role));
  const email = input.email.trim().toLowerCase();

  const clash = await query<{ id: string; status: string }>(
    `SELECT id, status FROM principal WHERE lower(email) = $1 LIMIT 1`,
    [email],
  );
  if (clash.rows[0]) {
    throw new ApiError('BAD_REQUEST', `${email} is already a user`, {
      existing_id: clash.rows[0].id,
      status: clash.rows[0].status,
    });
  }

  const res = await query<{ id: string }>(
    `INSERT INTO principal (kind, display_name, email, role, initials, status, is_super_admin)
     VALUES ('human', $1, $2, $3, $4, 'invited', $5)
     RETURNING id`,
    [input.name.trim(), email, input.role, initialsOf(input.name), input.is_super_admin ?? false],
  );
  const created = await getUser(res.rows[0].id);
  await logAdminEvent({
    actorId,
    entity: 'principal',
    entityId: created.id,
    action: 'user_invited',
    after: snapshot(created),
  });
  return created;
}

export interface UpdateUserInput {
  name?: string;
  role?: string;
  is_super_admin?: boolean;
  status?: 'invited' | 'active' | 'disabled';
}

/** W4-1: the super-admin flag is granted and removed by super admins only. The REAL signed-in user decides, never `actingAs`. */
export function assertMaySetSuperAdmin(input: { is_super_admin?: boolean }, actorIsSuperAdmin: boolean): void {
  if (input.is_super_admin === undefined || actorIsSuperAdmin) return;
  throw new ApiError('FORBIDDEN', 'Only a super admin can grant or remove super-admin access', {
    code: 'SUPER_ADMIN_ONLY',
    required: 'is_super_admin',
  });
}

/** W4-1, the other half of the ring: a super admin's own row — name, role,
    status — is changed by super admins only. Without this an Admin › Users
    editor could not promote anyone (above) but could still disable or demote
    every super admin but the last. Same 403 vocabulary; `target` is the row
    as it stands. */
export function assertMayEditSuperAdmin(target: { is_super_admin: boolean }, actorIsSuperAdmin: boolean): void {
  if (!target.is_super_admin || actorIsSuperAdmin) return;
  throw new ApiError('FORBIDDEN', "Only a super admin can change a super admin's account", {
    code: 'SUPER_ADMIN_ONLY',
    required: 'is_super_admin',
  });
}

/** #18 (UAT round 1, Wave B) · nobody — super admins included — changes
    their own role, status, super-admin flag, client list or permission
    overrides: 403 SELF_EDIT. A name change is not a right and passes. */
export function assertNotSelfEdit(targetId: string, actorId: string, what: string): void {
  if (targetId !== actorId) return;
  throw new ApiError('FORBIDDEN', SELF_EDIT_MESSAGE, { code: SELF_EDIT_CODE, field: what });
}

/** #18 · a non-super-admin cannot hand out (through a role) an action they
    do not hold themselves: 403 GRANT_EXCEEDS_OWN naming the first few. */
export function assertGrantWithinOwn(
  actorPerms: PermissionSet,
  actorIsSuperAdmin: boolean,
  granted: PermMap,
  previous: PermMap = {},
): void {
  const over = grantsExceeding(actorPerms, actorIsSuperAdmin, granted, previous);
  if (over.length === 0) return;
  throw new ApiError(
    'FORBIDDEN',
    `You cannot grant permissions you do not hold yourself (${describeGrants(over)})`,
    { code: GRANT_EXCEEDS_OWN_CODE, exceeds: over },
  );
}

/** #18 · the three rights on an account row, compared with the row as it
    stands: only a CHANGE to one's own is refused. */
export function assertNoSelfRightsChange(
  id: string,
  actorId: string,
  input: UpdateUserInput,
  row: { role: string | null; status: string; is_super_admin: boolean },
): void {
  if (input.role !== undefined && input.role !== row.role) assertNotSelfEdit(id, actorId, 'role');
  if (input.status !== undefined && input.status !== row.status) assertNotSelfEdit(id, actorId, 'status');
  if (input.is_super_admin !== undefined && input.is_super_admin !== row.is_super_admin) {
    assertNotSelfEdit(id, actorId, 'is_super_admin');
  }
}

/** Transaction-level advisory lock taken by every change that could leave the
    app with no super admin (its key is the registry's, ADVISORY_LOCKS in
    @theone/shared, never a literal here): the "last super admin" count and
    the UPDATE it protects run under it, so two demotions of the last two
    super admins cannot both pass the count. */
const SUPER_ADMIN_RING_LOCK_KEY = ADVISORY_LOCKS.superAdminRing;

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actorId: string,
  /** Whether the REAL signed-in user is a super admin (routes/admin.ts passes
      it): needed to set `is_super_admin`, and to change a super admin's row at
      all. Required, never defaulted: a default of true was a fail-open
      security check. A caller with no session in hand passes false; the
      route is the first check, this the second. */
  actorIsSuperAdmin: boolean,
  /** #18 · the editor's own tree: a role handed out may not grant more. */
  actorPerms: PermissionSet,
): Promise<AdminUser> {
  assertMaySetSuperAdmin(input, actorIsSuperAdmin);
  if (input.role) await assertRole(input.role);

  const current = await getUser(id);
  // The early answer, on a pool read; the check that counts runs again on the
  // locked row inside the transaction below.
  assertMayEditSuperAdmin(current, actorIsSuperAdmin);

  // ── #18 · nobody changes their own rights ───────────────────────────────
  // Role, status and the super-admin flag on one's own row are refused for
  // everyone, super admins included (403 SELF_EDIT). Before 0084 only
  // removing one's own super-admin access and disabling oneself were (two
  // 400s), which left promoting oneself to the Admin role one click away.
  // A value equal to the one on file is not a change (the row editor sends
  // the whole row back) and passes.
  assertNoSelfRightsChange(id, actorId, input, current);
  if (input.role !== undefined && input.role !== current.role) {
    assertGrantWithinOwn(actorPerms, actorIsSuperAdmin, await getRolePermissionsByCode(input.role));
  }

  // And never let the last super admin be demoted or disabled. The count and
  // the UPDATE it protects run in ONE transaction: the row is re-read under a
  // row lock so the decision is made on the locked value, not on `current`, and
  // the ring lock serialises it with every other demotion — as two pool
  // queries, two concurrent demotions of the last two super admins both passed.
  // The locked read carries the audit columns too and the UPDATE returns them:
  // the before / after logged below are the row as it was locked and as it was
  // written, not a pool read a change committed in between could leave stale.
  const written = await withTransaction(async (tx) => {
    // FOR NO KEY UPDATE: no path updates principal.id, so a child insert's FK KEY SHARE never waits on this lock.
    const locked = await tx.query<AccountRow>(
      `SELECT display_name AS name, email, role, status, is_super_admin
         FROM principal WHERE id = $1 FOR NO KEY UPDATE`,
      [id],
    );
    if (!locked.rows[0]) throw new ApiError('NOT_FOUND', 'No such user');
    // The ring check on the LOCKED value: `current` was a pool read, and a
    // promotion committed between it and this lock would otherwise let a
    // non-super-admin change a super admin's row.
    assertMayEditSuperAdmin(locked.rows[0], actorIsSuperAdmin);
    // #18 again on the locked row: the pool read above may be stale.
    assertNoSelfRightsChange(id, actorId, input, locked.rows[0]);
    const losingSuper =
      (input.is_super_admin === false || input.status === 'disabled') && locked.rows[0].is_super_admin;
    if (losingSuper) {
      await tx.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [SUPER_ADMIN_RING_LOCK_KEY]);
      const remaining = await tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM principal
          WHERE is_super_admin = true AND status <> 'disabled' AND id <> $1`,
        [id],
      );
      if (remaining.rows[0].n === 0) {
        throw new ApiError('BAD_REQUEST', 'This is the last super admin — promote someone else first');
      }
    }

    const row = await tx.query<AccountRow>(
      `UPDATE principal
          SET display_name   = COALESCE($2, display_name),
              role           = COALESCE($3, role),
              is_super_admin = COALESCE($4, is_super_admin),
              status         = COALESCE($5, status),
              initials       = CASE WHEN $2 IS NULL THEN initials ELSE $6 END
        WHERE id = $1
    RETURNING display_name AS name, email, role, status, is_super_admin`,
      [
        id,
        input.name?.trim() ?? null,
        input.role ?? null,
        input.is_super_admin ?? null,
        input.status ?? null,
        input.name ? initialsOf(input.name) : null,
      ],
    );
    return { before: locked.rows[0], after: row.rows[0] };
  });

  // Disabling has to bite immediately, not whenever their cookie expires.
  if (input.status === 'disabled') await destroySessionsFor(id);

  const updated = await getUser(id);
  const before = snapshot(written.before);
  const after = snapshot(written.after);
  if (snapshotsDiffer(before, after)) {
    await logAdminEvent({
      actorId,
      entity: 'principal',
      entityId: id,
      action:
        input.status === 'disabled' && written.before.status !== 'disabled' ? 'user_disabled' : 'user_updated',
      before,
      after,
    });
  }
  return updated;
}

/**
 * Users are never deleted — activity_log rows reference them, and an audit
 * trail with dangling actors is worse than a disabled row. Disable instead.
 */
export async function disableUser(
  id: string,
  actorId: string,
  actorIsSuperAdmin: boolean,
  actorPerms: PermissionSet,
): Promise<AdminUser> {
  // The flag rides through: disabling a super admin needs a super admin (W4-1),
  // and disabling oneself is a SELF_EDIT (#18).
  return updateUser(id, { status: 'disabled' }, actorId, actorIsSuperAdmin, actorPerms);
}

// ── Per-user overrides (0015) ────────────────────────────────────────────────
// "Adam is an OM, but Adam specifically may not build quotes." The override
// map has the same shape as a role's tree and wins over it wherever it says
// something; everything it leaves unsaid falls through to the role.

export interface UserPermissions {
  user: AdminUser;
  /** What the person's role grants — the baseline the overrides sit on. */
  role_permissions: PermMap;
  overrides: PermMap;
}

export async function getUserPermissions(id: string): Promise<UserPermissions> {
  const user = await getUser(id);
  const res = await query<{ permission_overrides: PermMap }>(
    `SELECT permission_overrides FROM principal WHERE id = $1`,
    [id],
  );
  return {
    user,
    role_permissions: await getRolePermissionsByCode(user.role),
    overrides: res.rows[0]?.permission_overrides ?? {},
  };
}

export async function setUserPermissions(
  id: string,
  raw: unknown,
  actorId: string,
): Promise<UserPermissions> {
  // #18 · not on oneself, super admins included.
  assertNotSelfEdit(id, actorId, 'permission_overrides');
  const current = await getUserPermissions(id);
  const overrides = parsePermMap(raw);
  await query(`UPDATE principal SET permission_overrides = $2::jsonb WHERE id = $1`, [
    id,
    JSON.stringify(overrides),
  ]);
  const before: Snapshot = { name: current.user.name, overrides: current.overrides };
  const after: Snapshot = { name: current.user.name, overrides };
  if (snapshotsDiffer(before, after)) {
    await logAdminEvent({
      actorId,
      entity: 'principal',
      entityId: id,
      action: 'user_permissions_set',
      before,
      after,
    });
  }
  return getUserPermissions(id);
}

/**
 * 0073 · set or clear ONE path's `view` in a person's overrides — the Share
 * dialog's per-person sharing of a dashboard. Logged like any override edit,
 * as a whole before/after of the map. `view = null` removes the entry so the
 * role decides again. A super admin's overrides are a super admin's to change
 * (W4-1 ring): checked on the read, and again by the UPDATE itself, so a
 * promotion committed between the two writes nothing.
 */
export async function setUserOverrideView(
  id: string,
  key: string,
  view: boolean | null,
  actorId: string,
  /** Whether the actor is a super admin. Required, never defaulted (F1). The
      Share dialog hands in the acting identity's flag, which is never wider
      than the signed-in user's: only a super admin can act as someone else. */
  actorIsSuperAdmin: boolean,
): Promise<void> {
  // #18 · ticking oneself in the Share dialog is still an override on oneself.
  assertNotSelfEdit(id, actorId, 'permission_overrides');
  const current = await getUserPermissions(id);
  assertMayEditSuperAdmin(current.user, actorIsSuperAdmin);
  const overrides: PermMap = { ...current.overrides };
  const grant = { ...(overrides[key] ?? {}) };
  if (view === null) delete grant.view;
  else grant.view = view;
  if (Object.keys(grant).length > 0) overrides[key] = grant;
  else delete overrides[key];
  const res = await query(
    `UPDATE principal SET permission_overrides = $2::jsonb
      WHERE id = $1 AND (NOT is_super_admin OR $3::boolean)`,
    [id, JSON.stringify(overrides), actorIsSuperAdmin],
  );
  if ((res.rowCount ?? 0) === 0) {
    // Promoted since the read (the ring refuses it), or no longer on file.
    assertMayEditSuperAdmin(await getUser(id), actorIsSuperAdmin);
    throw new ApiError('CONFLICT', 'The account changed while it was being edited — try again');
  }
  const before: Snapshot = { name: current.user.name, overrides: current.overrides };
  const after: Snapshot = { name: current.user.name, overrides };
  if (snapshotsDiffer(before, after)) {
    await logAdminEvent({ actorId, entity: 'principal', entityId: id, action: 'user_permissions_set', before, after });
  }
}

// ── A person's clients (0072) ────────────────────────────────────────────────
// "Sam looks after Walmart and Target." The list is kept per person, not per
// role, because it IS the person's book — a role says *whether* their clients
// count ("Which work orders" = Only theirs), this says *which*. Anyone who may
// edit users keeps it (it is an assignment, not a permission override, so it
// is not held back for super admins the way Adjust is) — except a super
// admin's own list, which the W4-1 ring keeps to super admins like the rest
// of their row.

export interface UserClientsResult {
  user: AdminUser;
  clients: UserClient[];
}

export async function getUserClients(id: string): Promise<UserClientsResult> {
  const user = await getUser(id);
  return { user, clients: user.clients };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Replace one person's client list. Empty = none. A super admin sees every
    work order already, so a list on them would mean nothing — refused rather
    than silently ignored; and their row, the list included, is changed by
    super admins only (W4-1 ring — before this any Admin › Users editor could
    clear a super admin's list), decided on the row as locked, like updateUser. */
export async function setUserClients(
  id: string,
  clientIds: string[],
  actorId: string,
  /** Whether the REAL signed-in user is a super admin (routes/admin.ts passes
      it). Required, never defaulted (F1). */
  actorIsSuperAdmin: boolean,
): Promise<UserClientsResult> {
  // #18 · a client list widens what "Only theirs" counts: not on oneself.
  assertNotSelfEdit(id, actorId, 'clients');
  const current = await getUser(id);
  // The early answer, on a pool read; the check that counts runs again on the
  // locked row inside the transaction below.
  assertMayEditSuperAdmin(current, actorIsSuperAdmin);
  const ids = [...new Set(clientIds.filter((c) => UUID_RE.test(c)))];
  if (ids.length > 0 && current.is_super_admin) {
    throw new ApiError('BAD_REQUEST', 'A super admin sees every client already');
  }
  await withTransaction(async (tx) => {
    // FOR NO KEY UPDATE: no path updates principal.id, so a child insert's FK KEY SHARE never waits on this lock.
    const locked = await tx.query<{ is_super_admin: boolean }>(
      `SELECT is_super_admin FROM principal WHERE id = $1 FOR NO KEY UPDATE`,
      [id],
    );
    if (!locked.rows[0]) throw new ApiError('NOT_FOUND', 'No such user');
    assertMayEditSuperAdmin(locked.rows[0], actorIsSuperAdmin);
    if (ids.length > 0 && locked.rows[0].is_super_admin) {
      throw new ApiError('BAD_REQUEST', 'A super admin sees every client already');
    }
    await tx.query(`DELETE FROM principal_client WHERE principal_id = $1`, [id]);
    if (ids.length > 0) {
      await tx.query(
        `INSERT INTO principal_client (principal_id, client_id, granted_by)
         SELECT $1, c.id, $3 FROM client c WHERE c.id = ANY($2::uuid[]) AND c.deleted_at IS NULL`,
        [id, ids, actorId],
      );
    }
  });
  const updated = await getUser(id);
  const before: Snapshot = { name: current.name, clients: current.clients.map((c) => c.name) };
  const after: Snapshot = { name: updated.name, clients: updated.clients.map((c) => c.name) };
  if (snapshotsDiffer(before, after)) {
    await logAdminEvent({
      actorId,
      entity: 'principal',
      entityId: id,
      action: 'user_clients_changed',
      before,
      after,
    });
  }
  return { user: updated, clients: updated.clients };
}
