// Routes: Admin › Integrations (migration 0074) — every connector with its
// on / off switch.
//
//   GET  /admin/integrations            the list, each with enabled + configured
//   PUT  /admin/integrations/:key       { enabled: boolean }
//
// Gated on admin/integrations view / edit of the person whose rights count
// (D6, Wave B): the person being viewed while viewing as them, else the user.
// Viewing as someone never flips a switch — the session is read-only
// (plugins/authGuard.ts) — it only shows the page as they would see it.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, parse } from '../errors.js';
import { listIntegrations, setIntegration } from '../services/integrations.js';
import { ecotrakOverview, syncEcotrakNow } from '../services/ecotrakAdmin.js';
import {
  clickUpOverview,
  refreshClickUp,
  retryClickUpTask,
  saveClickUpMap,
  setClickUpDedupe,
  setClickUpList,
  syncClickUpNow,
} from '../services/clickup.js';
const clickUpDedupeBody = z.object({ days: z.number().int().min(0).max(90) }).strict();

// 0078 · ClickUp's own panel under its row.
const clickUpListBody = z.object({ list: z.string().min(1).max(500) }).strict();
const clickUpMapBody = z
  .object({
    rows: z
      .array(z.object({ source: z.string().min(1).max(200), target: z.string().min(1).max(40), cu_field_id: z.string().max(100).nullable() }).strict())
      .max(500),
  })
  .strict();
const taskParams = z.object({ taskId: z.string().uuid() });

const keyParams = z.object({ key: z.string().min(1).max(40) });
const body = z.object({ enabled: z.boolean() }).strict();

function realUser(req: FastifyRequest) {
  if (!req.auth) throw new ApiError('UNAUTHORIZED', 'Sign in to continue');
  // D6 (Wave B): the person being viewed while viewing as them; else the user.
  return req.auth.actingAs;
}

export default async function adminIntegrationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/integrations', async (req) => listIntegrations(realUser(req)));

  app.put('/admin/integrations/:key', async (req) => {
    const { key } = parse(keyParams, req.params);
    const { enabled } = parse(body, req.body);
    return setIntegration(key, enabled, realUser(req));
  });

  // 0079 · Ecotrak → The One's panel: last run, Sync now (read only).
  //   GET  /admin/integrations/ecotrak              the panel
  //   POST /admin/integrations/ecotrak/sync         read Ecotrak now
  app.get('/admin/integrations/ecotrak', async (req) => ecotrakOverview(realUser(req)));
  app.post('/admin/integrations/ecotrak/sync', async (req) => syncEcotrakNow(realUser(req)));

  //   GET  /admin/integrations/clickup              the panel
  //   PUT  /admin/integrations/clickup/list         { list: URL or id }
  //   POST /admin/integrations/clickup/refresh      re-read fields / statuses / members
  //   PUT  /admin/integrations/clickup/map          { rows: [{ source, target, cu_field_id }] }
  //   POST /admin/integrations/clickup/sync         push what is owed now
  //   POST /admin/integrations/clickup/retry/:taskId
  app.get('/admin/integrations/clickup', async (req) => clickUpOverview(realUser(req)));
  app.put('/admin/integrations/clickup/list', async (req) => setClickUpList(realUser(req), parse(clickUpListBody, req.body).list));
  app.post('/admin/integrations/clickup/refresh', async (req) => refreshClickUp(realUser(req)));
  app.put('/admin/integrations/clickup/map', async (req) => saveClickUpMap(realUser(req), parse(clickUpMapBody, req.body).rows));
  app.post('/admin/integrations/clickup/sync', async (req) => syncClickUpNow(realUser(req)));
  app.put('/admin/integrations/clickup/dedupe', async (req) => setClickUpDedupe(realUser(req), parse(clickUpDedupeBody, req.body).days));
  app.post('/admin/integrations/clickup/retry/:taskId', async (req) =>
    retryClickUpTask(realUser(req), parse(taskParams, req.params).taskId),
  );
}
