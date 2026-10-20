// 0079 · Ecotrak → The One: the panel under its row in Admin › Integrations,
// Sync now, and the 10-minute cron.
//
// Read only against Ecotrak, always: the client has no method that writes.
// Off means off — the cron returns without contacting Ecotrak, Sync now is
// refused with the switch's own 409, and the client itself refuses a token.

import { INTEGRATIONS_PERM_KEY, type EcotrakOverview, type EcotrakRun } from '@theone/shared';
import { query } from '../db.js';
import { getEcotrakConnection, ingestEcotrak, type IngestResult } from '../modules/integrations/ecotrak/ingest.js';
import { logAdminEvent } from './adminAudit.js';
import { integrationOnNow } from './integrations.js';
import { allowFor, requirePerm, type PermissionBearer } from './permissions.js';

type Admin = PermissionBearer & { id: string };

const ENV_KEYS = ['TOKEN_URL', 'BASE_URL', 'CLIENT_ID', 'CLIENT_SECRET'] as const;

export async function ecotrakOverview(user: Admin): Promise<EcotrakOverview> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'view', 'Admin › Integrations is not available to you');
  const enabled = await integrationOnNow('ecotrak');
  let connection: string | null = null;
  let lastSynced: string | null = null;
  let lastRun: EcotrakRun | null = null;
  let linked = 0;
  try {
    const r = await query<{ name: string; last_synced_at: string | null; last_run: EcotrakRun | null; linked: string }>(
      `SELECT c.name, c.last_synced_at::text AS last_synced_at, c.last_run,
              (SELECT count(*) FROM cmms_wo_link l WHERE l.connection_id = c.id)::text AS linked
         FROM cmms_connection c
        WHERE c.provider = 'ecotrak' AND c.active = true
        ORDER BY c.created_at LIMIT 1`,
    );
    const c = r.rows[0];
    if (c) {
      connection = c.name;
      lastSynced = c.last_synced_at ? new Date(c.last_synced_at).toISOString() : null;
      lastRun = c.last_run ?? null;
      linked = Number(c.linked);
    }
  } catch {
    /* before 0079 */
  }
  return {
    enabled,
    credentials_set: ENV_KEYS.every((k) => Boolean(process.env[`ECOTRAK_${k}`]?.trim())),
    connection,
    last_synced_at: lastSynced,
    last_run: lastRun,
    linked,
    can: { edit: allowFor(user)(INTEGRATIONS_PERM_KEY, 'edit') },
  };
}

/** Sync now: the same run as the cron, started by an administrator. */
export async function syncEcotrakNow(user: Admin): Promise<{ result: IngestResult; overview: EcotrakOverview }> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'edit', 'You cannot run the Ecotrak sync');
  const result = await ingestEcotrak({ trigger: 'manual' });
  // Rule 1.2.1: Sync now, with the run's counts (a refused run — switched off,
  // not set up — throws above and changed nothing, so it logs nothing).
  await logAdminEvent({
    actorId: user.id,
    entity: 'integration',
    entityId: 'ecotrak',
    action: 'ecotrak_sync_requested',
    after: {
      name: 'Ecotrak → The One',
      fetched: result.fetched,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      errors: result.errors.length,
    },
  });
  return { result, overview: await ecotrakOverview(user) };
}

/** The cron's tick. Switched off = return at once, Ecotrak never contacted. */
export async function runEcotrakCron(): Promise<{ ran: boolean; note: string }> {
  if (!(await integrationOnNow('ecotrak'))) return { ran: false, note: 'Ecotrak → The One is switched off.' };
  if (!(await getEcotrakConnection())) return { ran: false, note: 'No Ecotrak connection on file.' };
  const res = await ingestEcotrak({ trigger: 'cron' });
  return { ran: true, note: res.note };
}
