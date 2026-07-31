// Route: GET /statuses — all statuses ordered by position (§5).

import type { FastifyInstance } from 'fastify';
import { listStatuses } from '../services/workOrders.js';

export default async function statusesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/statuses', async () => listStatuses());
}
