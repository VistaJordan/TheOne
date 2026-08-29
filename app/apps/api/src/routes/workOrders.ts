// Routes: GET /work-orders, GET /work-orders/:id, PATCH /work-orders/:id/status,
// (S2) GET /work-orders/:id/feed + POST /work-orders/:id/comments, and
// (S6) the list-wide operations the saved-view UI is built on:
//
//   GET  /work-orders/ids           every id the current filters match
//   GET  /work-orders/export        those rows as CSV, in the chosen columns
//   POST /work-orders/bulk          apply one patch to many work orders
//   POST /work-orders/bulk/delete   soft-delete many
//   POST /work-orders/import        create/update from parsed CSV rows
//
// (Registered under the /api prefix in index.ts.)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, notFound, badRequest } from '../errors.js';
import {
  listWorkOrders,
  listMatchingIds,
  getWorkOrderDetail,
  changeStatus,
  type ListFilters,
} from '../services/workOrders.js';
import { resolveTaskId, actorFromRequest, actorIdFromRequest } from '../services/activity.js';
import { getFeed, addComment } from '../services/feed.js';
import { getMessages, resolveConversationId, sendMessage } from '../services/messages.js';
import { bulkDelete, bulkUpdate, exportCsv, importWorkOrders, IMPORT_CAP } from '../services/woBulk.js';
import { filterSetSchema, sortSchema } from './views.js';

/** A query-string parameter carrying JSON — `filters` and `sort`. Decoding here
    rather than inventing a flat encoding keeps ONE representation of a filter
    set: the same object the saved view stores, the browser holds, and the
    compiler in woFields.ts reads. */
const jsonParam = <S extends z.ZodTypeAny>(schema: S) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    if (v.trim() === '') return undefined;
    try {
      return JSON.parse(v);
    } catch {
      throw badRequest('Malformed JSON in a query parameter');
    }
  }, schema);

/** A comma-separated list — `columns=wo_number,client,status`. */
const csvParam = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
  z.array(z.string().min(1)).max(60),
);

// The shape shared by the list, the CSV export, and "select everything that
// matches". They must read the same parameters or the three would disagree
// about which rows the user is looking at.
const listCriteriaSchema = z.object({
  status_group: z.enum(['open', 'active', 'done', 'closed']).optional(),
  status_id: z.string().uuid().optional(),
  search: z.string().trim().min(1).optional(),
  filters: jsonParam(filterSetSchema).optional(),
  sort: jsonParam(sortSchema).nullish(),
  group_by: z.string().min(1).optional(),
  columns: csvParam.optional(),
});

const listQuerySchema = listCriteriaSchema.extend({
  // Raised from 200: a grouped list renders every bucket at once, and a view
  // grouped by trade over a few hundred work orders is an ordinary thing to ask.
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function criteriaOf(q: z.output<typeof listCriteriaSchema>): Omit<ListFilters, 'limit' | 'offset'> {
  return {
    status_group: q.status_group,
    status_id: q.status_id,
    search: q.search,
    filters: q.filters,
    sort: q.sort ?? null,
    group_by: q.group_by ?? null,
    columns: q.columns,
  };
}

// ── Bulk / import bodies ─────────────────────────────────────────────────────

const BULK_ID_CAP = 5000;

const bulkPatchSchema = z
  .object({
    status_id: z.string().uuid().optional(),
    home_list_id: z.string().uuid().nullable().optional(),
    client: z.string().trim().max(200).nullable().optional(),
    trade: z.string().trim().max(120).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(60).nullable().optional(),
    billing_entity: z.string().trim().max(120).nullable().optional(),
    priority: z.enum(['urgent', 'high', 'normal', 'low']).nullable().optional(),
    nte: z.coerce.number().nonnegative().nullable().optional(),
    date_received: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    fields: z.record(z.string(), z.string().nullable()).optional(),
  })
  .strict();

const bulkBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(BULK_ID_CAP),
  patch: bulkPatchSchema,
});

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(BULK_ID_CAP),
});

const importBodySchema = z.object({
  rows: z.array(z.record(z.string(), z.string().nullable())).min(1).max(IMPORT_CAP),
  mode: z.enum(['create', 'upsert']).default('upsert'),
  dry_run: z.boolean().default(false),
});

const idParamsSchema = z.object({ id: z.string().min(1) });

const statusBodySchema = z.object({ status_id: z.string().uuid() });

// S2: an update is 1..4000 chars of real text (whitespace-only is empty).
const commentBodySchema = z.object({
  body: z.string().trim().min(1).max(4000),
  client_visible: z.boolean(),
});

// S3: one SMS is 1..1600 chars of real text (1600 = the 10-segment concatenated
// SMS ceiling carriers accept; whitespace-only is empty).
const messageBodySchema = z.object({
  body: z.string().trim().min(1).max(1600),
});


export default async function workOrdersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/work-orders', async (req) => {
    const q = parse(listQuerySchema, req.query);
    return listWorkOrders({ ...criteriaOf(q), limit: q.limit, offset: q.offset });
  });

  // ── S6 · list-wide operations ──────────────────────────────────────────────
  // These three sit BEFORE /work-orders/:id in source order for readability
  // only — Fastify's radix router prefers a static segment over a parameter, so
  // 'export' can never be mistaken for a work-order id.

  // Every id the current filters match, so "select all 1,240" acts on the whole
  // result set and not just the page the browser happens to be holding.
  app.get('/work-orders/ids', async (req) => {
    const q = parse(listCriteriaSchema, req.query);
    const ids = await listMatchingIds(criteriaOf(q));
    return { ids, total: ids.length };
  });

  // A file download, so it answers with text/csv rather than the §5 envelope.
  // The browser reaches it as a same-origin link and the session cookie rides
  // along — no token in the URL to leak into a history entry.
  app.get('/work-orders/export', async (req, reply) => {
    const q = parse(listCriteriaSchema, req.query);
    const csv = await exportCsv(criteriaOf(q), q.columns ?? []);
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="work-orders-${stamp}.csv"`)
      .send(csv);
  });

  app.post('/work-orders/bulk', async (req) => {
    const { ids, patch } = parse(bulkBodySchema, req.body);
    return bulkUpdate(ids, patch, actorIdFromRequest(req));
  });

  app.post('/work-orders/bulk/delete', async (req) => {
    const { ids } = parse(bulkDeleteSchema, req.body);
    return bulkDelete(ids, actorIdFromRequest(req));
  });

  // The CSV is parsed in the browser and arrives here as rows keyed by FIELD
  // KEY — the header→field mapping is a decision the person importing makes,
  // and it belongs next to the preview where they can see its effect.
  app.post('/work-orders/import', async (req) => {
    const { rows, mode, dry_run } = parse(importBodySchema, req.body);
    return importWorkOrders(rows, { mode, dry_run }, actorIdFromRequest(req));
  });

  app.get('/work-orders/:id', async (req) => {
    const { id } = parse(idParamsSchema, req.params);
    const detail = await getWorkOrderDetail(id);
    if (!detail) throw notFound('Work order not found');
    return detail;
  });

  app.patch('/work-orders/:id/status', async (req) => {
    const { id } = parse(idParamsSchema, req.params);
    const { status_id } = parse(statusBodySchema, req.body);
    return changeStatus(id, status_id, actorIdFromRequest(req));
  });

  // S2 · the merged updates+activity stream, newest-first.
  app.get('/work-orders/:id/feed', async (req) => {
    const { id } = parse(idParamsSchema, req.params);
    const taskId = await resolveTaskId(id);
    if (!taskId) throw notFound('Work order not found');
    return getFeed(taskId);
  });

  // S2 · the second write path: post an internal or client-visible update.
  app.post('/work-orders/:id/comments', async (req, reply) => {
    const { id } = parse(idParamsSchema, req.params);
    const { body, client_visible } = parse(commentBodySchema, req.body);
    const taskId = await resolveTaskId(id);
    if (!taskId) throw notFound('Work order not found');

    // Resolved outside the transaction — PGlite is single-connection (see feed.ts).
    const actor = actorFromRequest(req);
    const item = await addComment(taskId, body, client_visible, actor);
    return reply.status(201).send({ item });
  });

  // S3 · the Quo conversation mirror — oldest-first thread + its channel header.
  // A WO with no linked Quo line is NOT an error: it returns conversation:null
  // and the web renders the empty state.
  app.get('/work-orders/:id/messages', async (req) => {
    const { id } = parse(idParamsSchema, req.params);
    const taskId = await resolveTaskId(id);
    if (!taskId) throw notFound('Work order not found');
    return getMessages(taskId);
  });

  // S3 · the third write path: send a text to the technician. Local-only until
  // the real Quo pipe lands, hence pending_sync=true on the stored row.
  app.post('/work-orders/:id/messages', async (req, reply) => {
    const { id } = parse(idParamsSchema, req.params);
    const { body } = parse(messageBodySchema, req.body);
    const taskId = await resolveTaskId(id);
    if (!taskId) throw notFound('Work order not found');

    const conversationId = await resolveConversationId(taskId);
    if (!conversationId) throw notFound('No Quo conversation linked to this work order');

    // Resolved outside the transaction — PGlite is single-connection (see messages.ts).
    const actor = actorFromRequest(req);
    const item = await sendMessage(taskId, conversationId, body, actor);
    return reply.status(201).send({ item });
  });
}
