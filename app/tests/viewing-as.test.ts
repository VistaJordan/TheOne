/* Viewing as can make changes, and the audit log says who really made them
 * (Jordan, 2026-10-20 — migration 0088, replacing W4-2's read-only rule).
 *
 * While a super admin views the app as somebody else, the API acts as that
 * person: their rights, their scope, their name on the records they create.
 * The audit trail must still name the human at the keyboard, and some sixty
 * statements write activity_log, so the fix lives below them:
 *   · plugins/authGuard.ts wraps every route handler in `runWithAuditContext`
 *     while the session is viewing as someone;
 *   · packages/db/src/client.ts sets two transaction-local settings in every
 *     transaction opened in that context, and runs a pool statement that
 *     names activity_log inside its own transaction so it gets them too;
 *   · migration 0088's BEFORE INSERT trigger re-signs a row signed by the
 *     viewed person to the real one and sets `viewing_as_id`.
 * The histories print "Name (viewing as Other)" through lib/actorName.ts,
 * and Admin › Audit carries `viewing_as` (and a CSV column).
 *
 * Also pinned here: "Keep me signed in" (0088) and, at the foot, the F7 pins
 * that shared the old file. Hermetic: no database, no network, no .env.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../apps/web/src/api/client';
import { importRefusalRows } from '../apps/web/src/components/wo/list/ImportDialog';
import { VIEWING_AS_HINT } from '../apps/web/src/lib/actor';
import { ACTOR_NAME_SQL, VIEWING_AS_NAME_SQL } from '../apps/api/src/lib/actorName';
import {
  ACTIVITY_LOG_RE,
  AUDIT_SETTING_REAL_ACTOR,
  AUDIT_SETTING_VIEWING_AS,
  currentAuditContext,
  runWithAuditContext,
} from '../packages/db/src/client';
import { REMEMBER_RENEW_AFTER_MS, rememberDue, sessionLifetimeMs } from '../apps/api/src/services/auth';
import { config } from '../apps/api/src/config';

/** Source text with CRLF folded to LF. The repo runs core.autocrlf=true with
    no .gitattributes, so the same file is CRLF on one checkout and LF on
    another (`git ls-files --eol`: i/lf, w/crlf) — a `\n`-anchored assertion
    below must not depend on which one this is. `rawSrc` is the bytes as they
    are on disk, for the line-ending proof at the foot of this file. */
const foldCrlf = (s: string) => s.replace(/\r\n/g, '\n');
const rawSrc = (...parts: string[]) => readFileSync(resolve(__dirname, '..', ...parts), 'utf8');
const readSrc = (...parts: string[]) => foldCrlf(rawSrc(...parts));
const apiSrc = (...parts: string[]) => readSrc('apps', 'api', 'src', ...parts);
const webSrc = (...parts: string[]) => readSrc('apps', 'web', 'src', ...parts);
const MIGRATION = readSrc('packages', 'db', 'migrations', '0088_viewing_as_remember_me.sql');

describe('viewing as is no longer read-only', () => {
  const guard = apiSrc('plugins', 'authGuard.ts');

  it('the guard refuses nothing for viewing as: the read-only rule and its lists are gone', () => {
    expect(guard).not.toMatch(/IMPERSONATION_READ_ONLY/);
    expect(guard).not.toMatch(/impersonationWriteBlocked|IMPERSONATION_WRITE_ALLOWLIST|IMPERSONATION_GET_DENYLIST/);
  });

  it('wraps every route handler in the audit context while the session is viewing as someone', () => {
    expect(guard).toMatch(/import \{ runWithAuditContext \} from '\.\.\/db\.js';/);
    const at = guard.indexOf("app.addHook('onRoute'");
    expect(at).toBeGreaterThan(-1);
    // Registered before the preHandler, inside the guard — which app.ts
    // registers before every business route, so onRoute sees all of them.
    expect(at).toBeLessThan(guard.indexOf("app.addHook('preHandler'"));
    const hook = guard.slice(at, guard.indexOf("app.addHook('preHandler'"));
    expect(hook).toMatch(/if \(!auth\?\.isImpersonating\) return handler\.call/);
    expect(hook).toMatch(/runWithAuditContext\(\{ realActorId: auth\.user\.id, viewingAsId: auth\.actingAs\.id \}/);
    const app = apiSrc('app.ts');
    expect(app.indexOf('await app.register(authGuard)')).toBeLessThan(app.indexOf('await app.register(authRoutes'));
  });

  it('keeps the test-account refusal on user and role writes', () => {
    expect(guard).toMatch(/auth\.user\.isTestAccount && testAccountAdminWriteBlocked\(req\.method, path\)/);
  });
});

describe('the database half: settings in, trigger re-signs', () => {
  const client = readSrc('packages', 'db', 'src', 'client.ts');

  it('the context is request-scoped and absent outside it', async () => {
    expect(currentAuditContext()).toBeNull();
    const seen = await runWithAuditContext({ realActorId: 'r', viewingAsId: 'v' }, async () => {
      await Promise.resolve();
      return currentAuditContext();
    });
    expect(seen).toEqual({ realActorId: 'r', viewingAsId: 'v' });
    expect(currentAuditContext()).toBeNull();
  });

  it('every transaction sets both settings, transaction-local, right after BEGIN', () => {
    const tx = client.slice(client.indexOf('export async function withTransaction'));
    expect(tx).toMatch(/await client\.query\('BEGIN'\);\n\s+await applyAuditContext\(client\);/);
    expect(client).toMatch(/set_config\(\$1, \$2, true\), set_config\(\$3, \$4, true\)/);
  });

  it('a pool statement that names activity_log runs in its own transaction while in the context', () => {
    const q = client.slice(client.indexOf('export async function query'), client.indexOf('// ── Viewing as'));
    expect(q).toMatch(/if \(ctx && ACTIVITY_LOG_RE\.test\(sql\)\) \{\n\s+return withTransaction/);
    // Found by the end-to-end run: a quoting slip once put backspaces where
    // the \b were, and the regex matched nothing — so test what it matches.
    expect(ACTIVITY_LOG_RE.test('INSERT INTO activity_log (actor_principal_id) VALUES ($1)')).toBe(true);
    expect(ACTIVITY_LOG_RE.test('insert into ACTIVITY_LOG\n  (x)')).toBe(true);
    expect(ACTIVITY_LOG_RE.test('SELECT 1 FROM activity_logs')).toBe(false);
    expect(ACTIVITY_LOG_RE.test('SELECT * FROM task')).toBe(false);
    expect(client).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  });

  it('the setting names are the ones the trigger reads', () => {
    expect(AUDIT_SETTING_REAL_ACTOR).toBe('theone.real_actor_id');
    expect(AUDIT_SETTING_VIEWING_AS).toBe('theone.viewing_as_id');
    expect(MIGRATION).toContain(`current_setting('${AUDIT_SETTING_REAL_ACTOR}', true)`);
    expect(MIGRATION).toContain(`current_setting('${AUDIT_SETTING_VIEWING_AS}', true)`);
  });

  it('the trigger re-signs only rows the viewed person signed, and marks the real person\'s own', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS viewing_as_id uuid REFERENCES principal\(id\)/);
    expect(MIGRATION).toMatch(/BEFORE INSERT ON activity_log/);
    expect(MIGRATION).toMatch(
      /IF NEW\.actor_principal_id::text = view_id THEN\n\s+NEW\.actor_principal_id := real_id::uuid;\n\s+NEW\.viewing_as_id := view_id::uuid;/,
    );
    expect(MIGRATION).toMatch(/ELSIF NEW\.actor_principal_id::text = real_id AND NEW\.viewing_as_id IS NULL THEN/);
    // No setting (every request that is not viewing as, the worker, the seed) = untouched.
    expect(MIGRATION).toMatch(/IF real_id IS NULL OR view_id IS NULL OR real_id = view_id THEN\n\s+RETURN NEW;/);
  });
});

describe('the histories name both people', () => {
  it('one fragment prints "Name (viewing as Other)"', () => {
    expect(ACTOR_NAME_SQL).toContain("' (viewing as '");
    expect(ACTOR_NAME_SQL).toContain(VIEWING_AS_NAME_SQL);
    expect(VIEWING_AS_NAME_SQL).toContain('a.viewing_as_id');
  });

  it.each([
    'activity.ts',
    'feed.ts',
    'visits.ts',
    'woFieldValues.ts',
    'portfolio.ts',
    'portfolioExtras.ts',
    'vendors.ts',
  ])('services/%s reads the actor name through it', (f) => {
    const s = readFileSync(resolve(__dirname, '..', 'apps', 'api', 'src', 'services', f), 'latin1');
    expect(s).toContain("import { ACTOR_NAME_SQL } from '../lib/actorName.js';");
    expect(s).toContain('${ACTOR_NAME_SQL}');
  });

  it('Admin › Audit carries viewing_as on the row and as a CSV column', () => {
    const audit = apiSrc('services', 'auditLog.ts');
    expect(audit).toMatch(/a\.viewing_as_id, \$\{VIEWING_AS_NAME_SQL\} AS viewing_as_name/);
    expect(audit).toContain("'User', 'Viewing as', 'Action'");
    expect(webSrc('pages', 'admin', 'AdminAuditPage.tsx')).toContain('viewing as {e.viewing_as.display_name}');
  });
});

describe('the admin routes act as the viewed person (D6), never wider', () => {
  const admin = apiSrc('routes', 'admin.ts');
  const fn = (name: string) => admin.slice(admin.indexOf(`function ${name}(`), admin.indexOf('\n}', admin.indexOf(`function ${name}(`)));

  it('the ring flag and the writer are the acting person\'s', () => {
    expect(fn('isActingSuperAdmin')).toMatch(/return permissionSubject\(req\)\.isSuperAdmin;/);
    expect(fn('writer')).toMatch(/const u = permissionSubject\(req\);/);
    expect(admin).not.toMatch(/req\.auth\.user\.isSuperAdmin/);
  });

  it('Admin › Users no longer locks its switches for viewing as', () => {
    const page = webSrc('pages', 'admin', 'AdminUsersPage.tsx');
    expect(page).not.toMatch(/isImpersonating|viewingAs/);
    expect(page).toContain('const canGrantSuper = editorIsSuperAdmin;');
  });
});

describe('the web: plain download links and an honest chip', () => {
  it('the five downloads are ordinary links again', () => {
    expect(webSrc('lib', 'actor.ts')).not.toMatch(/downloadLinkProps|READ_ONLY_HINT/);
    for (const [file, href] of [
      [['pages', 'WorkOrdersPage.tsx'], 'href={workOrdersExportUrl(criteria)}'],
      [['pages', 'VendorsPage.tsx'], 'href={vendorExportUrl(filterParams)} download'],
      [['pages', 'ClientUpdatesPage.tsx'], 'href={clientUpdateCsvUrl(tracker.id)}'],
      [['components', 'wo', 'record', 'RecordParts.tsx'], 'href={workOrderPdfUrl(woNumber, k)} download'],
    ] as const) {
      const src = webSrc(...file);
      expect(src, file.join('/')).toContain(href);
      expect(src, file.join('/')).not.toContain('downloadLinkProps');
    }
  });

  it('the switcher says changes are logged as you', () => {
    const sw = webSrc('components', 'ActorSwitcher.tsx');
    expect(sw).toMatch(/import \{[^}]*\bVIEWING_AS_HINT\b[^}]*\} from '\.\.\/lib\/actor'/);
    expect(sw).toContain('Changes logged as you');
    expect(VIEWING_AS_HINT).toContain('logged under your name');
  });
});

describe('Keep me signed in (0088)', () => {
  it('a remembered session lasts REMEMBER_ME_DAYS, any other SESSION_TTL_HOURS', () => {
    expect(sessionLifetimeMs(true)).toBe(config.rememberMeDays * 86_400_000);
    expect(sessionLifetimeMs(false)).toBe(config.sessionTtlHours * 3_600_000);
    expect(config.rememberMeDays).toBeGreaterThan(0);
  });

  it('is pushed out once a day, never on a session that was not remembered', () => {
    const now = Date.UTC(2026, 9, 20, 12);
    const full = now + sessionLifetimeMs(true);
    expect(rememberDue(true, new Date(full), now)).toBe(false);
    expect(rememberDue(true, new Date(full - REMEMBER_RENEW_AFTER_MS + 1000), now)).toBe(false);
    expect(rememberDue(true, new Date(full - REMEMBER_RENEW_AFTER_MS - 1000), now)).toBe(true);
    expect(rememberDue(false, new Date(now + 1000), now)).toBe(false);
  });

  it('the columns exist, and the tick survives the Microsoft round trip', () => {
    expect(MIGRATION).toMatch(/ALTER TABLE session ADD COLUMN IF NOT EXISTS remember boolean NOT NULL DEFAULT false;/);
    expect(MIGRATION).toMatch(/ALTER TABLE auth_transaction ADD COLUMN IF NOT EXISTS remember boolean NOT NULL DEFAULT false;/);
    const routes = apiSrc('routes', 'auth.ts');
    expect(routes).toMatch(/storeAuthTransaction\(\{ state, codeVerifier: verifier, nonce, redirectTo, remember \}\)/);
    expect(routes).toMatch(/remember: tx\.remember,/);
    expect(routes.match(/setSessionCookie\(reply, id, expiresAt, remember\)/g)).toHaveLength(3);
  });

  it('only a remembered cookie carries an expiry; a renewed session re-sends it', () => {
    const auth = apiSrc('services', 'auth.ts');
    expect(auth).toMatch(/\.\.\.\(remember \? \{ expires: expiresAt \} : \{\}\),/);
    expect(apiSrc('plugins', 'authGuard.ts')).toMatch(
      /if \(auth\.renewedExpiresAt\) setSessionCookie\(reply, auth\.sessionId, auth\.renewedExpiresAt, true\);/,
    );
  });

  it('the sign-in page offers the box and sends it on all three ways in', () => {
    const page = webSrc('pages', 'SignInPage.tsx');
    expect(page).toContain('Keep me signed in');
    expect(page).toContain('startMicrosoftSignIn(landingFrom(params), remember)');
    expect(page).toContain('devSignIn(id, remember)');
    expect(page).toContain('testSignIn(username, password, remember)');
  });
});

describe('OM Under Probation and Ops Coordinator are one role (0088)', () => {
  it('moves everyone, retargets what decides, and removes the role', () => {
    expect(MIGRATION).toMatch(/UPDATE principal SET role = 'om_probation' WHERE role = 'ops_coord';/);
    expect(MIGRATION).toMatch(/UPDATE approval_task SET assigned_role = 'om_probation' WHERE assigned_role = 'ops_coord';/);
    expect(MIGRATION).toMatch(/array_replace\(roles, 'ops_coord', 'om_probation'\)/);
    expect(MIGRATION).toMatch(/DELETE FROM role WHERE code = 'ops_coord';/);
    // The principals move before the role row goes (principal.role is an FK).
    expect(MIGRATION.indexOf("UPDATE principal SET role = 'om_probation'")).toBeLessThan(
      MIGRATION.indexOf("DELETE FROM role WHERE code = 'ops_coord'"),
    );
  });

  it('no code outside the migrations names ops_coord any more', () => {
    for (const parts of [
      ['packages', 'shared', 'src', 'access.ts'],
      ['packages', 'shared', 'src', 'workflow.ts'],
      ['packages', 'shared', 'src', 'dashboards.ts'],
      ['apps', 'api', 'src', 'services', 'quotes.ts'],
    ]) {
      expect(readSrc(...parts), parts.join('/')).not.toContain("'ops_coord'");
    }
  });
});

describe('an import refusal names its rows (F7)', () => {
  const refusal = (code: string, wo_numbers: unknown) =>
    new ApiRequestError(403, { error: { code: 'FORBIDDEN', message: 'refused', details: { code, wo_numbers } } }, 'x');

  it('lists details.wo_numbers for IMPORT_SCOPE and IMPORT_STATUS_PERMISSION', () => {
    expect(importRefusalRows(refusal('IMPORT_SCOPE', ['WO-1', 'WO-2']))).toEqual(['WO-1', 'WO-2']);
    expect(importRefusalRows(refusal('IMPORT_STATUS_PERMISSION', ['WO-3', 'row 4']))).toEqual(['WO-3', 'row 4']);
  });

  it('names no rows for any other failure, and never throws on a payload it does not recognise', () => {
    expect(importRefusalRows(refusal('SOMETHING_ELSE', ['WO-1']))).toEqual([]);
    expect(importRefusalRows(refusal('IMPORT_SCOPE', 'WO-1'))).toEqual([]);
    expect(importRefusalRows(refusal('IMPORT_SCOPE', [1, null, 'WO-9']))).toEqual(['WO-9']);
    expect(importRefusalRows(new ApiRequestError(500, null, 'boom'))).toEqual([]);
    expect(importRefusalRows(new Error('network'))).toEqual([]);
    expect(importRefusalRows(undefined)).toEqual([]);
  });

  it('the dialog keeps them with the message and draws them under it', () => {
    const src = webSrc('components', 'wo', 'list', 'ImportDialog.tsx');
    expect(src).toMatch(/rows:\s*importRefusalRows\(e\)/);
    expect(src).toMatch(/error\.rows\.length > 0/);
  });
});

describe('the bell asks the Pulse only for a role with the Pulse grant (F7; work_orders/pulse since 2026-10-27)', () => {
  it('useNotifications takes `enabled` and hands it to the query', () => {
    const src = webSrc('hooks', 'useObligations.ts');
    const at = src.indexOf('export function useNotifications(');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf('\n}', at));
    expect(fn).toMatch(/useNotifications\(enabled = true\)/);
    expect(fn).toMatch(/\n\s+enabled,\r?\n/);
  });

  it("PulseBell gates it on can(PULSE_PERM_KEY, 'view') and leaves the notices half alone", () => {
    const src = webSrc('components', 'obligations', 'PulseBell.tsx');
    expect(src).toMatch(/const canPulse = can\(PULSE_PERM_KEY, 'view'\);/);
    expect(src).toMatch(/useNotifications\(canPulse\)/);
    // 0059's two queries, exactly as they were.
    expect(src).toContain('useQuery({ queryKey: NOTICE_COUNT_KEY, queryFn: getNoticeCount, refetchInterval: 60_000, retry: 0 })');
    expect(src).toContain('useQuery({ queryKey: NOTICES_KEY, queryFn: getNotices, enabled: open, retry: 0 })');
  });

  it('without the Pulse, "Nothing for you" waits for the notices to load — no empty state flashes while the list is on its way', () => {
    // The notices list is `enabled: open`, so on the first open forYou is []
    // until it lands; the dropdown shows the notices' own three states
    // (loading / unavailable / empty), as the Pulse half does for its rows.
    const src = webSrc('components', 'obligations', 'PulseBell.tsx');
    const at = src.indexOf('{!canPulse && (');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('{canPulse && (', at));
    expect(block).toMatch(/notices\.isLoading && <div className="pulse-pop-note">Loading…<\/div>/);
    expect(block).toMatch(/notices\.isError && !notices\.isLoading &&/);
    expect(block).toMatch(
      /!notices\.isLoading && !notices\.isError && forYou\.length === 0 && \(\s*<div className="pulse-pop-note">Nothing for you right now\.<\/div>/,
    );
    expect(src).not.toMatch(/!canPulse && forYou\.length === 0 &&/);
  });
});

describe('the source readers above are line-ending proof', () => {
  // An earlier version asserted that readSrc's OUTPUT carries no '\r' — true
  // by construction, since readSrc IS the fold, so it proved nothing. What the
  // name means is pinned on the bytes as they are on disk instead: every file
  // the \n-anchored assertions above read is uniformly ONE ending (every line
  // CRLF or every line LF — the house rule is "keep each file's own line
  // endings", and a mixed file is what a careless edit leaves behind) with no
  // lone '\r', the one ending the fold would not touch; and the fold itself on
  // a synthetic string, so the proof holds on either checkout, whichever the
  // raw files happen to be (`git ls-files --eol`'s w/ column says which).
  it('the fold turns CRLF into LF and touches nothing else', () => {
    expect(foldCrlf('a\r\nb\r\n')).toBe('a\nb\n');
    expect(foldCrlf('a\nb\n')).toBe('a\nb\n');
    expect(foldCrlf('a\rb')).toBe('a\rb'); // a lone CR is left alone — the raw check below refuses one
  });

  it('every file read above is uniformly one line ending on disk, with no lone CR', () => {
    const files: string[][] = [
      ['apps', 'api', 'src', 'plugins', 'authGuard.ts'],
      ['apps', 'web', 'src', 'lib', 'actor.ts'],
      ['apps', 'web', 'src', 'components', 'ActorSwitcher.tsx'],
      ['apps', 'web', 'src', 'pages', 'WorkOrdersPage.tsx'],
      ['apps', 'web', 'src', 'pages', 'ClientUpdatesPage.tsx'],
      ['apps', 'web', 'src', 'pages', 'VendorsPage.tsx'],
      ['apps', 'web', 'src', 'components', 'wo', 'record', 'RecordParts.tsx'],
      ['apps', 'web', 'src', 'components', 'wo', 'list', 'ImportDialog.tsx'],
      ['apps', 'web', 'src', 'components', 'obligations', 'PulseBell.tsx'],
      ['apps', 'web', 'src', 'hooks', 'useObligations.ts'],
      ['apps', 'web', 'src', 'styles', 'messages.css'],
      ['apps', 'web', 'src', 'styles', 'wo-list.css'],
    ];
    for (const parts of files) {
      const name = parts.join('/');
      const raw = rawSrc(...parts);
      const lf = (raw.match(/\n/g) ?? []).length;
      const crlf = (raw.match(/\r\n/g) ?? []).length;
      expect(lf, `${name}: no line ends at all`).toBeGreaterThan(0);
      expect(raw, `${name}: a lone \\r`).not.toMatch(/\r(?!\n)/);
      expect(crlf === 0 || crlf === lf, `${name}: ${crlf} CRLF among ${lf} line ends — mixed endings`).toBe(true);
      // …and the reader the assertions above use folds whatever the file has.
      expect(readSrc(...parts), name).not.toContain('\r');
    }
  });
});
