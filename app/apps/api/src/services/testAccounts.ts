// UAT follow-up T1 — test sign-in accounts, one per role.
//
// POST /api/auth/test-login {username, password}: username = a role code,
// password = TEST_ACCOUNTS_PASSWORD. Off (404) unless TEST_ACCOUNTS_ENABLED
// =true AND the password is set (config.testAccounts). On the first success
// the role's test principal is CREATED — email `test+<code>@test.theone.local`,
// display name "Test <role label>", that role, active, NEVER a super admin —
// and audited `test_account_created`; after that the row is the admins' like
// any other: a later sign-in never rewrites its role or status (only
// last_login_at), and a disabled one is refused. The caller gets the ordinary
// server-side session + httpOnly cookie (routes/auth.ts), carrying the
// fingerprint of the password it was issued under (migration 0087) so
// switching the feature off or rotating the password signs it out
// (services/auth.ts loadSession). Nothing is seeded; no migration holds these
// rows, so there is nothing to drift. In DEMO_MODE the seed marker is asked
// first (assertDemoSeeded), as the dev sign-in does.
//
// Guards: `admin` only with TEST_ACCOUNTS_INCLUDE_ADMIN=true, the `service`
// role never; five failed tries per minute per IP (lib/testAccountAuth.ts,
// in memory — see its caveat); one refusal sentence for every wrong part;
// every success logged `test_sign_in` (by the test principal) and every
// failure `test_sign_in_failed` (by the 'Test sign-in' service principal,
// keyed by the username as typed) — the password is never written anywhere.
// What a test account may DO once in is its role, minus users and roles
// (plugins/authGuard.ts testAccountAdminWriteBlocked, services/dashboards.ts
// applySharing), and it is never a super admin (services/auth.ts toPrincipal).

import { query } from '../db.js';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { AttemptLimiter, testPasswordFingerprint, testPasswordMatches } from '../lib/testAccountAuth.js';
import { logAdminEvent } from './adminAudit.js';
import { serviceActorId } from './serviceActors.js';
import {
  PRINCIPAL_COLUMNS,
  PRINCIPAL_FROM,
  assertDemoSeeded,
  toPrincipal,
  type PrincipalRow,
  type SessionPrincipal,
} from './auth.js';
import {
  TEST_ACCOUNT_READ_ONLY_ADMIN_CODE,
  TEST_ACCOUNT_READ_ONLY_ADMIN_MESSAGE,
  TEST_LOGIN_MAX_FAILURES,
  TEST_LOGIN_REFUSED_MESSAGE,
  TEST_LOGIN_WINDOW_MS,
  TEST_SIGN_IN_ACTION,
  TEST_SIGN_IN_FAILED_ACTION,
  testAccountDisplayName,
  testAccountEmail,
  testAccountRoleAllowed,
} from '@theone/shared';

/** Admin audit action when a role's test account is first created. */
export const TEST_ACCOUNT_CREATED_ACTION = 'test_account_created';

const limiter = new AttemptLimiter(TEST_LOGIN_MAX_FAILURES, TEST_LOGIN_WINDOW_MS);

/** Tests only: start every case with a clean count. */
export function resetTestLoginLimiter(): void {
  limiter.reset();
}

/** Is the form on? Read by GET /auth/me so the sign-in page knows. */
export function testAccountsEnabled(): boolean {
  return config.testAccounts !== null;
}

/** What a new test session is bound to: the current password's fingerprint
    (null while the feature is off). */
export function testSessionFingerprint(): string | null {
  return config.testAccounts ? testPasswordFingerprint(config.testAccounts.password) : null;
}

/** The 403 a test account gets on any user or role write. */
export function testAccountAdminRefusal(): ApiError {
  return new ApiError('FORBIDDEN', TEST_ACCOUNT_READ_ONLY_ADMIN_MESSAGE, { code: TEST_ACCOUNT_READ_ONLY_ADMIN_CODE });
}

function initialsOf(code: string): string {
  return ('T' + code.replace(/[^a-z]/g, '').slice(0, 1)).toUpperCase();
}

async function logFailure(username: string, ip: string, reason: string): Promise<void> {
  try {
    const actor = await serviceActorId('Test sign-in', 'TS');
    await query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, after)
       VALUES ($1, 'test_sign_in', $2, $3, $4)`,
      [actor, username.slice(0, 64), TEST_SIGN_IN_FAILED_ACTION, JSON.stringify({ username: username.slice(0, 64), ip, reason })],
    );
  } catch {
    /* a failed log line must not turn a refusal into a 500 */
  }
}

export async function testAccountSignIn(input: { username: string; password: string; ip: string }): Promise<SessionPrincipal> {
  const cfg = config.testAccounts;
  if (!cfg) throw new ApiError('NOT_FOUND', 'Route not found');

  const { ip } = input;
  if (limiter.blocked(ip)) {
    throw new ApiError('TOO_MANY_REQUESTS', 'Too many failed test sign-ins — wait a minute and try again', {
      code: 'TEST_LOGIN_RATE_LIMITED',
    });
  }

  const code = input.username.trim().toLowerCase();
  const refuse = async (reason: string): Promise<never> => {
    limiter.fail(ip);
    await logFailure(code || input.username, ip, reason);
    throw new ApiError('UNAUTHORIZED', TEST_LOGIN_REFUSED_MESSAGE);
  };

  // The password is checked first and always, so every refusal costs the same.
  const passwordOk = testPasswordMatches(input.password, cfg.password);
  if (!testAccountRoleAllowed(code, cfg.includeAdmin)) return refuse('role_not_allowed');
  if (!passwordOk) return refuse('wrong_password');

  // DEMO_MODE: nothing is created on a database the seed never marked (W4-11).
  await assertDemoSeeded();

  const role = await query<{ code: string; label: string | null }>(`SELECT code, label FROM role WHERE code = $1`, [code]);
  if (!role.rows[0]) return refuse('no_such_role');

  const email = testAccountEmail(code);
  const name = testAccountDisplayName(role.rows[0].label, code);
  const findExisting = async () =>
    (await query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM principal WHERE lower(email) = $1 LIMIT 1`,
      [email],
    )).rows[0] ?? null;

  let existing = await findExisting();
  let id: string | null = null;
  if (!existing) {
    const ins = await query<{ id: string }>(
      `INSERT INTO principal (kind, display_name, email, role, initials, status, is_super_admin, last_login_at)
       VALUES ('human', $1, $2, $3, $4, 'active', false, now())
       ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO NOTHING
       RETURNING id::text AS id`,
      [name, email, code, initialsOf(code)],
    );
    if (ins.rows[0]) {
      id = ins.rows[0].id;
      await logAdminEvent({
        actorId: id,
        entity: 'principal',
        entityId: id,
        action: TEST_ACCOUNT_CREATED_ACTION,
        after: { name, email, role: code, status: 'active', is_super_admin: false, test_account: true },
      });
    } else {
      // Lost a race with another first sign-in: the row is theirs now.
      existing = await findExisting();
      if (!existing) return refuse('no_such_account');
    }
  }
  if (existing) {
    // The row belongs to the admins once it exists: never rewrite its role or
    // status here, and a disabled test account stays out.
    if (existing.status === 'disabled') return refuse('disabled');
    id = existing.id;
    await query(`UPDATE principal SET last_login_at = now() WHERE id = $1`, [id]);
  }
  if (!id) return refuse('no_such_account');
  const row = await query<PrincipalRow>(`SELECT ${PRINCIPAL_COLUMNS} ${PRINCIPAL_FROM} WHERE p.id = $1 LIMIT 1`, [id]);
  const principal = toPrincipal(row.rows[0]);

  // Same shape as recordAuthEvent; the id twice for the uuid / text columns.
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, after)
     VALUES ($1, 'principal', $2, $3, $4)`,
    [id, id, TEST_SIGN_IN_ACTION, JSON.stringify({ method: 'test_account', username: code, role: principal.role, ip })],
  );
  return principal;
}
