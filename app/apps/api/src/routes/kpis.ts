// Route: GET /kpis — live-computed KPIs (§5). Needs dashboard:view (0015).
// 0050 · ?board=main (the Main Dashboard) also needs that page ticked, and
// counts with its "Which work orders it counts" choice.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { getKpis } from '../services/kpis.js';
import { boardViewer, requireBoardView } from '../services/dashboards.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import { requirePerm } from '../services/permissions.js';

/** The built-in dashboard pages a read can be counted for (0050). */
export const boardQuery = z.object({ board: z.enum(['attention', 'main']).optional() });

export default async function kpisRoutes(app: FastifyInstance): Promise<void> {
  app.get('/kpis', async (req) => {
    const viewer = actingPrincipalFromRequest(req);
    requirePerm(viewer, 'dashboard', 'view', 'You cannot view the dashboard');
    const { board } = parse(boardQuery, req.query);
    if (!board) return getKpis(viewer);
    requireBoardView(viewer, board);
    return getKpis(boardViewer(viewer, board));
  });
}
