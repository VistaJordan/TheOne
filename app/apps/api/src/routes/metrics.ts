// Routes: the dashboard metrics.
//
//   GET /metrics/breakdown  ?field=&filters=&limit=   any field, bucketed
//   GET /metrics/duration   ?from=&to=&filters=       time between two events
//
// `filters` narrows WHICH work orders count, in the same WoFilterSet shape the
// list takes; `from`/`to` are MetricEvent JSON ({"field":…,"value":…}). Both
// endpoints are aggregates over data every signed-in user can already list, so
// like /kpis they need a session and nothing more (the auth guard 401s the
// rest). (Registered under the /api prefix in index.ts.)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { metricBreakdown, metricDuration } from '../services/woMetrics.js';
import { filterSetSchema } from './views.js';
import { jsonParam } from './workOrders.js';

const eventSchema = z.object({
  field: z.string().min(1).max(200),
  value: z.string().max(500).nullish(),
});

const breakdownQuerySchema = z.object({
  field: z.string().min(1).max(200),
  filters: jsonParam(filterSetSchema).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

const durationQuerySchema = z.object({
  from: jsonParam(eventSchema),
  to: jsonParam(eventSchema),
  filters: jsonParam(filterSetSchema).optional(),
});

export default async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics/breakdown', async (req) => {
    const q = parse(breakdownQuerySchema, req.query);
    return metricBreakdown(q.field, q.filters, q.limit);
  });

  app.get('/metrics/duration', async (req) => {
    const q = parse(durationQuerySchema, req.query);
    return metricDuration(q.from, q.to, q.filters);
  });
}
