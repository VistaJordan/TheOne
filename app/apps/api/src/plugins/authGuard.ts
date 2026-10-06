// The auth guard — one preHandler, applied to every route.
//
// This plugin is the fix for the hole S1–S4 shipped with: the acting principal
// used to come from an `X-Actor-Id` request header, which the browser sets
// freely, so every role gate in the app was enforced against a value the caller
// controlled. From here on the actor comes from a server-side session and
// NOTHING ELSE. The header is ignored.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadSession, SESSION_COOKIE, unauthorized, type AuthContext } from '../services/auth.js';

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

function isPublic(req: FastifyRequest): boolean {
  // Compare the PATH only — a query string must never widen the allowlist.
  const path = req.url.split('?')[0].replace(/\/+$/, '') || '/';
  return PUBLIC_PATHS.has(path) || PUBLIC_PATTERNS.some((re) => re.test(path));
}

export default fp(async function authGuard(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    // Always attempt the load, even on public paths: /auth/me needs to be able
    // to answer "yes, and here is who" without being guarded itself.
    const auth = await loadSession(cookie);
    if (auth) req.auth = auth;

    if (isPublic(req)) return;
    if (!auth) throw unauthorized();
  });
});
