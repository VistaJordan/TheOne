// 0060 · Portfolio: sites, their buildings / floors / spaces, and assets.
//
// `site` and `asset` are also written by the Ecotrak sync (modules/
// integrations/ecotrak/ingest.ts), which this file neither imports nor
// changes. The sync rewrites client, name, store number and address on every
// sighting of one of its sites, so those columns are refused here for a site
// whose source is 'ecotrak' — everything else on the record is ours.
//
// A work order shown inside a site or an asset is still a work order: the
// viewer's work-order scope (0026) applies to every list and count of them
// here, exactly as it does on the Work Orders page.

import {
  ASSETS_PERM_KEY,
  SITES_PERM_KEY,
  SITE_SYNCED_FIELDS,
  canNestUnder,
  locationPath,
  normalizeState,
  permAllows,
  warrantyState,
  zip5,
} from '@theone/shared';
import type {
  AssetCondition,
  AssetConditionEntry,
  AssetDetail,
  AssetInput,
  AssetRow,
  AssetStatus,
  AssetsListResponse,
  FeedActor,
  LinkWorkOrdersResult,
  PermAction,
  PortfolioCounts,
  PortfolioHistoryEntry,
  SiteDetail,
  SiteInput,
  SiteLocation,
  SiteLocationInput,
  SiteLocationKind,
  SiteMapPoint,
  SiteRow,
  SiteWorkOrder,
  SitesListResponse,
  SitesMetaResponse,
  WoPlaceResponse,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { geoLookup } from './geo.js';
import { requirePerm } from './permissions.js';
import { logTaskChanges } from './woAudit.js';
import { Params } from './woFields.js';
import { woScopeSql } from './woScope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_WO = `t.deleted_at IS NULL AND t.status_group::text NOT IN ('done', 'closed')`;

const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const today = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const can = (a: ActingPrincipal, key: string, action: PermAction): boolean => permAllows(a.perms, key, action, a.isSuperAdmin);
const actorOf = (id: string | null, name: string | null, kind: 'human' | 'service' | null): FeedActor | null =>
  id ? { id, name: name ?? 'Unknown', kind: kind ?? 'human' } : null;

export function requireSitesView(a: ActingPrincipal): void {
  requirePerm(a, SITES_PERM_KEY, 'view', 'You cannot open Sites');
}
export function requireAssetsView(a: ActingPrincipal): void {
  requirePerm(a, ASSETS_PERM_KEY, 'view', 'You cannot open Assets');
}

/** The viewer's work-order scope as an AND-able clause over alias t. */
function woScopeClause(a: ActingPrincipal, p: Params): string {
  const s = woScopeSql(a, p);
  return s ? `AND ${s}` : '';
}

// ── Site access (0061) ───────────────────────────────────────────────────────
// A person with rows in `principal_site` sees only those sites and what is in
// them. `col` is the site id column of the query at hand. Null = unrestricted,
// and the query stays exactly what it was.

export function siteAccessSql(a: ActingPrincipal, p: Params, col: string): string | null {
  if (!a.siteRestricted || a.isSuperAdmin) return null;
  return `${col} IN (SELECT ps.site_id FROM principal_site ps WHERE ps.principal_id = ${p.add(a.id)})`;
}

/** 403 for a site outside the person's list (404 handling is the caller's). */
export async function assertSiteAccess(a: ActingPrincipal, siteId: string | null | undefined): Promise<void> {
  if (!a.siteRestricted || a.isSuperAdmin) return;
  const ok = siteId
    ? await query<{ ok: boolean }>(`SELECT true AS ok FROM principal_site WHERE principal_id = $1 AND site_id = $2`, [a.id, siteId])
    : { rows: [] };
  if (!ok.rows[0]) throw forbidden('That site is not one of the sites you have access to');
}

// ═══ Sites ═══════════════════════════════════════════════════════════════════

type SiteSqlRow = {
  id: string;
  source: string;
  name: string | null;
  client: string | null;
  store_number: string | null;
  address1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  site_type: string | null;
  m_id: string | null;
  m_name: string | null;
  m_kind: 'human' | 'service' | null;
  is_active: boolean;
  on_map: boolean;
  buildings: number;
  assets: number;
  work_orders: number;
  open_work_orders: number;
  created_at: Date;
};

/** The row select, with the work-order counts trimmed to the viewer's scope. */
function siteSelect(a: ActingPrincipal, p: Params): string {
  const scope = woScopeClause(a, p);
  return `
    SELECT s.id::text AS id, s.external_source AS source, s.name, s.client, s.store_number, s.address1,
           s.city, s.state, s.zip, s.site_type,
           m.id::text AS m_id, m.display_name AS m_name, m.kind AS m_kind,
           s.is_active, (s.lat IS NOT NULL) AS on_map,
           (SELECT count(*)::int FROM site_location l WHERE l.site_id = s.id AND l.kind = 'building') AS buildings,
           (SELECT count(*)::int FROM asset x WHERE x.site_id = s.id AND x.deleted_at IS NULL) AS assets,
           (SELECT count(*)::int FROM task t WHERE t.site_id = s.id AND t.deleted_at IS NULL ${scope}) AS work_orders,
           (SELECT count(*)::int FROM task t WHERE t.site_id = s.id AND ${OPEN_WO} ${scope}) AS open_work_orders,
           s.created_at
      FROM site s
      LEFT JOIN principal m ON m.id = s.managed_by`;
}

function mapSite(r: SiteSqlRow): SiteRow {
  return {
    id: r.id,
    source: r.source,
    name: r.name,
    client: r.client,
    store_number: r.store_number,
    address1: r.address1,
    city: r.city,
    state: r.state,
    zip: r.zip,
    site_type: r.site_type,
    managed_by: actorOf(r.m_id, r.m_name, r.m_kind),
    is_active: r.is_active,
    on_map: r.on_map,
    buildings: r.buildings,
    assets: r.assets,
    work_orders: r.work_orders,
    open_work_orders: r.open_work_orders,
    created_at: iso(r.created_at)!,
  };
}

export interface SiteListQuery {
  search?: string;
  client?: string;
  state?: string;
  site_type?: string;
  managed_by?: string;
  /** active (default) · inactive · all */
  show?: 'active' | 'inactive' | 'all';
  flag?: 'not_on_map' | 'open_work' | 'no_assets';
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
}

const SITE_SORTS: Record<string, string> = {
  name: 'lower(s.name)',
  client: 'lower(s.client)',
  store: 's.store_number',
  city: 'lower(s.city)',
  state: 's.state',
  type: 'lower(s.site_type)',
  assets: 'assets',
  open: 'open_work_orders',
  work_orders: 'work_orders',
  added: 's.created_at',
};

function siteWhere(q: SiteListQuery, p: Params, actor: ActingPrincipal): string {
  const where = ['s.deleted_at IS NULL'];
  const access = siteAccessSql(actor, p, 's.id');
  if (access) where.push(access);
  const search = (q.search ?? '').trim();
  if (search !== '') {
    const like = p.add(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(s.name ILIKE ${like} OR s.client ILIKE ${like} OR s.store_number ILIKE ${like} OR s.address1 ILIKE ${like} OR s.city ILIKE ${like} OR s.zip ILIKE ${like})`);
  }
  if (q.client) where.push(`lower(s.client) = lower(${p.add(q.client)})`);
  if (q.state) where.push(`upper(s.state) = upper(${p.add(q.state)})`);
  if (q.site_type) where.push(`lower(s.site_type) = lower(${p.add(q.site_type)})`);
  if (q.managed_by === 'none') where.push('s.managed_by IS NULL');
  else if (q.managed_by && UUID_RE.test(q.managed_by)) where.push(`s.managed_by = ${p.add(q.managed_by)}`);
  if ((q.show ?? 'active') === 'active') where.push('s.is_active');
  if (q.show === 'inactive') where.push('NOT s.is_active');
  if (q.flag === 'not_on_map') where.push('s.lat IS NULL');
  if (q.flag === 'open_work') where.push(`EXISTS (SELECT 1 FROM task t WHERE t.site_id = s.id AND ${OPEN_WO})`);
  if (q.flag === 'no_assets') where.push('NOT EXISTS (SELECT 1 FROM asset x WHERE x.site_id = s.id AND x.deleted_at IS NULL)');
  return where.join(' AND ');
}

export async function listSites(q: SiteListQuery, actor: ActingPrincipal): Promise<SitesListResponse> {
  requireSitesView(actor);
  const pageSize = Math.min(100, Math.max(1, q.page_size ?? 50));
  const page = Math.max(1, q.page ?? 1);

  const cp = new Params();
  const total = await query<{ n: number }>(`SELECT count(*)::int AS n FROM site s WHERE ${siteWhere(q, cp, actor)}`, cp.values);

  const p = new Params();
  const select = siteSelect(actor, p);
  const where = siteWhere(q, p, actor);
  const sort = SITE_SORTS[q.sort ?? 'name'] ?? SITE_SORTS.name;
  const rows = await query<SiteSqlRow>(
    `${select} WHERE ${where}
      ORDER BY ${sort} ${q.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, lower(s.name), s.id
      LIMIT ${p.add(pageSize)} OFFSET ${p.add((page - 1) * pageSize)}`,
    p.values,
  );
  return { items: rows.rows.map(mapSite), total: total.rows[0]?.n ?? 0, page, page_size: pageSize };
}

async function counts(actor: ActingPrincipal): Promise<PortfolioCounts> {
  const p = new Params();
  const scope = woScopeClause(actor, p);
  const acc = siteAccessSql(actor, p, 's.id');
  const mine = acc ? `AND ${acc}` : '';
  const res = await query<PortfolioCounts>(
    `SELECT (SELECT count(*)::int FROM site s WHERE s.deleted_at IS NULL ${mine}) AS sites,
            (SELECT count(*)::int FROM site_location l JOIN site s ON s.id = l.site_id WHERE s.deleted_at IS NULL AND l.kind = 'building' ${mine}) AS buildings,
            (SELECT count(*)::int FROM site_location l JOIN site s ON s.id = l.site_id WHERE s.deleted_at IS NULL AND l.kind = 'floor' ${mine}) AS floors,
            (SELECT count(*)::int FROM site_location l JOIN site s ON s.id = l.site_id WHERE s.deleted_at IS NULL AND l.kind = 'space' ${mine}) AS spaces,
            (SELECT count(*)::int FROM asset x JOIN site s ON s.id = x.site_id WHERE x.deleted_at IS NULL ${mine}) AS assets,
            (SELECT count(*)::int FROM task t WHERE t.deleted_at IS NULL AND t.site_id IS NULL ${scope}) AS unlinked_work_orders,
            (WITH ${PLACE_CTE} SELECT count(*)::int FROM placed) AS linkable_work_orders`,
    p.values,
  );
  return res.rows[0];
}

const distinct = async (sql: string): Promise<string[]> => (await query<{ v: string }>(sql)).rows.map((r) => r.v);

export async function sitesMeta(actor: ActingPrincipal): Promise<SitesMetaResponse> {
  // Either door is enough: the Assets page needs the same lists.
  if (!can(actor, SITES_PERM_KEY, 'view')) requireAssetsView(actor);
  const [c, clients, states, siteTypes, categories, assetTypes, spaceTypes, entities, people] = await Promise.all([
    counts(actor),
    distinct(`SELECT DISTINCT btrim(client) AS v FROM site WHERE deleted_at IS NULL AND btrim(COALESCE(client, '')) <> '' ORDER BY 1`),
    distinct(`SELECT DISTINCT upper(btrim(state)) AS v FROM site WHERE deleted_at IS NULL AND btrim(COALESCE(state, '')) <> '' ORDER BY 1`),
    distinct(`SELECT v FROM (
                SELECT name AS v, position FROM site_type WHERE is_active
                UNION SELECT DISTINCT btrim(site_type), 1000 FROM site WHERE deleted_at IS NULL AND btrim(COALESCE(site_type, '')) <> ''
              ) x GROUP BY v ORDER BY min(position), v`),
    distinct(`SELECT v FROM (
                SELECT name AS v, position FROM asset_category WHERE is_active
                UNION SELECT DISTINCT btrim(category), 1000 FROM asset WHERE deleted_at IS NULL AND btrim(COALESCE(category, '')) <> ''
              ) x GROUP BY v ORDER BY min(position), v`),
    distinct(`SELECT DISTINCT btrim(asset_type) AS v FROM asset WHERE deleted_at IS NULL AND btrim(COALESCE(asset_type, '')) <> '' ORDER BY 1`),
    distinct(`SELECT DISTINCT btrim(space_type) AS v FROM site_location WHERE btrim(COALESCE(space_type, '')) <> '' ORDER BY 1`),
    distinct(`SELECT DISTINCT btrim(billing_entity) AS v FROM task WHERE deleted_at IS NULL AND btrim(COALESCE(billing_entity, '')) <> '' ORDER BY 1`),
    query<FeedActor>(
      `SELECT id::text AS id, display_name AS name, kind FROM principal
        WHERE kind = 'human' AND status <> 'disabled' ORDER BY lower(display_name)`,
    ),
  ]);
  return {
    counts: c,
    clients,
    states,
    site_types: siteTypes,
    asset_categories: categories,
    asset_types: assetTypes,
    space_types: spaceTypes,
    billing_entities: entities,
    people: people.rows,
    can: {
      sites: { create: can(actor, SITES_PERM_KEY, 'create'), edit: can(actor, SITES_PERM_KEY, 'edit'), delete: can(actor, SITES_PERM_KEY, 'delete') },
      assets: {
        view: can(actor, ASSETS_PERM_KEY, 'view'),
        create: can(actor, ASSETS_PERM_KEY, 'create'),
        edit: can(actor, ASSETS_PERM_KEY, 'edit'),
        delete: can(actor, ASSETS_PERM_KEY, 'delete'),
      },
    },
  };
}

export async function sitesMap(q: SiteListQuery, actor: ActingPrincipal): Promise<SiteMapPoint[]> {
  requireSitesView(actor);
  const p = new Params();
  const scope = woScopeClause(actor, p);
  const where = siteWhere(q, p, actor);
  const res = await query<SiteMapPoint>(
    `SELECT s.id::text AS id, COALESCE(s.name, s.client, 'Site') AS name, s.client, s.city, s.state, s.lat, s.lng,
            (SELECT count(*)::int FROM task t WHERE t.site_id = s.id AND ${OPEN_WO} ${scope}) AS open_work_orders,
            s.boundary_radius_ft
       FROM site s
      WHERE ${where} AND s.lat IS NOT NULL
      LIMIT 5000`,
    p.values,
  );
  return res.rows;
}

type SiteDetailRow = SiteSqlRow & {
  address2: string | null;
  phone_1: string | null;
  phone_2: string | null;
  ownership_status: string | null;
  billing_entity: string | null;
  contact_name: string | null;
  contact_email: string | null;
  hours: string | null;
  access_notes: string | null;
  notes: string | null;
  boundary_radius_ft: number | null;
  lat: number | null;
  lng: number | null;
  geo_source: 'zip' | 'city' | 'manual' | null;
  updated_at: Date;
};

async function loadLocations(siteId: string): Promise<SiteLocation[]> {
  const res = await query<Omit<SiteLocation, 'area_sqft'> & { area_sqft: string | null }>(
    `SELECT l.id::text AS id, l.parent_id::text AS parent_id, l.kind, l.name, l.level, l.space_type, l.area_sqft, l.notes, l.position,
            (SELECT count(*)::int FROM asset x WHERE x.location_id = l.id AND x.deleted_at IS NULL) AS assets
       FROM site_location l WHERE l.site_id = $1
      ORDER BY l.position, lower(l.name)`,
    [siteId],
  );
  return res.rows.map((r) => ({ ...r, area_sqft: num(r.area_sqft) }));
}

async function workOrdersAt(col: 't.site_id' | 't.asset_id', id: string, actor: ActingPrincipal): Promise<SiteWorkOrder[]> {
  const p = new Params();
  const hole = p.add(id);
  const scope = woScopeClause(actor, p);
  const res = await query<{ wo_number: string; title: string; status: string; status_group: string; trade: string | null; a_id: string | null; a_name: string | null; date_received: string | null; created_at: Date }>(
    `SELECT t.wo_number, t.title, st.name AS status, t.status_group::text AS status_group, t.trade,
            x.id::text AS a_id, x.name AS a_name, to_char(t.date_received, 'YYYY-MM-DD') AS date_received, t.created_at
       FROM task t JOIN status st ON st.id = t.status_id
       LEFT JOIN asset x ON x.id = t.asset_id
      WHERE ${col} = ${hole} AND t.deleted_at IS NULL ${scope}
      ORDER BY COALESCE(t.date_received, t.created_at::date) DESC, t.created_at DESC
      LIMIT 100`,
    p.values,
  );
  return res.rows.map((r) => ({
    wo_number: r.wo_number,
    title: r.title,
    status: r.status,
    status_group: r.status_group,
    trade: r.trade,
    asset: r.a_id ? { id: r.a_id, name: r.a_name ?? 'Asset' } : null,
    date_received: r.date_received,
    created_at: iso(r.created_at)!,
  }));
}

async function loadSite(id: string, actor: ActingPrincipal): Promise<SiteDetail> {
  const p = new Params();
  const select = siteSelect(actor, p).replace(
    's.created_at\n      FROM site s',
    `s.created_at, s.address2, s.phone_1, s.phone_2, s.ownership_status, s.billing_entity, s.contact_name,
           s.contact_email, s.hours, s.access_notes, s.notes, s.boundary_radius_ft, s.lat, s.lng, s.geo_source, s.updated_at
      FROM site s`,
  );
  const res = await query<SiteDetailRow>(`${select} WHERE s.id = ${p.add(id)} AND s.deleted_at IS NULL`, p.values);
  const r = res.rows[0];
  if (!r) throw notFound('Site not found');
  const seeAssets = can(actor, ASSETS_PERM_KEY, 'view');
  const [locations, assets, wos] = await Promise.all([
    loadLocations(id),
    seeAssets ? listAssetRows({ site: id, page_size: 500 }, actor) : Promise.resolve({ rows: [], total: 0 }),
    workOrdersAt('t.site_id', id, actor),
  ]);
  return {
    ...mapSite(r),
    address2: r.address2,
    phone_1: r.phone_1,
    phone_2: r.phone_2,
    ownership_status: r.ownership_status,
    billing_entity: r.billing_entity,
    contact_name: r.contact_name,
    contact_email: r.contact_email,
    hours: r.hours,
    access_notes: r.access_notes,
    notes: r.notes,
    boundary_radius_ft: r.boundary_radius_ft,
    lat: r.lat,
    lng: r.lng,
    geo_source: r.geo_source,
    locations,
    asset_list: assets.rows,
    recent_work_orders: wos,
    updated_at: iso(r.updated_at)!,
    can: {
      edit: can(actor, SITES_PERM_KEY, 'edit'),
      delete: can(actor, SITES_PERM_KEY, 'delete'),
      add_asset: can(actor, ASSETS_PERM_KEY, 'create'),
    },
  };
}

export async function getSite(id: string, actor: ActingPrincipal): Promise<SiteDetail> {
  requireSitesView(actor);
  if (!UUID_RE.test(id)) throw notFound('Site not found');
  await assertSiteAccess(actor, id);
  return loadSite(id, actor);
}

const SITE_TEXT: (keyof SiteInput)[] = [
  'name', 'client', 'store_number', 'address1', 'address2', 'city', 'state', 'zip', 'phone_1', 'phone_2', 'site_type',
  'ownership_status', 'billing_entity', 'contact_name', 'contact_email', 'hours', 'access_notes', 'notes',
];

function checkSiteInput(input: SiteInput): void {
  const r = input.boundary_radius_ft;
  if (r !== undefined && r !== null && (!Number.isInteger(r) || r < 50 || r > 26400)) {
    throw badRequest('The boundary must be between 50 feet and 5 miles (26,400 feet)', { field: 'boundary_radius_ft' });
  }
  const hasLat = input.lat !== undefined && input.lat !== null;
  const hasLng = input.lng !== undefined && input.lng !== null;
  if (hasLat !== hasLng) throw badRequest('Give both the latitude and the longitude, or neither', { field: 'lat' });
  if (hasLat && (Math.abs(input.lat!) > 90 || Math.abs(input.lng!) > 180)) throw badRequest('Those are not coordinates', { field: 'lat' });
  if (input.managed_by && !UUID_RE.test(input.managed_by)) throw badRequest('That is not a person', { field: 'managed_by' });
}

/** Put the pin where the address says, unless a person placed it by hand. */
async function placeSite(id: string, force = false): Promise<void> {
  const cur = await query<{ city: string | null; state: string | null; zip: string | null; geo_source: string | null }>(
    `SELECT city, state, zip, geo_source FROM site WHERE id = $1`,
    [id],
  );
  const s = cur.rows[0];
  if (!s || (s.geo_source === 'manual' && !force)) return;
  const hit = await geoLookup({ city: s.city, state: s.state, zip: s.zip });
  await query(`UPDATE site SET lat = $2, lng = $3, geo_source = $4 WHERE id = $1`, [id, hit?.lat ?? null, hit?.lng ?? null, hit?.from ?? null]);
}

export async function createSite(input: SiteInput, actor: ActingPrincipal): Promise<SiteDetail> {
  requirePerm(actor, SITES_PERM_KEY, 'create', 'You cannot add sites');
  checkSiteInput(input);
  const name = clean(input.name) ?? [clean(input.client), clean(input.store_number) ? `#${clean(input.store_number)}` : null].filter(Boolean).join(' ');
  if (!name) throw badRequest('A site needs a name, or a client and a store number', { field: 'name' });
  // A hand-made record is its own external id, so (source, id) stays unique.
  const id = (await query<{ id: string }>(`SELECT gen_random_uuid()::text AS id`)).rows[0].id;
  const cols = ['id', 'external_source', 'external_id', 'name', 'created_by'];
  const vals: unknown[] = [id, 'manual', id, name, actor.id];
  for (const c of SITE_TEXT) {
    if (c === 'name') continue;
    const v = c === 'state' ? (normalizeState(input.state) ?? clean(input.state)) : c === 'zip' ? (zip5(input.zip) ?? clean(input.zip)) : clean(input[c] as string | null);
    if (v !== null) {
      cols.push(c);
      vals.push(v);
    }
  }
  if (input.managed_by) { cols.push('managed_by'); vals.push(input.managed_by); }
  if (input.boundary_radius_ft != null) { cols.push('boundary_radius_ft'); vals.push(input.boundary_radius_ft); }
  if (input.is_active === false) { cols.push('is_active'); vals.push(false); }
  await query(`INSERT INTO site (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
  if (input.lat != null && input.lng != null) {
    await query(`UPDATE site SET lat = $2, lng = $3, geo_source = 'manual' WHERE id = $1`, [id, input.lat, input.lng]);
  } else {
    await placeSite(id);
  }
  await logAdminEvent({ actorId: actor.id, entity: 'site', entityId: id, action: 'site_created', after: { name, client: clean(input.client), city: clean(input.city), state: clean(input.state) } });
  return loadSite(id, actor);
}

const SITE_DIFF: (keyof SiteDetail)[] = [
  'name', 'client', 'store_number', 'address1', 'address2', 'city', 'state', 'zip', 'phone_1', 'phone_2', 'site_type',
  'ownership_status', 'billing_entity', 'contact_name', 'contact_email', 'hours', 'access_notes', 'notes',
  'boundary_radius_ft', 'lat', 'lng', 'is_active',
];

export async function updateSite(id: string, input: SiteInput, actor: ActingPrincipal): Promise<SiteDetail> {
  requirePerm(actor, SITES_PERM_KEY, 'edit', 'You cannot edit sites');
  if (!UUID_RE.test(id)) throw notFound('Site not found');
  checkSiteInput(input);
  await assertSiteAccess(actor, id);
  const before = await loadSite(id, actor);

  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  let addressChanged = false;
  for (const c of SITE_TEXT) {
    if (input[c] === undefined) continue;
    const v = c === 'state' ? (normalizeState(input.state) ?? clean(input.state)) : c === 'zip' ? (zip5(input.zip) ?? clean(input.zip)) : clean(input[c] as string | null);
    if ((before as unknown as Record<string, unknown>)[c] === v) continue;
    if (before.source === 'ecotrak' && SITE_SYNCED_FIELDS.includes(c)) {
      throw conflict('This site comes from Ecotrak, which rewrites its name, client, store number and address on every sync. Change them in Ecotrak.', { field: c });
    }
    if (c === 'name' && v === null) throw badRequest('A site needs a name', { field: 'name' });
    if (c === 'city' || c === 'state' || c === 'zip') addressChanged = true;
    set(c, v);
  }
  if (input.managed_by !== undefined) set('managed_by', input.managed_by);
  if (input.boundary_radius_ft !== undefined) set('boundary_radius_ft', input.boundary_radius_ft);
  if (input.is_active !== undefined) set('is_active', input.is_active);
  if (input.lat !== undefined && input.lng !== undefined) {
    if (input.lat === null) {
      set('geo_source', null);
      addressChanged = true; // place it from the address again
    } else if (input.lat !== before.lat || input.lng !== before.lng) {
      set('lat', input.lat);
      set('lng', input.lng);
      set('geo_source', 'manual');
    }
  }
  if (sets.length > 0) {
    vals.push(id);
    await query(`UPDATE site SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }
  if (addressChanged) await placeSite(id);

  const after = await loadSite(id, actor);
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of SITE_DIFF) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    b[k] = before[k];
    a[k] = after[k];
  }
  if ((before.managed_by?.id ?? null) !== (after.managed_by?.id ?? null)) {
    b.managed_by = before.managed_by?.name ?? null;
    a.managed_by = after.managed_by?.name ?? null;
  }
  if (Object.keys(a).length > 0) {
    await logAdminEvent({ actorId: actor.id, entity: 'site', entityId: id, action: 'site_updated', before: { name: before.name ?? 'Site', ...b }, after: { name: after.name ?? 'Site', ...a } });
  }
  return after;
}

export async function deleteSite(id: string, actor: ActingPrincipal): Promise<void> {
  requirePerm(actor, SITES_PERM_KEY, 'delete', 'You cannot remove sites');
  if (!UUID_RE.test(id)) throw notFound('Site not found');
  await assertSiteAccess(actor, id);
  const res = await query<{ name: string | null; open: number }>(
    `UPDATE site s SET deleted_at = now(), is_active = false WHERE s.id = $1 AND s.deleted_at IS NULL
     RETURNING s.name, (SELECT count(*)::int FROM task t WHERE t.site_id = s.id AND ${OPEN_WO}) AS open`,
    [id],
  );
  if (!res.rows[0]) throw notFound('Site not found');
  await logAdminEvent({ actorId: actor.id, entity: 'site', entityId: id, action: 'site_deleted', before: { name: res.rows[0].name ?? 'Site', open_work_orders: res.rows[0].open } });
}

// ── Buildings, floors, spaces ────────────────────────────────────────────────

async function siteName(siteId: string): Promise<string> {
  if (!UUID_RE.test(siteId)) throw notFound('Site not found');
  const s = await query<{ name: string | null }>(`SELECT name FROM site WHERE id = $1 AND deleted_at IS NULL`, [siteId]);
  if (!s.rows[0]) throw notFound('Site not found');
  return s.rows[0].name ?? 'Site';
}

async function parentKindOf(siteId: string, parentId: string | null): Promise<SiteLocationKind | null> {
  if (!parentId) return null;
  if (!UUID_RE.test(parentId)) throw badRequest('That place does not exist', { field: 'parent_id' });
  const res = await query<{ kind: SiteLocationKind }>(`SELECT kind FROM site_location WHERE id = $1 AND site_id = $2`, [parentId, siteId]);
  if (!res.rows[0]) throw badRequest('That place is not on this site', { field: 'parent_id' });
  return res.rows[0].kind;
}

export async function addLocation(siteId: string, input: SiteLocationInput, actor: ActingPrincipal): Promise<SiteDetail> {
  requirePerm(actor, SITES_PERM_KEY, 'edit', 'You cannot edit sites');
  await assertSiteAccess(actor, siteId);
  const site = await siteName(siteId);
  const kind = input.kind;
  if (kind !== 'building' && kind !== 'floor' && kind !== 'space') throw badRequest('Say whether it is a building, a floor or a space', { field: 'kind' });
  const name = clean(input.name);
  if (!name) throw badRequest('It needs a name', { field: 'name' });
  const parentKind = await parentKindOf(siteId, input.parent_id ?? null);
  if (!canNestUnder(kind, parentKind)) {
    throw badRequest(
      kind === 'building' ? 'A building sits on the site itself' : kind === 'floor' ? 'A floor belongs in a building' : 'A space sits on a floor, in a building or on the site',
      { field: 'parent_id' },
    );
  }
  const ins = await query<{ id: string }>(
    `INSERT INTO site_location (site_id, parent_id, kind, name, level, space_type, area_sqft, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id::text AS id`,
    [siteId, input.parent_id ?? null, kind, name, kind === 'floor' ? (input.level ?? null) : null, kind === 'space' ? clean(input.space_type) : null, input.area_sqft ?? null, clean(input.notes), actor.id],
  );
  await logAdminEvent({ actorId: actor.id, entity: 'site', entityId: siteId, action: 'site_location_added', after: { name: site, kind, location: name, location_id: ins.rows[0].id } });
  return loadSite(siteId, actor);
}

export async function updateLocation(siteId: string, locId: string, input: SiteLocationInput, actor: ActingPrincipal): Promise<SiteDetail> {
  requirePerm(actor, SITES_PERM_KEY, 'edit', 'You cannot edit sites');
  await assertSiteAccess(actor, siteId);
  const site = await siteName(siteId);
  if (!UUID_RE.test(locId)) throw notFound('That place does not exist');
  const cur = await query<{ kind: SiteLocationKind; name: string }>(`SELECT kind, name FROM site_location WHERE id = $1 AND site_id = $2`, [locId, siteId]);
  if (!cur.rows[0]) throw notFound('That place does not exist');
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (input.name !== undefined) {
    const name = clean(input.name);
    if (!name) throw badRequest('It needs a name', { field: 'name' });
    set('name', name);
  }
  if (input.level !== undefined && cur.rows[0].kind === 'floor') set('level', input.level);
  if (input.space_type !== undefined && cur.rows[0].kind === 'space') set('space_type', clean(input.space_type));
  if (input.area_sqft !== undefined) set('area_sqft', input.area_sqft);
  if (input.notes !== undefined) set('notes', clean(input.notes));
  if (sets.length > 0) {
    vals.push(locId);
    await query(`UPDATE site_location SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    await logAdminEvent({ actorId: actor.id, entity: 'site', entityId: siteId, action: 'site_location_updated', before: { name: site, location: cur.rows[0].name }, after: { name: site, location: clean(input.name) ?? cur.rows[0].name } });
  }
  return loadSite(siteId, actor);
}

export async function removeLocation(siteId: string, locId: string, actor: ActingPrincipal): Promise<SiteDetail> {
  requirePerm(actor, SITES_PERM_KEY, 'edit', 'You cannot edit sites');
  await assertSiteAccess(actor, siteId);
  const site = await siteName(siteId);
  if (!UUID_RE.test(locId)) throw notFound('That place does not exist');
  // Everything inside goes with it (the FK cascades); assets standing there
  // stay at the site and simply lose their place.
  const res = await query<{ name: string; kind: string }>(`DELETE FROM site_location WHERE id = $1 AND site_id = $2 RETURNING name, kind`, [locId, siteId]);
  if (!res.rows[0]) throw notFound('That place does not exist');
  await logAdminEvent({ actorId: actor.id, entity: 'site', entityId: siteId, action: 'site_location_removed', before: { name: site, kind: res.rows[0].kind, location: res.rows[0].name } });
  return loadSite(siteId, actor);
}

// ═══ Assets ══════════════════════════════════════════════════════════════════

type AssetSqlRow = {
  id: string;
  source: string;
  name: string;
  asset_type: string | null;
  category: string | null;
  manufacturer: string | null;
  model_number: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  s_id: string | null;
  s_name: string | null;
  s_client: string | null;
  s_city: string | null;
  s_state: string | null;
  location_id: string | null;
  location: string | null;
  status: AssetStatus;
  condition: AssetCondition | null;
  warranty_expires_on: string | null;
  work_orders: number;
  open_work_orders: number;
  created_at: Date;
};

/** "Building › Floor › Space" for a location, walked up in SQL. */
const LOCATION_PATH_SQL = `
  (WITH RECURSIVE up AS (
     SELECT l.id, l.parent_id, l.name, 1 AS d FROM site_location l WHERE l.id = x.location_id
     UNION ALL
     SELECT l.id, l.parent_id, l.name, up.d + 1 FROM site_location l JOIN up ON l.id = up.parent_id WHERE up.d < 10
   ) SELECT string_agg(name, ' › ' ORDER BY d DESC) FROM up)`;

function assetSelect(a: ActingPrincipal, p: Params): string {
  const scope = woScopeClause(a, p);
  return `
    SELECT x.id::text AS id, x.external_source AS source, x.name, x.asset_type, x.category, x.manufacturer,
           x.model_number, x.serial_number, x.asset_tag,
           s.id::text AS s_id, COALESCE(s.name, s.client) AS s_name, s.client AS s_client, s.city AS s_city, s.state AS s_state,
           x.location_id::text AS location_id, ${LOCATION_PATH_SQL} AS location,
           x.status, x.condition, to_char(x.warranty_expires_on, 'YYYY-MM-DD') AS warranty_expires_on,
           (SELECT count(*)::int FROM task t WHERE t.asset_id = x.id AND t.deleted_at IS NULL ${scope}) AS work_orders,
           (SELECT count(*)::int FROM task t WHERE t.asset_id = x.id AND ${OPEN_WO} ${scope}) AS open_work_orders,
           x.created_at
      FROM asset x
      LEFT JOIN site s ON s.id = x.site_id`;
}

function mapAsset(r: AssetSqlRow): AssetRow {
  return {
    id: r.id,
    source: r.source,
    name: r.name,
    asset_type: r.asset_type,
    category: r.category,
    manufacturer: r.manufacturer,
    model_number: r.model_number,
    serial_number: r.serial_number,
    asset_tag: r.asset_tag,
    site: r.s_id ? { id: r.s_id, name: r.s_name ?? 'Site', client: r.s_client, city: r.s_city, state: r.s_state } : null,
    location: r.location,
    location_id: r.location_id,
    status: r.status,
    condition: r.condition,
    warranty_expires_on: r.warranty_expires_on,
    warranty: warrantyState(r.warranty_expires_on, today()),
    work_orders: r.work_orders,
    open_work_orders: r.open_work_orders,
    created_at: iso(r.created_at)!,
  };
}

export interface AssetListQuery {
  search?: string;
  site?: string;
  client?: string;
  category?: string;
  asset_type?: string;
  status?: AssetStatus;
  condition?: AssetCondition | 'none';
  warranty?: 'expired' | 'expiring' | 'active' | 'none';
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
}

const ASSET_SORTS: Record<string, string> = {
  name: 'lower(x.name)',
  type: 'lower(x.asset_type)',
  category: 'lower(x.category)',
  site: 'lower(COALESCE(s.name, s.client))',
  status: 'x.status',
  condition: `CASE x.condition WHEN 'critical' THEN 0 WHEN 'poor' THEN 1 WHEN 'fair' THEN 2 WHEN 'good' THEN 3 END`,
  warranty: 'x.warranty_expires_on',
  work_orders: 'work_orders',
  added: 'x.created_at',
};

function assetWhere(q: AssetListQuery, p: Params, actor: ActingPrincipal): string {
  const where = ['x.deleted_at IS NULL'];
  const access = siteAccessSql(actor, p, 'x.site_id');
  if (access) where.push(access);
  const search = (q.search ?? '').trim();
  if (search !== '') {
    const like = p.add(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(x.name ILIKE ${like} OR x.asset_type ILIKE ${like} OR x.model_number ILIKE ${like} OR x.serial_number ILIKE ${like} OR x.asset_tag ILIKE ${like} OR x.manufacturer ILIKE ${like} OR s.name ILIKE ${like})`);
  }
  if (q.site && UUID_RE.test(q.site)) where.push(`x.site_id = ${p.add(q.site)}`);
  if (q.client) where.push(`lower(s.client) = lower(${p.add(q.client)})`);
  if (q.category) where.push(`lower(x.category) = lower(${p.add(q.category)})`);
  if (q.asset_type) where.push(`lower(x.asset_type) = lower(${p.add(q.asset_type)})`);
  if (q.status) where.push(`x.status = ${p.add(q.status)}`);
  if (q.condition === 'none') where.push('x.condition IS NULL');
  else if (q.condition) where.push(`x.condition = ${p.add(q.condition)}`);
  // "Today" is a day in Chicago, like every other date here (0024).
  const day = `(now() AT TIME ZONE 'America/Chicago')::date`;
  if (q.warranty === 'none') where.push('x.warranty_expires_on IS NULL');
  if (q.warranty === 'expired') where.push(`x.warranty_expires_on < ${day}`);
  if (q.warranty === 'expiring') where.push(`x.warranty_expires_on >= ${day} AND x.warranty_expires_on <= ${day} + 60`);
  if (q.warranty === 'active') where.push(`x.warranty_expires_on > ${day} + 60`);
  return where.join(' AND ');
}

async function listAssetRows(q: AssetListQuery, actor: ActingPrincipal): Promise<{ rows: AssetRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(500, Math.max(1, q.page_size ?? 50));
  const page = Math.max(1, q.page ?? 1);
  const cp = new Params();
  const total = await query<{ n: number }>(`SELECT count(*)::int AS n FROM asset x LEFT JOIN site s ON s.id = x.site_id WHERE ${assetWhere(q, cp, actor)}`, cp.values);
  const p = new Params();
  const select = assetSelect(actor, p);
  const where = assetWhere(q, p, actor);
  const sort = ASSET_SORTS[q.sort ?? 'name'] ?? ASSET_SORTS.name;
  const rows = await query<AssetSqlRow>(
    `${select} WHERE ${where}
      ORDER BY ${sort} ${q.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, lower(x.name), x.id
      LIMIT ${p.add(pageSize)} OFFSET ${p.add((page - 1) * pageSize)}`,
    p.values,
  );
  return { rows: rows.rows.map(mapAsset), total: total.rows[0]?.n ?? 0, page, pageSize };
}

export async function listAssets(q: AssetListQuery, actor: ActingPrincipal): Promise<AssetsListResponse> {
  requireAssetsView(actor);
  const r = await listAssetRows({ ...q, page_size: Math.min(100, q.page_size ?? 50) }, actor);
  return { items: r.rows, total: r.total, page: r.page, page_size: r.pageSize };
}

type AssetDetailRow = AssetSqlRow & {
  description: string | null;
  alt_description: string | null;
  install_date: string | null;
  warranty_provider: string | null;
  warranty_notes: string | null;
  notes: string | null;
  condition_at: Date | null;
  p_id: string | null;
  p_name: string | null;
  updated_at: Date;
};

async function loadAsset(id: string, actor: ActingPrincipal): Promise<AssetDetail> {
  const p = new Params();
  const select = assetSelect(actor, p).replace(
    'x.created_at\n      FROM asset x',
    `x.created_at, x.description, x.alt_description, to_char(x.install_date, 'YYYY-MM-DD') AS install_date,
           x.warranty_provider, x.warranty_notes, x.notes, x.condition_at, x.updated_at,
           x.parent_asset_id::text AS p_id, (SELECT pa.name FROM asset pa WHERE pa.id = x.parent_asset_id) AS p_name
      FROM asset x`,
  );
  const res = await query<AssetDetailRow>(`${select} WHERE x.id = ${p.add(id)} AND x.deleted_at IS NULL`, p.values);
  const r = res.rows[0];
  if (!r) throw notFound('Asset not found');
  await assertSiteAccess(actor, r.s_id);
  const [children, log, history] = await Promise.all([
    query<{ id: string; name: string; asset_type: string | null; status: AssetStatus }>(
      `SELECT id::text AS id, name, asset_type, status FROM asset WHERE parent_asset_id = $1 AND deleted_at IS NULL ORDER BY lower(name)`,
      [id],
    ),
    query<{ id: string; condition: AssetCondition; note: string | null; wo_number: string | null; r_id: string | null; r_name: string | null; r_kind: 'human' | 'service' | null; recorded_at: Date }>(
      `SELECT c.id::text AS id, c.condition, c.note, t.wo_number, pr.id::text AS r_id, pr.display_name AS r_name, pr.kind AS r_kind, c.recorded_at
         FROM asset_condition_log c
         LEFT JOIN task t ON t.id = c.task_id
         LEFT JOIN principal pr ON pr.id = c.recorded_by
        WHERE c.asset_id = $1 ORDER BY c.recorded_at DESC LIMIT 200`,
      [id],
    ),
    workOrdersAt('t.asset_id', id, actor),
  ]);
  const entries: AssetConditionEntry[] = log.rows.map((c) => ({
    id: c.id,
    condition: c.condition,
    note: c.note,
    wo_number: c.wo_number,
    recorded_by: actorOf(c.r_id, c.r_name, c.r_kind),
    recorded_at: iso(c.recorded_at)!,
  }));
  return {
    ...mapAsset(r),
    description: r.description,
    alt_description: r.alt_description,
    install_date: r.install_date,
    warranty_provider: r.warranty_provider,
    warranty_notes: r.warranty_notes,
    notes: r.notes,
    condition_at: iso(r.condition_at),
    parent: r.p_id ? { id: r.p_id, name: r.p_name ?? 'Asset' } : null,
    children: children.rows,
    condition_log: entries,
    service_history: history,
    updated_at: iso(r.updated_at)!,
    can: { edit: can(actor, ASSETS_PERM_KEY, 'edit'), delete: can(actor, ASSETS_PERM_KEY, 'delete') },
  };
}

export async function getAsset(id: string, actor: ActingPrincipal): Promise<AssetDetail> {
  requireAssetsView(actor);
  if (!UUID_RE.test(id)) throw notFound('Asset not found');
  return loadAsset(id, actor);
}

const ASSET_TEXT: (keyof AssetInput)[] = [
  'asset_type', 'category', 'manufacturer', 'model_number', 'serial_number', 'asset_tag', 'description',
  'warranty_provider', 'warranty_notes', 'notes',
];
const ASSET_DAYS: (keyof AssetInput)[] = ['install_date', 'warranty_expires_on'];

/** Checks the fields that point at other records, against the site the asset
 *  is (or will be) at. Returns nothing; throws what is wrong. */
async function checkAssetLinks(input: AssetInput, siteId: string | null, selfId: string | null): Promise<void> {
  for (const d of ASSET_DAYS) {
    const v = input[d] as string | null | undefined;
    if (v && !DAY_RE.test(v)) throw badRequest('That is not a date', { field: d });
  }
  if (input.status !== undefined && !['in_service', 'out_of_service', 'retired'].includes(input.status)) {
    throw badRequest('That is not an asset status', { field: 'status' });
  }
  if (input.location_id) {
    if (!UUID_RE.test(input.location_id)) throw badRequest('That place does not exist', { field: 'location_id' });
    const l = await query<{ site_id: string }>(`SELECT site_id::text AS site_id FROM site_location WHERE id = $1`, [input.location_id]);
    if (!l.rows[0]) throw badRequest('That place does not exist', { field: 'location_id' });
    if (l.rows[0].site_id !== siteId) throw badRequest('That place is at a different site', { field: 'location_id' });
  }
  if (input.parent_asset_id) {
    if (!UUID_RE.test(input.parent_asset_id)) throw badRequest('That asset does not exist', { field: 'parent_asset_id' });
    if (input.parent_asset_id === selfId) throw badRequest('An asset cannot be part of itself', { field: 'parent_asset_id' });
    // Walk up from the proposed parent: meeting ourselves would be a loop.
    const chain = await query<{ id: string }>(
      `WITH RECURSIVE up AS (
         SELECT id, parent_asset_id, 1 AS d FROM asset WHERE id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT a.id, a.parent_asset_id, up.d + 1 FROM asset a JOIN up ON a.id = up.parent_asset_id WHERE up.d < 25
       ) SELECT id::text AS id FROM up`,
      [input.parent_asset_id],
    );
    if (chain.rows.length === 0) throw badRequest('That asset does not exist', { field: 'parent_asset_id' });
    if (selfId && chain.rows.some((r) => r.id === selfId)) throw badRequest('That would make the asset part of itself', { field: 'parent_asset_id' });
  }
}

export async function createAsset(input: AssetInput, actor: ActingPrincipal): Promise<AssetDetail> {
  requirePerm(actor, ASSETS_PERM_KEY, 'create', 'You cannot add assets');
  const name = clean(input.name);
  if (!name) throw badRequest('An asset needs a name', { field: 'name' });
  const siteId = input.site_id ?? null;
  if (!siteId) throw badRequest('Say which site the asset is at', { field: 'site_id' });
  await assertSiteAccess(actor, siteId);
  await siteName(siteId);
  await checkAssetLinks(input, siteId, null);
  const id = (await query<{ id: string }>(`SELECT gen_random_uuid()::text AS id`)).rows[0].id;
  const cols = ['id', 'external_source', 'external_id', 'site_id', 'name', 'created_by'];
  const vals: unknown[] = [id, 'manual', id, siteId, name, actor.id];
  for (const c of [...ASSET_TEXT, ...ASSET_DAYS]) {
    const v = clean(input[c] as string | null);
    if (v !== null) { cols.push(c); vals.push(v); }
  }
  if (input.parent_asset_id) { cols.push('parent_asset_id'); vals.push(input.parent_asset_id); }
  if (input.location_id) { cols.push('location_id'); vals.push(input.location_id); }
  if (input.status) { cols.push('status'); vals.push(input.status); }
  await query(`INSERT INTO asset (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
  await logAdminEvent({ actorId: actor.id, entity: 'asset', entityId: id, action: 'asset_created', after: { name, asset_type: clean(input.asset_type), site_id: siteId } });
  return loadAsset(id, actor);
}

const ASSET_DIFF: (keyof AssetDetail)[] = [
  'name', 'asset_type', 'category', 'manufacturer', 'model_number', 'serial_number', 'asset_tag', 'description',
  'install_date', 'warranty_expires_on', 'warranty_provider', 'warranty_notes', 'status', 'notes', 'location',
];

export async function updateAsset(id: string, input: AssetInput, actor: ActingPrincipal): Promise<AssetDetail> {
  requirePerm(actor, ASSETS_PERM_KEY, 'edit', 'You cannot edit assets');
  if (!UUID_RE.test(id)) throw notFound('Asset not found');
  const before = await loadAsset(id, actor);
  const siteId = input.site_id !== undefined ? input.site_id : (before.site?.id ?? null);
  if (input.site_id !== undefined) {
    if (!input.site_id) throw badRequest('An asset is always at a site', { field: 'site_id' });
    await assertSiteAccess(actor, input.site_id);
    await siteName(input.site_id);
  }
  await checkAssetLinks(input, siteId, id);

  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (input.name !== undefined) {
    const name = clean(input.name);
    if (!name) throw badRequest('An asset needs a name', { field: 'name' });
    set('name', name);
  }
  for (const c of [...ASSET_TEXT, ...ASSET_DAYS]) if (input[c] !== undefined) set(c, clean(input[c] as string | null));
  if (input.status !== undefined) set('status', input.status);
  if (input.parent_asset_id !== undefined) set('parent_asset_id', input.parent_asset_id);
  if (input.site_id !== undefined && input.site_id !== before.site?.id) {
    set('site_id', input.site_id);
    // Moved to another site: the place it stood in stays behind.
    if (input.location_id === undefined) set('location_id', null);
  }
  if (input.location_id !== undefined) set('location_id', input.location_id);
  if (sets.length > 0) {
    vals.push(id);
    await query(`UPDATE asset SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }
  const after = await loadAsset(id, actor);
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of ASSET_DIFF) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    b[k] = before[k];
    a[k] = after[k];
  }
  if ((before.site?.id ?? null) !== (after.site?.id ?? null)) { b.site = before.site?.name ?? null; a.site = after.site?.name ?? null; }
  if ((before.parent?.id ?? null) !== (after.parent?.id ?? null)) { b.part_of = before.parent?.name ?? null; a.part_of = after.parent?.name ?? null; }
  if (Object.keys(a).length > 0) {
    await logAdminEvent({ actorId: actor.id, entity: 'asset', entityId: id, action: 'asset_updated', before: { name: before.name, ...b }, after: { name: after.name, ...a } });
  }
  return after;
}

export async function deleteAsset(id: string, actor: ActingPrincipal): Promise<void> {
  requirePerm(actor, ASSETS_PERM_KEY, 'delete', 'You cannot remove assets');
  if (!UUID_RE.test(id)) throw notFound('Asset not found');
  await loadAsset(id, actor); // 404, or 403 for an asset at a site outside their list
  const res = await query<{ name: string }>(`UPDATE asset SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING name`, [id]);
  if (!res.rows[0]) throw notFound('Asset not found');
  // Its parts become assets in their own right rather than pointing at nothing visible.
  await query(`UPDATE asset SET parent_asset_id = NULL WHERE parent_asset_id = $1`, [id]);
  await logAdminEvent({ actorId: actor.id, entity: 'asset', entityId: id, action: 'asset_deleted', before: { name: res.rows[0].name } });
}

export async function recordCondition(
  id: string,
  input: { condition: AssetCondition; note?: string | null; wo_number?: string | null },
  actor: ActingPrincipal,
): Promise<AssetDetail> {
  requirePerm(actor, ASSETS_PERM_KEY, 'edit', 'You cannot edit assets');
  if (!UUID_RE.test(id)) throw notFound('Asset not found');
  const cur = await query<{ name: string; condition: string | null; site_id: string | null }>(`SELECT name, condition, site_id::text AS site_id FROM asset WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!cur.rows[0]) throw notFound('Asset not found');
  await assertSiteAccess(actor, cur.rows[0].site_id);
  if (!['good', 'fair', 'poor', 'critical'].includes(input.condition)) throw badRequest('That is not a condition', { field: 'condition' });
  let taskId: string | null = null;
  const wo = clean(input.wo_number);
  if (wo) {
    const t = await query<{ id: string }>(`SELECT id::text AS id FROM task WHERE wo_number = $1 AND deleted_at IS NULL`, [wo]);
    if (!t.rows[0]) throw badRequest(`There is no work order ${wo}`, { field: 'wo_number' });
    taskId = t.rows[0].id;
  }
  await withTransaction(async (tx) => {
    await tx.query(`INSERT INTO asset_condition_log (asset_id, condition, note, task_id, recorded_by) VALUES ($1, $2, $3, $4, $5)`, [id, input.condition, clean(input.note), taskId, actor.id]);
    await tx.query(`UPDATE asset SET condition = $2, condition_at = now() WHERE id = $1`, [id, input.condition]);
  });
  await logAdminEvent({
    actorId: actor.id,
    entity: 'asset',
    entityId: id,
    action: 'asset_condition_recorded',
    before: { name: cur.rows[0].name, condition: cur.rows[0].condition },
    after: { name: cur.rows[0].name, condition: input.condition, note: clean(input.note), wo_number: wo },
  });
  return loadAsset(id, actor);
}

// ═══ History ═════════════════════════════════════════════════════════════════

export async function portfolioHistory(entity: 'site' | 'asset', id: string, actor: ActingPrincipal): Promise<PortfolioHistoryEntry[]> {
  if (entity === 'site') requireSitesView(actor);
  else requireAssetsView(actor);
  if (!UUID_RE.test(id)) throw notFound('Not found');
  // entity_id is text (0017): the id travels as text, never as a uuid here.
  const res = await query<{ id: string; action: string; a_id: string | null; a_name: string | null; a_kind: 'human' | 'service' | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; created_at: Date }>(
    `SELECT a.id::text AS id, a.action, p.id::text AS a_id, p.display_name AS a_name, p.kind AS a_kind, a.before, a.after, a.created_at
       FROM activity_log a LEFT JOIN principal p ON p.id = a.actor_principal_id
      WHERE a.entity_type = $1 AND a.entity_id = $2::text
      ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    [entity, id],
  );
  return res.rows.map((r) => ({ id: r.id, action: r.action, actor: actorOf(r.a_id, r.a_name, r.a_kind), before: r.before, after: r.after, created_at: iso(r.created_at)! }));
}

// ═══ The work order's place ══════════════════════════════════════════════════

export async function woPlace(taskId: string, actor: ActingPrincipal): Promise<WoPlaceResponse> {
  const seeSites = can(actor, SITES_PERM_KEY, 'view');
  const seeAssets = can(actor, ASSETS_PERM_KEY, 'view');
  const t = await query<{ site_id: string | null; asset_id: string | null; client: string | null; city: string | null; state: string | null; store: string | null }>(
    `SELECT site_id::text AS site_id, asset_id::text AS asset_id, client, city, state, fields->>'Store' AS store FROM task WHERE id = $1`,
    [taskId],
  );
  const row = t.rows[0];
  if (!row) throw notFound('Work order not found');

  let site: WoPlaceResponse['site'] = null;
  if (row.site_id) {
    const p = new Params();
    const hole = p.add(row.site_id);
    const scope = woScopeClause(actor, p);
    const s = await query<NonNullable<WoPlaceResponse['site']>>(
      `SELECT s.id::text AS id, s.name, s.client, s.store_number, s.address1, s.city, s.state, s.zip, s.site_type,
              (SELECT count(*)::int FROM task t WHERE t.site_id = s.id AND ${OPEN_WO} ${scope}) AS open_work_orders,
              s.phone_1, s.hours, s.access_notes, s.lat, s.lng, s.boundary_radius_ft
         FROM site s WHERE s.id = ${hole}`,
      p.values,
    );
    site = s.rows[0] ?? null;
  }

  let asset: WoPlaceResponse['asset'] = null;
  if (row.asset_id) {
    const a = await query<{ id: string; name: string; asset_type: string | null; category: string | null; model_number: string | null; serial_number: string | null; status: AssetStatus; condition: AssetCondition | null; warranty_expires_on: string | null; location: string | null }>(
      `SELECT x.id::text AS id, x.name, x.asset_type, x.category, x.model_number, x.serial_number, x.status, x.condition,
              to_char(x.warranty_expires_on, 'YYYY-MM-DD') AS warranty_expires_on, ${LOCATION_PATH_SQL} AS location
         FROM asset x WHERE x.id = $1`,
      [row.asset_id],
    );
    if (a.rows[0]) asset = { ...a.rows[0], warranty: warrantyState(a.rows[0].warranty_expires_on, today()) };
  }

  // Nothing linked: offer the sites this work order most likely means.
  let suggestions: WoPlaceResponse['suggestions'] = [];
  if (!site && seeSites && row.client) {
    const s = await query<WoPlaceResponse['suggestions'][number] & { rank: number }>(
      `SELECT s.id::text AS id, s.name, s.client, s.store_number, s.address1, s.city, s.state,
              (CASE WHEN $2::text IS NOT NULL AND s.store_number = $2 THEN 0 ELSE 1 END
               + CASE WHEN $3::text IS NOT NULL AND lower(s.city) = lower($3) THEN 0 ELSE 1 END) AS rank
         FROM site s
        WHERE s.deleted_at IS NULL AND lower(s.client) = lower($1)
          AND (($2::text IS NOT NULL AND s.store_number = $2) OR ($3::text IS NOT NULL AND lower(s.city) = lower($3)))
          AND ($4::uuid IS NULL OR s.id IN (SELECT ps.site_id FROM principal_site ps WHERE ps.principal_id = $4::uuid))
        ORDER BY rank, lower(s.name) LIMIT 8`,
      [row.client, clean(row.store), clean(row.city), actor.siteRestricted && !actor.isSuperAdmin ? actor.id : null],
    );
    suggestions = s.rows.map(({ rank: _rank, ...rest }) => rest);
  }

  let siteAssets: WoPlaceResponse['site_assets'] = [];
  if (site && seeAssets) {
    const a = await query<WoPlaceResponse['site_assets'][number]>(
      `SELECT x.id::text AS id, x.name, x.asset_type, ${LOCATION_PATH_SQL} AS location
         FROM asset x WHERE x.site_id = $1 AND x.deleted_at IS NULL AND x.status <> 'retired'
        ORDER BY lower(x.name) LIMIT 500`,
      [site.id],
    );
    siteAssets = a.rows;
  }
  return {
    site,
    asset,
    suggestions,
    site_assets: siteAssets,
    can: { link: can(actor, SITES_PERM_KEY, 'edit') && can(actor, 'work_orders', 'edit'), view_sites: seeSites, view_assets: seeAssets },
  };
}

/** Point a work order at a site and, optionally, one of that site's assets.
 *  Logged on the work order like any other field change. */
export async function setWoPlace(
  taskId: string,
  input: { site_id?: string | null; asset_id?: string | null },
  actor: ActingPrincipal,
): Promise<WoPlaceResponse> {
  requirePerm(actor, 'work_orders', 'edit', 'You cannot edit work orders');
  requirePerm(actor, SITES_PERM_KEY, 'edit', 'You cannot link work orders to sites');
  const cur = await query<{ site_id: string | null; asset_id: string | null; site: string | null; asset: string | null }>(
    `SELECT t.site_id::text AS site_id, t.asset_id::text AS asset_id, COALESCE(s.name, s.client) AS site, x.name AS asset
       FROM task t LEFT JOIN site s ON s.id = t.site_id LEFT JOIN asset x ON x.id = t.asset_id WHERE t.id = $1`,
    [taskId],
  );
  const before = cur.rows[0];
  if (!before) throw notFound('Work order not found');

  let siteId = input.site_id !== undefined ? input.site_id : before.site_id;
  let assetId = input.asset_id !== undefined ? input.asset_id : before.asset_id;
  let siteLabel: string | null = null;
  let assetLabel: string | null = null;
  if (siteId) {
    if (siteId !== before.site_id) await assertSiteAccess(actor, siteId);
    siteLabel = await siteName(siteId);
  }
  // A different site leaves the old site's asset behind unless one is named.
  if (input.site_id !== undefined && input.site_id !== before.site_id && input.asset_id === undefined) assetId = null;
  if (assetId) {
    if (!UUID_RE.test(assetId)) throw badRequest('That asset does not exist', { field: 'asset_id' });
    const a = await query<{ name: string; site_id: string | null }>(`SELECT name, site_id::text AS site_id FROM asset WHERE id = $1 AND deleted_at IS NULL`, [assetId]);
    if (!a.rows[0]) throw badRequest('That asset does not exist', { field: 'asset_id' });
    // Naming only an asset places the work order at the asset's site.
    if (!siteId && a.rows[0].site_id) {
      siteId = a.rows[0].site_id;
      siteLabel = await siteName(siteId);
    }
    if (a.rows[0].site_id !== siteId) throw badRequest('That asset is at a different site', { field: 'asset_id' });
    assetLabel = a.rows[0].name;
  }
  if (!siteId && assetId) throw forbidden('An asset needs its site');

  const changes: { field: string; before: unknown; after: unknown }[] = [];
  if (siteId !== before.site_id) changes.push({ field: 'Site', before: before.site, after: siteLabel });
  if (assetId !== before.asset_id) changes.push({ field: 'Asset', before: before.asset, after: assetLabel });
  if (changes.length > 0) {
    await withTransaction(async (tx) => {
      await tx.query(`UPDATE task SET site_id = $2, asset_id = $3 WHERE id = $1`, [taskId, siteId, assetId]);
      await logTaskChanges(tx, actor.id, taskId, changes);
    });
  }
  return woPlace(taskId, actor);
}

// ═══ Sites from work orders ══════════════════════════════════════════════════
//
// Work orders that did not come through Ecotrak (CSV imports, intake drafts)
// carry their site as text: a client, a store, an address, a city. This turns
// that text into site records and links the work orders to them.
//
// A work order's place is its client plus the first of: store number, street
// address, store name, city. "Store" holds a number on some work orders and a
// name on others ("Cheesecake Factory - Irvine", or just the client's own name
// again), so only a value with a digit in it counts as a store number, and a
// store name that merely repeats the client is ignored — otherwise every
// 7-Eleven whose Store reads "7-eleven" would collapse into one site.
//
// A work order links to a site already on file for the same client with the
// same store number, else the same street address; failing both, one new site
// is made per distinct place. A work order naming no client, or nothing but a
// client, is left alone.

const PLACE_CTE = `
  cand AS (
    SELECT t.id, btrim(t.client) AS client,
           -- A store NUMBER has a digit in it and is not just the client's name ("7-eleven").
           CASE WHEN x.st ~ '[0-9]' AND lower(x.st) <> lower(btrim(COALESCE(t.client, ''))) THEN x.st END AS store,
           CASE WHEN x.st <> '' AND x.st !~ '[0-9]' AND lower(x.st) <> lower(btrim(COALESCE(t.client, ''))) THEN x.st END AS store_name,
           NULLIF(btrim(split_part(t.fields->>'17. Address', ',', 1)), '') AS street,
           NULLIF(btrim(t.fields->>'17. Address'), '') AS address,
           NULLIF(btrim(t.city), '') AS city, NULLIF(btrim(t.state), '') AS state,
           substring(t.fields->>'17. Address' from '([0-9]{5})(?:-[0-9]{4})?[^0-9]*$') AS zip
      FROM task t
     CROSS JOIN LATERAL (SELECT btrim(COALESCE(t.fields->>'Store', ''), E' \\t\\r\\n') AS st) x
     WHERE t.deleted_at IS NULL AND t.site_id IS NULL
  ),
  placed AS (
    SELECT c.*, lower(c.client) || '|' || lower(COALESCE(c.store, c.street, c.store_name, c.city)) AS place_key
      FROM cand c
     WHERE COALESCE(c.client, '') <> '' AND COALESCE(c.store, c.street, c.store_name, c.city) IS NOT NULL
  ),
  matched AS (
    SELECT p.*, (
             SELECT s.id FROM site s
              WHERE s.deleted_at IS NULL AND lower(s.client) = lower(p.client)
                AND ((p.store IS NOT NULL AND s.store_number = p.store)
                  OR (p.street IS NOT NULL AND lower(s.address1) = lower(p.street)))
              ORDER BY (p.store IS NOT NULL AND s.store_number = p.store) DESC, s.created_at
              LIMIT 1
           ) AS site_id
      FROM placed p
  )`;

export async function previewLinkWorkOrders(actor: ActingPrincipal): Promise<LinkWorkOrdersResult> {
  requireSitesView(actor);
  const res = await query<{ candidates: number; would_link: number; would_create: number; skipped: number }>(
    `WITH ${PLACE_CTE}
     SELECT (SELECT count(*)::int FROM matched) AS candidates,
            (SELECT count(*)::int FROM matched WHERE site_id IS NOT NULL) AS would_link,
            (SELECT count(DISTINCT place_key)::int FROM matched WHERE site_id IS NULL) AS would_create,
            (SELECT count(*)::int FROM cand) - (SELECT count(*)::int FROM placed) AS skipped`,
  );
  return res.rows[0];
}

export async function linkWorkOrders(actor: ActingPrincipal): Promise<LinkWorkOrdersResult> {
  requirePerm(actor, SITES_PERM_KEY, 'create', 'You cannot add sites');
  const preview = await previewLinkWorkOrders(actor);
  let created = 0;
  let linked = 0;
  let madeIds: string[] = [];
  await withTransaction(async (tx) => {
    // 1 · one new site per distinct place that matches nothing on file. The
    //     external id is the place key, so running this twice makes nothing twice.
    const made = (await tx.query(
      `WITH ${PLACE_CTE},
       fresh AS (
         SELECT DISTINCT ON (place_key) place_key, client, store, store_name, street, city, state, zip
           FROM matched WHERE site_id IS NULL
          ORDER BY place_key, (street IS NOT NULL) DESC, (zip IS NOT NULL) DESC
       )
       INSERT INTO site (external_source, external_id, client, name, store_number, address1, city, state, zip, created_by)
       SELECT 'work_orders', place_key, client,
              CASE WHEN store ~ '^[0-9]+$' THEN client || ' #' || store
                   WHEN store IS NOT NULL THEN client || ' ' || store
                   -- "Cheesecake Factory - Irvine" already says whose it is.
                   WHEN store_name IS NOT NULL AND lower(store_name) LIKE lower(client) || '%' THEN store_name
                   WHEN store_name IS NOT NULL THEN client || ' — ' || store_name
                   WHEN city IS NOT NULL THEN client || ' — ' || initcap(city)
                   ELSE client END,
              store, street, city, state, zip, $1
         FROM fresh
       ON CONFLICT (external_source, external_id) DO NOTHING
       RETURNING id`,
      [actor.id],
    )) as { rows: { id: string }[] };
    created = made.rows.length;
    madeIds = made.rows.map((r) => r.id);
    // 2 · place the new ones on the map, by ZIP (one statement for all of them).
    await tx.query(
      `UPDATE site s SET lat = z.lat, lng = z.lng, geo_source = 'zip'
         FROM geo_zip z WHERE s.external_source = 'work_orders' AND s.lat IS NULL AND z.zip = s.zip`,
    );
    // 3 · link: sites already on file first, then the ones just made (by key).
    const l = (await tx.query(
      `WITH ${PLACE_CTE}
       UPDATE task t SET site_id = COALESCE(m.site_id, n.id)
         FROM matched m LEFT JOIN site n ON n.external_source = 'work_orders' AND n.external_id = m.place_key AND n.deleted_at IS NULL
        WHERE t.id = m.id AND COALESCE(m.site_id, n.id) IS NOT NULL
       RETURNING t.id`,
    )) as { rows: { id: string }[] };
    linked = l.rows.length;
  });
  // The ones with no usable ZIP fall back to their city, one lookup each —
  // capped, so a very large run cannot outlast the request; the rest are
  // placed the first time somebody saves them.
  if (madeIds.length > 0) {
    const unplaced = await query<{ id: string }>(`SELECT id::text AS id FROM site WHERE id = ANY($1::uuid[]) AND lat IS NULL LIMIT 300`, [madeIds]);
    for (const r of unplaced.rows) await placeSite(r.id);
  }
  if (created > 0 || linked > 0) {
    await logAdminEvent({ actorId: actor.id, entity: 'site', entityId: actor.id, action: 'sites_created_from_work_orders', after: { name: 'Sites from work orders', sites_created: created, work_orders_linked: linked } });
  }
  return { ...preview, created, linked };
}
