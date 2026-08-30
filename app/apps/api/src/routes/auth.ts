// Routes: sign-in, sign-out, session identity, impersonation.
//
//   GET  /auth/login          → 302 to Microsoft (or the dev picker)
//   GET  /auth/callback       ← Microsoft returns here with ?code & ?state
//   POST /auth/dev-login      dev bypass only; refuses in every other mode
//   GET  /auth/me             who am I, who am I acting as, what can I do
//   POST /auth/logout
//   POST /auth/impersonate    super admin only — the "Viewing as" switcher
//   DELETE /auth/impersonate  drop back to yourself
//
// Everything here is registered BEFORE the auth guard, so these are the only
// routes reachable without a session (see plugins/authGuard.ts).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { ApiError, parse } from '../errors.js';
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  createPkce,
  EntraError,
  exchangeCode,
  randomToken,
  verifyIdToken,
} from '../auth/entra.js';
import {
  SESSION_COOKIE,
  consumeAuthTransaction,
  createSession,
  destroySession,
  devBypassSignIn,
  resolveInvitedPrincipal,
  setImpersonation,
  storeAuthTransaction,
  unauthorized,
  type SessionPrincipal,
} from '../services/auth.js';
import { listSignInCandidates } from '../services/users.js';
import { recordAuthEvent } from '../services/activity.js';

/** Only ever redirect somewhere inside our own app — never to a supplied URL. */
function safeRedirect(raw: string | undefined): string {
  // Same default as the web sign-in page: the dashboard. A bare "/" means no
  // particular page was asked for, so it lands there too.
  if (!raw || raw === '/' || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard';
  return raw;
}

function setSessionCookie(reply: FastifyReply, id: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true, // unreadable from JS — an XSS bug cannot lift the session
    sameSite: 'lax', // survives the top-level redirect back from Microsoft
    secure: config.cookieSecure,
    expires: expiresAt,
  });
}

function publicPrincipal(p: SessionPrincipal) {
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    role: p.role,
    is_super_admin: p.isSuperAdmin,
    status: p.status,
    // The resolved capability set (0005/0007), so the web can gate UI on the
    // same booleans the server enforces instead of guessing from the role code.
    can: {
      edit_quote: p.can.quoteEdit,
      approve_quote: p.can.quoteApprove,
      manage_users: p.can.manageUsers,
      edit_wo_fields: p.can.editWoFields,
      view_field_history: p.can.viewFieldHistory,
    },
  };
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── Where the sign-in button goes ─────────────────────────────────────────
  app.get('/auth/login', async (req, reply) => {
    const redirectTo = safeRedirect((req.query as { redirect_to?: string }).redirect_to);

    if (config.authMode === 'bypass') {
      // No Microsoft to bounce off — the web app renders a user picker instead.
      return reply.redirect(`${config.webOrigin}/sign-in?dev=1`);
    }

    const { verifier, challenge } = createPkce();
    const state = randomToken();
    const nonce = randomToken();
    await storeAuthTransaction({ state, codeVerifier: verifier, nonce, redirectTo });

    return reply.redirect(buildAuthorizeUrl({ state, challenge, nonce }));
  });

  // ── Microsoft comes back here ─────────────────────────────────────────────
  // Failures redirect to /sign-in?error=… rather than rendering JSON: this URL
  // is loaded in a top-level browser tab, and a raw error object is a dead end
  // for whoever just tried to sign in.
  app.get('/auth/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error_description?: string };

    const fail = (message: string, detail?: string) => {
      req.log.warn({ message, detail }, 'sign-in failed');
      const url = new URL('/sign-in', config.webOrigin);
      url.searchParams.set('error', message);
      if (detail) url.searchParams.set('detail', detail);
      return reply.redirect(url.toString());
    };

    if (q.error_description) return fail('Microsoft rejected the sign-in', q.error_description);
    if (!q.code || !q.state) return fail('That sign-in link was incomplete');

    const tx = await consumeAuthTransaction(q.state);
    if (!tx) return fail('That sign-in link has expired', 'Start again from the sign-in page.');

    try {
      const idToken = await exchangeCode(q.code, tx.codeVerifier);
      const identity = await verifyIdToken(idToken, tx.nonce);
      const principal = await resolveInvitedPrincipal(identity);

      const { id, expiresAt } = await createSession(principal.id, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
      setSessionCookie(reply, id, expiresAt);
      await recordAuthEvent(principal.id, 'signed_in', { method: 'entra' });

      return reply.redirect(`${config.webOrigin}${safeRedirect(tx.redirectTo ?? undefined)}`);
    } catch (err) {
      if (err instanceof EntraError) return fail(err.message, err.detail);
      if (err instanceof ApiError) {
        // The invite-only refusal lands here. Say plainly what happened —
        // "not invited" is actionable; "authentication failed" is not.
        return fail(err.message, 'Ask a super admin to invite this address.');
      }
      req.log.error(err);
      return fail('Could not complete the sign-in');
    }
  });

  // ── Dev bypass ────────────────────────────────────────────────────────────
  app.get('/auth/dev-candidates', async () => {
    if (config.authMode !== 'bypass') throw new ApiError('NOT_FOUND', 'Route not found');
    return { items: await listSignInCandidates() };
  });

  app.post('/auth/dev-login', async (req, reply) => {
    if (config.authMode !== 'bypass') throw new ApiError('NOT_FOUND', 'Route not found');
    const { principal_id } = parse(z.object({ principal_id: z.string().uuid() }), req.body);

    const principal = await devBypassSignIn(principal_id);
    const { id, expiresAt } = await createSession(principal.id, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setSessionCookie(reply, id, expiresAt);
    await recordAuthEvent(principal.id, 'signed_in', { method: 'dev_bypass' });

    return { user: publicPrincipal(principal) };
  });

  // ── Identity ──────────────────────────────────────────────────────────────
  // The one authenticated-ish route the guard lets through unguarded: the web
  // app calls it on boot to decide between the app and the sign-in screen, so
  // "not signed in" has to be an answer rather than an error.
  app.get('/auth/me', async (req: FastifyRequest) => {
    if (!req.auth) {
      return { authenticated: false, auth_mode: config.authMode, user: null, acting_as: null };
    }
    return {
      authenticated: true,
      auth_mode: config.authMode,
      user: publicPrincipal(req.auth.user),
      acting_as: publicPrincipal(req.auth.actingAs),
      is_impersonating: req.auth.isImpersonating,
    };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth) {
      await recordAuthEvent(req.auth.user.id, 'signed_out', null);
      await destroySession(req.auth.sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });

    // Also end the Microsoft session, otherwise "sign out" then "sign in"
    // silently returns the same account and looks broken.
    const post = `${config.webOrigin}/sign-in`;
    return {
      ok: true,
      microsoft_logout_url: config.authMode === 'entra' ? buildLogoutUrl(post) : null,
    };
  });

  // ── Impersonation — the "Viewing as" switcher, now gated ──────────────────
  app.post('/auth/impersonate', async (req) => {
    if (!req.auth) throw unauthorized();
    if (!req.auth.user.isSuperAdmin) {
      throw new ApiError('FORBIDDEN', 'Only super admins can view as another user');
    }
    const { principal_id } = parse(z.object({ principal_id: z.string().uuid() }), req.body);
    if (principal_id === req.auth.user.id) {
      await setImpersonation(req.auth.sessionId, null);
      return { ok: true, impersonating: null };
    }

    await setImpersonation(req.auth.sessionId, principal_id);
    // Logged as its own event: an audit trail that cannot show when somebody
    // started acting as somebody else is not an audit trail.
    await recordAuthEvent(req.auth.user.id, 'impersonation_started', {
      target_principal_id: principal_id,
    });
    return { ok: true, impersonating: principal_id };
  });

  app.delete('/auth/impersonate', async (req) => {
    if (!req.auth) throw unauthorized();
    if (req.auth.isImpersonating) {
      await setImpersonation(req.auth.sessionId, null);
      await recordAuthEvent(req.auth.user.id, 'impersonation_ended', null);
    }
    return { ok: true, impersonating: null };
  });
}
