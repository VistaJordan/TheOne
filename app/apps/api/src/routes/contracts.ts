// Routes: contracts and labor rates (0046).
//
//   GET    /contracts                    every rate card
//   GET    /contracts/:id                one, with its rates
//   GET    /work-orders/:id/contract     the contract in force for a work order (or null)
//   POST   /contracts                    create
//   PUT    /contracts/:id                replace (rates included)
//   DELETE /contracts/:id
//
// (Registered under the /api prefix in app.ts.)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONTRACT_KINDS, RATE_TYPES } from '@theone/shared';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import {
  contractForTask,
  createContract,
  deleteContract,
  getContract,
  hoursOnSite,
  listContracts,
  requireContractView,
  updateContract,
} from '../services/contracts.js';

const idParams = z.object({ id: z.string().uuid() });
const woParams = z.object({ id: z.string().min(1) });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const rateSchema = z.object({
  rate_type: z.enum(RATE_TYPES),
  trade: z.string().trim().max(120).nullable().optional(),
  amount: z.number().min(0).max(1_000_000),
});

const contractSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    client: z.string().trim().max(200).nullable().optional(),
    billing_entity: z.string().trim().max(60).nullable().optional(),
    kind: z.enum(CONTRACT_KINDS).optional(),
    account_code: z.string().trim().max(80).nullable().optional(),
    starts_on: day.optional(),
    ends_on: day.nullable().optional(),
    active: z.boolean().optional(),
    sites_covered: z.array(z.string().trim().max(120)).max(500).optional(),
    trades_covered: z.array(z.string().trim().max(120)).max(100).optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    rates: z.array(rateSchema).max(50).optional(),
  })
  .strict();

export default async function contractRoutes(app: FastifyInstance): Promise<void> {
  app.get('/contracts', async (req) => listContracts(actingPrincipalFromRequest(req)));

  app.get('/contracts/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { contract: await getContract(id, actingPrincipalFromRequest(req)) };
  });

  // Which contract prices this work order today, and the hours on site so
  // far — what the quote builder and the invoice show as their basis.
  app.get('/work-orders/:id/contract', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requireContractView(actor);
    const { id } = parse(woParams, req.params);
    const taskId = await resolveTaskId(id, actor);
    if (!taskId) return { contract: null, rates: null, hours: null };
    const match = await contractForTask(taskId);
    const hours = await hoursOnSite(taskId);
    return match
      ? { contract: match.contract, rates: match.rates, hours }
      : { contract: null, rates: null, hours };
  });

  app.post('/contracts', async (req, reply) => {
    const body = parse(contractSchema, req.body);
    const contract = await createContract(body, actingPrincipalFromRequest(req));
    return reply.status(201).send({ contract });
  });

  app.put('/contracts/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(contractSchema, req.body);
    return { contract: await updateContract(id, body, actingPrincipalFromRequest(req)) };
  });

  app.delete('/contracts/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deleteContract(id, actingPrincipalFromRequest(req));
    return reply.status(204).send();
  });
}
