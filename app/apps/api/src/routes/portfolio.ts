// Routes: Portfolio (0060) — sites, their buildings / floors / spaces, assets.
//
// Sites
//   GET    /sites                          the list (filters, sort, pages)
//   GET    /sites/meta                     counts strip, filter lists, what the viewer may do
//   GET    /sites/map                      every placed site the filters match
//   GET    /sites/from-work-orders         what "create sites from work orders" would do
//   POST   /sites/from-work-orders         do it
//   POST   /sites                          add a site
//   GET    /sites/:id · PATCH · DELETE     one record (delete hides it)
//   GET    /sites/:id/history
//   POST   /sites/:id/locations            add a building, floor or space
//   PATCH  /sites/:id/locations/:locId · DELETE
// Assets
//   GET    /assets · POST
//   GET    /assets/:id · PATCH · DELETE
//   GET    /assets/:id/history
//   POST   /assets/:id/condition           log a condition reading
// On a work order
//   GET    /work-orders/:id/place          its site and asset, or suggestions
//   PUT    /work-orders/:id/place          link / unlink { site_id, asset_id }
// Clients (0062)
//   GET    /clients · POST · GET /clients/:id · PATCH · DELETE · GET …/history
// Asset management requests (0062)
//   GET    /asset-requests · POST
//   POST   /asset-requests/:id/decide      { decision: approve | reject, note }
//   POST   /asset-requests/:id/withdraw
// Admin › Sites & assets (0062)
//   GET    /admin/portfolio
//   POST   /admin/portfolio/lists/:list    add a value · PATCH rename / switch off
//   PUT    /admin/portfolio/site-access/:id   the sites one person is restricted to

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import {
  addLocation,
  createAsset,
  createSite,
  deleteAsset,
  deleteSite,
  getAsset,
  getSite,
  linkWorkOrders,
  listAssets,
  listSites,
  portfolioHistory,
  previewLinkWorkOrders,
  recordCondition,
  removeLocation,
  setWoPlace,
  sitesMap,
  sitesMeta,
  updateAsset,
  updateLocation,
  updateSite,
  woPlace,
} from '../services/portfolio.js';
import {
  addListValue,
  adminPortfolio,
  clientHistory,
  createAssetRequest,
  createClient,
  decideAssetRequest,
  deleteClient,
  getClient,
  listAssetRequests,
  listClients,
  setSiteAccess,
  updateClient,
  updateListValue,
  withdrawAssetRequest,
} from '../services/portfolioExtras.js';

const idParams = z.object({ id: z.string().min(1).max(64) });
const text = (max: number) => z.string().max(max).nullable().optional();
const uuid = z.string().uuid();

const siteQuery = z.object({
  search: z.string().max(200).optional(),
  client: z.string().max(200).optional(),
  state: z.string().max(40).optional(),
  site_type: z.string().max(80).optional(),
  managed_by: z.string().max(40).optional(),
  show: z.enum(['active', 'inactive', 'all']).optional(),
  flag: z.enum(['not_on_map', 'open_work', 'no_assets']).optional(),
  sort: z.string().max(20).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
});

const siteBody = z
  .object({
    name: text(200),
    client: text(200),
    store_number: text(60),
    address1: text(200),
    address2: text(200),
    city: text(120),
    state: text(40),
    zip: text(20),
    phone_1: text(40),
    phone_2: text(40),
    site_type: text(80),
    ownership_status: text(40),
    managed_by: uuid.nullable().optional(),
    billing_entity: text(80),
    contact_name: text(120),
    contact_email: text(200),
    hours: text(300),
    access_notes: text(2000),
    notes: text(4000),
    boundary_radius_ft: z.number().int().nullable().optional(),
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

const locationBody = z
  .object({
    kind: z.enum(['building', 'floor', 'space']).optional(),
    parent_id: uuid.nullable().optional(),
    name: z.string().max(160).optional(),
    level: z.number().int().min(-20).max(200).nullable().optional(),
    space_type: text(80),
    area_sqft: z.number().min(0).max(100_000_000).nullable().optional(),
    notes: text(2000),
  })
  .strict();

const assetQuery = z.object({
  search: z.string().max(200).optional(),
  site: z.string().max(40).optional(),
  client: z.string().max(200).optional(),
  category: z.string().max(80).optional(),
  asset_type: z.string().max(160).optional(),
  status: z.enum(['in_service', 'out_of_service', 'retired']).optional(),
  condition: z.enum(['good', 'fair', 'poor', 'critical', 'none']).optional(),
  warranty: z.enum(['expired', 'expiring', 'active', 'none']).optional(),
  sort: z.string().max(20).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
});

const assetBody = z
  .object({
    name: z.string().max(200).optional(),
    site_id: uuid.nullable().optional(),
    asset_type: text(160),
    category: text(80),
    manufacturer: text(120),
    model_number: text(120),
    serial_number: text(120),
    asset_tag: text(80),
    description: text(4000),
    install_date: text(10),
    warranty_expires_on: text(10),
    warranty_provider: text(160),
    warranty_notes: text(2000),
    parent_asset_id: uuid.nullable().optional(),
    location_id: uuid.nullable().optional(),
    status: z.enum(['in_service', 'out_of_service', 'retired']).optional(),
    notes: text(4000),
  })
  .strict();

export default async function portfolioRoutes(app: FastifyInstance): Promise<void> {
  // ── Sites ──────────────────────────────────────────────────────────────────
  app.get('/sites', async (req) => listSites(parse(siteQuery, req.query), actingPrincipalFromRequest(req)));
  app.get('/sites/meta', async (req) => sitesMeta(actingPrincipalFromRequest(req)));
  app.get('/sites/map', async (req) => ({ points: await sitesMap(parse(siteQuery, req.query), actingPrincipalFromRequest(req)) }));
  app.get('/sites/from-work-orders', async (req) => previewLinkWorkOrders(actingPrincipalFromRequest(req)));
  app.post('/sites/from-work-orders', async (req) => linkWorkOrders(actingPrincipalFromRequest(req)));

  app.post('/sites', async (req, reply) => {
    const site = await createSite(parse(siteBody, req.body), actingPrincipalFromRequest(req));
    return reply.status(201).send({ site });
  });
  app.get('/sites/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { site: await getSite(id, actingPrincipalFromRequest(req)) };
  });
  app.patch('/sites/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { site: await updateSite(id, parse(siteBody, req.body), actingPrincipalFromRequest(req)) };
  });
  app.delete('/sites/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await deleteSite(id, actingPrincipalFromRequest(req));
    return { ok: true };
  });
  app.get('/sites/:id/history', async (req) => {
    const { id } = parse(idParams, req.params);
    return { history: await portfolioHistory('site', id, actingPrincipalFromRequest(req)) };
  });

  app.post('/sites/:id/locations', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const site = await addLocation(id, parse(locationBody, req.body), actingPrincipalFromRequest(req));
    return reply.status(201).send({ site });
  });
  app.patch('/sites/:id/locations/:locId', async (req) => {
    const { id, locId } = parse(z.object({ id: z.string().min(1).max(64), locId: z.string().min(1).max(64) }), req.params);
    return { site: await updateLocation(id, locId, parse(locationBody, req.body), actingPrincipalFromRequest(req)) };
  });
  app.delete('/sites/:id/locations/:locId', async (req) => {
    const { id, locId } = parse(z.object({ id: z.string().min(1).max(64), locId: z.string().min(1).max(64) }), req.params);
    return { site: await removeLocation(id, locId, actingPrincipalFromRequest(req)) };
  });

  // ── Assets ─────────────────────────────────────────────────────────────────
  app.get('/assets', async (req) => listAssets(parse(assetQuery, req.query), actingPrincipalFromRequest(req)));
  app.post('/assets', async (req, reply) => {
    const asset = await createAsset(parse(assetBody, req.body), actingPrincipalFromRequest(req));
    return reply.status(201).send({ asset });
  });
  app.get('/assets/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { asset: await getAsset(id, actingPrincipalFromRequest(req)) };
  });
  app.patch('/assets/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { asset: await updateAsset(id, parse(assetBody, req.body), actingPrincipalFromRequest(req)) };
  });
  app.delete('/assets/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await deleteAsset(id, actingPrincipalFromRequest(req));
    return { ok: true };
  });
  app.get('/assets/:id/history', async (req) => {
    const { id } = parse(idParams, req.params);
    return { history: await portfolioHistory('asset', id, actingPrincipalFromRequest(req)) };
  });
  app.post('/assets/:id/condition', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({ condition: z.enum(['good', 'fair', 'poor', 'critical']), note: text(2000), wo_number: text(40) }).strict(),
      req.body,
    );
    return { asset: await recordCondition(id, body, actingPrincipalFromRequest(req)) };
  });

  // ── On a work order ────────────────────────────────────────────────────────
  // resolveTaskId applies the viewer's work-order scope: a work order outside
  // it is a 403 here as everywhere else.
  app.get('/work-orders/:id/place', async (req) => {
    const { id } = parse(idParams, req.params);
    const actor = actingPrincipalFromRequest(req);
    const taskId = await resolveTaskId(id, actor);
    if (!taskId) throw notFound('Work order not found');
    return woPlace(taskId, actor);
  });
  app.put('/work-orders/:id/place', async (req) => {
    const { id } = parse(idParams, req.params);
    const actor = actingPrincipalFromRequest(req);
    const taskId = await resolveTaskId(id, actor);
    if (!taskId) throw notFound('Work order not found');
    const body = parse(z.object({ site_id: uuid.nullable().optional(), asset_id: uuid.nullable().optional() }).strict(), req.body);
    return setWoPlace(taskId, body, actor);
  });
  // ── Clients (0062) ─────────────────────────────────────────────────────────
  const clientBody = z
    .object({
      name: z.string().max(200).optional(),
      code: text(60),
      account_manager: uuid.nullable().optional(),
      billing_entity: text(80),
      contact_name: text(120),
      contact_email: text(200),
      contact_phone: text(40),
      billing_email: text(200),
      address: text(400),
      portal_type: text(40),
      payment_terms: text(120),
      notes: text(4000),
      is_active: z.boolean().optional(),
    })
    .strict();

  app.get('/clients', async (req) => {
    const q = parse(
      z.object({ search: z.string().max(200).optional(), show: z.enum(['active', 'inactive', 'all']).optional(), sort: z.string().max(20).optional(), dir: z.enum(['asc', 'desc']).optional() }),
      req.query,
    );
    return listClients(q, actingPrincipalFromRequest(req));
  });
  app.post('/clients', async (req, reply) => {
    const client = await createClient(parse(clientBody, req.body), actingPrincipalFromRequest(req));
    return reply.status(201).send({ client });
  });
  app.get('/clients/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { client: await getClient(id, actingPrincipalFromRequest(req)) };
  });
  app.patch('/clients/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { client: await updateClient(id, parse(clientBody, req.body), actingPrincipalFromRequest(req)) };
  });
  app.delete('/clients/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await deleteClient(id, actingPrincipalFromRequest(req));
    return { ok: true };
  });
  app.get('/clients/:id/history', async (req) => {
    const { id } = parse(idParams, req.params);
    return { history: await clientHistory(id, actingPrincipalFromRequest(req)) };
  });

  // ── Asset management requests (0062) ───────────────────────────────────────
  app.get('/asset-requests', async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'approved', 'rejected', 'withdrawn', 'all']).optional(), asset: z.string().max(40).optional() }), req.query);
    return listAssetRequests(q, actingPrincipalFromRequest(req));
  });
  app.post('/asset-requests', async (req, reply) => {
    const body = parse(
      z
        .object({
          type: z.enum(['add', 'replace', 'retire', 'move']),
          asset_id: uuid.nullable().optional(),
          site_id: uuid.nullable().optional(),
          reason: z.string().max(2000),
          proposed: z
            .object({ name: text(200), category: text(80), asset_type: text(160), manufacturer: text(120), model_number: text(120), serial_number: text(120), location_id: uuid.nullable().optional() })
            .strict()
            .optional(),
          wo_number: text(40),
        })
        .strict(),
      req.body,
    );
    const request = await createAssetRequest(body, actingPrincipalFromRequest(req));
    return reply.status(201).send({ request });
  });
  app.post('/asset-requests/:id/decide', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']), note: text(2000) }).strict(), req.body);
    return { request: await decideAssetRequest(id, body.decision, body.note ?? null, actingPrincipalFromRequest(req)) };
  });
  app.post('/asset-requests/:id/withdraw', async (req) => {
    const { id } = parse(idParams, req.params);
    return { request: await withdrawAssetRequest(id, actingPrincipalFromRequest(req)) };
  });

  // ── Admin › Sites & assets (0062) ──────────────────────────────────────────
  const listName = z.enum(['site-types', 'asset-categories']);
  app.get('/admin/portfolio', async (req) => adminPortfolio(actingPrincipalFromRequest(req)));
  app.post('/admin/portfolio/lists/:list', async (req) => {
    const { list } = parse(z.object({ list: listName }), req.params);
    const { name } = parse(z.object({ name: z.string().max(80) }).strict(), req.body);
    return addListValue(list, name, actingPrincipalFromRequest(req));
  });
  app.patch('/admin/portfolio/lists/:list', async (req) => {
    const { list } = parse(z.object({ list: listName }), req.params);
    // The value travels in the body, not the path: a name may hold a slash.
    const body = parse(z.object({ value: z.string().max(80), name: z.string().max(80).optional(), is_active: z.boolean().optional() }).strict(), req.body);
    return updateListValue(list, body.value, { name: body.name, is_active: body.is_active }, actingPrincipalFromRequest(req));
  });
  app.put('/admin/portfolio/site-access/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { site_ids } = parse(z.object({ site_ids: z.array(uuid).max(2000) }).strict(), req.body);
    return setSiteAccess(id, site_ids, actingPrincipalFromRequest(req));
  });
}
