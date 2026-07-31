// Route: GET /principals — humans only, ordered by name (S4.1).
// Read-only and deliberately UNGATED: it is the list the "Viewing as" switcher
// picks the X-Actor-Id from, so it has to answer before any actor is known.

import type { FastifyInstance } from 'fastify';
import type { PrincipalsResponse } from '@theone/shared';
import { listPrincipals } from '../services/principals.js';

export default async function principalsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/principals', async (): Promise<PrincipalsResponse> => ({
    items: await listPrincipals(),
  }));
}
