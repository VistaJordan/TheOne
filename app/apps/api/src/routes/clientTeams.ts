// 0096 · Clients › a client › Account team: who leads the client under each
// of our companies (services/clientTeams.ts).
//
//   GET    /clients/:id/teams
//   POST   /clients/:id/teams            add a team (one per Comp)
//   PATCH  /clients/:id/teams/:teamId    replace it
//   DELETE /clients/:id/teams/:teamId

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import { deleteClientTeam, listClientTeams, saveClientTeam } from '../services/clientTeams.js';

const idParams = z.object({ id: z.string().max(40) });
const teamParams = z.object({ id: z.string().max(40), teamId: z.string().max(40) });
const name = z.string().max(120).nullable().optional();
const teamBody = z
  .object({ billing_entity: z.string().min(1).max(40), tl: name, atl: name, sales: name, am: name })
  .strict();

export default async function clientTeamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/clients/:id/teams', async (req) => {
    const { id } = parse(idParams, req.params);
    return listClientTeams(id, actingPrincipalFromRequest(req));
  });
  app.post('/clients/:id/teams', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const res = await saveClientTeam(id, null, parse(teamBody, req.body), actingPrincipalFromRequest(req));
    return reply.status(201).send(res);
  });
  app.patch('/clients/:id/teams/:teamId', async (req) => {
    const { id, teamId } = parse(teamParams, req.params);
    return saveClientTeam(id, teamId, parse(teamBody, req.body), actingPrincipalFromRequest(req));
  });
  app.delete('/clients/:id/teams/:teamId', async (req) => {
    const { id, teamId } = parse(teamParams, req.params);
    return deleteClientTeam(id, teamId, actingPrincipalFromRequest(req));
  });
}
