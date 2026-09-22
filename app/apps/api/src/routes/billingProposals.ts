// Routes: billing proposals (0053) — what a contract proposes to bill once a
// work order is done, waiting on a person (BRD §6.4).
//
//   GET    /billing-proposals                    pending, scoped, trimmed to the viewer's kinds
//   GET    /work-orders/:id/billing-proposals    the proposals on one work order
//   POST   /billing-proposals/:id/confirm        file the invoice / vendor bill  { note? }
//   POST   /billing-proposals/:id/dismiss        file nothing                    { note? }
//
// (Registered under the /api prefix in app.ts.)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import {
  confirmProposal,
  dismissProposal,
  listPendingProposals,
  proposalsForTask,
} from '../services/billingProposals.js';

const idParams = z.object({ id: z.string().uuid() });
const woParams = z.object({ id: z.string().min(1) });
const noteSchema = z.object({ note: z.string().trim().max(2000).nullable().optional() }).strict();

export default async function billingProposalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/billing-proposals', async (req) => ({
    items: await listPendingProposals(actingPrincipalFromRequest(req)),
  }));

  app.get('/work-orders/:id/billing-proposals', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    const { id } = parse(woParams, req.params);
    const taskId = await resolveTaskId(id, actor);
    if (!taskId) return { items: [] };
    return { items: await proposalsForTask(taskId, actor) };
  });

  app.post('/billing-proposals/:id/confirm', async (req) => {
    const { id } = parse(idParams, req.params);
    const { note } = parse(noteSchema, req.body ?? {});
    return confirmProposal(id, actingPrincipalFromRequest(req), note);
  });

  app.post('/billing-proposals/:id/dismiss', async (req) => {
    const { id } = parse(idParams, req.params);
    const { note } = parse(noteSchema, req.body ?? {});
    return { proposal: await dismissProposal(id, actingPrincipalFromRequest(req), note) };
  });
}
