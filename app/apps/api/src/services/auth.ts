// Sessions and sign-in policy.
//
// The rule this file exists to enforce (5.1.1): a verified Microsoft identity
// is necessary but not sufficient. Either the address already matches a
// `principal` row that is not disabled (an invitation, made from Admin › Users),
// or it belongs to one of `config.signIn.allowedDomains` — in which case the
// first sign-in enrols the person as `config.signIn.autoEnrolRole` (OM Under
// Probation by default) and a super admin promotes them from Admin › Users.
// Anyone else is refused. There is no other registration path.

import { randomBytes } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import type { EntraIdentity } from '../auth/entra.js';
import { logAdminEvent } from './adminAudit.js';
import {
  normalizePermMap,
  permAllows,
  type PermAction,
  type PermissionSet,
} from '@theone/shared';

export const SESSION_COOKIE = 'theone.sid';

/** 401 — no valid session. Distinct from 403, which means signed in but barred. */
export const unauthorized = (message = 'Sign in to continue', details: unknown = null) =>
  new ApiError('UNAUTHORIZED', message, details);

/** What a role grants, resolved from the `role` table at session load. */
export interface Capabilities {
  quoteEdit: boolean;
  quoteApprove: boolean;
  manageUsers: boolean;
  editWoFields: boolean;
  viewFieldHistory: boolean;
}

export interface SessionPrincipal {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  roleLabel: string | null;
  kind: 'human' | 'service';
  isSuperAdmin: boolean;
  status: 'invited' | 'active' | 'disabled';
  /** The permission tree (0015): the role's grants + this person's overrides.
      Every gate resolves against this; `can` below is derived from it. */
  perms: PermissionSet;
  /** The five legacy booleans, now DERIVED from `perms` for the older gates. */
  can: Capabilities;
}

export interface AuthContext {
  sessionId: string;
  /** The human who actually signed in. Every write is attributed here. */
  user: SessionPrincipal;
  /** Who they are viewing as, when a super admin is impersonating. */
  actingAs: SessionPrincipal;
  isImpersonating: boolean;
}

// LEFT JOIN, not INNER: a principal with a NULL role must still resolve to a
// session — it simply has no capabilities. An inner join would make such a row
// unable to sign in at all, which is a confusing way to express "no role yet".
const PRINCIPAL_COLUMNS = `
  p.id, p.display_name, p.email, p.role, p.kind, p.is_super_admin, p.status,
  r.label AS role_label,
  COALESCE(r.permissions, '{}'::jsonb)          AS role_permissions,
  COALESCE(p.permission_overrides, '{}'::jsonb) AS permission_overrides`;

const PRINCIPAL_FROM = `FROM principal p LEFT JOIN role r ON r.code = p.role`;

interface PrincipalRow {
  id: string;
  display_name: string;
  email: string | null;
  role: string | null;
  role_label: string | null;
  kind: 'human' | 'service';
  is_super_admin: boolean;
  status: 'invited' | 'active' | 'disabled';
  role_permissions: unknown;
  permission_overrides: unknown;
}

function toPrincipal(r: PrincipalRow): SessionPrincipal {
  // Normalised on the way in so a hand-edited or half-written JSON value can
  // never make a gate throw — a malformed grant is simply not a grant.
  const perms: PermissionSet = {
    role: normalizePermMap(r.role_permissions),
    overrides: normalizePermMap(r.permission_overrides),
  };
  // A super admin holds every permission regardless of role — the two grants
  // are orthogonal (see 0005) — which `permAllows` bakes in via the last arg.
  const allow = (key: string, action: PermAction) =>
    permAllows(perms, key, action, r.is_super_admin);
  return {
    id: r.id,
    name: r.display_name,
    email: r.email,
    role: r.role,
    kind: r.kind,
    roleLabel: r.role_label,
    isSuperAdmin: r.is_super_admin,
    status: r.status,
    perms,
    can: {
      quoteEdit: allow('quotes', 'edit'),
      quoteApprove: allow('quotes', 'approve'),
      manageUsers: allow('admin', 'view'),
      editWoFields: allow('work_orders', 'edit'),
      viewFieldHistory: allow('work_orders/history', 'view'),
    },
  };
}

// ── 1 · Sign-in policy ───────────────────────────────────────────────────────

/**
 * Turn a verified Entra identity into a principal, or refuse.
 *
 * Matched on lowercased email because that is the only claim an administrator
 * can act on when inviting somebody. On first successful sign-in the immutable
 * `oid` is bound to the row, and from then on it is preferred — so changing
 * somebody's display name or even their primary address in Entra does not
 * detach them from their history.
 *
 * Nobody on file: an address on an allowed domain is enrolled on the spot
 * (`enrolNewPrincipal`); anything else is refused with `reason: 'not_invited'`.
 */
export async function resolvePrincipalForSignIn(identity: EntraIdentity): Promise<SessionPrincipal> {
  const byOid = await query<PrincipalRow>(
    `SELECT ${PRINCIPAL_COLUMNS} ${PRINCIPAL_FROM} WHERE p.entra_oid = $1 LIMIT 1`,
    [identity.oid],
  );

  const found =
    byOid.rows[0] ??
    (
      await query<PrincipalRow>(
        `SELECT ${PRINCIPAL_COLUMNS} ${PRINCIPAL_FROM}
          WHERE lower(p.email) = $1 AND p.kind = 'human' LIMIT 1`,
        [identity.email],
      )
    ).rows[0];

  if (!found) {
    if (isAllowedDomain(identity.email)) return enrolNewPrincipal(identity);
    const { allowedDomains } = config.signIn;
    throw new ApiError(
      'FORBIDDEN',
      allowedDomains.length > 0
        ? `${identity.email} is not a @${allowedDomains.join(' / @')} account and has not been invited`
        : `${identity.email} has not been invited to The One`,
      {
        email: identity.email,
        reason: 'not_invited',
        hint:
          allowedDomains.length > 0
            ? `Sign in with your @${allowedDomains[0]} account, or ask a super admin to invite this address.`
            : 'Ask a super admin to invite this address.',
      },
    );
  }

  if (found.status === 'disabled') {
    throw new ApiError('FORBIDDEN', 'This account has been disabled', {
      email: identity.email,
      reason: 'disabled',
    });
  }

  // Bind the Entra identity and flip invited → active. Doing both in one
  // statement means a half-completed first sign-in cannot leave a row claiming
  // to be active without an oid behind it.
  await query(
    `UPDATE principal
        SET entra_oid     = $2,
            status        = 'active',
            last_login_at = now(),
            display_name  = COALESCE(NULLIF($3, ''), display_name)
      WHERE id = $1`,
    [found.id, identity.oid, identity.name ?? ''],
  );

  // Re-read through the join: RETURNING cannot reach the role columns.
  const updated = await query<PrincipalRow>(
    `SELECT ${PRINCIPAL_COLUMNS} ${PRINCIPAL_FROM} WHERE p.id = $1 LIMIT 1`,
    [found.id],
  );
  return toPrincipal(updated.rows[0]);
}

function isAllowedDomain(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return config.signIn.allowedDomains.includes(domain);
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (parts[0][0] + last).toUpperCase();
}

/**
 * First sign-in from an allowed domain: create the principal as
 * `config.signIn.autoEnrolRole`, already `active` with the oid bound.
 *
 * The role must exist — a typo in AUTH_AUTO_ENROL_ROLE must fail loudly at the
 * door, not create a row with a dangling role code and no permissions.
 * The insert is ON CONFLICT DO NOTHING on the case-insensitive email index so
 * two first sign-ins racing each other converge on one row. The event is
 * logged as `user_auto_enrolled`, attributed to the person themselves: no
 * admin acted, and the audit page reads it like an invitation.
 */
async function enrolNewPrincipal(identity: EntraIdentity): Promise<SessionPrincipal> {
  const roleCode = config.signIn.autoEnrolRole;
  const role = await query<{ code: string }>(`SELECT code FROM role WHERE code = $1`, [roleCode]);
  if (!role.rows[0]) {
    throw new ApiError('INTERNAL', 'Sign-in is misconfigured on the server', {
      email: identity.email,
      reason: 'auto_enrol_role_missing',
      hint: `AUTH_AUTO_ENROL_ROLE="${roleCode}" is not a role code. Ask an administrator.`,
    });
  }

  const name = identity.name?.trim() || identity.email.slice(0, identity.email.indexOf('@'));
  const inserted = await query<{ id: string }>(
    `INSERT INTO principal
       (kind, display_name, email, role, initials, status, is_super_admin, entra_oid, last_login_at)
     VALUES ('human', $1, $2, $3, $4, 'active', false, $5, now())
     ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO NOTHING
     RETURNING id`,
    [name, identity.email, roleCode, initialsOf(name), identity.oid],
  );

  if (!inserted.rows[0]) {
    // Lost the race — the other request created the row; take the normal path.
    return resolvePrincipalForSignIn(identity);
  }

  const id = inserted.rows[0].id;
  const row = await query<PrincipalRow>(
    `SELECT ${PRINCIPAL_COLUMNS} ${PRINCIPAL_FROM} WHERE p.id = $1 LIMIT 1`,
    [id],
  );
  const principal = toPrincipal(row.rows[0]);
  await logAdminEvent({
    actorId: id,
    entity: 'principal',
    entityId: id,
    action: 'user_auto_enrolled',
    after: { name, email: identity.email, role: roleCode, status: 'active', is_super_admin: false },
  });
  return principal;
}

// ── 2 · Sessions ─────────────────────────────────────────────────────────────

export async function createSession(
  principalId: string,
  meta: { userAgent?: string; ip?: string },
): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);

  await query(
    `INSERT INTO session (id, principal_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, principalId, expiresAt.toISOString(), meta.userAgent ?? null, meta.ip ?? null],
  );

  return { id, expiresAt };
}

interface SessionRow extends PrincipalRow {
  session_id: string;
  impersonating_id: string | null;
}

/**
 * Load the session behind a cookie, or null. Returns null for every failure
 * mode — missing, expired, revoked, or belonging to a since-disabled user —
 * because the caller's response is identical in all of them.
 *
 * Note the `status <> 'disabled'` join condition: disabling somebody in the
 * admin console ends their session on their very next request, which is the
 * whole reason sessions live in the database instead of in a JWT.
 */
export async function loadSession(sessionId: string | undefined): Promise<AuthContext | null> {
  if (!sessionId) return null;

  const res = await query<SessionRow>(
    `SELECT s.id AS session_id, s.impersonating_id, ${PRINCIPAL_COLUMNS}
       FROM session s
       JOIN principal p ON p.id = s.principal_id
       LEFT JOIN role r ON r.code = p.role
      WHERE s.id = $1
        AND s.expires_at > now()
        AND p.status <> 'disabled'
      LIMIT 1`,
    [sessionId],
  );

  const row = res.rows[0];
  if (!row) return null;

  const user = toPrincipal(row);
  let actingAs = user;

  if (row.impersonating_id) {
    const target = await query<PrincipalRow>(
      `SELECT ${PRINCIPAL_COLUMNS} ${PRINCIPAL_FROM} WHERE p.id = $1 LIMIT 1`,
      [row.impersonating_id],
    );
    // Impersonation only holds while the impersonator is still a super admin —
    // revoking that privilege drops them back to themselves immediately.
    if (target.rows[0] && user.isSuperAdmin) actingAs = toPrincipal(target.rows[0]);
  }

  // Cheap liveness for the admin session list; not on the hot path for auth.
  await query(`UPDATE session SET last_seen_at = now() WHERE id = $1`, [row.session_id]);

  return {
    sessionId: row.session_id,
    user,
    actingAs,
    isImpersonating: actingAs.id !== user.id,
  };
}

export async function destroySession(sessionId: string): Promise<void> {
  await query(`DELETE FROM session WHERE id = $1`, [sessionId]);
}

/** Used by the admin console when disabling somebody: kill every live session. */
export async function destroySessionsFor(principalId: string): Promise<void> {
  await query(`DELETE FROM session WHERE principal_id = $1`, [principalId]);
}

export async function setImpersonation(
  sessionId: string,
  targetId: string | null,
): Promise<void> {
  await query(`UPDATE session SET impersonating_id = $2 WHERE id = $1`, [sessionId, targetId]);
}

// ── 3 · OAuth transactions (state + PKCE verifier, between redirect and callback) ──

export async function storeAuthTransaction(tx: {
  state: string;
  codeVerifier: string;
  nonce: string;
  redirectTo?: string;
}): Promise<void> {
  await query(
    `INSERT INTO auth_transaction (state, code_verifier, nonce, redirect_to, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
    [tx.state, tx.codeVerifier, tx.nonce, tx.redirectTo ?? null],
  );
  // Opportunistic sweep — no scheduler in the prototype, and the table is tiny.
  await query(`DELETE FROM auth_transaction WHERE expires_at < now()`);
}

export interface AuthTransaction {
  codeVerifier: string;
  nonce: string;
  redirectTo: string | null;
}

/** Single-use by construction: the DELETE ... RETURNING is the consumption. */
export async function consumeAuthTransaction(state: string): Promise<AuthTransaction | null> {
  const res = await query<{ code_verifier: string; nonce: string; redirect_to: string | null }>(
    `DELETE FROM auth_transaction
      WHERE state = $1 AND expires_at > now()
      RETURNING code_verifier, nonce, redirect_to`,
    [state],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { codeVerifier: row.code_verifier, nonce: row.nonce, redirectTo: row.redirect_to };
}

// ── 4 · Dev bypass ───────────────────────────────────────────────────────────

/**
 * Sign in as any non-disabled human without a password. Guarded twice: the
 * config module refuses to boot this mode in production, and this function
 * refuses again at call time. Two locks on a door that must never open.
 */
export async function devBypassSignIn(principalId: string): Promise<SessionPrincipal> {
  if (config.authMode !== 'bypass' || config.isProduction) {
    throw new ApiError('FORBIDDEN', 'The development sign-in bypass is not enabled');
  }
  const touched = await query<{ id: string }>(
    `UPDATE principal SET last_login_at = now(), status = 'active'
      WHERE id = $1 AND kind = 'human' AND status <> 'disabled'
      RETURNING id`,
    [principalId],
  );
  if (!touched.rows[0]) throw new ApiError('NOT_FOUND', 'No such user');

  const res = await query<PrincipalRow>(
    `SELECT ${PRINCIPAL_COLUMNS} ${PRINCIPAL_FROM} WHERE p.id = $1 LIMIT 1`,
    [principalId],
  );
  return toPrincipal(res.rows[0]);
}
