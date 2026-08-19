// Routes: GET /work-orders, GET /work-orders/:id, PATCH /work-orders/:id/status,
// and (S2) GET /work-orders/:id/feed + POST /work-orders/:id/comments.
// (Registered under the /api prefix in index.ts.)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../errors.js';
import { listWorkOrders, getWorkOrderDetail, changeStatus } from '../services/workOrders.js';
import { resolveTaskId, resolveActor } from '../services/activity.js';
import { getFeed, addComment } from '../services/feed.js';
import { getMessages, resolveConversationId, sendMessage } from '../services/messages.js';
import { evaluateForTask } from '../services/obligations.js';

const listQuerySchema = z.object({
  status_group: z.enum(['open', 'active', 'pending', 'done', 'closed']).optional(),
  status_id: z.string().uuid().optional(),
  search: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /** S5 · the board's "Sort by breach" toggle. Anything else keeps the default. */
  sort: z.enum(['breach']).optional(),
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

/** X-Actor-Id, normalized (Fastify hands back string | string[] | undefined). */
function actorHeader(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function workOrdersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/work-orders', async (req) => {
    const q = parse(listQuerySchema, req.query);
    return listWorkOrders(q);
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
    return changeStatus(id, status_id, actorHeader(req.headers['x-actor-id']));
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
    const actor = await resolveActor(actorHeader(req.headers['x-actor-id']));
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
    const actor = await resolveActor(actorHeader(req.headers['x-actor-id']));
    const item = await sendMessage(taskId, conversationId, body, actor);

    // S5 · texting the technician is activity on the work order, which is what
    // acknowledging an emergency looks like in practice.
    await evaluateForTask(taskId);
    return reply.status(201).send({ item });
  });
}
