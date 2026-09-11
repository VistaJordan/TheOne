// Routes: the Incoming Work Order Intake (section 14, 0040) — the OP
// Admin's staging area.
//   GET    /intake/drafts             the staging list (intake:view)
//   POST   /intake/drafts             start a draft (intake:create)
//   GET    /intake/drafts/:id         one draft (intake:view)
//   PATCH  /intake/drafts/:id         save what was typed (intake:edit)
//   POST   /intake/drafts/:id/submit  every field + assignee → a work order (intake:edit)
//   POST   /intake/drafts/:id/discard mark it discarded, never deleted (intake:edit)
//
// The permission checks live in the service (requireIntake*) so no route
// can forget one.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import {
  createIntakeDraft,
  discardIntakeDraft,
  getIntakeDraft,
  listIntakeDrafts,
  requireIntakeView,
  submitIntakeDraft,
  updateIntakeDraft,
} from '../services/intake.js';

const uuidParamsSchema = z.object({ id: z.string().uuid() });

const draftBodySchema = z.object({
  wo_number: z.string().max(80).nullable().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  assignee: z.string().max(200).nullable().optional(),
});

export default async function intakeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/intake/drafts', async (req) => {
    requireIntakeView(actingPrincipalFromRequest(req));
    return listIntakeDrafts();
  });

  app.post('/intake/drafts', async (req, reply) => {
    const actor = actingPrincipalFromRequest(req);
    const body = parse(draftBodySchema, req.body ?? {});
    const item = await createIntakeDraft(body, actor);
    return reply.code(201).send({ item });
  });

  app.get('/intake/drafts/:id', async (req) => {
    requireIntakeView(actingPrincipalFromRequest(req));
    const { id } = parse(uuidParamsSchema, req.params);
    return { item: await getIntakeDraft(id) };
  });

  app.patch('/intake/drafts/:id', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    const { id } = parse(uuidParamsSchema, req.params);
    const body = parse(draftBodySchema, req.body ?? {});
    return { item: await updateIntakeDraft(id, body, actor) };
  });

  app.post('/intake/drafts/:id/submit', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    const { id } = parse(uuidParamsSchema, req.params);
    return submitIntakeDraft(id, actor);
  });

  app.post('/intake/drafts/:id/discard', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    const { id } = parse(uuidParamsSchema, req.params);
    return { item: await discardIntakeDraft(id, actor) };
  });
}
