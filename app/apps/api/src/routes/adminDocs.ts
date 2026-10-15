// Routes: Admin › Documentation (migration 0075).
//
//   GET /admin/docs/snapshot   the live half of the BRD / SOP / lifecycle
//
// Gated on admin/docs view of the person whose rights count (D6, Wave B):
// the person being viewed while a super admin views as them, else the user —
// so viewing as someone shows the page exactly as they would see it.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DOCS_PERM_KEY, brdMarkdown, docsContent, lifecycleMarkdown, sopMarkdown } from '@theone/shared';
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
  // L5 (UAT Wave D): the registry itself, behind the same gate — the web
  // bundle no longer carries the BRD / SOP / lifecycle prose.
  app.get('/admin/docs/content', async (req) => {
    realUser(req);
    return docsContent();
  });
  // The Markdown download, built here with the asker's live appendix.
  app.get('/admin/docs/markdown', async (req) => {
    const who = realUser(req);
    const doc = String((req.query as { doc?: string } | undefined)?.doc ?? 'brd');
    const snap = await docsSnapshot(who).catch(() => null);
    const markdown = doc === 'sop' ? sopMarkdown(snap) : doc === 'lifecycle' ? lifecycleMarkdown(snap) : brdMarkdown(snap);
    return { markdown };
  });
}
