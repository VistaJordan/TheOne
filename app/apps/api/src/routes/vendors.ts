// Routes: vendors and technicians, the technician map on a work order, hiring,
// and Admin › Vendors & map (migration 0057).
//
// The Vendors section
//   GET    /vendors                      the list (filters, sort, pages)
//   GET    /vendors/meta                 statuses, brand sources, trades, owners, counts
//   GET    /vendors/coverage             every placed vendor location (the coverage map)
//   GET    /vendors/city-suggest         city names as typed
//   POST   /vendors                      add (409 VENDOR_DUPLICATE unless override_duplicate)
//   GET    /vendors/:id                  the record
//   PATCH  /vendors/:id
//   DELETE /vendors/:id                  remove (kept, hidden)
//   GET    /vendors/:id/history
//   GET    /vendors/:id/notes · POST     notes (also reachable from the map)
//   POST   /vendors/:id/blacklist · DELETE
//   POST   /vendors/:id/expiries · DELETE /vendors/:id/expiries/:expiryId
//
// On a work order (:id = uuid or WO number, resolved through the work-order scope)
//   GET    /work-orders/:id/tech-map             the map's results
//   GET    /work-orders/:id/technicians          hired technicians (People tab)
//   POST   /work-orders/:id/technicians          hire  { vendor_id, note? }
//   DELETE /work-orders/:id/technicians/:vendorId   release
//   POST   /work-orders/:id/technicians/new      add a technician from the map
//   GET    /work-orders/:id/tech-search          any technician, for a visit
//
// Admin › Vendors & map
//   GET    /admin/vendors
//   PUT    /admin/vendors/settings
//   GET    /admin/vendors/vendor-search
//   POST   /admin/vendors/preferred · PATCH / DELETE /admin/vendors/preferred/:id
//   POST   /admin/vendors/lists/:list · PATCH /admin/vendors/lists/:list/:key
//
// Every gate is in the service, so no route can forget one.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AVAILABILITY_FLAGS, VENDOR_PRIORITIES, TRI_STATES, parseVendorFilter, type AvailabilityKey } from '@theone/shared';
import { notFound, parse } from '../errors.js';
import { actingPrincipalFromRequest, resolveTaskId } from '../services/activity.js';
import { query } from '../db.js';
import { suggestCities } from '../services/geo.js';
import { requirePerm } from '../services/permissions.js';
import { requireVisitEdit } from '../services/visits.js';
import {
  addExpiry,
  addNote,
  blacklistVendor,
  clearBlacklist,
  createVendor,
  deleteVendor,
  getVendor,
  listNotes,
  listVendors,
  removeExpiry,
  requireVendorsView,
  updateVendor,
  vendorHistory,
  vendorScopeFor,
  vendorBoard,
  vendorsMeta,
  type VendorListQuery,
} from '../services/vendors.js';
import {
  addListValue,
  addTechnician,
  adminVendors,
  coveragePoints,
  createPreferred,
  deletePreferred,
  hireTechnician,
  listTechnicians,
  releaseTechnician,
  requireVendorAdmin,
  saveVendorSettings,
  searchTechs,
  updateListValue,
  updatePreferred,
  workOrderMap,
} from '../services/vendorMap.js';

const idParams = z.object({ id: z.string().min(1) });
const text = (max: number) => z.string().max(max).nullable().optional();
const money = z.number().min(0).max(1_000_000).nullable().optional();
const tri = z.enum(TRI_STATES as [string, ...string[]]).optional();

const vendorSchema = z
  .object({
    kind: z.enum(['vendor', 'tech']).optional(),
    name: z.string().trim().max(200).optional(),
    status: z.string().trim().max(40).optional(),
    brand_source: text(40),
    owner_id: z.string().uuid().nullable().optional(),
    priority: z.enum(VENDOR_PRIORITIES as unknown as [string, ...string[]]).nullable().optional(),
    email: text(320),
    legal_name: text(200),
    dba_name: text(200),
    primary_trade: text(80),
    secondary_trades: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    city: text(120),
    state: text(40),
    zip: text(12),
    nationwide: z.boolean().optional(),
    statewide: z.boolean().optional(),
    coverage_states: z.array(z.string().trim().length(2)).max(60).optional(),
    max_travel_radius: text(80),
    emergency_same_day: z.boolean().nullable().optional(),
    after_hours: z.boolean().nullable().optional(),
    weekends: z.boolean().nullable().optional(),
    holiday_emergency: z.boolean().nullable().optional(),
    estimated_response_time: text(200),
    regular_hourly_rate: money,
    after_hours_rate: money,
    weekend_emergency_rate: money,
    trip_charge: money,
    diagnostic_fee: money,
    minimum_charge: money,
    payment_methods: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    accepts_payment_after_30_days: z.boolean().nullable().optional(),
    primary_contact_name: text(200),
    primary_contact_role: text(120),
    dispatch_phone: text(60),
    billing_email: text(320),
    w9_received: tri,
    msa_signed: tri,
    coi_received: tri,
    coi_approved: tri,
    is_subcontractor: z.boolean().optional(),
    notes: text(20000),
    details: z.record(z.unknown()).optional(),
    phones: z.array(z.object({ phone: z.string().max(60), label: text(60) })).max(12).optional(),
    contacts: z
      .array(z.object({ id: z.string().optional(), name: z.string().max(200), role: text(120), phone: text(60), email: text(320) }))
      .max(20)
      .optional(),
    override_duplicate: z.boolean().optional(),
    override_missing: z.boolean().optional(),
  })
  .strict();

export const listQuery = z.object({
  search: z.string().max(200).optional(),
  kind: z.enum(['vendor', 'tech']).optional(),
  status: z.string().max(400).optional(),
  trade: z.string().max(80).optional(),
  state: z.string().max(2).optional(),
  owner: z.string().max(40).optional(),
  brand_source: z.string().max(40).optional(),
  compliance: z.enum(['MISSING_DOCS', 'IN_REVIEW', 'APPROVED', 'EXPIRED', 'REJECTED']).optional(),
  flag: z.enum(['blacklisted', 'duplicate', 'missing', 'not_on_map']).optional(),
  /** A selection, or a bulk-search result: comma-separated ids. */
  ids: z.string().max(200000).optional(),
  /** 0059 · the advanced filter: JSON `{ join, rules }` (shared/vendorFilters). */
  filter: z.string().max(8000).optional(),
  sort: z.string().max(20).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The parsed query string → what the list service takes. */
export function toListQuery(q: z.infer<typeof listQuery>): VendorListQuery {
  return {
    ...q,
    status: q.status ? q.status.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    ids: q.ids ? q.ids.split(',').map((s) => s.trim()).filter((s) => UUID.test(s)) : undefined,
    filter: parseVendorFilter(q.filter),
  };
}

async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParams, req.params);
  const taskId = await resolveTaskId(id, actingPrincipalFromRequest(req));
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

/** A note or blacklist written from a work order's map carries the work order. */
async function optionalTaskId(req: FastifyRequest, ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  return resolveTaskId(ref, actingPrincipalFromRequest(req));
}

export default async function vendorRoutes(app: FastifyInstance): Promise<void> {
  // ── The Vendors section ────────────────────────────────────────────────────
  app.get('/vendors', async (req) => {
    return listVendors(toListQuery(parse(listQuery, req.query)), actingPrincipalFromRequest(req));
  });

  app.get('/vendors/meta', async (req) => vendorsMeta(actingPrincipalFromRequest(req)));

  // 0059 · the same rows as the list, stacked by status.
  app.get('/vendors/board', async (req) => {
    return vendorBoard(toListQuery(parse(listQuery, req.query)), actingPrincipalFromRequest(req));
  });

  app.get('/vendors/coverage', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requireVendorsView(actor);
    const q = parse(
      z.object({
        trade: z.string().max(80).optional(),
        state: z.string().max(2).optional(),
        kind: z.enum(['vendor', 'tech']).optional(),
        status: z.string().max(40).optional(),
      }),
      req.query,
    );
    const scope = vendorScopeFor(actor);
    return { points: await coveragePoints(q, scope.sql, scope.params) };
  });

  app.get('/vendors/city-suggest', async (req) => {
    actingPrincipalFromRequest(req);
    const q = parse(z.object({ q: z.string().max(80).default(''), state: z.string().max(40).optional() }), req.query);
    return { cities: await suggestCities(q.q, q.state) };
  });

  app.post('/vendors', async (req, reply) => {
    const input = parse(vendorSchema, req.body);
    const vendor = await createVendor(input as never, actingPrincipalFromRequest(req));
    return reply.status(201).send({ vendor });
  });

  app.get('/vendors/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { vendor: await getVendor(id, actingPrincipalFromRequest(req)) };
  });

  app.patch('/vendors/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const input = parse(vendorSchema, req.body);
    return { vendor: await updateVendor(id, input as never, actingPrincipalFromRequest(req)) };
  });

  app.delete('/vendors/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await deleteVendor(id, actingPrincipalFromRequest(req));
    return { ok: true };
  });

  app.get('/vendors/:id/history', async (req) => {
    const { id } = parse(idParams, req.params);
    return { items: await vendorHistory(id, actingPrincipalFromRequest(req)) };
  });

  app.get('/vendors/:id/notes', async (req) => {
    const { id } = parse(idParams, req.params);
    return { notes: await listNotes(id, actingPrincipalFromRequest(req)) };
  });

  app.post('/vendors/:id/notes', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ body: z.string().trim().min(1).max(4000), work_order: z.string().max(64).optional() }).strict(), req.body);
    const taskId = await optionalTaskId(req, body.work_order);
    return { notes: await addNote(id, body.body, taskId, actingPrincipalFromRequest(req)) };
  });

  app.post('/vendors/:id/blacklist', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ reason: z.string().trim().min(1).max(4000), work_order: z.string().max(64).optional() }).strict(), req.body);
    const taskId = await optionalTaskId(req, body.work_order);
    await blacklistVendor(id, body.reason, taskId, actingPrincipalFromRequest(req));
    return { notes: await listNotes(id, actingPrincipalFromRequest(req)) };
  });

  app.delete('/vendors/:id/blacklist', async (req) => {
    const { id } = parse(idParams, req.params);
    const q = parse(z.object({ note: z.string().max(4000).optional() }), req.query);
    await clearBlacklist(id, q.note ?? null, actingPrincipalFromRequest(req));
    return { notes: await listNotes(id, actingPrincipalFromRequest(req)) };
  });

  app.post('/vendors/:id/expiries', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({ entity: text(40), insurance_type: z.string().trim().min(1).max(120), expires_on: z.string().max(10) }).strict(),
      req.body,
    );
    return {
      vendor: await addExpiry(id, { entity: body.entity ?? null, insurance_type: body.insurance_type, expires_on: body.expires_on }, actingPrincipalFromRequest(req)),
    };
  });

  app.delete('/vendors/:id/expiries/:expiryId', async (req) => {
    const p = parse(z.object({ id: z.string().min(1), expiryId: z.string().min(1) }), req.params);
    return { vendor: await removeExpiry(p.id, p.expiryId, actingPrincipalFromRequest(req)) };
  });

  // ── On a work order ────────────────────────────────────────────────────────
  const availabilityKeys = AVAILABILITY_FLAGS.map((f) => f.key) as string[];

  app.get('/work-orders/:id/tech-map', async (req) => {
    const taskId = await taskIdOf(req);
    const q = parse(
      z.object({
        trades: z.string().max(2000).optional(),
        availability: z.string().max(200).optional(),
        opened: z.enum(['1', '0']).optional(),
      }),
      req.query,
    );
    const trades = q.trades === undefined ? null : q.trades.split('|').map((s) => s.trim()).filter(Boolean);
    const availability = (q.availability ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is AvailabilityKey => availabilityKeys.includes(s));
    return workOrderMap(taskId, { trades, availability, opened: q.opened === '1' }, actingPrincipalFromRequest(req));
  });

  app.get('/work-orders/:id/technicians', async (req) => {
    const taskId = await taskIdOf(req);
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, 'work_orders', 'view', 'You cannot view work orders');
    return listTechnicians(taskId, actor);
  });

  app.post('/work-orders/:id/technicians', async (req) => {
    const taskId = await taskIdOf(req);
    const body = parse(z.object({ vendor_id: z.string().uuid(), note: text(1000) }).strict(), req.body);
    return hireTechnician(taskId, body.vendor_id, body.note ?? null, actingPrincipalFromRequest(req));
  });

  app.delete('/work-orders/:id/technicians/:vendorId', async (req) => {
    const taskId = await taskIdOf(req);
    const { vendorId } = parse(z.object({ id: z.string(), vendorId: z.string().uuid() }), req.params);
    return releaseTechnician(taskId, vendorId, actingPrincipalFromRequest(req));
  });

  app.post('/work-orders/:id/technicians/new', async (req, reply) => {
    const taskId = await taskIdOf(req);
    const body = parse(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          phone: z.string().trim().min(1).max(60),
          city: z.string().trim().min(1).max(120),
          state: z.string().trim().min(1).max(40),
          zip: text(12),
          trade: z.string().trim().min(1).max(80),
          hire: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    const result = await addTechnician(taskId, body, actingPrincipalFromRequest(req));
    return reply.status(201).send(result);
  });

  app.get('/work-orders/:id/tech-search', async (req) => {
    const taskId = await taskIdOf(req);
    requireVisitEdit(actingPrincipalFromRequest(req));
    const q = parse(z.object({ q: z.string().max(120).default('') }), req.query);
    return { hits: await searchTechs(taskId, q.q) };
  });

  // ── Admin › Vendors & map ──────────────────────────────────────────────────
  app.get('/admin/vendors', async (req) => adminVendors(actingPrincipalFromRequest(req)));

  app.put('/admin/vendors/settings', async (req) => {
    const body = parse(
      z
        .object({
          map_radius_miles: z.number().optional(),
          map_daily_alert: z.number().optional(),
          hire_warn_compliance: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    return { settings: await saveVendorSettings(body, actingPrincipalFromRequest(req)) };
  });

  // The vendor picker of a preferred-vendor rule: by name, for someone who may
  // hold Admin › Vendors & map without the Vendors section.
  app.get('/admin/vendors/vendor-search', async (req) => {
    requireVendorAdmin(actingPrincipalFromRequest(req), 'view');
    const q = parse(z.object({ q: z.string().max(120).default('') }), req.query);
    const term = q.q.trim();
    if (term.length < 2) return { hits: [] };
    const res = await query<{ id: string; name: string; phone: string | null; kind: string; primary_trade: string | null; city: string | null; state: string | null }>(
      `SELECT id::text AS id, name, phone, kind, primary_trade, city, state FROM vendor
        WHERE deleted_at IS NULL AND name ILIKE $1 ORDER BY lower(name) LIMIT 15`,
      [`%${term.replace(/[\\%_]/g, '\\$&')}%`],
    );
    return { hits: res.rows };
  });

  const preferredSchema = z
    .object({
      client: text(200),
      trade: text(80),
      state: text(40),
      vendor_id: z.string().uuid().optional(),
      rank: z.number().int().min(1).max(99).optional(),
      note: text(1000),
    })
    .strict();

  app.post('/admin/vendors/preferred', async (req, reply) => {
    const body = parse(preferredSchema, req.body);
    return reply.status(201).send({ preferred: await createPreferred(body, actingPrincipalFromRequest(req)) });
  });

  app.patch('/admin/vendors/preferred/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(preferredSchema, req.body);
    return { preferred: await updatePreferred(id, body, actingPrincipalFromRequest(req)) };
  });

  app.delete('/admin/vendors/preferred/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { preferred: await deletePreferred(id, actingPrincipalFromRequest(req)) };
  });

  const listName = z.enum(['statuses', 'brand-sources', 'trades']);

  app.post('/admin/vendors/lists/:list', async (req, reply) => {
    const { list } = parse(z.object({ list: listName }), req.params);
    const body = parse(z.object({ label: z.string().trim().min(1).max(80), color: z.string().max(20).optional() }).strict(), req.body);
    await addListValue(list, body, actingPrincipalFromRequest(req));
    return reply.status(201).send(await adminVendors(actingPrincipalFromRequest(req)));
  });

  app.patch('/admin/vendors/lists/:list/:key', async (req) => {
    const p = parse(z.object({ list: listName, key: z.string().min(1).max(80) }), req.params);
    const body = parse(
      z.object({ label: z.string().trim().min(1).max(80).optional(), color: z.string().max(20).optional(), is_active: z.boolean().optional() }).strict(),
      req.body,
    );
    await updateListValue(p.list, p.key, body, actingPrincipalFromRequest(req));
    return adminVendors(actingPrincipalFromRequest(req));
  });
}
