// Routes: the assistant (migration 0068).
//
//   GET    /assistant/status                     switched on? questions left today? may teach?
//   GET    /assistant/conversations              mine, newest first
//   GET    /assistant/conversations/:id          one of mine, with its messages
//   DELETE /assistant/conversations/:id
//   POST   /assistant/ask                        a question → the answer (takes as long as the look-ups do)
//   POST   /assistant/messages/:id/feedback      thumb up / down / clear on one of my answers
//   GET    /assistant/notes                      what it has been taught        (assistant: edit)
//   POST   /assistant/notes
//   PATCH  /assistant/notes/:id
//   DELETE /assistant/notes/:id
//   GET    /assistant/feedback                   the answers people marked      (assistant: edit)
//   POST   /assistant/feedback/:id/reviewed
//
// Conversations belong to the person signed in; the look-ups behind an answer
// run as whoever they are acting as, through the same session cookie the
// browser sent with the question.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ASSISTANT_NOTE_BODY_MAX, ASSISTANT_NOTE_TITLE_MAX, ASSISTANT_QUESTION_MAX } from '@theone/shared';
import { parse } from '../errors.js';
import { unauthorized } from '../services/auth.js';
import {
  ask,
  assistantStatus,
  createNote,
  deleteConversation,
  deleteNote,
  getConversation,
  listConversations,
  listFeedback,
  listNotes,
  markReviewed,
  setFeedback,
  updateNote,
} from '../services/assistant.js';
import type { Asker } from '../services/assistant.js';

const idParams = z.object({ id: z.string().min(1).max(60) });

const askSchema = z
  .object({
    conversation_id: z.string().uuid().nullable().optional(),
    question: z.string().trim().min(1).max(ASSISTANT_QUESTION_MAX),
    page: z.string().max(400).nullable().optional(),
  })
  .strict();

const feedbackSchema = z
  .object({
    rating: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
    note: z
      .string()
      .trim()
      .max(1000)
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .strict();

const noteSchema = z
  .object({
    title: z.string().trim().min(1).max(ASSISTANT_NOTE_TITLE_MAX),
    body: z.string().trim().min(1).max(ASSISTANT_NOTE_BODY_MAX),
    is_active: z.boolean().optional(),
  })
  .strict();

const reviewedSchema = z.object({ reviewed: z.boolean().default(true) }).strict();

function askerOf(req: FastifyRequest): Asker {
  if (!req.auth) throw unauthorized();
  return { user: req.auth.user, actingAs: req.auth.actingAs, cookie: req.headers.cookie ?? '' };
}

export default async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.get('/assistant/status', async (req) => assistantStatus(askerOf(req)));

  app.get('/assistant/conversations', async (req) => listConversations(askerOf(req)));

  app.get('/assistant/conversations/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return getConversation(askerOf(req), id);
  });

  app.delete('/assistant/conversations/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deleteConversation(askerOf(req), id);
    return reply.status(204).send();
  });

  app.post('/assistant/ask', async (req) => ask(app, askerOf(req), parse(askSchema, req.body)));

  app.post('/assistant/messages/:id/feedback', async (req) => {
    const { id } = parse(idParams, req.params);
    const { rating, note } = parse(feedbackSchema, req.body);
    return { message: await setFeedback(askerOf(req), id, rating, note) };
  });

  app.get('/assistant/notes', async (req) => listNotes(askerOf(req)));

  app.post('/assistant/notes', async (req, reply) => {
    const note = await createNote(askerOf(req), parse(noteSchema, req.body));
    return reply.status(201).send({ note });
  });

  app.patch('/assistant/notes/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { note: await updateNote(askerOf(req), id, parse(noteSchema, req.body)) };
  });

  app.delete('/assistant/notes/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deleteNote(askerOf(req), id);
    return reply.status(204).send();
  });

  app.get('/assistant/feedback', async (req) => listFeedback(askerOf(req)));

  app.post('/assistant/feedback/:id/reviewed', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { reviewed } = parse(reviewedSchema, req.body ?? {});
    await markReviewed(askerOf(req), id, reviewed);
    return reply.status(204).send();
  });
}
