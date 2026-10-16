// The auth guard — one preHandler, applied to every route.
//
// This plugin is the fix for the hole S1–S4 shipped with: the acting principal
// used to come from an `X-Actor-Id` request header, which the browser sets
// freely, so every role gate in the app was enforced against a value the caller
// controlled. From here on the actor comes from a server-side session and
// NOTHING ELSE. The header is ignored.
//
// Second rule, W4-2 (D1): a session that is "viewing as" somebody else is
// READ-ONLY. The acting principal while impersonating is the impersonated
// person, so a write made in that state would be logged under their name;
// until an on_behalf_of column records the real author, every non-GET under
// /api is refused with 403 IMPERSONATION_READ_ONLY — except the two acts that
// end or switch the view, and signing out (`IMPERSONATION_WRITE_ALLOWLIST`) —
// and so is the handful of GETs that write a row under the acting principal
// (the CSV exports, Save as PDF, the technician map: `IMPERSONATION_GET_DENYLIST`).

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { loadSession, SESSION_COOKIE, unauthorized, type AuthContext } from '../services/auth.js';
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

// W4-2 (D1): viewing as someone is READ-ONLY. A write made while impersonating
// would be logged as the impersonated person (actorFromRequest returns actingAs),
// so until an on_behalf_of column exists the guard refuses every non-GET under
// /api except the two acts that end or switch the view and signing out.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const IMPERSONATION_WRITE_ALLOWLIST = new Set([
  'POST /api/auth/impersonate',
  'DELETE /api/auth/impersonate',
  'POST /api/auth/logout',
]);
export const IMPERSONATION_READ_ONLY_MESSAGE =
  'Viewing as another user is read-only. Stop viewing as them to make changes.';
// The method rule alone would leave five GETs that write a row under the acting
// principal — a CSV download is a logged button (rule 1.2.1), Save as PDF logs
// `work_order_pdf_saved`, the technician map counts its opens per person — so
// viewing as someone would still put their name on a row. Those paths are
// refused whatever the method (Fastify answers HEAD with the GET handler), and
// the query string is never read: `?opened=0` cannot let the map through. The
// match is on the ROUTE PATTERN Fastify resolved (`req.routeOptions.url`), with
// the percent-decoded path as the fallback, so an encoded spelling such as
// `/api/work-orders/%65xport` cannot slip past. A write to a path no route
// serves answers 403 here rather than 404 while viewing as (this hook runs
// before the not-found handler) — harmless, and noted so nobody chases it.
// NOT here on purpose: Admin › Audit's export — routes/admin.ts logs it under
// the REAL user (`requireAdmin`), as every admin route reads the real user.
export const IMPERSONATION_GET_DENYLIST: RegExp[] = [
  /^\/api\/work-orders\/export$/, // work_orders_exported (routes/workOrders.ts)
  /^\/api\/vendors\/export$/, // vendors_exported (services/vendorWork.ts exportCsv)
  /^\/api\/work-orders\/[^/]+\/pdf$/, // work_order_pdf_saved (services/woPdf.ts)
  /^\/api\/work-orders\/[^/]+\/tech-map$/, // vendor_map_log.principal_id (services/vendorMap.ts)
  /^\/api\/client-updates\/[^/]+\/csv$/, // client_update_exported (services/clientUpdates.ts clientCsv)
];
/** The same five as Fastify registers them (the routes file's `app.get` string
    with the '/api' prefix) — matched on `req.routeOptions.url`, which no URL
    encoding can alter. Keep in step with IMPERSONATION_GET_DENYLIST. */
export const IMPERSONATION_GET_DENYLIST_ROUTES: ReadonlySet<string> = new Set([
  '/api/work-orders/export', // routes/workOrders.ts
  '/api/vendors/export', // routes/vendorWork.ts
  '/api/work-orders/:id/pdf', // routes/woPdf.ts
  '/api/work-orders/:id/tech-map', // routes/vendors.ts
  '/api/client-updates/:id/csv', // routes/clientUpdates.ts
]);
/** The denylist regexes run over the decoded path: `%65xport` is `export`. A
    path that does not decode is matched as it came. Only the denylist uses
    it — PUBLIC_PATHS and the allowlist keep the raw path. */
function decodedPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
/** Pure: is this request refused for an impersonating session? `path` is the
    query-stripped path (`pathOf`) — a query string is never part of the key;
    `routeUrl` is the matched route's pattern (undefined when no route matched). */
export function impersonationWriteBlocked(method: string, path: string, routeUrl?: string): boolean {
  if (routeUrl && IMPERSONATION_GET_DENYLIST_ROUTES.has(routeUrl)) return true;
  if (IMPERSONATION_GET_DENYLIST.some((re) => re.test(decodedPath(path)))) return true;
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return false;
  return !IMPERSONATION_WRITE_ALLOWLIST.has(`${m} ${path}`);
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
  app.addHook('preHandler', async (req) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    // Always attempt the load, even on public paths: /auth/me needs to be able
    // to answer "yes, and here is who" without being guarded itself.
    const auth = await loadSession(cookie);
    if (auth) req.auth = auth;

    const path = pathOf(req);
    // Public paths return here, so /api/auth/logout passes the read-only rule
    // below naturally.
    if (isPublic(path)) return;
    if (!auth) throw unauthorized();
    if (auth.isImpersonating && impersonationWriteBlocked(req.method, path, req.routeOptions?.url)) {
      throw new ApiError('FORBIDDEN', IMPERSONATION_READ_ONLY_MESSAGE, { code: 'IMPERSONATION_READ_ONLY' });
    }
    if (auth.user.isTestAccount && testAccountAdminWriteBlocked(req.method, path)) {
      throw testAccountAdminRefusal();
    }
  });
});
