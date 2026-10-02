// Routes: the work-order record (0064).
//
// On a work order (every one resolves the id through the viewer's scope)
//   GET    /work-orders/:id/record                    the rail + checklist + timelog + costs + related
//   PUT    /work-orders/:id/vendor                    { vendor_id | null } — the responsible vendor
//   POST   /work-orders/:id/pause · /resume           { reason }
//   PUT    /work-orders/:id/eta                       { eta_at | null, note }
//   POST   /work-orders/:id/cancel · /reopen          { reason }
//   POST   /work-orders/:id/complete-service          { note, fault_code, action_code, temporary_fix }
//   DELETE /work-orders/:id/complete-service
//   POST   /work-orders/:id/checklist                 { titles: [] }
//   PATCH  /work-orders/:id/checklist/:itemId · DELETE
//   POST   /work-orders/:id/tags · DELETE …/tags/:tagId
//   POST   /work-orders/:id/nte-requests              { requested_nte, reason }
//   POST   /work-orders/:id/nte-requests/:requestId   { decision: approve | reject | withdraw, note }
//   PUT    /work-orders/:id/visits/:visitId/location  { lat, lng } | { clear: true }
// Sites
//   GET    /site-events                               running / upcoming / recently ended, across sites
//   GET    /sites/:id/events · POST · PATCH …/:eventId · DELETE
//   GET    /sites/:id/spaces                          the space viewer
// Admin › Settings
//   GET    /admin/wo-codes · POST · PATCH /:codeId
//   GET    /admin/wo-form-layouts · POST · PATCH /:layoutId · DELETE

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound, parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import { deleteFormLayout, listFormLayoutsAdmin, saveFormLayout } from '../services/woCreate.js';
import {
  addChecklistItems,
  addWoTag,
  cancelWo,
  clearWoCompletion,
  completeWoService,
  decideNteIncrease,
  getWoRecord,
  listSiteEvents,
  listWoCodes,
  locateVisit,
  pauseWo,
  removeChecklistItem,
  removeSiteEvent,
  removeWoTag,
  reopenWo,
  requestNteIncrease,
  resumeWo,
  saveSiteEvent,
  saveWoCode,
  setWoEta,
  setWoVendor,
  spaceViewer,
  updateChecklistItem,
} from '../services/woRecord.js';

const idParams = z.object({ id: z.string().min(1).max(64) });
const text = (max: number) => z.string().max(max).nullable().optional();
const mode = z.enum(['off', 'optional', 'required']);

export default async function woRecordRoutes(app: FastifyInstance): Promise<void> {
  /** The work order, resolved through the viewer's scope (403 outside it). */
  const task = async (req: FastifyRequest) => {
    const { id } = parse(idParams, req.params);
    const actor = actingPrincipalFromRequest(req);
    const taskId = await resolveTaskId(id, actor);
    if (!taskId) throw notFound('Work order not found');
    return { taskId, actor };
  };

  app.get('/work-orders/:id/record', async (req) => {
    const { taskId, actor } = await task(req);
    return getWoRecord(taskId, actor);
  });

  app.put('/work-orders/:id/vendor', async (req) => {
    const { taskId, actor } = await task(req);
    const { vendor_id } = parse(z.object({ vendor_id: z.string().uuid().nullable() }).strict(), req.body);
    return setWoVendor(taskId, vendor_id, actor);
  });

  app.post('/work-orders/:id/pause', async (req) => {
    const { taskId, actor } = await task(req);
    const { reason } = parse(z.object({ reason: text(500) }).strict(), req.body);
    return pauseWo(taskId, reason ?? null, actor);
  });
  app.post('/work-orders/:id/resume', async (req) => {
    const { taskId, actor } = await task(req);
    return resumeWo(taskId, actor);
  });

  app.put('/work-orders/:id/eta', async (req) => {
    const { taskId, actor } = await task(req);
    const body = parse(z.object({ eta_at: z.string().max(40).nullable(), note: text(300) }).strict(), req.body);
    return setWoEta(taskId, body, actor);
  });

  app.post('/work-orders/:id/cancel', async (req) => {
    const { taskId, actor } = await task(req);
    const { reason } = parse(z.object({ reason: text(500) }).strict(), req.body);
    return cancelWo(taskId, reason ?? null, actor);
  });
  app.post('/work-orders/:id/reopen', async (req) => {
    const { taskId, actor } = await task(req);
    return reopenWo(taskId, actor);
  });

  app.post('/work-orders/:id/complete-service', async (req) => {
    const { taskId, actor } = await task(req);
    const body = parse(
      z.object({ note: text(4000), fault_code: text(40), action_code: text(40), temporary_fix: z.boolean().nullable().optional() }).strict(),
      req.body,
    );
    return completeWoService(taskId, body, actor);
  });
  app.delete('/work-orders/:id/complete-service', async (req) => {
    const { taskId, actor } = await task(req);
    return clearWoCompletion(taskId, actor);
  });

  app.post('/work-orders/:id/checklist', async (req) => {
    const { taskId, actor } = await task(req);
    const { titles } = parse(z.object({ titles: z.array(z.string().max(300)).min(1).max(50) }).strict(), req.body);
    return addChecklistItems(taskId, titles, actor);
  });
  app.patch('/work-orders/:id/checklist/:itemId', async (req) => {
    const { taskId, actor } = await task(req);
    const { itemId } = parse(z.object({ itemId: z.string().min(1).max(64) }).passthrough(), req.params);
    const body = parse(z.object({ done: z.boolean().optional(), title: z.string().max(300).optional(), note: text(1000) }).strict(), req.body);
    return updateChecklistItem(taskId, itemId, body, actor);
  });
  app.delete('/work-orders/:id/checklist/:itemId', async (req) => {
    const { taskId, actor } = await task(req);
    const { itemId } = parse(z.object({ itemId: z.string().min(1).max(64) }).passthrough(), req.params);
    return removeChecklistItem(taskId, itemId, actor);
  });

  app.post('/work-orders/:id/tags', async (req) => {
    const { taskId, actor } = await task(req);
    const body = parse(z.object({ tag: z.string().min(1).max(60), reason: text(300) }).strict(), req.body);
    return addWoTag(taskId, body, actor);
  });
  app.delete('/work-orders/:id/tags/:tagId', async (req) => {
    const { taskId, actor } = await task(req);
    const { tagId } = parse(z.object({ tagId: z.string().min(1).max(64) }).passthrough(), req.params);
    return removeWoTag(taskId, tagId, actor);
  });

  app.post('/work-orders/:id/nte-requests', async (req) => {
    const { taskId, actor } = await task(req);
    const body = parse(z.object({ requested_nte: z.number().positive().max(100_000_000), reason: z.string().max(2000) }).strict(), req.body);
    return requestNteIncrease(taskId, body, actor);
  });
  app.post('/work-orders/:id/nte-requests/:requestId', async (req) => {
    const { taskId, actor } = await task(req);
    const { requestId } = parse(z.object({ requestId: z.string().min(1).max(64) }).passthrough(), req.params);
    const body = parse(z.object({ decision: z.enum(['approve', 'reject', 'withdraw']), note: text(1000) }).strict(), req.body);
    return decideNteIncrease(taskId, requestId, body.decision, body.note ?? null, actor);
  });

  app.put('/work-orders/:id/visits/:visitId/location', async (req) => {
    const { taskId, actor } = await task(req);
    const { visitId } = parse(z.object({ visitId: z.string().min(1).max(64) }).passthrough(), req.params);
    const body = parse(z.union([z.object({ lat: z.number(), lng: z.number() }).strict(), z.object({ clear: z.literal(true) }).strict()]), req.body);
    return locateVisit(taskId, visitId, 'clear' in body ? null : body, actor);
  });

  // ── Sites: events and the space viewer ─────────────────────────────────────
  const eventBody = z
    .object({
      kind: z.enum(['closure', 'restricted_access', 'remodel', 'incident', 'inspection', 'weather', 'notice']).optional(),
      title: z.string().max(200).optional(),
      detail: text(2000),
      starts_on: z.string().max(10).optional(),
      ends_on: z.string().max(10).nullable().optional(),
    })
    .strict();
  app.get('/site-events', async (req) => ({ events: await listSiteEvents({}, actingPrincipalFromRequest(req)) }));
  app.get('/sites/:id/events', async (req) => {
    const { id } = parse(idParams, req.params);
    return { events: await listSiteEvents({ site: id }, actingPrincipalFromRequest(req)) };
  });
  app.post('/sites/:id/events', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const events = await saveSiteEvent(id, null, parse(eventBody, req.body), actingPrincipalFromRequest(req));
    return reply.status(201).send({ events });
  });
  app.patch('/sites/:id/events/:eventId', async (req) => {
    const { id, eventId } = parse(z.object({ id: z.string().min(1).max(64), eventId: z.string().min(1).max(64) }), req.params);
    return { events: await saveSiteEvent(id, eventId, parse(eventBody, req.body), actingPrincipalFromRequest(req)) };
  });
  app.delete('/sites/:id/events/:eventId', async (req) => {
    const { id, eventId } = parse(z.object({ id: z.string().min(1).max(64), eventId: z.string().min(1).max(64) }), req.params);
    return { events: await removeSiteEvent(id, eventId, actingPrincipalFromRequest(req)) };
  });
  app.get('/sites/:id/spaces', async (req) => {
    const { id } = parse(idParams, req.params);
    return spaceViewer(id, actingPrincipalFromRequest(req));
  });

  // ── Admin › Settings: codes and form layouts ───────────────────────────────
  app.get('/admin/wo-codes', async (req) => listWoCodes(actingPrincipalFromRequest(req)));
  app.post('/admin/wo-codes', async (req) => {
    const body = parse(z.object({ kind: z.enum(['fault', 'action']), code: z.string().max(40), label: z.string().max(120) }).strict(), req.body);
    return saveWoCode(null, body, actingPrincipalFromRequest(req));
  });
  app.patch('/admin/wo-codes/:codeId', async (req) => {
    const { codeId } = parse(z.object({ codeId: z.string().min(1).max(64) }), req.params);
    const body = parse(z.object({ label: z.string().max(120).optional(), is_active: z.boolean().optional() }).strict(), req.body);
    return saveWoCode(codeId, body, actingPrincipalFromRequest(req));
  });

  const layoutBody = z
    .object({
      name: z.string().trim().min(1).max(120),
      client: text(200),
      trade: text(200),
      fields: z.record(z.string(), mode).default({}),
      is_active: z.boolean().optional(),
    })
    .strict();
  app.get('/admin/wo-form-layouts', async (req) => listFormLayoutsAdmin(actingPrincipalFromRequest(req)));
  app.post('/admin/wo-form-layouts', async (req) => saveFormLayout(null, parse(layoutBody, req.body), actingPrincipalFromRequest(req)));
  app.patch('/admin/wo-form-layouts/:layoutId', async (req) => {
    const { layoutId } = parse(z.object({ layoutId: z.string().min(1).max(64) }), req.params);
    return saveFormLayout(layoutId, parse(layoutBody, req.body), actingPrincipalFromRequest(req));
  });
  app.delete('/admin/wo-form-layouts/:layoutId', async (req) => {
    const { layoutId } = parse(z.object({ layoutId: z.string().min(1).max(64) }), req.params);
    return deleteFormLayout(layoutId, actingPrincipalFromRequest(req));
  });
}
