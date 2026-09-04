// Route: GET /kpis — live-computed KPIs (§5). Needs dashboard:view (0015).

import type { FastifyInstance } from 'fastify';
import { getKpis } from '../services/kpis.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import { requirePerm } from '../services/permissions.js';

export default async function kpisRoutes(app: FastifyInstance): Promise<void> {
  app.get('/kpis', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), 'dashboard', 'view', 'You cannot view the dashboard');
    return getKpis();
  });
}
