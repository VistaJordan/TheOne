// Routes: the sign-off sheet of a work order (migration 0070). Nested under
// the work order like every per-work-order route — :id is its uuid or WO
// number and resolves through the work-order scope.
//
//   GET    /work-orders/:id/signoff                       sheet, technicians, held replies, what the viewer may do
//   POST   /work-orders/:id/signoff                       draw a (new) blank sheet
//   GET    /work-orders/:id/signoff/file                  the blank PDF, for the dispatcher
//   POST   /work-orders/:id/signoff/share                 { phone, tech_name?, vendor_id? } → text it through Quo
//   POST   /work-orders/:id/signoff/replies/:replyId/claim    a held signed copy is this work order's
//   POST   /work-orders/:id/signoff/replies/:replyId/dismiss  … or not
//
//   GET    /public/signoff/:token                         the technician's download (no session; the
//                                                         token is the credential — plugins/authGuard)
//
// The signed copy arrives through POST /webhooks/quo (message.received) —
// routes/webhooks.ts → services/woCalls → services/signoff.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound, parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import {
  claimReply,
  dismissReply,
  generateSignoff,
  getSignoff,
  publicSignoffFile,
  readSignoffFile,
  shareSignoff,
  type SheetFile,
} from '../services/signoff.js';

const idParams = z.object({ id: z.string().min(1) });
const replyParams = z.object({ id: z.string().min(1), replyId: z.string().uuid() });
const tokenParams = z.object({ token: z.string().min(1).max(64) });

const shareSchema = z
  .object({
    phone: z.string().trim().min(1).max(40),
    tech_name: z.string().trim().max(200).nullable().optional().transform((v) => (v ? v : null)),
    vendor_id: z.string().uuid().nullable().optional().transform((v) => (v ? v : null)),
  })
  .strict();

async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParams, req.params);
  const taskId = await resolveTaskId(id, actingPrincipalFromRequest(req));
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

function sendPdf(reply: FastifyReply, file: SheetFile, disposition: 'inline' | 'attachment') {
  return reply
    .header('Content-Type', 'application/pdf')
    .header('Content-Disposition', `${disposition}; filename="${file.fileName.replace(/"/g, '')}"`)
    .header('Cache-Control', 'private, no-store')
    .header('X-Robots-Tag', 'noindex, nofollow')
    .send(file.stream);
}

export default async function signoffRoutes(app: FastifyInstance): Promise<void> {
  app.get('/work-orders/:id/signoff', async (req) => getSignoff(await taskIdOf(req), actingPrincipalFromRequest(req)));

  app.post('/work-orders/:id/signoff', async (req) => generateSignoff(await taskIdOf(req), actingPrincipalFromRequest(req)));

  app.get('/work-orders/:id/signoff/file', async (req, reply) => {
    const file = await readSignoffFile(await taskIdOf(req), actingPrincipalFromRequest(req));
    return sendPdf(reply, file, 'inline');
  });

  app.post('/work-orders/:id/signoff/share', async (req) => {
    const body = parse(shareSchema, req.body);
    return shareSignoff(await taskIdOf(req), body, actingPrincipalFromRequest(req));
  });

  app.post('/work-orders/:id/signoff/replies/:replyId/claim', async (req) => {
    const { replyId } = parse(replyParams, req.params);
    return claimReply(await taskIdOf(req), replyId, actingPrincipalFromRequest(req));
  });

  app.post('/work-orders/:id/signoff/replies/:replyId/dismiss', async (req) => {
    const { replyId } = parse(replyParams, req.params);
    return dismissReply(await taskIdOf(req), replyId, actingPrincipalFromRequest(req));
  });

  // The technician's link. Inline so a phone shows the sheet straight away;
  // the filename is there for "share" / "print" on the phone.
  app.get('/public/signoff/:token', async (req, reply) => {
    const { token } = parse(tokenParams, req.params);
    const file = await publicSignoffFile(token);
    return sendPdf(reply, file, 'inline');
  });
}
