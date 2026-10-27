// 0096 · Clients › a client › Account team: who leads the client under each
// of our companies (services/clientTeams.ts).
//
//   GET    /client-teams                 every client's teams (the Clients list)
//   GET    /clients/:id/teams
//   POST   /clients/:id/teams            add a team (one per Comp)
//   PATCH  /clients/:id/teams/:teamId    replace it
//   DELETE /clients/:id/teams/:teamId
//
// 0100 · Clients › a client › Check-in method, keyed the same way
// (services/clientCico.ts):
//
//   GET    /clients/:id/cico
//   POST   /clients/:id/cico             add a row (one per Comp)
//   PATCH  /clients/:id/cico/:rowId      replace it
//   DELETE /clients/:id/cico/:rowId

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import { deleteClientCico, listClientCico, saveClientCico } from '../services/clientCico.js';
import { deleteClientTeam, listClientTeams, saveClientTeam, teamsOverview } from '../services/clientTeams.js';

const idParams = z.object({ id: z.string().max(40) });
const teamParams = z.object({ id: z.string().max(40), teamId: z.string().max(40) });
const name = z.string().max(120).nullable().optional();
const teamBody = z
  .object({ billing_entity: z.string().min(1).max(40), tl: name, atl: name, sales: name, am: name })
  .strict();
const cicoParams = z.object({ id: z.string().max(40), rowId: z.string().max(40) });
const cicoBody = z
  .object({
    billing_entity: z.string().min(1).max(40),
    method: z.string().min(1).max(40),
    portal: z.string().max(120).nullable().optional(),
    detail: z.string().max(500).nullable().optional(),
    email: z.string().max(200).nullable().optional(),
  })
  .strict();

export default async function clientTeamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/client-teams', async (req) => teamsOverview(actingPrincipalFromRequest(req)));
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

  app.get('/clients/:id/cico', async (req) => {
    const { id } = parse(idParams, req.params);
    return listClientCico(id, actingPrincipalFromRequest(req));
  });
  app.post('/clients/:id/cico', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const res = await saveClientCico(id, null, parse(cicoBody, req.body), actingPrincipalFromRequest(req));
    return reply.status(201).send(res);
  });
  app.patch('/clients/:id/cico/:rowId', async (req) => {
    const { id, rowId } = parse(cicoParams, req.params);
    return saveClientCico(id, rowId, parse(cicoBody, req.body), actingPrincipalFromRequest(req));
  });
  app.delete('/clients/:id/cico/:rowId', async (req) => {
    const { id, rowId } = parse(cicoParams, req.params);
    return deleteClientCico(id, rowId, actingPrincipalFromRequest(req));
  });
}
