// Integration routes. POST /api/integrations/ecotrak/sync is the manual "sync
// now" trigger (Admin › Integrations has its own button on the same run, and
// Vercel's cron calls it every minute — routes/webhooks.ts). Read-only
// against Ecotrak — nothing is written back.
//
// 0079 · both routes need Admin › Integrations (view for the status, edit for
// a run); before 0079 any signed-in person could start a sync. The switch
// still decides: off = 409, and Ecotrak is not contacted.
//
// DEMO_MODE refuses both routes outright: the public demo runs on seed data
// only, and with the dev bypass on, "signed in" means "anyone on the
// internet" — a reachable sync trigger would let any visitor pull production
// work orders into the demo database. The credentials may sit in the
// environment; this gate is what keeps them cold.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { INTEGRATIONS_PERM_KEY } from '@theone/shared';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { ingestEcotrak, getEcotrakConnection } from '../modules/integrations/ecotrak/ingest.js';
import { integrationOnNow } from '../services/integrations.js';
import { requirePerm } from '../services/permissions.js';

function realUser(req: FastifyRequest) {
  if (!req.auth) throw new ApiError('UNAUTHORIZED', 'Sign in to continue');
  // D6 (Wave B): the person being viewed while viewing as them; else the user.
  return req.auth.actingAs;
}

export default async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    if (config.demoMode && req.url.startsWith('/api/integrations/')) {
      throw new ApiError('FORBIDDEN', 'Integrations are disabled in the public demo.');
    }
  });

  app.get('/integrations/ecotrak/status', async (req) => {
    requirePerm(realUser(req), INTEGRATIONS_PERM_KEY, 'view', 'Admin › Integrations is not available to you');
    const conn = await getEcotrakConnection();
    if (!conn) return { configured: false };
    return {
      configured: true,
      enabled: await integrationOnNow('ecotrak'),
      shadow_mode: conn.shadow_mode,
      last_synced_at: conn.last_synced_at,
    };
  });

  app.post<{ Body: { sinceDays?: number } | undefined }>(
    '/integrations/ecotrak/sync',
    async (req) => {
      requirePerm(realUser(req), INTEGRATIONS_PERM_KEY, 'edit', 'You cannot run the Ecotrak sync');
      const sinceDays = req.body?.sinceDays;
      const result = await ingestEcotrak(
        typeof sinceDays === 'number' ? { sinceDays, trigger: 'manual' } : { trigger: 'manual' },
      );
      return result;
    },
  );
}
