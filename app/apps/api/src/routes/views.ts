// Routes: the work-order list's field catalogue and the saved views built on it.
//
//   GET    /wo-fields          the filterable/sortable/displayable field list
//   GET    /views              mine + everyone's shared ones
//   POST   /views              save the current arrangement
//   PATCH  /views/:id          rename / re-save (owner only)
//   DELETE /views/:id          (owner only)
//
// A view is scoped to the person viewing it, so every handler reads the actor
// from the session rather than taking an owner id from the body.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { actorIdFromRequest } from '../services/activity.js';
import { getFieldCatalogue, FILTER_OPS, OPS_BY_TYPE } from '../services/woFields.js';
import { createView, deleteView, listViews, updateView } from '../services/views.js';

const filterRuleSchema = z.object({
  field: z.string().min(1),
  op: z.enum(FILTER_OPS),
  // Deliberately permissive: `between` takes a pair, `in` a list, everything
  // else a scalar. The shape is checked against the FIELD's type in woFields.ts,
  // which is the only place that knows what a given field accepts.
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
    .nullish(),
});

export const filterSetSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  rules: z.array(filterRuleSchema).max(50).default([]),
});

export const sortSchema = z.object({
  field: z.string().min(1),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

const viewBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  columns: z.array(z.string().min(1)).max(60).optional(),
  filters: filterSetSchema.optional(),
  group_by: z.string().min(1).nullable().optional(),
  sort: sortSchema.nullable().optional(),
  is_shared: z.boolean().optional(),
});

const idParams = z.object({ id: z.string().uuid() });

export default async function viewRoutes(app: FastifyInstance): Promise<void> {
  // The catalogue also ships the operator table, so the filter builder never
  // has to keep its own copy of which tests apply to which field type.
  app.get('/wo-fields', async () => {
    const cat = await getFieldCatalogue();
    return { ...cat, ops_by_type: OPS_BY_TYPE };
  });

  app.get('/views', async (req) => {
    const items = await listViews(actorIdFromRequest(req));
    return { items };
  });

  app.post('/views', async (req, reply) => {
    const body = parse(viewBodySchema, req.body);
    const view = await createView(actorIdFromRequest(req), body);
    return reply.status(201).send({ view });
  });

  app.patch('/views/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    // `.partial()` on the body but NOT on the request: an absent key means
    // "leave it", which is what lets "rename" and "re-save the layout" share
    // one endpoint. views.ts distinguishes absent from explicitly-null.
    const body = parse(viewBodySchema.partial(), req.body);
    const view = await updateView(id, actorIdFromRequest(req), body);
    return { view };
  });

  app.delete('/views/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await deleteView(id, actorIdFromRequest(req));
    return { ok: true };
  });
}
