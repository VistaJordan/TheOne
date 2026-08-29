// User administration — the data layer behind Admin › Users.
//
// "Inviting" somebody is just inserting a principal row with status 'invited'.
// There is no email sent and no token issued: the invitation IS the row, and
// Entra proves the person owns the mailbox at first sign-in. That keeps the
// trust boundary in one place (services/auth.ts) instead of splitting it across
// an invite-token scheme we would then have to secure separately.

import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { destroySessionsFor } from './auth.js';

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
         (p.entra_oid IS NOT NULL) AS has_signed_in
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

export async function inviteUser(input: InviteInput): Promise<AdminUser> {
  await assertRole(input.role);
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
  return getUser(res.rows[0].id);
}

export interface UpdateUserInput {
  name?: string;
  role?: string;
  is_super_admin?: boolean;
  status?: 'invited' | 'active' | 'disabled';
}

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actorId: string,
): Promise<AdminUser> {
  if (input.role) await assertRole(input.role);

  const current = await getUser(id);

  // ── Two guards against locking everyone out ─────────────────────────────
  // You cannot remove your own super-admin rights or disable yourself: both
  // are one click away from an app nobody can administer, and both are far
  // more likely to be a misclick than an intention.
  if (id === actorId && input.is_super_admin === false) {
    throw new ApiError('BAD_REQUEST', 'You cannot remove your own super-admin access');
  }
  if (id === actorId && input.status === 'disabled') {
    throw new ApiError('BAD_REQUEST', 'You cannot disable your own account');
  }

  // And never let the last super admin be demoted or disabled.
  const losingSuper =
    (input.is_super_admin === false || input.status === 'disabled') && current.is_super_admin;
  if (losingSuper) {
    const remaining = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM principal
        WHERE is_super_admin = true AND status <> 'disabled' AND id <> $1`,
      [id],
    );
    if (remaining.rows[0].n === 0) {
      throw new ApiError('BAD_REQUEST', 'This is the last super admin — promote someone else first');
    }
  }

  await query(
    `UPDATE principal
        SET display_name   = COALESCE($2, display_name),
            role           = COALESCE($3, role),
            is_super_admin = COALESCE($4, is_super_admin),
            status         = COALESCE($5, status),
            initials       = CASE WHEN $2 IS NULL THEN initials ELSE $6 END
      WHERE id = $1`,
    [
      id,
      input.name?.trim() ?? null,
      input.role ?? null,
      input.is_super_admin ?? null,
      input.status ?? null,
      input.name ? initialsOf(input.name) : null,
    ],
  );

  // Disabling has to bite immediately, not whenever their cookie expires.
  if (input.status === 'disabled') await destroySessionsFor(id);

  return getUser(id);
}

/**
 * Users are never deleted — activity_log rows reference them, and an audit
 * trail with dangling actors is worse than a disabled row. Disable instead.
 */
export async function disableUser(id: string, actorId: string): Promise<AdminUser> {
  return updateUser(id, { status: 'disabled' }, actorId);
}
