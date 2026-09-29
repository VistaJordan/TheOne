// Routes: client updates (0055).
//
//   GET    /client-updates                     every tracker + whether email is set up
//   GET    /client-updates/:id                 one
//   POST   /client-updates                     create
//   PUT    /client-updates/:id                 change (sharing fields need client_updates/share)
//   DELETE /client-updates/:id
//   POST   /client-updates/insights            tiles + charts over a filter set (viewer-scoped)
//   PUT    /client-updates/:id/link            turn the read-only link on / off / regenerate
//   GET    /client-updates/:id/email-preview   the email as it would go out now
//   POST   /client-updates/:id/send            send now (or a test to yourself)
//   GET    /client-updates/:id/deliveries      what was sent, to whom, when
//   GET    /client-updates/:id/csv             the client columns as a CSV
//
// Public, no session (plugins/authGuard.ts allows exactly these two shapes):
//   GET    /public/client-updates/:token       the client's read-only view
//   GET    /public/client-updates/:token/csv   the same, as a CSV
//
// The schedule's clock is /webhooks/client-updates-run (routes/webhooks.ts).
// (Registered under /api in app.ts.)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CLIENT_UPDATE_CHART_KINDS, DELIVERY_TRIGGERS, SCHEDULE_FREQUENCIES } from '@theone/shared';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import {
  clientCsv,
  createClientUpdate,
  deleteClientUpdate,
  emailPreview,
  getClientUpdate,
  insights,
  listClientUpdates,
  listDeliveries,
  publicCsv,
  publicView,
  sendClientUpdate,
  setShareLink,
  updateClientUpdate,
} from '../services/clientUpdates.js';
import { filterSetSchema, sortSchema } from './views.js';

const idParams = z.object({ id: z.string().uuid() });
const tokenParams = z.object({ token: z.string().min(1).max(64) });
const text = (max: number) => z.string().trim().max(max).nullable().optional();

const columnSchema = z.object({
  key: z.string().min(1).max(200),
  label: z.string().trim().max(80).nullable().optional().transform((v) => v ?? null),
  shared: z.boolean(),
});
const chartSchema = z.object({
  field: z.string().min(1).max(200),
  kind: z.enum(CLIENT_UPDATE_CHART_KINDS),
  shared: z.boolean(),
});
const recipientSchema = z.object({
  email: z.string().trim().min(3).max(320),
  name: z.string().trim().max(200).nullable().optional().transform((v) => v ?? null),
});
const scheduleSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(SCHEDULE_FREQUENCIES),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  day_of_month: z.number().int().min(1).max(28),
  time: z.string().regex(/^\d{2}:\d{2}$/),
});

const trackerSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    client: text(200),
    description: text(2000),
    filters: filterSetSchema.optional(),
    columns: z.array(columnSchema).min(1).max(40).optional(),
    sort: sortSchema.nullable().optional(),
    group_by: z.string().max(200).nullable().optional(),
    charts: z.array(chartSchema).max(8).optional(),
    note_field: z.string().max(200).nullable().optional(),
    share: z
      .object({
        enabled: z.boolean().optional(),
        expires_at: z.string().max(40).nullable().optional(),
        charts: z.boolean().optional(),
        summary: z.boolean().optional(),
      })
      .optional(),
    email: z
      .object({
        subject: text(300),
        intro: text(4000),
        to: z.array(recipientSchema).max(50).optional(),
        cc: z.array(recipientSchema).max(50).optional(),
        attach_csv: z.boolean().optional(),
        include_link: z.boolean().optional(),
      })
      .optional(),
    schedule: scheduleSchema.nullable().optional(),
  })
  .strict();

const insightsSchema = z.object({
  filters: filterSetSchema,
  charts: z.array(chartSchema).max(8),
});

const linkSchema = z
  .object({
    enabled: z.boolean(),
    regenerate: z.boolean().optional(),
    expires_at: z.string().max(40).nullable().optional(),
    origin: z.string().max(300).nullable().optional(),
  })
  .strict();

const sendSchema = z
  .object({
    trigger: z.enum(DELIVERY_TRIGGERS).refine((t) => t !== 'scheduled', 'Only the scheduler sends scheduled updates'),
    to: z.array(recipientSchema).max(50).optional(),
    cc: z.array(recipientSchema).max(50).optional(),
    subject: text(300),
    intro: text(4000),
  })
  .strict();

export default async function clientUpdateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/client-updates', async (req) => listClientUpdates(actingPrincipalFromRequest(req)));

  app.post('/client-updates/insights', async (req) => {
    const body = parse(insightsSchema, req.body);
    return insights(body.filters, body.charts, actingPrincipalFromRequest(req));
  });

  app.get('/client-updates/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { item: await getClientUpdate(id, actingPrincipalFromRequest(req)) };
  });

  app.post('/client-updates', async (req, reply) => {
    const body = parse(trackerSchema, req.body);
    const item = await createClientUpdate(body, actingPrincipalFromRequest(req));
    return reply.status(201).send({ item });
  });

  app.put('/client-updates/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(trackerSchema, req.body);
    return { item: await updateClientUpdate(id, body, actingPrincipalFromRequest(req)) };
  });

  app.delete('/client-updates/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deleteClientUpdate(id, actingPrincipalFromRequest(req));
    return reply.status(204).send();
  });

  app.put('/client-updates/:id/link', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(linkSchema, req.body);
    return { item: await setShareLink(id, body, actingPrincipalFromRequest(req)) };
  });

  app.get('/client-updates/:id/email-preview', async (req) => {
    const { id } = parse(idParams, req.params);
    return emailPreview(id, actingPrincipalFromRequest(req));
  });

  app.post('/client-updates/:id/send', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(sendSchema, req.body);
    return { delivery: await sendClientUpdate(id, body, actingPrincipalFromRequest(req)) };
  });

  app.get('/client-updates/:id/deliveries', async (req) => {
    const { id } = parse(idParams, req.params);
    return { items: await listDeliveries(id, actingPrincipalFromRequest(req)) };
  });

  app.get('/client-updates/:id/csv', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { csv, filename } = await clientCsv(id, actingPrincipalFromRequest(req));
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv);
  });

  // ── Public: the client's read-only view ────────────────────────────────────
  app.get('/public/client-updates/:token', async (req, reply) => {
    const { token } = parse(tokenParams, req.params);
    const view = await publicView(token);
    // A client's data: never cached by a shared proxy, never indexed.
    return reply.header('Cache-Control', 'private, no-store').header('X-Robots-Tag', 'noindex').send(view);
  });

  app.get('/public/client-updates/:token/csv', async (req, reply) => {
    const { token } = parse(tokenParams, req.params);
    const { csv, filename } = await publicCsv(token);
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Robots-Tag', 'noindex')
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv);
  });
}
