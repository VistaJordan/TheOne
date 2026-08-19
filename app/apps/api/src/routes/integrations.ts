// Integration routes. POST /api/integrations/ecotrak/sync is the manual "sync
// now" trigger; the worker will call the same service on a timer once the poll
// job lands. Read-only against Ecotrak — nothing is written back.
import type { FastifyInstance } from 'fastify';
import { ingestEcotrak, getEcotrakConnection } from '../modules/integrations/ecotrak/ingest.js';

export default async function integrationRoutes(app: FastifyInstance): Promise<void> {
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
