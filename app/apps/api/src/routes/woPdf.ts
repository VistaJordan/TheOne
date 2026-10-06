// Routes: a work order as a PDF (migration 0073), and the two layouts an
// administrator edits in Admin › Settings.
//
//   GET  /work-orders/:id/pdf?kind=full|request[&download=1]
//        the document (inline by default; download=1 sets the attachment
//        disposition so the browser saves it under the WO number).
//        :id is the uuid or the WO number and resolves through the work-order
//        scope like every per-work-order route.
//   GET  /admin/pdf-layouts            both layouts + every field they may list
//   PUT  /admin/pdf-layouts/:kind      { title?, items?, hide_empty?, note? }

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { WO_PDF_KINDS } from '@theone/shared';
import { notFound, parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import { getPdfLayouts, savePdfLayout, workOrderPdf } from '../services/woPdf.js';

const idParams = z.object({ id: z.string().min(1) });
const kindParams = z.object({ kind: z.enum(WO_PDF_KINDS) });
const pdfQuery = z.object({
  kind: z.enum(WO_PDF_KINDS).default('full'),
  download: z.enum(['1', 'true', '0', 'false']).optional(),
});
const layoutBody = z
  .object({
    title: z.string().max(200).optional(),
    items: z.array(z.string().max(200)).max(200).optional(),
    hide_empty: z.boolean().optional(),
    note: z.string().max(4000).nullable().optional(),
  })
  .strict();

async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParams, req.params);
  const taskId = await resolveTaskId(id, actingPrincipalFromRequest(req));
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

export default async function woPdfRoutes(app: FastifyInstance): Promise<void> {
  app.get('/work-orders/:id/pdf', async (req, reply) => {
    const q = parse(pdfQuery, req.query);
    const actor = actingPrincipalFromRequest(req);
    const file = await workOrderPdf(await taskIdOf(req), q.kind, actor);
    const disposition = q.download === '1' || q.download === 'true' ? 'attachment' : 'inline';
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `${disposition}; filename="${file.fileName.replace(/"/g, '')}"`)
      .header('Cache-Control', 'private, no-store')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .send(Buffer.from(file.bytes));
  });

  app.get('/admin/pdf-layouts', async (req) => getPdfLayouts(actingPrincipalFromRequest(req)));

  app.put('/admin/pdf-layouts/:kind', async (req) => {
    const { kind } = parse(kindParams, req.params);
    return savePdfLayout(kind, parse(layoutBody, req.body), actingPrincipalFromRequest(req));
  });
}
