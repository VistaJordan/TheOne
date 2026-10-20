/* W4-1 (AUDIT.md Must-fix, group G1-admin) — the super-admin ring is managed
 * by super admins only. Before the fix any Admin › Users editor could promote
 * themselves, or anyone, through POST / PATCH /admin/users (the two routes
 * asked for `admin/users` edit and nothing more) and could disable or demote
 * every super admin but the last.
 *
 * Pinned here:
 *  - The pure decisions. `assertMaySetSuperAdmin`: a body that carries
 *    `is_super_admin` in EITHER value is refused with 403 FORBIDDEN /
 *    details.code SUPER_ADMIN_ONLY unless the actor is a super admin; a body
 *    that never mentions the flag passes for anyone. `assertMayEditSuperAdmin`
 *    (the other half of the ring): a super admin's row is changed by super
 *    admins only, same 403.
 *  - The wiring in routes/admin.ts: POST and PATCH /admin/users call the
 *    first, and all three user-writing routes (POST, PATCH, disable) hand the
 *    service a flag read from the REAL signed-in user
 *    (`req.auth.user.isSuperAdmin`), never `actingAs` — the identity
 *    `requireAdmin` already reads. The checks accept the helper or an inline
 *    read, so a rename does not fail them; only a change of identity does.
 *  - The race (raised by the Skeptics on the first revision): the "last super
 *    admin" count and the UPDATE it protects run inside ONE transaction, on
 *    the row read FOR NO KEY UPDATE, under the ring's advisory lock. They used
 *    to be two pool queries, so two demotions of the last two super admins
 *    could both pass the count. NO KEY because no path updates principal.id:
 *    a child row's FK KEY SHARE (a session, an audit row) never waits on it.
 *  - The follow-up (F1-users-ring): `actorIsSuperAdmin` is a REQUIRED
 *    parameter of inviteUser / updateUser / disableUser — it used to default
 *    to true, a fail-open default on a security check — and
 *    `assertMayEditSuperAdmin` runs again on the LOCKED row inside the
 *    transaction, so a promotion committed between the pool read and the lock
 *    cannot let a non-super-admin change a super admin's row.
 *  - The second revision (F1, after the Skeptics): the ring covers the REST of
 *    the row too — setUserClients (any Admin › Users editor could clear a
 *    super admin's client list) and setUserOverrideView (the Share dialog's
 *    per-person grant) take the same required flag and run
 *    assertMayEditSuperAdmin, the first on the locked row, the second inside
 *    the UPDATE's WHERE as well; and updateUser's audit `before` / `after`
 *    come from the locked read and the UPDATE's RETURNING, not from the pool
 *    read. The locked-row checks are matched by data flow (whatever the const
 *    is called), not by a variable name.
 *
 * Hermetic: `services/users.ts` imports the db and config modules but opens
 * nothing; the wiring checks read the three source files off disk.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../apps/api/src/errors';
import { assertMayEditSuperAdmin, assertMaySetSuperAdmin } from '../apps/api/src/services/users';

const ROUTES = readFileSync(new URL('../apps/api/src/routes/admin.ts', import.meta.url), 'utf8');
const USERS = readFileSync(new URL('../apps/api/src/services/users.ts', import.meta.url), 'utf8');
const DASHBOARDS = readFileSync(new URL('../apps/api/src/services/dashboards.ts', import.meta.url), 'utf8');

function refusal(fn: () => void): ApiError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error('expected a refusal');
}

/** One route registration: from its marker to the next `app.<verb>(` at the same depth. */
function routeBlock(marker: string): string {
  const start = ROUTES.indexOf(marker);
  expect(start, `route ${marker} is registered`).toBeGreaterThan(-1);
  const next = ROUTES.indexOf('\n  app.', start + marker.length);
  return ROUTES.slice(start, next === -1 ? undefined : next);
}

/** One top-level function of users.ts: from its signature to the next export. */
function fnBody(name: string): string {
  const start = USERS.indexOf(`export async function ${name}(`);
  expect(start, `${name} is exported`).toBeGreaterThan(-1);
  const next = USERS.indexOf('\nexport ', start + 1);
  return USERS.slice(start, next === -1 ? undefined : next);
}

/** A read of the REAL signed-in user's flag: the helper, or an inline read. */
const REAL_FLAG = /isActingSuperAdmin\(req\)/;

/** The argument list of `call(...)` inside `block` — one nested paren level allowed. */
function argsOf(block: string, call: string): string {
  const m = block.match(new RegExp(`\\b${call}\\(((?:[^()]|\\([^()]*\\))*)\\)`));
  expect(m, `${call}( is called`).not.toBeNull();
  return m![1];
}

/** True when `call` in `block` receives the real flag — inline, or through a const assigned from it. */
function callGetsRealFlag(block: string, call: string): boolean {
  const args = argsOf(block, call);
  if (REAL_FLAG.test(args)) return true;
  const assigned = block.match(/const (\w+) = isActingSuperAdmin\(req\)/);
  return assigned !== null && new RegExp(`\\b${assigned[1]}\\b`).test(args);
}

describe('assertMaySetSuperAdmin (W4-1)', () => {
  it('refuses a non-super-admin granting super admin: 403 FORBIDDEN / SUPER_ADMIN_ONLY', () => {
    const err = refusal(() => assertMaySetSuperAdmin({ is_super_admin: true }, false));
    expect(err.code).toBe('FORBIDDEN');
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Only a super admin can grant or remove super-admin access');
    expect(err.details).toEqual({ code: 'SUPER_ADMIN_ONLY', required: 'is_super_admin' });
  });

  it('refuses a non-super-admin removing it too — the key is what counts, not its value', () => {
    const err = refusal(() => assertMaySetSuperAdmin({ is_super_admin: false }, false));
    expect(err.code).toBe('FORBIDDEN');
    expect(err.statusCode).toBe(403);
    expect((err.details as { code: string }).code).toBe('SUPER_ADMIN_ONLY');
  });

  it('lets a super admin set it either way', () => {
    expect(() => assertMaySetSuperAdmin({ is_super_admin: true }, true)).not.toThrow();
    expect(() => assertMaySetSuperAdmin({ is_super_admin: false }, true)).not.toThrow();
  });

  it('is indifferent to a body that never mentions the flag', () => {
    expect(() => assertMaySetSuperAdmin({ role: 'admin' } as { is_super_admin?: boolean }, false)).not.toThrow();
    expect(() => assertMaySetSuperAdmin({}, false)).not.toThrow();
    expect(() => assertMaySetSuperAdmin({ is_super_admin: undefined }, false)).not.toThrow();
  });
});

describe('assertMayEditSuperAdmin (W4-1, the other half of the ring)', () => {
  it("refuses a non-super-admin changing a super admin's row: 403 FORBIDDEN / SUPER_ADMIN_ONLY", () => {
    const err = refusal(() => assertMayEditSuperAdmin({ is_super_admin: true }, false));
    expect(err.code).toBe('FORBIDDEN');
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe("Only a super admin can change a super admin's account");
    expect(err.details).toEqual({ code: 'SUPER_ADMIN_ONLY', required: 'is_super_admin' });
  });

  it('lets a non-super-admin change anyone else, and a super admin change anyone', () => {
    expect(() => assertMayEditSuperAdmin({ is_super_admin: false }, false)).not.toThrow();
    expect(() => assertMayEditSuperAdmin({ is_super_admin: true }, true)).not.toThrow();
    expect(() => assertMayEditSuperAdmin({ is_super_admin: false }, true)).not.toThrow();
  });
});

describe('routes/admin.ts wires the three user-writing routes to the acting person (D6, 0088)', () => {
  const post = routeBlock("app.post('/admin/users'");
  const patch = routeBlock("app.patch('/admin/users/:id'");
  const disable = routeBlock("app.post('/admin/users/:id/disable'");

  it('imports assertMaySetSuperAdmin and calls it on POST and on PATCH — nowhere else', () => {
    expect(ROUTES).toMatch(/import \{[^}]*\bassertMaySetSuperAdmin\b[^}]*\} from '\.\.\/services\/users\.js'/);
    expect(post).toContain('assertMaySetSuperAdmin(');
    expect(patch).toContain('assertMaySetSuperAdmin(');
    expect(ROUTES.match(/assertMaySetSuperAdmin\(/g)?.length).toBe(2);
  });

  it('decides on the acting person\'s flag — permissionSubject, which only a super admin can make anyone else', () => {
    const helperStart = ROUTES.indexOf('function isActingSuperAdmin(');
    expect(helperStart).toBeGreaterThan(-1);
    const helper = ROUTES.slice(helperStart, ROUTES.indexOf('\n}', helperStart));
    expect(helper).toMatch(/permissionSubject\(req\)\.isSuperAdmin/);
    for (const block of [post, patch, disable]) {
      expect(block).toMatch(REAL_FLAG);
      expect(block).not.toMatch(/req\.auth!?\.user\.isSuperAdmin/);
    }
  });

  it('hands that flag to assertMaySetSuperAdmin and on to inviteUser / updateUser / disableUser', () => {
    expect(callGetsRealFlag(post, 'assertMaySetSuperAdmin')).toBe(true);
    expect(callGetsRealFlag(post, 'inviteUser')).toBe(true);
    expect(callGetsRealFlag(patch, 'assertMaySetSuperAdmin')).toBe(true);
    expect(callGetsRealFlag(patch, 'updateUser')).toBe(true);
    expect(callGetsRealFlag(disable, 'disableUser')).toBe(true);
  });
});

/** The parameter list of one function: from its name to its return type. */
function signatureOf(name: string): string {
  const body = fnBody(name);
  const end = body.indexOf('): Promise<');
  expect(end, `${name} declares its return type`).toBeGreaterThan(-1);
  return body.slice(0, end);
}

/** The const a transaction's FOR NO KEY UPDATE read is assigned to: the check
    on the locked row is matched through it, whatever the const is called. */
function lockedReadVar(tx: string): string {
  const m = tx.match(/const (\w+) = await tx\.query<[^>]*>\(\s*`SELECT [^`]*FOR NO KEY UPDATE`/);
  expect(m, 'the FOR NO KEY UPDATE read is assigned to a const').not.toBeNull();
  return m![1];
}

/** Every writer of users.ts that takes the ring flag. */
const RING_WRITERS = ['inviteUser', 'updateUser', 'disableUser', 'setUserClients', 'setUserOverrideView'];

describe('services/users.ts checks again, on the row, inside one locked transaction', () => {
  const invite = fnBody('inviteUser');
  const update = fnBody('updateUser');
  const disable = fnBody('disableUser');

  it('declares actorIsSuperAdmin as a required boolean on every ring writer — no fail-open default', () => {
    for (const name of RING_WRITERS) {
      const sig = signatureOf(name);
      expect(sig, `${name} takes the flag`).toMatch(/\bactorIsSuperAdmin: boolean\b/);
      expect(sig, `${name} neither defaults nor optionalises it`).not.toMatch(/actorIsSuperAdmin\s*[?=]/);
    }
    // Nowhere in the file: not a default in either value, not an optional.
    expect(USERS).not.toMatch(/actorIsSuperAdmin\s*[?=]/);
    expect(USERS).not.toContain('actorIsSuperAdmin = true');
  });

  it('inviteUser and updateUser re-check the flag first thing; updateUser checks the target row too', () => {
    expect(invite).toContain('assertMaySetSuperAdmin(input, actorIsSuperAdmin)');
    expect(update).toContain('assertMaySetSuperAdmin(input, actorIsSuperAdmin)');
    expect(update).toMatch(/assertMayEditSuperAdmin\(current, actorIsSuperAdmin\)/);
  });

  it('disableUser passes the flag through to updateUser', () => {
    // UAT Wave B (#18) added the editor's own tree as a fifth argument.
    expect(disable).toMatch(/updateUser\(\s*id,\s*\{\s*status:\s*'disabled'\s*\},\s*actorId,\s*\w+(?:,\s*\w+)?\s*\)/);
  });

  it('the last-super-admin count and the UPDATE run in one transaction, on the row locked FOR NO KEY UPDATE, under the ring lock', () => {
    const txStart = update.indexOf('withTransaction(');
    expect(txStart).toBeGreaterThan(-1);
    const tx = update.slice(txStart);
    const lockedRead = tx.indexOf('FOR NO KEY UPDATE`');
    const ringLock = tx.indexOf('pg_advisory_xact_lock');
    const count = tx.indexOf('COUNT(*)');
    const write = tx.indexOf('UPDATE principal');
    expect(lockedRead).toBeGreaterThan(-1);
    expect(ringLock).toBeGreaterThan(lockedRead);
    expect(count).toBeGreaterThan(ringLock);
    expect(write).toBeGreaterThan(count);
    expect(tx).toContain("is_super_admin = true AND status <> 'disabled'");
    // NO KEY, not the stronger FOR UPDATE: no path updates principal.id, so a
    // child row's FK KEY SHARE (a session, an audit row) never waits on it.
    expect(tx).toMatch(/WHERE id = \$1 FOR NO KEY UPDATE`/);
    expect(tx).not.toMatch(/FOR UPDATE`/);
    // Every statement of the act goes through the transaction's client, none through the pool.
    expect(tx).not.toMatch(/\bawait query\(/);
    expect(tx.match(/tx\.query/g)?.length).toBeGreaterThanOrEqual(4);
    // Nothing of the old two-pool-queries shape survives outside it.
    expect(update.slice(0, txStart)).not.toContain('COUNT(*)');
    expect(update.slice(0, txStart)).not.toContain('UPDATE principal');
  });

  it('re-checks the ring on the LOCKED row inside the transaction — after the lock, before the count and the UPDATE', () => {
    const txStart = update.indexOf('withTransaction(');
    const tx = update.slice(txStart);
    const lockedRead = tx.indexOf('FOR NO KEY UPDATE`');
    const lockedCheck = tx.indexOf('assertMayEditSuperAdmin(');
    expect(lockedRead).toBeGreaterThan(-1);
    expect(lockedCheck).toBeGreaterThan(lockedRead);
    expect(lockedCheck).toBeLessThan(tx.indexOf('pg_advisory_xact_lock'));
    expect(lockedCheck).toBeLessThan(tx.indexOf('UPDATE principal'));
    // On the locked value, never on the pool read `current`: the row the check
    // receives is the one the FOR NO KEY UPDATE read assigned, whatever its name.
    const locked = lockedReadVar(tx);
    expect(tx).toMatch(new RegExp(`assertMayEditSuperAdmin\\(${locked}\\.rows\\[0\\], actorIsSuperAdmin\\)`));
    expect(tx).not.toMatch(/assertMayEditSuperAdmin\(current\b/);
  });

  it('logs before / after from the locked read and the RETURNING row — never from the pool read', () => {
    const txStart = update.indexOf('withTransaction(');
    const tx = update.slice(txStart);
    // The locked read selects every column the snapshot keeps …
    expect(tx).toMatch(
      /SELECT display_name AS name, email, role, status, is_super_admin\s+FROM principal WHERE id = \$1 FOR NO KEY UPDATE`/,
    );
    // … the UPDATE returns the same columns …
    expect(tx).toMatch(
      /UPDATE principal[\s\S]*?WHERE id = \$1\s+RETURNING display_name AS name, email, role, status, is_super_admin`/,
    );
    // … and the two snapshots are built from what the transaction returned.
    const result = update.match(/const (\w+) = await withTransaction\(/);
    expect(result, 'the transaction returns the rows it locked and wrote').not.toBeNull();
    expect(update).toMatch(new RegExp(`const before = snapshot\\(${result![1]}\\.before\\)`));
    expect(update).toMatch(new RegExp(`const after = snapshot\\(${result![1]}\\.after\\)`));
    expect(update).not.toMatch(/snapshot\(current\)/);
  });
});

describe('the ring covers the rest of the row (F1, second revision)', () => {
  const clients = fnBody('setUserClients');
  const overrideView = fnBody('setUserOverrideView');

  it('setUserClients checks the ring on the pool read and again on the row locked FOR NO KEY UPDATE, before the DELETE', () => {
    const txStart = clients.indexOf('withTransaction(');
    expect(txStart).toBeGreaterThan(-1);
    expect(clients.slice(0, txStart)).toMatch(/assertMayEditSuperAdmin\(current, actorIsSuperAdmin\)/);
    const tx = clients.slice(txStart);
    const locked = lockedReadVar(tx);
    const check = tx.search(new RegExp(`assertMayEditSuperAdmin\\(${locked}\\.rows\\[0\\], actorIsSuperAdmin\\)`));
    expect(check).toBeGreaterThan(tx.indexOf('FOR NO KEY UPDATE`'));
    expect(check).toBeLessThan(tx.indexOf('DELETE FROM principal_client'));
    expect(tx).not.toMatch(/FOR UPDATE`/);
    expect(tx).not.toMatch(/\bawait query\(/);
  });

  it('setUserOverrideView checks the ring on the read, and the UPDATE carries the same test and refuses when it wrote no row', () => {
    expect(overrideView).toMatch(/assertMayEditSuperAdmin\(current\.user, actorIsSuperAdmin\)/);
    expect(overrideView).toMatch(
      /UPDATE principal SET permission_overrides = \$2::jsonb\s+WHERE id = \$1 AND \(NOT is_super_admin OR \$3::boolean\)`/,
    );
    const write = overrideView.indexOf('UPDATE principal SET permission_overrides');
    const noRow = overrideView.indexOf('rowCount');
    expect(noRow).toBeGreaterThan(write);
    expect(overrideView.slice(noRow)).toContain('assertMayEditSuperAdmin(');
    expect(overrideView.slice(noRow)).toMatch(/ApiError\('CONFLICT'/);
  });

  it('PUT /admin/users/:id/clients hands the REAL flag to setUserClients; the Share dialog hands the acting flag, never wider than the real one', () => {
    const put = routeBlock("app.put('/admin/users/:id/clients'");
    expect(put).toMatch(REAL_FLAG);
    expect(put).not.toContain('actingAs');
    expect(callGetsRealFlag(put, 'setUserClients')).toBe(true);
    // Only a super admin can act as somebody else, so the acting identity's
    // flag is true only when the real user's is too — and `peoplePerms` lists
    // no super admin to share with in the first place.
    expect(DASHBOARDS).toMatch(
      /setUserOverrideView\(person\.id, key, want \? true : null, viewer\.id, viewer\.isSuperAdmin\)/,
    );
    expect(DASHBOARDS).toMatch(/NOT p\.is_super_admin/);
  });
});
