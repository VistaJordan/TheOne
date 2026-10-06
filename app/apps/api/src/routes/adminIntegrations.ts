// Routes: Admin › Integrations (migration 0074) — every connector with its
// on / off switch.
//
//   GET  /admin/integrations            the list, each with enabled + configured
//   PUT  /admin/integrations/:key       { enabled: boolean }
//
// Gated on the REAL signed-in user (admin/integrations view / edit), never
// on who they are viewing as — the same rule as routes/admin.ts: impersonating
// an administrator must not hand the impersonator the switches.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, parse } from '../errors.js';
import { listIntegrations, setIntegration } from '../services/integrations.js';

const keyParams = z.object({ key: z.string().min(1).max(40) });
const body = z.object({ enabled: z.boolean() }).strict();

function realUser(req: FastifyRequest) {
  if (!req.auth) throw new ApiError('UNAUTHORIZED', 'Sign in to continue');
  return req.auth.user;
}

export default async function adminIntegrationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/integrations', async (req) => listIntegrations(realUser(req)));

  app.put('/admin/integrations/:key', async (req) => {
    const { key } = parse(keyParams, req.params);
    const { enabled } = parse(body, req.body);
    return setIntegration(key, enabled, realUser(req));
  });
}
