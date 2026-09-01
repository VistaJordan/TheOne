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
]);

function isPublic(req: FastifyRequest): boolean {
  // Compare the PATH only — a query string must never widen the allowlist.
  const path = req.url.split('?')[0].replace(/\/+$/, '') || '/';
  return PUBLIC_PATHS.has(path);
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
