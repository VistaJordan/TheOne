// 0066 · Vendors, the rest.
//
//   GET    /vendors/performance                     ?from&to
//   GET    /vendors/:id/qualifications
//   POST   /vendors/:id/skills · PATCH /:skillId · DELETE /:skillId
//   POST   /vendors/:id/inductions · PATCH /:inductionId · DELETE /:inductionId
//   GET    /vendors/:id/portal
//   POST   /vendors/:id/portal/links                { purpose, days, origin }
//   DELETE /vendors/:id/portal/links/:linkId
//   POST   /vendors/:id/portal/onboarding/:submissionId   { decision, note }
//
//   POST   /vendor-bills/:id/credit-notes           { amount, reason, vendor_ref }
//   POST   /vendor-credit-notes/:id                 { decision, note }
//
//   GET    /work-orders/:id/dispatch
//   POST   /work-orders/:id/dispatch/start · /stop
//   POST   /work-orders/:id/dispatch/offers/:offerId   { answer, note }
//   GET    /work-orders/:id/consumables · POST · DELETE /:lineId
//
//   GET    /admin/vendor-catalogues
//   POST   /admin/vendor-catalogues/skills · PATCH /:id
//   POST   /admin/vendor-catalogues/consumables · PATCH /:id
//   PUT    /admin/vendor-catalogues/bill-rules
//   PUT    /admin/vendor-catalogues/dispatch
//
// Public (the token is the credential — see services/vendorPortal.ts):
//   GET    /public/vendor-portal/:token
//   POST   /public/vendor-portal/:token/onboarding
//   POST   /public/vendor-portal/:token/offers/:offerId   { answer, note }
//   POST   /public/vendor-portal/:token/jobs/:ref/eta     { eta_at }
//   POST   /public/vendor-portal/:token/jobs/:ref/notes   { body }

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SKILL_LEVELS } from '@theone/shared';
import { notFound, parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import {
  addCreditNote,
  addWoConsumable,
  answerOfferAsStaff,
  decideCreditNote,
  getWoDispatch,
  removeVendorInduction,
  removeVendorSkill,
  removeWoConsumable,
  saveBillRules,
  saveConsumableDef,
  saveDispatchSettings,
  saveSkillDef,
  saveVendorInduction,
  saveVendorSkill,
  startDispatch,
  stopDispatch,
  vendorCatalogues,
  vendorPerformance,
  vendorQualifications,
  woConsumables,
} from '../services/vendorExtras.js';
import {
  createPortalLink,
  decideOnboarding,
  portalAddNote,
  portalAdmin,
  portalAnswerOffer,
  portalSetEta,
  portalSubmitOnboarding,
  portalView,
  revokePortalLink,
} from '../services/vendorPortal.js';

const idParams = z.object({ id: z.string().min(1).max(64) });
const text = (max: number) => z.string().max(max).nullable().optional();
const day = z.string().max(10).nullable().optional();
const amount = z.number().min(0).max(10_000_000).nullable().optional();

export default async function vendorExtraRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (req: FastifyRequest) => actingPrincipalFromRequest(req);
  const task = async (req: FastifyRequest) => {
    const { id } = parse(idParams, req.params);
    const actor = actorOf(req);
    const taskId = await resolveTaskId(id, actor);
    if (!taskId) throw notFound('Work order not found');
    return { taskId, actor };
  };
  const p = (req: FastifyRequest, key: string): string => (parse(z.object({ [key]: z.string().min(1).max(64) }), req.params) as Record<string, string>)[key];

  // ── Performance, qualifications ────────────────────────────────────────────
  app.get('/vendors/performance', async (req) => {
    const q = parse(z.object({ from: z.string().max(10).optional(), to: z.string().max(10).optional(), vendor_id: z.string().uuid().optional() }), req.query);
    return vendorPerformance(actorOf(req), q);
  });
  app.get('/vendors/:id/qualifications', async (req) => vendorQualifications(p(req, 'id'), actorOf(req)));

  const skillBody = z.object({ skill: z.string().max(120).optional(), level: z.enum(SKILL_LEVELS).optional(), certified_until: day, note: text(300) }).strict();
  app.post('/vendors/:id/skills', async (req) => saveVendorSkill(p(req, 'id'), null, parse(skillBody, req.body), actorOf(req)));
  app.patch('/vendors/:id/skills/:skillId', async (req) => saveVendorSkill(p(req, 'id'), p(req, 'skillId'), parse(skillBody, req.body), actorOf(req)));
  app.delete('/vendors/:id/skills/:skillId', async (req) => removeVendorSkill(p(req, 'id'), p(req, 'skillId'), actorOf(req)));

  const inductionBody = z.object({ title: z.string().max(200).optional(), client: text(200), completed_on: day, expires_on: day, note: text(500) }).strict();
  app.post('/vendors/:id/inductions', async (req) => saveVendorInduction(p(req, 'id'), null, parse(inductionBody, req.body), actorOf(req)));
  app.patch('/vendors/:id/inductions/:inductionId', async (req) => saveVendorInduction(p(req, 'id'), p(req, 'inductionId'), parse(inductionBody, req.body), actorOf(req)));
  app.delete('/vendors/:id/inductions/:inductionId', async (req) => removeVendorInduction(p(req, 'id'), p(req, 'inductionId'), actorOf(req)));

  // ── Portal, staff side ─────────────────────────────────────────────────────
  app.get('/vendors/:id/portal', async (req) => portalAdmin(p(req, 'id'), actorOf(req)));
  app.post('/vendors/:id/portal/links', async (req) => {
    const body = parse(z.object({ purpose: z.enum(['onboarding', 'portal']), days: z.number().int().min(1).max(730).nullable().optional(), origin: z.string().url().max(300) }).strict(), req.body);
    return createPortalLink(p(req, 'id'), body, body.origin, actorOf(req));
  });
  app.delete('/vendors/:id/portal/links/:linkId', async (req) => revokePortalLink(p(req, 'id'), p(req, 'linkId'), actorOf(req)));
  app.post('/vendors/:id/portal/onboarding/:submissionId', async (req) => {
    const body = parse(z.object({ decision: z.enum(['accept', 'reject']), note: text(500) }).strict(), req.body);
    return decideOnboarding(p(req, 'id'), p(req, 'submissionId'), body.decision, body.note ?? null, actorOf(req));
  });

  // ── Credit notes ───────────────────────────────────────────────────────────
  app.post('/vendor-bills/:id/credit-notes', async (req) => {
    const body = parse(z.object({ amount: z.number().positive().max(10_000_000), reason: z.string().min(1).max(500), vendor_ref: text(80) }).strict(), req.body);
    return addCreditNote(p(req, 'id'), body, actorOf(req));
  });
  app.post('/vendor-credit-notes/:id', async (req) => {
    const body = parse(z.object({ decision: z.enum(['approve', 'void']), note: text(500) }).strict(), req.body);
    return decideCreditNote(p(req, 'id'), body.decision, body.note ?? null, actorOf(req));
  });

  // ── Dispatch offers and consumables on a work order ────────────────────────
  app.get('/work-orders/:id/dispatch', async (req) => {
    const { taskId, actor } = await task(req);
    return getWoDispatch(taskId, actor);
  });
  app.post('/work-orders/:id/dispatch/start', async (req) => {
    const { taskId, actor } = await task(req);
    return startDispatch(taskId, actor);
  });
  app.post('/work-orders/:id/dispatch/stop', async (req) => {
    const { taskId, actor } = await task(req);
    return stopDispatch(taskId, actor);
  });
  app.post('/work-orders/:id/dispatch/offers/:offerId', async (req) => {
    const { taskId, actor } = await task(req);
    const body = parse(z.object({ answer: z.enum(['accept', 'decline']), note: text(500) }).strict(), req.body);
    return answerOfferAsStaff(taskId, p(req, 'offerId'), body.answer, body.note ?? null, actor);
  });

  app.get('/work-orders/:id/consumables', async (req) => {
    const { taskId, actor } = await task(req);
    return woConsumables(taskId, actor);
  });
  app.post('/work-orders/:id/consumables', async (req) => {
    const { taskId, actor } = await task(req);
    const body = parse(
      z.object({ consumable_id: z.string().uuid().nullable().optional(), name: z.string().max(200).optional(), unit: z.string().max(40).optional(), qty: z.number().positive().max(100_000).optional(), unit_cost: amount, vendor_id: z.string().uuid().nullable().optional(), note: text(300) }).strict(),
      req.body,
    );
    return addWoConsumable(taskId, body, actor);
  });
  app.delete('/work-orders/:id/consumables/:lineId', async (req) => {
    const { taskId, actor } = await task(req);
    return removeWoConsumable(taskId, p(req, 'lineId'), actor);
  });

  // ── Admin › Vendors & map ──────────────────────────────────────────────────
  app.get('/admin/vendor-catalogues', async (req) => vendorCatalogues(actorOf(req)));
  const skillDef = z.object({ name: z.string().max(120).optional(), trade: text(120), is_active: z.boolean().optional() }).strict();
  app.post('/admin/vendor-catalogues/skills', async (req) => saveSkillDef(null, parse(skillDef, req.body), actorOf(req)));
  app.patch('/admin/vendor-catalogues/skills/:id', async (req) => saveSkillDef(p(req, 'id'), parse(skillDef, req.body), actorOf(req)));
  const consumableDef = z.object({ name: z.string().max(200).optional(), unit: z.string().max(40).optional(), unit_cost: amount, is_active: z.boolean().optional() }).strict();
  app.post('/admin/vendor-catalogues/consumables', async (req) => saveConsumableDef(null, parse(consumableDef, req.body), actorOf(req)));
  app.patch('/admin/vendor-catalogues/consumables/:id', async (req) => saveConsumableDef(p(req, 'id'), parse(consumableDef, req.body), actorOf(req)));
  app.put('/admin/vendor-catalogues/bill-rules', async (req) => saveBillRules(parse(z.record(z.union([z.boolean(), z.number()])), req.body), actorOf(req)));
  app.put('/admin/vendor-catalogues/dispatch', async (req) =>
    saveDispatchSettings(parse(z.object({ enabled: z.boolean().optional(), auto_start: z.boolean().optional(), hours: z.number().int().min(1).max(168).optional() }).strict(), req.body), actorOf(req)),
  );

  // ── Public: the vendor's own link ──────────────────────────────────────────
  // Never cached by a shared proxy, never indexed.
  const sealed = (reply: FastifyReply) => reply.header('Cache-Control', 'private, no-store').header('X-Robots-Tag', 'noindex, nofollow');
  const token = (req: FastifyRequest) => p(req, 'token');
  app.get('/public/vendor-portal/:token', async (req, reply) => {
    sealed(reply);
    return portalView(token(req));
  });
  app.post('/public/vendor-portal/:token/onboarding', async (req, reply) => {
    sealed(reply);
    return portalSubmitOnboarding(token(req), req.body);
  });
  app.post('/public/vendor-portal/:token/offers/:offerId', async (req, reply) => {
    sealed(reply);
    const body = parse(z.object({ answer: z.enum(['accept', 'decline']), note: text(500) }).strict(), req.body);
    return portalAnswerOffer(token(req), p(req, 'offerId'), body.answer, body.note ?? null);
  });
  app.post('/public/vendor-portal/:token/jobs/:ref/eta', async (req, reply) => {
    sealed(reply);
    const body = parse(z.object({ eta_at: z.string().max(40) }).strict(), req.body);
    return portalSetEta(token(req), p(req, 'ref'), body.eta_at);
  });
  app.post('/public/vendor-portal/:token/jobs/:ref/notes', async (req, reply) => {
    sealed(reply);
    const body = parse(z.object({ body: z.string().min(1).max(2000) }).strict(), req.body);
    return portalAddNote(token(req), p(req, 'ref'), body.body);
  });
}
