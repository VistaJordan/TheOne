// The auth guard — one preHandler, applied to every route.
//
// This plugin is the fix for the hole S1–S4 shipped with: the acting principal
// used to come from an `X-Actor-Id` request header, which the browser sets
// freely, so every role gate in the app was enforced against a value the caller
// controlled. From here on the actor comes from a server-side session and
// NOTHING ELSE. The header is ignored.
//
// Viewing as (2026-10-20, replacing W4-2's read-only rule): a super admin
// viewing as somebody acts as them — their rights, their scope, their name on
// the records they create — and every audit row says who really acted. Each
// route handler runs inside `runWithAuditContext` while the session is viewing
// as someone; migration 0088's trigger re-signs the activity_log rows the
// viewed person would have signed to the real one, with `viewing_as_id` set.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { runWithAuditContext } from '../db.js';
import { loadSession, SESSION_COOKIE, setSessionCookie, unauthorized, type AuthContext } from '../services/auth.js';
import { testAccountAdminRefusal } from '../services/testAccounts.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present once the guard has run and a valid session was found. */
    auth?: AuthContext;
  }
}

/** Reachable with no session. Everything else 401s. */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/dev-login',
  '/api/auth/dev-candidates',
  // UAT T1: the test-account sign-in. 404 unless TEST_ACCOUNTS_ENABLED=true
  // and TEST_ACCOUNTS_PASSWORD is set; services/testAccounts.ts guards it.
  '/api/auth/test-login',
  // Rule 7.3.2: the email tool has no session; routes/webhooks.ts checks its
  // shared secret instead. Nothing else under /api/webhooks is public.
  '/api/webhooks/email-escalation',
  // 0051: the daily cron that raises planned-maintenance work orders; the
  // route checks CRON_SECRET instead.
  '/api/webhooks/planned-maintenance-run',
  // 0054: Quo's call / transcript / summary events; the route verifies Quo's
  // signature (QUO_WEBHOOK_SECRET) instead.
  '/api/webhooks/quo',
  // 0055: the hourly cron that sends scheduled client updates (CRON_SECRET).
  '/api/webhooks/client-updates-run',
  // 0078: the once-a-minute cron that pushes work-order changes to ClickUp
  // (CRON_SECRET).
  '/api/webhooks/clickup-sync',
  // 0079: the once-a-minute cron that reads Ecotrak while Ecotrak → The One
  // is on (CRON_SECRET; read only).
  '/api/webhooks/ecotrak-sync',
]);

// 0055: a client's read-only tracker link. Exactly a 32-character share token
// (and its CSV) — the token IS the credential, checked in services/clientUpdates.
// 0066: a vendor's portal link. Exactly a 32-character token, then one of the
// five things a vendor can do — the token IS the credential, checked (as a
// hash) in services/vendorPortal, which also pins every read to that vendor.
const PUBLIC_PATTERNS: RegExp[] = [
  /^\/api\/public\/client-updates\/[A-Za-z0-9_-]{32}(\/csv)?$/,
  // 0070: a technician's download of a blank sign-off sheet. Exactly a
  // 32-character token; it names one generated PDF (a WO number and an
  // address on a branded page) and nothing else — services/signoff.
  /^\/api\/public\/signoff\/[A-Za-z0-9_-]{32}$/,
  /^\/api\/public\/vendor-portal\/[A-Za-z0-9_-]{32}(\/onboarding|\/offers\/[0-9a-fA-F-]{36}|\/jobs\/[0-9a-fA-F-]{36}\/(eta|notes))?$/,
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The test-account path regexes run over the decoded path: `%75sers` is
    `users`. A path that does not decode is matched as it came. */
function decodedPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// UAT T1: a test account holds a real role, but changing who may do what is
// never part of a test — whatever its role grants, every write to users and
// roles is refused (the Share dialog's role grants and per-person ticks are
// refused in services/dashboards.ts applySharing, which this path list cannot
// see). Read through `req.auth.user`, the person signed in.
const TEST_ACCOUNT_ADMIN_WRITE_PATHS: RegExp[] = [
  /^\/api\/admin\/users(\/.*)?$/,
  /^\/api\/admin\/roles(\/.*)?$/,
  /^\/api\/admin\/portfolio\/site-access(\/.*)?$/,
];
/** Pure: is this request a user / role write a test account may not make? */
export function testAccountAdminWriteBlocked(method: string, path: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return false;
  const p = decodedPath(path);
  return TEST_ACCOUNT_ADMIN_WRITE_PATHS.some((re) => re.test(p));
}

/** The PATH only — a query string must never widen (or narrow) an allowlist. */
function pathOf(req: FastifyRequest): string {
  return req.url.split('?')[0].replace(/\/+$/, '') || '/';
}

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.has(path) || PUBLIC_PATTERNS.some((re) => re.test(path));
}

export default fp(async function authGuard(app: FastifyInstance) {
  // Viewing as: every handler registered after the guard (all of them — the
  // guard is registered first) runs in the audit context while the session is
  // viewing as someone, so whatever it writes to activity_log, however deep,
  // names the real person and whom they were viewing as.
  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = function viewingAsAware(this: unknown, req, reply) {
      const auth = req.auth;
      if (!auth?.isImpersonating) return handler.call(this as never, req, reply);
      return runWithAuditContext({ realActorId: auth.user.id, viewingAsId: auth.actingAs.id }, () =>
        handler.call(this as never, req, reply),
      );
    } as typeof handler;
  });

  app.addHook('preHandler', async (req, reply) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    // Always attempt the load, even on public paths: /auth/me needs to be able
    // to answer "yes, and here is who" without being guarded itself.
    const auth = await loadSession(cookie);
    if (auth) {
      req.auth = auth;
      // "Keep me signed in": a remembered session that loadSession pushed out
      // gets its cookie pushed out with it.
      if (auth.renewedExpiresAt) setSessionCookie(reply, auth.sessionId, auth.renewedExpiresAt, true);
    }

    const path = pathOf(req);
    if (isPublic(path)) return;
    if (!auth) throw unauthorized();
    if (auth.user.isTestAccount && testAccountAdminWriteBlocked(req.method, path)) {
      throw testAccountAdminRefusal();
    }
  });
});
