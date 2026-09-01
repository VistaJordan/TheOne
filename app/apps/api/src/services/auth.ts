// Sessions and sign-in policy.
//
// The rule this file exists to enforce: SIGN-IN IS INVITE-ONLY. A verified
// Microsoft identity is necessary but not sufficient — the address must already
// match a `principal` row that is not disabled. Creating that row IS the
// invitation; there is no self-registration path anywhere in the API.

import { randomBytes } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import type { EntraIdentity } from '../auth/entra.js';

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
  /** Read from the database, never from a hardcoded list (migration 0005). */
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
  COALESCE(r.can_edit_quote,         false) AS can_edit_quote,
  COALESCE(r.can_approve_quote,      false) AS can_approve_quote,
  COALESCE(r.can_manage_users,       false) AS can_manage_users,
  COALESCE(r.can_edit_wo_fields,     false) AS can_edit_wo_fields,
  COALESCE(r.can_view_field_history, false) AS can_view_field_history`;

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
  can_edit_quote: boolean;
  can_approve_quote: boolean;
  can_manage_users: boolean;
  can_edit_wo_fields: boolean;
  can_view_field_history: boolean;
}

function toPrincipal(r: PrincipalRow): SessionPrincipal {
  return {
    id: r.id,
    name: r.display_name,
    email: r.email,
    role: r.role,
    kind: r.kind,
    roleLabel: r.role_label,
    isSuperAdmin: r.is_super_admin,
    status: r.status,
    can: {
      quoteEdit: r.can_edit_quote,
      quoteApprove: r.can_approve_quote,
      // A super admin can always reach the admin console regardless of which
      // operating role they hold — the two grants are orthogonal (see 0005).
      // The same reasoning covers the 0007 field gates: an account trusted to
      // manage every user is trusted to edit a field and read its history.
      manageUsers: r.can_manage_users || r.is_super_admin,
      editWoFields: r.can_edit_wo_fields || r.is_super_admin,
      viewFieldHistory: r.can_view_field_history || r.is_super_admin,
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
 */
export async function resolveInvitedPrincipal(identity: EntraIdentity): Promise<SessionPrincipal> {
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
    throw new ApiError(
      'FORBIDDEN',
      `${identity.email} has not been invited to The One`,
      { email: identity.email, reason: 'not_invited' },
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
  // DEMO_MODE opens the production lock the same way it does in config.ts —
  // a deliberately public demo on seed data only (never real work orders).
  if (config.authMode !== 'bypass' || (config.isProduction && !config.demoMode)) {
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
