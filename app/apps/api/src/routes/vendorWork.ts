// Routes: the vendor relations workflow (migration 0058) — everything around
// the vendor record that routes/vendors.ts does not carry.
//
// The list
//   GET    /vendors/ids                    every id the filters match (select all)
//   POST   /vendors/bulk                   edit a selection  { ids, patch }
//   POST   /vendors/bulk-delete            remove a selection { ids }
//   GET    /vendors/export                 the filtered list as CSV
//   POST   /vendors/bulk-search            paste names / phones / emails
//   GET    /vendors/views · POST · DELETE /vendors/views/:viewId     saved lists
// The work
//   GET    /vendors/tasks · POST           my tasks (+ the review queue) / a manual task
//   POST   /vendors/tasks/:taskId/resolve  { action, note? }
//   PUT    /vendors/targets                a rep's daily target
//   GET    /vendors/alerts                 insurance dates, soonest first
//   GET    /vendors/data-quality           duplicates · missing information · not on the map
// Import
//   POST   /vendors/imports/analyze        what the rows would do (writes nothing)
//   POST   /vendors/imports                start a run → id
//   POST   /vendors/imports/:importId/rows one chunk of rows
//   GET    /vendors/imports                the last runs
// One record
//   GET    /vendors/:id/work               documents, COI reviews, calls, emails, tasks, problems
//   POST   /vendors/:id/documents          upload (base64 in JSON, like attachments)
//   GET    /vendors/:id/documents/:docId   the bytes · PATCH rename · DELETE
//   PUT    /vendors/:id/coi/:entity        the six ticks
//   POST   /vendors/:id/calls · PATCH / DELETE /vendors/:id/calls/:callId
//   POST   /vendors/:id/emails
// Admin
//   GET    /admin/vendors/required-fields · PUT /admin/vendors/required-fields/:key
//
// Registered BEFORE routes/vendors.ts would matter only for a router that
// matched in order; this one prefers a static segment over :id, so
// /vendors/tasks never reaches GET /vendors/:id.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COI_CHECKLIST, IMPORT_MAX_ROWS } from '@theone/shared';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import { requireVendorAdmin } from '../services/vendorMap.js';
import { analyzeImport, importRows, listImports, startImport } from '../services/vendorImport.js';
import {
  bulkDelete,
  bulkSearch,
  bulkUpdate,
  createManualTask,
  dataQuality,
  deleteView,
  documentStorageReady,
  editCall,
  exportCsv,
  listAlerts,
  listSavedViews,
  listTasks,
  logCall,
  logEmail,
  matchingIds,
  readDocument,
  refreshMissingFlags,
  removeCall,
  removeDocument,
  renameDocument,
  requiredFieldSettings,
  resolveTask,
  saveCoiChecklist,
  saveView,
  setDailyTarget,
  setRequiredField,
  sweepExpiries,
  uploadDocument,
  vendorWork,
} from '../services/vendorWork.js';
import { listQuery, toListQuery } from './vendors.js';

const idParams = z.object({ id: z.string().min(1) });
const text = (max: number) => z.string().max(max).nullable().optional();
const ids = z.array(z.string().uuid()).min(1).max(5000);
/** Vercel caps a request at 4.5 MB; a 3 MB file is 4 MB of base64. */
const BIG_BODY = { bodyLimit: Math.floor(4.4 * 1024 * 1024) };

export default async function vendorWorkRoutes(app: FastifyInstance): Promise<void> {
  // ── The list ───────────────────────────────────────────────────────────────
  app.get('/vendors/ids', async (req) => ({ ids: await matchingIds(toListQuery(parse(listQuery, req.query)), actingPrincipalFromRequest(req)) }));

  app.post('/vendors/bulk', async (req) => {
    const body = parse(
      z
        .object({
          ids,
          patch: z
            .object({
              status: z.string().trim().min(1).max(40).optional(),
              owner_id: z.string().uuid().nullable().optional(),
              primary_trade: z.string().trim().min(1).max(80).optional(),
              state: z.string().trim().min(2).max(40).optional(),
              city: z.string().trim().min(1).max(120).optional(),
              brand_source: z.string().trim().max(40).nullable().optional(),
            })
            .strict(),
        })
        .strict(),
      req.body,
    );
    return bulkUpdate(body.ids, body.patch, actingPrincipalFromRequest(req));
  });

  app.post('/vendors/bulk-delete', async (req) => {
    const body = parse(z.object({ ids }).strict(), req.body);
    return bulkDelete(body.ids, actingPrincipalFromRequest(req));
  });

  app.get('/vendors/export', async (req, reply) => {
    const { csv } = await exportCsv(toListQuery(parse(listQuery, req.query)), actingPrincipalFromRequest(req));
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="vendors-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header('Cache-Control', 'no-store')
      .send(csv);
  });

  app.post('/vendors/bulk-search', async (req) => {
    const body = parse(
      z.object({ field: z.enum(['name', 'phone', 'email']), terms: z.array(z.string().max(320)).min(1).max(300) }).strict(),
      req.body,
    );
    return { results: await bulkSearch(body.field, body.terms, actingPrincipalFromRequest(req)) };
  });

  app.get('/vendors/views', async (req) => ({ views: await listSavedViews(actingPrincipalFromRequest(req)) }));

  app.post('/vendors/views', async (req, reply) => {
    const body = parse(
      z
        .object({
          name: z.string().trim().min(1).max(120),
          params: z.record(z.unknown()),
          visibility: z.enum(['PRIVATE', 'MANAGERS', 'EVERYONE']).optional(),
        })
        .strict(),
      req.body,
    );
    return reply.status(201).send({ views: await saveView(body, actingPrincipalFromRequest(req)) });
  });

  app.delete('/vendors/views/:viewId', async (req) => {
    const { viewId } = parse(z.object({ viewId: z.string().min(1) }), req.params);
    return { views: await deleteView(viewId, actingPrincipalFromRequest(req)) };
  });

  // ── The work ───────────────────────────────────────────────────────────────
  app.get('/vendors/tasks', async (req) => {
    // Insurance dates move vendors on their own; bring them in step first so
    // the queue and the list agree with the calendar.
    await sweepExpiries();
    return listTasks(actingPrincipalFromRequest(req));
  });

  app.post('/vendors/tasks', async (req, reply) => {
    const body = parse(
      z
        .object({
          title: z.string().trim().min(1).max(500),
          vendor_id: z.string().uuid().nullable().optional(),
          assigned_to: z.string().uuid().nullable().optional(),
        })
        .strict(),
      req.body,
    );
    return reply.status(201).send({ task: await createManualTask(body, actingPrincipalFromRequest(req)) });
  });

  app.post('/vendors/tasks/:taskId/resolve', async (req) => {
    const { taskId } = parse(z.object({ taskId: z.string().min(1) }), req.params);
    const body = parse(
      z.object({ action: z.enum(['keep', 'remove', 'acknowledge', 'approve', 'send_back', 'fixed', 'done']), note: text(2000) }).strict(),
      req.body,
    );
    return { task: await resolveTask(taskId, body.action, body.note ?? null, actingPrincipalFromRequest(req)) };
  });

  app.put('/vendors/targets', async (req) => {
    const body = parse(
      z
        .object({
          principal_id: z.string().uuid(),
          day: z.string().max(10).optional(),
          nationwide_target: z.number().min(0).max(10000),
          statewide_target: z.number().min(0).max(10000),
        })
        .strict(),
      req.body,
    );
    return { targets: await setDailyTarget(body, actingPrincipalFromRequest(req)) };
  });

  app.get('/vendors/alerts', async (req) => ({ alerts: await listAlerts(actingPrincipalFromRequest(req)) }));

  app.get('/vendors/data-quality', async (req) => {
    const q = parse(z.object({ by: z.enum(['phone', 'name', 'email']).default('phone') }), req.query);
    return dataQuality(q.by, actingPrincipalFromRequest(req));
  });

  // ── Import ─────────────────────────────────────────────────────────────────
  const rowSchema = z.record(z.string().max(4000));
  const mapping = z.record(z.string().max(80));

  app.post('/vendors/imports/analyze', BIG_BODY, async (req) => {
    const body = parse(
      z.object({ rows: z.array(rowSchema).max(IMPORT_MAX_ROWS), mapping, kind: z.enum(['vendor', 'tech']) }).strict(),
      req.body,
    );
    return { analysis: await analyzeImport(body, actingPrincipalFromRequest(req)) };
  });

  app.post('/vendors/imports', async (req, reply) => {
    const body = parse(
      z
        .object({
          file_name: z.string().trim().min(1).max(200),
          kind: z.enum(['vendor', 'tech']),
          total_rows: z.number().int().min(1).max(IMPORT_MAX_ROWS),
          mapping,
          duplicate_strategy: z.enum(['SKIP', 'FLAG', 'ADD_ANYWAY', 'ENRICH']),
          missing_strategy: z.enum(['ADD', 'SKIP']),
        })
        .strict(),
      req.body,
    );
    return reply.status(201).send(await startImport(body, actingPrincipalFromRequest(req)));
  });

  app.post('/vendors/imports/:importId/rows', BIG_BODY, async (req) => {
    const { importId } = parse(z.object({ importId: z.string().min(1) }), req.params);
    const body = parse(
      z.object({ offset: z.number().int().min(0), rows: z.array(rowSchema).min(1).max(250), brand_source: text(40) }).strict(),
      req.body,
    );
    return { summary: await importRows(importId, body, actingPrincipalFromRequest(req)) };
  });

  app.get('/vendors/imports', async (req) => ({ imports: await listImports(actingPrincipalFromRequest(req)) }));

  // ── One record ─────────────────────────────────────────────────────────────
  app.get('/vendors/:id/work', async (req) => {
    const { id } = parse(idParams, req.params);
    return vendorWork(id, actingPrincipalFromRequest(req));
  });

  app.post('/vendors/:id/documents', BIG_BODY, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z
        .object({
          type: z.enum(['W9', 'MSA', 'COI', 'OTHER']),
          entity: text(40),
          file_name: z.string().trim().min(1).max(200),
          content_type: z.string().max(120),
          data: z.string().min(1),
        })
        .strict(),
      req.body,
    );
    return reply.status(201).send(await uploadDocument(id, body, actingPrincipalFromRequest(req)));
  });

  const docParams = z.object({ id: z.string().min(1), docId: z.string().min(1) });

  // The bytes. An <iframe> / <img> hits this, so it answers with the file
  // itself, privately, never a link to storage.
  app.get('/vendors/:id/documents/:docId', async (req, reply) => {
    const p = parse(docParams, req.params);
    const file = await readDocument(p.id, p.docId, actingPrincipalFromRequest(req));
    return reply
      .header('Content-Type', file.contentType)
      .header('Content-Disposition', `inline; filename="${file.fileName.replace(/"/g, '')}"`)
      .header('Cache-Control', 'private, max-age=300')
      .send(file.stream);
  });

  app.patch('/vendors/:id/documents/:docId', async (req) => {
    const p = parse(docParams, req.params);
    const body = parse(z.object({ file_name: z.string().trim().min(1).max(200) }).strict(), req.body);
    return renameDocument(p.id, p.docId, body.file_name, actingPrincipalFromRequest(req));
  });

  app.delete('/vendors/:id/documents/:docId', async (req) => {
    const p = parse(docParams, req.params);
    return removeDocument(p.id, p.docId, actingPrincipalFromRequest(req));
  });

  const checks = z.object(Object.fromEntries(COI_CHECKLIST.map((c) => [c.key, z.boolean().optional()]))).strict();

  app.put('/vendors/:id/coi/:entity', async (req) => {
    const p = parse(z.object({ id: z.string().min(1), entity: z.string().min(1).max(40) }), req.params);
    const body = parse(checks, req.body);
    return saveCoiChecklist(p.id, p.entity, body, actingPrincipalFromRequest(req));
  });

  const callSchema = z
    .object({
      occurred_at: text(40),
      notes: text(20000),
      call_link: text(2000),
      transcript: text(200000),
      summary: text(20000),
      resulting_status: text(40),
    })
    .strict();

  app.post('/vendors/:id/calls', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    return reply.status(201).send(await logCall(id, parse(callSchema, req.body), actingPrincipalFromRequest(req)));
  });

  const callParams = z.object({ id: z.string().min(1), callId: z.string().min(1) });

  app.patch('/vendors/:id/calls/:callId', async (req) => {
    const p = parse(callParams, req.params);
    return editCall(p.id, p.callId, parse(callSchema, req.body), actingPrincipalFromRequest(req));
  });

  app.delete('/vendors/:id/calls/:callId', async (req) => {
    const p = parse(callParams, req.params);
    return removeCall(p.id, p.callId, actingPrincipalFromRequest(req));
  });

  app.post('/vendors/:id/emails', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ sent_at: text(40), subject: text(500), notes: text(20000) }).strict(), req.body);
    return reply.status(201).send(await logEmail(id, body, actingPrincipalFromRequest(req)));
  });

  // ── Admin › Vendors & map: required fields ─────────────────────────────────
  app.get('/admin/vendors/required-fields', async (req) => {
    requireVendorAdmin(actingPrincipalFromRequest(req), 'view');
    return { fields: await requiredFieldSettings(), storage_ready: documentStorageReady() };
  });

  app.put('/admin/vendors/required-fields/:key', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requireVendorAdmin(actor, 'edit');
    const { key } = parse(z.object({ key: z.string().min(1).max(60) }), req.params);
    const body = parse(z.object({ required: z.boolean() }).strict(), req.body);
    await setRequiredField(key, body.required, actor);
    // A vendor that was complete may now be missing something, and the reverse.
    await refreshMissingFlags();
    return { fields: await requiredFieldSettings(), storage_ready: documentStorageReady() };
  });
}
