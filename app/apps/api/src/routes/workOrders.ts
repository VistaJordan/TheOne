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
// Permissions (0015) are checked on the ACTING principal — viewing as a
// read-only role behaves as one. Reads are trimmed (redactWorkOrder) to the
// fields the caller may see; writes 403 on the first field they may not edit.
//
// (Registered under the /api prefix in index.ts.)

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { fieldPermKey, tabPermKey } from '@theone/shared';
import { ApiError, parse, notFound, badRequest } from '../errors.js';
import {
  listWorkOrders,
  listMatchingIds,
  getWorkOrderDetail,
  changeStatus,
  type ListFilters,
} from '../services/workOrders.js';
import {
  resolveTaskId,
  actorFromRequest,
  actorIdFromRequest,
  actingPrincipalFromRequest,
} from '../services/activity.js';
import { updateWorkOrderFields, getFieldHistory } from '../services/woFieldValues.js';
import { getFieldTimes } from '../services/woMetrics.js';
import { getFeed, addComment } from '../services/feed.js';
import { getMessages, resolveConversationId, sendMessage } from '../services/messages.js';
import { evaluateForTask } from '../services/obligations.js';
import { bulkDelete, bulkUpdate, exportCsv, importWorkOrders, IMPORT_CAP } from '../services/woBulk.js';
import {
  allowFor,
  assertFieldWrites,
  redactWorkOrder,
  requirePerm,
  visibleColumns,
} from '../services/permissions.js';
import { filterSetSchema, sortSchema } from './views.js';

/** A query-string parameter carrying JSON — `filters` and `sort`. Decoding here
    rather than inventing a flat encoding keeps ONE representation of a filter
    set: the same object the saved view stores, the browser holds, and the
    compiler in woFields.ts reads. */
export const jsonParam = <S extends z.ZodTypeAny>(schema: S) =>
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
  // A status_group_def code; since 0013 admins can add groups, so no enum here.
  // An unknown code simply matches nothing.
  status_group: z.string().trim().min(1).max(60).optional(),
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
  /** S5 · the board's "Sort by breach" toggle — ahead of (not instead of) `sort`. */
  breach: z.coerce.boolean().optional(),
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

// S7 · inline field edit: values keyed by CATALOGUE key (`fields.<json key>`).
const fieldValuesSchema = z.object({
  values: z.record(z.string().min(1).max(200), z.unknown()).refine(
    (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 50,
    'Send between 1 and 50 field values',
  ),
});

const fieldHistoryQuerySchema = z.object({
  field: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Every gate below reads the ACTING principal — the same choice the quote
    gates make: viewing as a read-only role behaves as one. */
function acting(req: FastifyRequest) {
  const p = actingPrincipalFromRequest(req);
  return { p, allow: allowFor(p) };
}

function requireView(req: FastifyRequest) {
  const a = acting(req);
  requirePerm(a.p, 'work_orders', 'view', 'You cannot view work orders');
  return a;
}

/** 403 helper for field writes: the section-level grant, then every key. */
function requireFieldEdit(req: FastifyRequest, catalogueKeys: string[]): string {
  const { p, allow } = acting(req);
  requirePerm(p, 'work_orders', 'edit', 'You cannot edit work orders');
  assertFieldWrites(allow, catalogueKeys);
  return p.id;
}

// The bulk patch names promoted columns directly (client, nte, …) and custom
// keys under `fields`; both become catalogue keys for the per-field gate.
function patchKeys(patch: z.output<typeof bulkPatchSchema>): string[] {
  const { status_id: _s, home_list_id: _h, fields, ...cols } = patch;
  return [
    ...Object.keys(cols),
    ...Object.keys(fields ?? {}).map((k) => `fields.${k}`),
  ];
}

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
    const { allow } = requireView(req);
    const q = parse(listQuerySchema, req.query);
    const page = await listWorkOrders({
      ...criteriaOf(q),
      breach: q.breach,
      columns: visibleColumns(allow, q.columns),
      limit: q.limit,
      offset: q.offset,
    });
    for (const item of page.items) redactWorkOrder(allow, item);
    return page;
  });

  // ── S6 · list-wide operations ──────────────────────────────────────────────
  // These three sit BEFORE /work-orders/:id in source order for readability
  // only — Fastify's radix router prefers a static segment over a parameter, so
  // 'export' can never be mistaken for a work-order id.

  // Every id the current filters match, so "select all 1,240" acts on the whole
  // result set and not just the page the browser happens to be holding.
  app.get('/work-orders/ids', async (req) => {
    requireView(req);
    const q = parse(listCriteriaSchema, req.query);
    const ids = await listMatchingIds(criteriaOf(q));
    return { ids, total: ids.length };
  });

  // A file download, so it answers with text/csv rather than the §5 envelope.
  // The browser reaches it as a same-origin link and the session cookie rides
  // along — no token in the URL to leak into a history entry.
  app.get('/work-orders/export', async (req, reply) => {
    const { p, allow } = requireView(req);
    requirePerm(p, 'work_orders/export', 'view', 'You cannot export work orders');
    const q = parse(listCriteriaSchema, req.query);
    const csv = await exportCsv(criteriaOf(q), visibleColumns(allow, q.columns) ?? []);
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="work-orders-${stamp}.csv"`)
      .send(csv);
  });

  app.post('/work-orders/bulk', async (req) => {
    const { ids, patch } = parse(bulkBodySchema, req.body);
    const { p } = acting(req);
    // A status move is its own grant; routing (home list) rides with it.
    // Writing field VALUES takes the edit grant, then every key named.
    if (patch.status_id !== undefined || patch.home_list_id !== undefined) {
      requirePerm(p, 'work_orders/status', 'edit', 'You cannot change work-order status');
    }
    const keys = patchKeys(patch);
    if (keys.length > 0) requireFieldEdit(req, keys);
    return bulkUpdate(ids, patch, actorIdFromRequest(req));
  });

  app.post('/work-orders/bulk/delete', async (req) => {
    const { p } = acting(req);
    requirePerm(p, 'work_orders', 'delete', 'You cannot delete work orders');
    const { ids } = parse(bulkDeleteSchema, req.body);
    return bulkDelete(ids, actorIdFromRequest(req));
  });

  // The CSV is parsed in the browser and arrives here as rows keyed by FIELD
  // KEY — the header→field mapping is a decision the person importing makes,
  // and it belongs next to the preview where they can see its effect.
  app.post('/work-orders/import', async (req) => {
    const { p, allow } = acting(req);
    requirePerm(p, 'work_orders', 'create', 'You cannot import work orders');
    const { rows, mode, dry_run } = parse(importBodySchema, req.body);
    // Upserting rewrites fields on existing rows: gate every column the file
    // carries, exactly as the bulk editor would.
    const keys = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) keys.add(k);
    assertFieldWrites(allow, [...keys].filter((k) => k !== 'wo_number' && k !== 'title' && k !== 'status'));
    return importWorkOrders(rows, { mode, dry_run }, actorIdFromRequest(req));
  });

  app.get('/work-orders/:id', async (req) => {
    const { allow } = requireView(req);
    const { id } = parse(idParamsSchema, req.params);
    const detail = await getWorkOrderDetail(id);
    if (!detail) throw notFound('Work order not found');
    return redactWorkOrder(allow, detail);
  });

  app.patch('/work-orders/:id/status', async (req) => {
    const { p } = acting(req);
    requirePerm(p, 'work_orders/status', 'edit', 'You cannot change work-order status');
    const { id } = parse(idParamsSchema, req.params);
    const { status_id } = parse(statusBodySchema, req.body);
    return changeStatus(id, status_id, actorIdFromRequest(req));
  });

  // S7 · the inline editor on the All-fields tab. One or many values, typed
  // coercion + mirror sync in the service, fresh detail back.
  app.patch('/work-orders/:id/fields', async (req) => {
    const { id } = parse(idParamsSchema, req.params);
    const { values } = parse(fieldValuesSchema, req.body);
    const actorId = requireFieldEdit(req, Object.keys(values));
    const { allow } = acting(req);
    const res = await updateWorkOrderFields(id, values, actorId);
    if (res.detail) redactWorkOrder(allow, res.detail);
    return res;
  });

  // S7 · one field's change history, permission-gated twice: the history
  // grant, and the field itself must be one the caller may see.
  app.get('/work-orders/:id/field-history', async (req) => {
    const { id } = parse(idParamsSchema, req.params);
    const { field, limit } = parse(fieldHistoryQuerySchema, req.query);
    const { p, allow } = requireView(req);
    requirePerm(p, 'work_orders/history', 'view', 'You cannot view field history');
    assertFieldVisible(allow, field);
    const taskId = await resolveTaskId(id);
    if (!taskId) throw notFound('Work order not found');
    return { items: await getFieldHistory(taskId, field, limit) };
  });

  // Per-field change timestamps — the audit trail as data. Unlike
  // /field-history this carries no before/after trail: just when each field
  // first/last changed and what it became, for any page that needs the
  // timestamps without displaying the history. Hidden fields are left out.
  app.get('/work-orders/:id/field-times', async (req) => {
    const { allow } = requireView(req);
    const { id } = parse(idParamsSchema, req.params);
    const taskId = await resolveTaskId(id);
    if (!taskId) throw notFound('Work order not found');
    const items = await getFieldTimes(taskId);
    return { items: items.filter((t) => allow(fieldPermKey(t.field), 'view')) };
  });

  // S2 · the merged updates+activity stream, newest-first.
  app.get('/work-orders/:id/feed', async (req) => {
    const { p } = requireView(req);
    requirePerm(p, tabPermKey('overview'), 'view', 'You cannot view the Overview tab');
    const { id } = parse(idParamsSchema, req.params);
    const taskId = await resolveTaskId(id);
    if (!taskId) throw notFound('Work order not found');
    return getFeed(taskId);
  });

  // S2 · the second write path: post an internal or client-visible update.
  app.post('/work-orders/:id/comments', async (req, reply) => {
    const { p } = acting(req);
    requirePerm(p, 'work_orders/comments', 'create', 'You cannot post updates');
    const { id } = parse(idParamsSchema, req.params);
    const { body, client_visible } = parse(commentBodySchema, req.body);
    const taskId = await resolveTaskId(id);
    if (!taskId) throw notFound('Work order not found');

    // Resolved outside the transaction — PGlite is single-connection (see feed.ts).
    const actor = actorFromRequest(req);
    const item = await addComment(taskId, body, client_visible, actor);

    // S5 · a comment is EVIDENCE. Any comment acknowledges an emergency; a
    // client-visible one is the chase that silences approval_followup.
    await evaluateForTask(taskId);
    return reply.status(201).send({ item });
  });

  // S3 · the Quo conversation mirror — oldest-first thread + its channel header.
  // A WO with no linked Quo line is NOT an error: it returns conversation:null
  // and the web renders the empty state.
  app.get('/work-orders/:id/messages', async (req) => {
    const { p } = requireView(req);
    requirePerm(p, tabPermKey('messages'), 'view', 'You cannot view messages');
    const { id } = parse(idParamsSchema, req.params);
    const taskId = await resolveTaskId(id);
    if (!taskId) throw notFound('Work order not found');
    return getMessages(taskId);
  });

  // S3 · the third write path: send a text to the technician. Local-only until
  // the real Quo pipe lands, hence pending_sync=true on the stored row.
  app.post('/work-orders/:id/messages', async (req, reply) => {
    const { p } = acting(req);
    requirePerm(p, tabPermKey('messages'), 'view', 'You cannot send messages');
    const { id } = parse(idParamsSchema, req.params);
    const { body } = parse(messageBodySchema, req.body);
    const taskId = await resolveTaskId(id);
    if (!taskId) throw notFound('Work order not found');

    const conversationId = await resolveConversationId(taskId);
    if (!conversationId) throw notFound('No Quo conversation linked to this work order');

    // Resolved outside the transaction — PGlite is single-connection (see messages.ts).
    const actor = actorFromRequest(req);
    const item = await sendMessage(taskId, conversationId, body, actor);

    // S5 · texting the technician is activity on the work order, which is what
    // acknowledging an emergency looks like in practice.
    await evaluateForTask(taskId);
    return reply.status(201).send({ item });
  });
}

// History and field-times address fields by CATALOGUE key ('fields.<key>' or a
// promoted column) — the same address the permission path is built from.
function assertFieldVisible(allow: ReturnType<typeof allowFor>, key: string): void {
  if (!allow(fieldPermKey(key), 'view')) {
    throw new ApiError('FORBIDDEN', `You cannot view "${key.replace(/^fields\./, '')}"`, {
      required_permission: `${fieldPermKey(key)}:view`,
    });
  }
}
