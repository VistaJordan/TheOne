// Routes: Admin › Documentation (migration 0075).
//
//   GET /admin/docs/snapshot   the live half of the BRD / SOP / lifecycle
//
// Gated on admin/docs view of the person whose rights count (D6, Wave B):
// the person being viewed while a super admin views as them, else the user —
// so viewing as someone shows the page exactly as they would see it.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DOCS_PERM_KEY } from '@theone/shared';
import { ApiError } from '../errors.js';
import { requirePerm } from '../services/permissions.js';
import { docsSnapshot } from '../services/docsSnapshot.js';

function realUser(req: FastifyRequest) {
  if (!req.auth) throw new ApiError('UNAUTHORIZED', 'Sign in to continue');
  requirePerm(req.auth.actingAs, DOCS_PERM_KEY, 'view', 'Admin › Documentation is not available to you');
  // D6 (Wave B): the person being viewed while viewing as them; else the user.
  return req.auth.actingAs;
}

export default async function adminDocsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/docs/snapshot', async (req) => docsSnapshot(realUser(req)));
}
