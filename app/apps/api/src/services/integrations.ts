// 0074 · Admin › Integrations — every connector, each with one switch.
//
// Two halves. The SWITCH, read on the hot path: `integrationOn(key)` is
// synchronous (storageReady and quoApiReady are called inside request
// handlers that never awaited anything for it) and answers from a small
// in-memory copy of `integration_setting`, refreshed in the background every
// 20 s and straight after a change on this instance. A key with no row, or
// a database that has not run 0074 yet, counts as ON — the app behaves as it
// did before the switch existed. On Vercel each warm instance refreshes on
// its own, so a flip reaches every instance within the refresh window; the
// page itself always reads the table.
//
// And the PAGE: `listIntegrations` pairs the switch with `configured` — are
// the credentials / connection there at all — because "on but nothing set
// on the server" and "set up but switched off" are different states an
// administrator needs to tell apart. Nothing here imports the connectors
// (they import this file), so configuration is read from config / env / the
// settings tables directly.

import {
  INTEGRATIONS,
  INTEGRATIONS_PERM_KEY,
  INTEGRATION_BY_KEY,
  INTEGRATION_KEYS,
  INTEGRATION_OFF,
  type IntegrationKey,
  type IntegrationStatus,
  type IntegrationsResponse,
} from '@theone/shared';
import { config } from '../config.js';
import { query } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { graphConfigured } from '../lib/graphDrive.js';
import { logAdminEvent } from './adminAudit.js';
import { allowFor, requirePerm, type PermissionBearer } from './permissions.js';

// ── The switch ───────────────────────────────────────────────────────────────

const REFRESH_MS = 20_000;
const flags = new Map<string, boolean>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** Re-read the table. Never throws: before 0074 (or with the database away)
    the copy is simply left as it was — everything on. */
export async function refreshIntegrations(): Promise<void> {
  try {
    const res = await query<{ key: string; enabled: boolean }>(`SELECT key, enabled FROM integration_setting`);
    flags.clear();
    for (const r of res.rows) flags.set(r.key, r.enabled);
    loadedAt = Date.now();
  } catch (e) {
    loadedAt = Date.now(); // do not hammer a database that cannot answer
    console.warn('[integrations] could not read integration_setting:', (e as Error).message);
  }
}

function kick(): void {
  if (Date.now() - loadedAt <= REFRESH_MS || loading) return;
  loading = refreshIntegrations().finally(() => {
    loading = null;
  });
}

/** Is the connector switched on? Synchronous; refreshes in the background. */
export function integrationOn(key: IntegrationKey): boolean {
  kick();
  return flags.get(key) ?? true;
}

/** The refusal every gated path raises: a 409 the UI can show as-is. */
export function requireIntegration(key: IntegrationKey): void {
  if (integrationOn(key)) return;
  const name = INTEGRATION_BY_KEY[key]?.name ?? key;
  throw new ApiError('CONFLICT', `${name} is switched off in Admin › Integrations`, { code: INTEGRATION_OFF, integration: key });
}

// ── Configured? ──────────────────────────────────────────────────────────────

interface Configured {
  configured: boolean;
  note: string;
}

function blobToken(): boolean {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  return Boolean(t && t.trim() !== '');
}

async function ecotrakConfigured(): Promise<Configured> {
  try {
    const r = await query<{ name: string; shadow_mode: boolean; last_synced_at: string | null }>(
      `SELECT name, shadow_mode, last_synced_at FROM cmms_connection WHERE provider = 'ecotrak' AND active = true ORDER BY created_at LIMIT 1`,
    );
    const c = r.rows[0];
    if (!c) return { configured: false, note: 'No active Ecotrak connection on file.' };
    const synced = c.last_synced_at ? `last sync ${new Date(c.last_synced_at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'never synced';
    return { configured: true, note: `${c.name}${c.shadow_mode ? ' · shadow mode (inbound only)' : ''} · ${synced}.` };
  } catch {
    return { configured: false, note: 'No Ecotrak connection table yet.' };
  }
}

async function sharepointConfigured(): Promise<Configured> {
  const creds = graphConfigured();
  let site: string | null = null;
  try {
    const r = await query<{ value: { site_url?: string | null } | null }>(`SELECT value FROM sharepoint_setting WHERE key = 'config'`);
    site = r.rows[0]?.value?.site_url ?? null;
  } catch {
    /* table not there yet */
  }
  if (creds && site) return { configured: true, note: `Credentials set · ${site}` };
  const missing = [!creds && 'credentials (SHAREPOINT_TENANT_ID / CLIENT_ID / CLIENT_SECRET)', !site && 'the site URL (Admin › Settings › SharePoint)'].filter(Boolean);
  return { configured: false, note: `Missing ${missing.join(' and ')}.` };
}

async function configuredOf(key: IntegrationKey): Promise<Configured> {
  switch (key) {
    case 'quo': {
      const send = Boolean(config.quoApiKey && config.quoFromNumber);
      const hook = config.quoWebhookSecret !== null;
      if (send && hook) return { configured: true, note: `Sending from ${config.quoFromNumber} · webhook secret set.` };
      const missing = [!send && 'QUO_API_KEY / QUO_FROM_NUMBER (sending)', !hook && 'QUO_WEBHOOK_SECRET (events coming back)'].filter(Boolean);
      return { configured: send || hook, note: `Missing ${missing.join(' and ')}.` };
    }
    case 'ecotrak':
      return ecotrakConfigured();
    case 'servicechannel':
    case 'corrigo':
      return { configured: false, note: 'No connector built yet. Client messages for these sites wait in the outbox.' };
    case 'sharepoint':
      return sharepointConfigured();
    case 'claude':
      return config.anthropicApiKey
        ? { configured: true, note: `Key set · assistant on ${config.assistant.model}, quote drafts on ${config.quoteAiModel}.` }
        : { configured: false, note: 'ANTHROPIC_API_KEY is not set on the server.' };
    case 'email':
      return config.mail.provider
        ? { configured: true, note: `${config.mail.provider === 'graph' ? 'Microsoft 365' : 'Resend'} · from ${config.mail.from}.` }
        : { configured: false, note: 'No mail provider set (MAIL_PROVIDER with its credentials).' };
    case 'email_escalations':
      return config.escalationWebhookSecret
        ? { configured: true, note: 'Webhook secret set · POST /api/webhooks/email-escalation.' }
        : { configured: false, note: 'ESCALATION_WEBHOOK_SECRET is not set, so the webhook answers 403.' };
    case 'blob':
      return blobToken()
        ? { configured: true, note: 'Blob store connected (BLOB_READ_WRITE_TOKEN).' }
        : { configured: false, note: 'No Blob store connected to this environment.' };
    case 'entra':
      return config.entra
        ? { configured: true, note: 'Tenant and app registration set · sign-in through Microsoft.' }
        : { configured: false, note: 'No tenant configured: this environment runs the development sign-in bypass.' };
  }
}

// ── The page ─────────────────────────────────────────────────────────────────

interface SettingRow {
  key: string;
  enabled: boolean;
  updated_at: Date | string | null;
  by_id: string | null;
  by_name: string | null;
}

async function rows(): Promise<Map<string, SettingRow>> {
  try {
    const res = await query<SettingRow>(
      `SELECT s.key, s.enabled, s.updated_at, p.id::text AS by_id, p.display_name AS by_name
         FROM integration_setting s LEFT JOIN principal p ON p.id = s.updated_by`,
    );
    return new Map(res.rows.map((r) => [r.key, r]));
  } catch {
    return new Map();
  }
}

type Admin = PermissionBearer & { id: string };

export async function listIntegrations(user: Admin): Promise<IntegrationsResponse> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'view', 'Admin › Integrations is not available to you');
  const [byKey, configured] = await Promise.all([
    rows(),
    Promise.all(INTEGRATIONS.map(async (d) => [d.key, await configuredOf(d.key)] as const)),
  ]);
  const conf = new Map(configured);
  const items: IntegrationStatus[] = INTEGRATIONS.map((d) => {
    const r = byKey.get(d.key);
    const c = conf.get(d.key) ?? { configured: false, note: '' };
    return {
      ...d,
      enabled: r?.enabled ?? true,
      configured: c.configured,
      configured_note: c.note,
      changed_by: r?.by_id && r.by_name ? { id: r.by_id, name: r.by_name } : null,
      changed_at: r?.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
  });
  return { items, can: { edit: allowFor(user)(INTEGRATIONS_PERM_KEY, 'edit') } };
}

export async function setIntegration(key: string, enabled: boolean, user: Admin): Promise<IntegrationsResponse> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'edit', 'You cannot change Admin › Integrations');
  if (!(INTEGRATION_KEYS as readonly string[]).includes(key)) throw notFound('That integration does not exist');
  const def = INTEGRATION_BY_KEY[key as IntegrationKey];
  if (def.locked && !enabled) {
    throw new ApiError('CONFLICT', `${def.name} cannot be switched off from inside the app`, { code: 'INTEGRATION_LOCKED' });
  }
  const before = (await rows()).get(key)?.enabled ?? true;
  await query(
    `INSERT INTO integration_setting (key, enabled, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, enabled, user.id],
  );
  flags.set(key, enabled);
  loadedAt = Date.now();
  if (before !== enabled) {
    await logAdminEvent({
      actorId: user.id,
      entity: 'integration',
      entityId: key,
      action: enabled ? 'integration_turned_on' : 'integration_turned_off',
      before: { name: def.name, enabled: before },
      after: { name: def.name, enabled },
    });
  }
  return listIntegrations(user);
}
