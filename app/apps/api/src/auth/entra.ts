// Microsoft Entra ID — OAuth 2.0 Authorization Code flow with PKCE.
//
// Deliberately hand-rolled against the protocol rather than pulled in through
// MSAL: the server half of this flow is three HTTP calls and one signature
// check, and `jose` does the only part that is genuinely easy to get wrong.
//
// The security properties that matter, and where each is enforced:
//   PKCE      — code_verifier stored server-side in auth_transaction, never
//               leaves this process; a stolen ?code= is useless without it.
//   state     — CSRF. Single-use row, deleted by the callback that consumes it.
//   nonce     — replay. Embedded in the ID token, compared after verification.
//   signature — verified against Microsoft's published JWKS, with issuer and
//               audience pinned. An unverified ID token is just a JSON blob.

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

function entra() {
  if (!config.entra) {
    throw new Error('Entra is not configured (auth mode is ' + config.authMode + ')');
  }
  return config.entra;
}

const authority = () => `https://login.microsoftonline.com/${entra().tenantId}/v2.0`;

/** Cached across requests — jose refetches and rotates keys on its own. */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function keyStore() {
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${entra().tenantId}/discovery/v2.0/keys`),
    );
  }
  return jwks;
}

/** URL-safe base64 with the padding stripped, per RFC 7636. */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkce(): PkcePair {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

/**
 * Where to send the browser to sign in.
 *
 * `prompt=select_account` rather than the default: on a shared machine the
 * default silently reuses whichever Microsoft account the browser saw last,
 * which is exactly the wrong behaviour for an app where identity decides what
 * you are allowed to approve.
 */
export function buildAuthorizeUrl(opts: {
  state: string;
  challenge: string;
  nonce: string;
  loginHint?: string;
}): string {
  const cfg = entra();
  const url = new URL(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', 'openid profile email offline_access');
  url.searchParams.set('state', opts.state);
  url.searchParams.set('nonce', opts.nonce);
  url.searchParams.set('code_challenge', opts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  if (opts.loginHint) url.searchParams.set('login_hint', opts.loginHint);
  return url.toString();
}

export class EntraError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'EntraError';
  }
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
}

/** Exchange the one-time ?code= for tokens. Returns the raw ID token. */
export async function exchangeCode(code: string, verifier: string): Promise<string> {
  const cfg = entra();
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
    scope: 'openid profile email offline_access',
  });

  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = (await res.json().catch(() => ({}))) as TokenResponse;

  if (!res.ok || json.error) {
    // error_description carries Entra's AADSTS code, which is the difference
    // between "debug this for an hour" and "the redirect URI has a typo".
    throw new EntraError(
      'Microsoft rejected the sign-in',
      json.error_description ?? json.error ?? `HTTP ${res.status}`,
    );
  }
  if (!json.id_token) {
    throw new EntraError('Microsoft returned no ID token');
  }
  return json.id_token;
}

export interface EntraIdentity {
  /** `oid` — immutable per user per tenant. The only safe long-term key. */
  oid: string;
  /** Verified, lowercased. Matched against principal.email to find the invite. */
  email: string;
  name: string | null;
  tenantId: string;
}

interface EntraClaims extends JWTPayload {
  oid?: string;
  tid?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  upn?: string;
}

/**
 * Verify the ID token's signature, issuer, audience and nonce, then pull out
 * the identity. Everything here throws rather than returning null — a token
 * that fails any check is not a "maybe", it is a rejected sign-in.
 */
export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<EntraIdentity> {
  const cfg = entra();

  const { payload } = await jwtVerify(idToken, keyStore(), {
    issuer: authority(),
    audience: cfg.clientId,
  }).catch((err: unknown) => {
    throw new EntraError('Could not verify the Microsoft token', (err as Error).message);
  });

  const claims = payload as EntraClaims;

  if (claims.nonce !== expectedNonce) {
    throw new EntraError('Sign-in token did not match this request');
  }

  // Single-tenant: a token from another directory is signed correctly and still
  // must not be accepted.
  if (claims.tid !== cfg.tenantId) {
    throw new EntraError('That account belongs to a different Microsoft directory');
  }

  if (!claims.oid) {
    throw new EntraError('Microsoft token carried no object id');
  }

  // Entra puts the address in different claims depending on account type and
  // which optional claims the app registration turns on.
  const rawEmail = claims.email ?? claims.preferred_username ?? claims.upn;
  if (!rawEmail || !rawEmail.includes('@')) {
    throw new EntraError(
      'Microsoft did not return an email address for that account',
      'Add the "email" optional claim to the app registration, or ensure the account has a mail address.',
    );
  }

  return {
    oid: claims.oid,
    email: rawEmail.trim().toLowerCase(),
    name: claims.name ?? null,
    tenantId: claims.tid,
  };
}

/** End the Microsoft session too, not just ours. */
export function buildLogoutUrl(postLogoutRedirect: string): string {
  const url = new URL(
    `https://login.microsoftonline.com/${entra().tenantId}/oauth2/v2.0/logout`,
  );
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
  return url.toString();
}
