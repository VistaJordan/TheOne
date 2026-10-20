// UAT follow-up T1 — test sign-in accounts, one per role.
//
// UAT needs real sessions per role (one per role, signed in for real). A test
// account is an ordinary `principal` (a real session gets the same scope,
// gates and audit as the role) that is created or refreshed on a successful
// test sign-in: username = the role code, one shared password from the
// environment (TEST_ACCOUNTS_PASSWORD — never in the repo), switched on by
// TEST_ACCOUNTS_ENABLED=true. What marks one is its address: every test
// account lives on TEST_ACCOUNT_EMAIL_DOMAIN, which no Microsoft tenant can
// issue, so a test account can never be reached through the Microsoft
// sign-in and no real person's row can be mistaken for one. No migration and
// no seed row: nothing to keep in step.
//
// The pure half lives here so the API and the browser agree; the password
// check, the attempt limiter and the database writes are apps/api's.

/** The domain every test account's email is on. Not resolvable on purpose. */
export const TEST_ACCOUNT_EMAIL_DOMAIN = 'test.theone.local';

/** The one role a test account is never made in, unless
    TEST_ACCOUNTS_INCLUDE_ADMIN=true. */
export const TEST_ACCOUNT_ADMIN_CODE = 'admin';

/** Roles that are not people at all — never a test account. */
export const TEST_ACCOUNT_EXCLUDED_CODES: readonly string[] = ['service'];

/** Failed tries allowed per IP inside the window before every try is refused. */
export const TEST_LOGIN_MAX_FAILURES = 5;
export const TEST_LOGIN_WINDOW_MS = 60_000;

/** details.code of the 403 a test account gets on a user or role write. */
export const TEST_ACCOUNT_READ_ONLY_ADMIN_CODE = 'TEST_ACCOUNT_READ_ONLY_ADMIN';
export const TEST_ACCOUNT_READ_ONLY_ADMIN_MESSAGE =
  'Test accounts cannot change users or roles, whatever their role allows.';

/** The one sentence every refused test sign-in gets (no hint which part was wrong). */
export const TEST_LOGIN_REFUSED_MESSAGE = 'Wrong test username or password';

/** The audit actions (activity_log.action). */
export const TEST_SIGN_IN_ACTION = 'test_sign_in';
export const TEST_SIGN_IN_FAILED_ACTION = 'test_sign_in_failed';

const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** `test+om@test.theone.local` — the row's identity, upserted by this. */
export function testAccountEmail(roleCode: string): string {
  return `test+${roleCode}@${TEST_ACCOUNT_EMAIL_DOMAIN}`;
}

/** True for an address on the test domain in the `test+<code>@` form. */
export function isTestAccountEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return e.startsWith('test+') && e.endsWith(`@${TEST_ACCOUNT_EMAIL_DOMAIN}`);
}

/** "Test OM Under Probation" — the role's label, else its code upper-cased. */
export function testAccountDisplayName(roleLabel: string | null | undefined, roleCode: string): string {
  const label = (roleLabel ?? '').trim();
  return `Test ${label || roleCode.toUpperCase()}`;
}

/** May a test account be made in this role? A plain role code, not a
    non-person role, and not admin unless the environment says so. */
export function testAccountRoleAllowed(roleCode: string, includeAdmin: boolean): boolean {
  if (!CODE_RE.test(roleCode)) return false;
  if (TEST_ACCOUNT_EXCLUDED_CODES.includes(roleCode)) return false;
  if (roleCode === TEST_ACCOUNT_ADMIN_CODE) return includeAdmin;
  return true;
}
