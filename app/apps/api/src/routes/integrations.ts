// Integration routes. POST /api/integrations/ecotrak/sync is the manual "sync
// now" trigger; the worker will call the same service on a timer once the poll
// job lands. Read-only against Ecotrak — nothing is written back.
//
// DEMO_MODE refuses both routes outright: the public demo runs on seed data
// only, and with the dev bypass on, "signed in" means "anyone on the
// internet" — a reachable sync trigger would let any visitor pull production
// work orders into the demo database. The credentials may sit in the
// environment; this gate is what keeps them cold.
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { ingestEcotrak, getEcotrakConnection } from '../modules/integrations/ecotrak/ingest.js';

export default async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    if (config.demoMode && req.url.startsWith('/api/integrations/')) {
      throw new ApiError('FORBIDDEN', 'Integrations are disabled in the public demo.');
    }
  });

  app.get('/integrations/ecotrak/status', async () => {
    const conn = await getEcotrakConnection();
    if (!conn) return { configured: false };
    return {
      configured: true,
      shadow_mode: conn.shadow_mode,
      last_synced_at: conn.last_synced_at,
    };
  });

  app.post<{ Body: { sinceDays?: number } | undefined }>(
    '/integrations/ecotrak/sync',
    async (req) => {
      const sinceDays = req.body?.sinceDays;
      const result = await ingestEcotrak(
        typeof sinceDays === 'number' ? { sinceDays } : {},
      );
      return result;
    },
  );
}
