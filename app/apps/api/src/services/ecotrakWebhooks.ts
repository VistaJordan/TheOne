// 0114 · Ecotrak webhooks: Ecotrak tells OBI the moment a work order
// changes or gets a comment, instead of OBI only finding out on its next
// look.
//
// SAFETY — read this before touching the file. Our clients see our work
// orders on Ecotrak; nothing here may change what they see.
//   * registerEcotrakWebhooks is the ONLY write to Ecotrak in this codebase
//     outside the OAuth token exchange. It sends exactly one kind of call,
//     `POST /api/webhook`, which adds a webhook to OUR integration settings on
//     Ecotrak — no work order, note, proposal or invoice is touched, and
//     clients never see it. It never edits (PATCH) or deletes a webhook, so a
//     webhook someone else set up on the account is never disturbed; one that
//     already points at our URL is reported, not duplicated.
//   * It is a button a super admin presses (not a viewer-as, not a test
//     account), logged as an admin event. Nothing calls it automatically.
//   * The receiver treats a delivery as a signal only: it reads the work order
//     and its notes back from Ecotrak with GETs (refreshEcotrakWorkOrders), so a
//     forged or odd delivery can at most make us re-read Ecotrak.
//   tests/ecotrak-inbound.test.ts pins all of this.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ECOTRAK_SAFETY_NET_MINUTES, ECOTRAK_WEBHOOK_ACTIONS, ecotrakIdsFromPayload, type EcotrakWebhookAction } from '@theone/shared';
import { config } from '../config.js';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { EcotrakClient, configFromEnv, type EcotrakWebhookRow } from '../modules/integrations/ecotrak/client.js';
import { getEcotrakConnection, ingestEcotrak, refreshEcotrakWorkOrders } from '../modules/integrations/ecotrak/ingest.js';
import { logAdminEvent } from './adminAudit.js';
import { integrationOnNow } from './integrations.js';

export const ECOTRAK_WEBHOOK_PATH = '/api/webhooks/ecotrak';

/** The delivery URL without its key. https only: Ecotrak cannot reach a
 *  developer's localhost, and a key must never travel in clear. */
export function ecotrakWebhookUrl(origin = config.webOrigin): string | null {
  const o = origin.replace(/\/+$/, '');
  return o.startsWith('https://') ? `${o}${ECOTRAK_WEBHOOK_PATH}` : null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface EcotrakWebhookState {
  url: string | null;
  registered: Array<{ action: EcotrakWebhookAction; registered_at: string }>;
  last_delivery_at: string | null;
  deliveries_24h: number;
}

export async function ecotrakWebhookState(): Promise<EcotrakWebhookState> {
  const state: EcotrakWebhookState = { url: ecotrakWebhookUrl(), registered: [], last_delivery_at: null, deliveries_24h: 0 };
  try {
    const r = await query<{ action: EcotrakWebhookAction; registered_at: string }>(
      `SELECT action, registered_at::text AS registered_at FROM ecotrak_webhook ORDER BY action`,
    );
    state.registered = r.rows.map((x) => ({ action: x.action, registered_at: new Date(x.registered_at).toISOString() }));
    const d = await query<{ last: string | null; n: string }>(
      `SELECT max(received_at)::text AS last,
              count(*) FILTER (WHERE received_at > now() - interval '24 hours')::text AS n
         FROM ecotrak_webhook_delivery`,
    );
    state.last_delivery_at = d.rows[0]?.last ? new Date(d.rows[0].last).toISOString() : null;
    state.deliveries_24h = Number(d.rows[0]?.n ?? 0);
  } catch {
    /* before 0114 */
  }
  return state;
}

export interface RegisterOutcome {
  action: EcotrakWebhookAction;
  result: 'registered' | 'already_ours' | 'already_on_ecotrak' | 'failed';
  detail?: string;
}

/**
 * Register the two webhooks on our Ecotrak account. Super admins only, the
 * real person (never while viewing as someone). Each action is asked on its
 * own: one already registered by this button is skipped; one Ecotrak already
 * holds for our URL (registered some other way) is reported and left alone.
 */
export async function registerEcotrakWebhooks(actor: { id: string; isSuperAdmin: boolean }): Promise<RegisterOutcome[]> {
  if (!actor.isSuperAdmin) throw new ApiError('FORBIDDEN', 'Only a super admin can register the Ecotrak webhooks');
  if (!(await integrationOnNow('ecotrak'))) {
    throw new ApiError('CONFLICT', 'Turn Ecotrak → OBI on first: registering needs to sign in to Ecotrak.');
  }
  const url = ecotrakWebhookUrl();
  if (!url) {
    throw new ApiError('CONFLICT', 'Webhooks need the app’s public https address (WEB_ORIGIN); this server has none.');
  }
  const conn = await getEcotrakConnection();
  if (!conn) throw new ApiError('CONFLICT', 'No Ecotrak connection on file.');
  const client = new EcotrakClient(configFromEnv(conn.credentials_ref));

  const ours = new Set(
    (await query<{ action: string }>(`SELECT action FROM ecotrak_webhook`)).rows.map((r) => r.action),
  );
  // What Ecotrak already holds (read): never register the same URL twice.
  const onEcotrak: EcotrakWebhookRow[] = await client.listWebhooks();
  const pointsHere = (w: EcotrakWebhookRow) => String(w.url ?? '').split('?')[0].replace(/\/+$/, '') === url;

  const out: RegisterOutcome[] = [];
  for (const action of ECOTRAK_WEBHOOK_ACTIONS) {
    if (ours.has(action)) {
      out.push({ action, result: 'already_ours' });
      continue;
    }
    if (onEcotrak.some((w) => pointsHere(w) && w.permission?.action === action)) {
      out.push({ action, result: 'already_on_ecotrak', detail: 'Ecotrak already has this webhook for our address; left as it is.' });
      continue;
    }
    const key = randomBytes(24).toString('base64url');
    try {
      const created = await postWebhook(client, {
        name: `OBI · ${action === 'WEBHOOK_WORKORDER_COMMENT' ? 'comments' : 'work order changes'}`,
        url: `${url}?key=${key}`,
        action,
        method: 'post',
        retryCount: 5,
        clientId: 'the-one',
        secret: key,
      });
      await query(
        `INSERT INTO ecotrak_webhook (action, ecotrak_webhook_id, url, secret_hash, registered_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [action, created, url, sha256(key), actor.id],
      );
      out.push({ action, result: 'registered' });
    } catch (e) {
      out.push({ action, result: 'failed', detail: (e as Error).message });
    }
  }
  await logAdminEvent({
    actorId: actor.id,
    entity: 'integration',
    entityId: 'ecotrak',
    action: 'ecotrak_webhooks_registered',
    after: { name: 'Ecotrak webhooks', url, outcomes: out },
  });
  return out;
}

/** The single write. POST /api/webhook, nothing else, ever. Answers
 *  Ecotrak's id for the new webhook when it says one. */
async function postWebhook(client: EcotrakClient, body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(`${client.baseUrl}/api/webhook`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await client.bearer()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  // Never echo the body: it may repeat the key back.
  if (!res.ok) throw new Error(`Ecotrak refused the webhook: HTTP ${res.status}`);
  try {
    const json = (await res.json()) as { id?: unknown } | Array<{ id?: unknown }>;
    const id = Array.isArray(json) ? json[0]?.id : json?.id;
    return id != null ? String(id) : null;
  } catch {
    return null;
  }
}

/** Does this key belong to one of our registered webhooks? Constant time. */
export async function ecotrakWebhookKeyOk(key: string | null | undefined): Promise<boolean> {
  if (!key) return false;
  const r = await query<{ secret_hash: string }>(`SELECT secret_hash FROM ecotrak_webhook`);
  const got = Buffer.from(sha256(key), 'hex');
  let ok = false;
  for (const row of r.rows) {
    const want = Buffer.from(row.secret_hash, 'hex');
    if (want.length === got.length && timingSafeEqual(want, got)) ok = true;
  }
  return ok;
}

export type DeliveryOutcome = 'refreshed' | 'synced' | 'switched_off' | 'not_found' | 'failed';

/**
 * One delivery from Ecotrak (already authenticated by its key). Kept verbatim,
 * then: the work order it names is read back and refreshed; when it names
 * none we recognise, an ordinary sync runs instead. Switched off = kept and
 * acknowledged, Ecotrak not contacted (the next sync after it is turned back
 * on catches up from where it stopped).
 */
export async function handleEcotrakDelivery(payload: unknown): Promise<{ outcome: DeliveryOutcome; external_id: string | null }> {
  let outcome: DeliveryOutcome = 'failed';
  let externalId: string | null = null;
  let error: string | null = null;
  try {
    if (!(await integrationOnNow('ecotrak'))) {
      outcome = 'switched_off';
    } else {
      const ids = ecotrakIdsFromPayload(payload);
      const { found } = ids.length > 0 ? await refreshEcotrakWorkOrders(ids) : { found: [] as string[] };
      if (found.length > 0) {
        externalId = found[0];
        outcome = 'refreshed';
      } else {
        const res = await ingestEcotrak({ trigger: 'webhook' });
        outcome = ids.length > 0 && res.fetched === 0 ? 'not_found' : 'synced';
      }
    }
  } catch (e) {
    error = (e as Error).message.slice(0, 500);
  }
  await query(
    `INSERT INTO ecotrak_webhook_delivery (external_id, payload, outcome, error) VALUES ($1, $2::jsonb, $3, $4)`,
    [externalId, JSON.stringify(payload ?? null), outcome, error],
  );
  await query(`DELETE FROM ecotrak_webhook_delivery WHERE received_at < now() - interval '30 days'`);
  return { outcome, external_id: externalId };
}

/** The minute cron's question: should it read Ecotrak now? Every minute until
 *  webhooks are registered; then every ECOTRAK_SAFETY_NET_MINUTES. */
export async function ecotrakPollDue(lastSyncedAt: string | null): Promise<boolean> {
  const state = await ecotrakWebhookState();
  if (state.registered.length < ECOTRAK_WEBHOOK_ACTIONS.length) return true;
  if (!lastSyncedAt) return true;
  return Date.now() - new Date(lastSyncedAt).getTime() >= ECOTRAK_SAFETY_NET_MINUTES * 60_000;
}
