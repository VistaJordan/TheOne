// Routes: Admin › Documentation (migration 0075).
//
//   GET /admin/docs/snapshot   the live half of the BRD / SOP / lifecycle
//
// Gated on the REAL signed-in user (admin/docs view), like every admin
// section — viewing as someone must not open the console to the viewer.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DOCS_PERM_KEY } from '@theone/shared';
import { ApiError } from '../errors.js';
import { requirePerm } from '../services/permissions.js';
import { docsSnapshot } from '../services/docsSnapshot.js';

function realUser(req: FastifyRequest) {
  if (!req.auth) throw new ApiError('UNAUTHORIZED', 'Sign in to continue');
  requirePerm(req.auth.user, DOCS_PERM_KEY, 'view', 'Admin › Documentation is not available to you');
  return req.auth.user;
}

export default async function adminDocsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/docs/snapshot', async (req) => docsSnapshot(realUser(req)));
}
