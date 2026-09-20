// Routes: the dashboard records (0042).
//
//   GET    /dashboards                  every dashboard this viewer may open
//   GET    /dashboards/:id/data         each card's answer, for THIS viewer
//   POST   /dashboards/preview          an unsaved card, answered (the editor)
//   POST   /dashboards                  build one
//   PATCH  /dashboards/:id              rename, refolder, reshare
//   DELETE /dashboards/:id              (a shipped one returns on next read)
//   POST   /dashboards/:id/widgets      add a card
//   PATCH  /dashboards/widgets/:id      edit a card
//   DELETE /dashboards/widgets/:id      remove a card
//
// Sharing decides who may open a dashboard; the rows its cards count are
// always scoped to the viewer (0026), so none of this can widen what anyone
// sees. (Registered under the /api prefix in app.ts.)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WIDGET_KINDS, WIDGET_METRICS, WIDGET_WIDTHS } from '@theone/shared';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import {
  addWidget,
  createDashboard,
  deleteDashboard,
  deleteWidget,
  listDashboards,
  previewWidget,
  readDashboardData,
  updateDashboard,
  updateWidget,
} from '../services/dashboards.js';
import { filterSetSchema } from './views.js';

const idParams = z.object({ id: z.string().uuid() });

const configSchema = z
  .object({
    metric: z.enum(WIDGET_METRICS).default('count'),
    value_field: z.string().min(1).max(200).optional(),
    group_field: z.string().min(1).max(200).optional(),
    filters: filterSetSchema.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const dashboardSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(400).nullable().optional(),
    folder_id: z.string().uuid().nullable().optional(),
    shared_roles: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    shared_all: z.boolean().optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .strict();

const widgetSchema = z
  .object({
    kind: z.enum(WIDGET_KINDS),
    label: z.string().trim().min(1).max(120),
    config: configSchema,
    width: z.enum(WIDGET_WIDTHS).optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .strict();

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboards', async (req) => listDashboards(actingPrincipalFromRequest(req)));

  app.get('/dashboards/:id/data', async (req) => {
    const { id } = parse(idParams, req.params);
    return readDashboardData(id, actingPrincipalFromRequest(req));
  });

  app.post('/dashboards/preview', async (req) => {
    const config = parse(configSchema, req.body);
    return previewWidget(config, actingPrincipalFromRequest(req));
  });

  app.post('/dashboards', async (req, reply) => {
    const body = parse(dashboardSchema, req.body);
    const dashboard = await createDashboard(body, actingPrincipalFromRequest(req));
    return reply.status(201).send({ dashboard });
  });

  app.patch('/dashboards/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(dashboardSchema.partial(), req.body);
    return { dashboard: await updateDashboard(id, body, actingPrincipalFromRequest(req)) };
  });

  app.delete('/dashboards/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deleteDashboard(id, actingPrincipalFromRequest(req));
    return reply.status(204).send();
  });

  app.post('/dashboards/:id/widgets', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(widgetSchema, req.body);
    const dashboard = await addWidget(id, body, actingPrincipalFromRequest(req));
    return reply.status(201).send({ dashboard });
  });

  app.patch('/dashboards/widgets/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(widgetSchema.partial(), req.body);
    return { dashboard: await updateWidget(id, body, actingPrincipalFromRequest(req)) };
  });

  app.delete('/dashboards/widgets/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deleteWidget(id, actingPrincipalFromRequest(req));
    return reply.status(204).send();
  });
}
