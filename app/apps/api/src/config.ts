// Runtime configuration — the ONE place that reads process.env.
//
// Two mutually exclusive modes, decided here at boot so no request handler ever
// has to ask "is auth real right now?":
//
//   entra   — Microsoft Entra ID sign-in. Requires tenant/client/secret.
//   bypass  — AUTH_DEV_BYPASS=true. Pick a seeded principal, no Microsoft.
//             Local development only, and this module REFUSES TO BOOT if it is
//             ever combined with NODE_ENV=production. The whole point of a
//             bypass is that it cannot survive the trip to a server.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node 24 built-in; loads app/.env into process.env if the file exists. Values
// already in the real environment win, so a deployed process is never
// overridden by a stray committed file.
const ENV_PATH = fileURLToPath(new URL('../../../.env', import.meta.url));
try {
  process.loadEnvFile(ENV_PATH);
} catch {
  /* no .env — expected in production, and in a fresh clone before setup */
}

function str(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function bool(key: string): boolean {
  return (str(key) ?? '').toLowerCase() === 'true';
}

const NODE_ENV = str('NODE_ENV') ?? 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Must match an Entra "Web" redirect URI exactly, including the path. */
  redirectUri: string;
}

export interface Config {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  host: string;
  /** Where the browser lives — used to bounce back after the Entra round trip. */
  webOrigin: string;
  authMode: 'entra' | 'bypass';
  entra: EntraConfig | null;
  sessionTtlHours: number;
  /** Cookies go Secure only over HTTPS; localhost is plain http in dev. */
  cookieSecure: boolean;
}

function buildEntra(): EntraConfig | null {
  const tenantId = str('ENTRA_TENANT_ID');
  const clientId = str('ENTRA_CLIENT_ID');
  const clientSecret = str('ENTRA_CLIENT_SECRET');
  if (!tenantId || !clientId || !clientSecret) return null;
  return {
    tenantId,
    clientId,
    clientSecret,
    redirectUri: str('ENTRA_REDIRECT_URI') ?? 'http://localhost:5173/api/auth/callback',
  };
}

function build(): Config {
  const devBypass = bool('AUTH_DEV_BYPASS');
  const entra = buildEntra();

  // ── The one refusal. A bypass in production is not a misconfiguration to
  //    warn about, it is an open front door. ────────────────────────────────
  if (devBypass && IS_PRODUCTION) {
    throw new Error(
      'AUTH_DEV_BYPASS=true with NODE_ENV=production. The dev bypass lets anyone ' +
        'sign in as any user without a password — it must never run on a server. ' +
        'Remove AUTH_DEV_BYPASS from the environment, or unset NODE_ENV=production.',
    );
  }

  if (!devBypass && !entra) {
    throw new Error(
      'No authentication configured. Either set ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ' +
        'ENTRA_CLIENT_SECRET for Microsoft sign-in, or set AUTH_DEV_BYPASS=true for ' +
        'local development. See app/.env.example.',
    );
  }

  // Entra config wins whenever it is complete: once the real credentials are in
  // place, leaving the bypass flag behind should not silently keep it on.
  const authMode: 'entra' | 'bypass' = entra ? 'entra' : 'bypass';

  const webOrigin = str('WEB_ORIGIN') ?? 'http://localhost:5173';

  return {
    nodeEnv: NODE_ENV,
    isProduction: IS_PRODUCTION,
    port: Number(str('API_PORT') ?? 5174),
    host: str('API_HOST') ?? '127.0.0.1',
    webOrigin,
    authMode,
    entra,
    sessionTtlHours: Number(str('SESSION_TTL_HOURS') ?? 12),
    cookieSecure: webOrigin.startsWith('https://'),
  };
}

export const config: Config = build();

/** Logged once at boot so the mode in force is never a guess. */
export function describeAuth(): string {
  if (config.authMode === 'entra') {
    return `auth: Microsoft Entra ID (tenant ${config.entra!.tenantId}), invite-only`;
  }
  return 'auth: DEV BYPASS — no password required, local development only';
}

/** Unused today; kept so a future secret-file mount has an obvious home. */
export function readSecretFile(path: string): string {
  return readFileSync(path, 'utf8').trim();
}
