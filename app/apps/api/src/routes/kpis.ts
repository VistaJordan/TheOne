// Route: GET /kpis — live-computed KPIs (§5).

import type { FastifyInstance } from 'fastify';
import { getKpis } from '../services/kpis.js';

export default async function kpisRoutes(app: FastifyInstance): Promise<void> {
  app.get('/kpis', async () => getKpis());
}
