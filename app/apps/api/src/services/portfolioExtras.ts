// 0061 · The rest of the portfolio: clients as records, asset management
// requests, the two admin lists, and who is restricted to which sites.
//
// A client RECORD describes a name; it does not own the work orders. Which
// client a work order belongs to is still `task.client` (and `site.client`),
// matched to the record by name with case and outer spaces ignored. That is
// why a client in use cannot be renamed here: the name is the join.

import {
  ASSETS_PERM_KEY,
  ASSET_REQUESTS_PERM_KEY,
  CLIENTS_PERM_KEY,
  SITES_PERM_KEY,
  assetRequestProblem,
  permAllows,
} from '@theone/shared';
import type {
  AdminPortfolioResponse,
  AssetRequest,
  AssetRequestInput,
  AssetRequestProposal,
  AssetRequestStatus,
  AssetRequestType,
  AssetRequestsResponse,
  ClientDetail,
  ClientInput,
  ClientRow,
  ClientsListResponse,
  FeedActor,
  PermAction,
  PortfolioHistoryEntry,
  PortfolioListItem,
  PortfolioListName,
  SiteAccessPerson,
  SiteWorkOrder,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { notify } from './notices.js';
import { requirePerm } from './permissions.js';
import { assertSiteAccess, createAsset, getAsset, listSites, siteAccessSql, updateAsset } from './portfolio.js';
import { Params } from './woFields.js';
import { woScopeSql } from './woScope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_WO = `t.deleted_at IS NULL AND t.status_group::text NOT IN ('done', 'closed')`;
const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const can = (a: ActingPrincipal, key: string, action: PermAction): boolean => permAllows(a.perms, key, action, a.isSuperAdmin);
const actorOf = (id: string | null, name: string | null, kind: 'human' | 'service' | null): FeedActor | null =>
  id ? { id, name: name ?? 'Unknown', kind: kind ?? 'human' } : null;

// ═══ Clients ═════════════════════════════════════════════════════════════════

function requireClientsView(a: ActingPrincipal): void {
  requirePerm(a, CLIENTS_PERM_KEY, 'view', 'You cannot open Clients');
}

/** A client named on a work order or a site since the last look gets its
 *  record. Idempotent and cheap: the unique index on the name does the work. */
async function adoptNewClients(): Promise<void> {
  await query(
    `INSERT INTO client (name)
     SELECT DISTINCT ON (lower(btrim(n))) btrim(n)
       FROM (
         SELECT client AS n FROM task WHERE deleted_at IS NULL AND btrim(COALESCE(client, '')) <> ''
         UNION
         SELECT client FROM site WHERE deleted_at IS NULL AND btrim(COALESCE(client, '')) <> ''
       ) x
      WHERE NOT EXISTS (SELECT 1 FROM client c WHERE lower(btrim(c.name)) = lower(btrim(x.n)))
      ORDER BY lower(btrim(n))
     ON CONFLICT DO NOTHING`,
  );
}

type ClientSqlRow = {
  id: string;
  name: string;
  code: string | null;
  m_id: string | null;
  m_name: string | null;
  m_kind: 'human' | 'service' | null;
  billing_entity: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  portal_type: string | null;
  is_active: boolean;
  sites: number;
  assets: number;
  work_orders: number;
  open_work_orders: number;
  created_at: Date;
  billing_email: string | null;
  address: string | null;
  payment_terms: string | null;
  notes: string | null;
  updated_at: Date;
};

/** The row select. Work-order counts follow the viewer's scope; site and
 *  asset counts follow their site list, when they have one. */
function clientSelect(a: ActingPrincipal, p: Params): string {
  const s = woScopeSql(a, p);
  const scope = s ? `AND ${s}` : '';
  const acc = siteAccessSql(a, p, 's.id');
  const mine = acc ? `AND ${acc}` : '';
  const same = `lower(btrim(%s)) = lower(btrim(c.name))`;
  return `
    SELECT c.id::text AS id, c.name, c.code, m.id::text AS m_id, m.display_name AS m_name, m.kind AS m_kind,
           c.billing_entity, c.contact_name, c.contact_email, c.contact_phone, c.portal_type, c.is_active,
           (SELECT count(*)::int FROM site s WHERE s.deleted_at IS NULL AND ${same.replace('%s', 's.client')} ${mine}) AS sites,
           (SELECT count(*)::int FROM asset x JOIN site s ON s.id = x.site_id
             WHERE x.deleted_at IS NULL AND s.deleted_at IS NULL AND ${same.replace('%s', 's.client')} ${mine}) AS assets,
           (SELECT count(*)::int FROM task t WHERE t.deleted_at IS NULL AND ${same.replace('%s', 't.client')} ${scope}) AS work_orders,
           (SELECT count(*)::int FROM task t WHERE ${OPEN_WO} AND ${same.replace('%s', 't.client')} ${scope}) AS open_work_orders,
           c.created_at, c.billing_email, c.address, c.payment_terms, c.notes, c.updated_at
      FROM client c
      LEFT JOIN principal m ON m.id = c.account_manager`;
}

function mapClient(r: ClientSqlRow): ClientRow {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    account_manager: actorOf(r.m_id, r.m_name, r.m_kind),
    billing_entity: r.billing_entity,
    contact_name: r.contact_name,
    contact_email: r.contact_email,
    contact_phone: r.contact_phone,
    portal_type: r.portal_type,
    is_active: r.is_active,
    sites: r.sites,
    assets: r.assets,
    work_orders: r.work_orders,
    open_work_orders: r.open_work_orders,
    created_at: iso(r.created_at)!,
  };
}

export interface ClientListQuery {
  search?: string;
  show?: 'active' | 'inactive' | 'all';
  sort?: string;
  dir?: 'asc' | 'desc';
}

const CLIENT_SORTS: Record<string, string> = {
  name: 'lower(c.name)',
  sites: 'sites',
  assets: 'assets',
  open: 'open_work_orders',
  work_orders: 'work_orders',
  manager: 'lower(m.display_name)',
};

export async function listClients(q: ClientListQuery, actor: ActingPrincipal): Promise<ClientsListResponse> {
  requireClientsView(actor);
  await adoptNewClients();
  const p = new Params();
  const select = clientSelect(actor, p);
  const where = ['c.deleted_at IS NULL'];
  const search = (q.search ?? '').trim();
  if (search !== '') {
    const like = p.add(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(c.name ILIKE ${like} OR c.code ILIKE ${like} OR c.contact_name ILIKE ${like} OR c.contact_email ILIKE ${like})`);
  }
  if ((q.show ?? 'active') === 'active') where.push('c.is_active');
  if (q.show === 'inactive') where.push('NOT c.is_active');
  const sort = CLIENT_SORTS[q.sort ?? 'name'] ?? CLIENT_SORTS.name;
  const [rows, people, entities] = await Promise.all([
    query<ClientSqlRow>(
      `${select} WHERE ${where.join(' AND ')} ORDER BY ${sort} ${q.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, lower(c.name) LIMIT 2000`,
      p.values,
    ),
    query<FeedActor>(`SELECT id::text AS id, display_name AS name, kind FROM principal WHERE kind = 'human' AND status <> 'disabled' ORDER BY lower(display_name)`),
    query<{ v: string }>(`SELECT DISTINCT btrim(billing_entity) AS v FROM task WHERE deleted_at IS NULL AND btrim(COALESCE(billing_entity, '')) <> '' ORDER BY 1`),
  ]);
  return {
    items: rows.rows.map(mapClient),
    total: rows.rows.length,
    people: people.rows,
    billing_entities: entities.rows.map((r) => r.v),
    can: { create: can(actor, CLIENTS_PERM_KEY, 'create'), edit: can(actor, CLIENTS_PERM_KEY, 'edit'), delete: can(actor, CLIENTS_PERM_KEY, 'delete') },
  };
}

async function loadClient(id: string, actor: ActingPrincipal): Promise<ClientDetail> {
  const p = new Params();
  const res = await query<ClientSqlRow>(`${clientSelect(actor, p)} WHERE c.id = ${p.add(id)} AND c.deleted_at IS NULL`, p.values);
  const r = res.rows[0];
  if (!r) throw notFound('Client not found');

  const wp = new Params();
  const name = wp.add(r.name);
  const s = woScopeSql(actor, wp);
  const [sites, wos, contracts] = await Promise.all([
    can(actor, SITES_PERM_KEY, 'view') ? listSites({ client: r.name, show: 'all', page_size: 100 }, actor) : Promise.resolve({ items: [] }),
    query<{ wo_number: string; title: string; status: string; status_group: string; trade: string | null; date_received: string | null; created_at: Date }>(
      `SELECT t.wo_number, t.title, st.name AS status, t.status_group::text AS status_group, t.trade,
              to_char(t.date_received, 'YYYY-MM-DD') AS date_received, t.created_at
         FROM task t JOIN status st ON st.id = t.status_id
        WHERE t.deleted_at IS NULL AND lower(btrim(t.client)) = lower(btrim(${name})) ${s ? `AND ${s}` : ''}
        ORDER BY COALESCE(t.date_received, t.created_at::date) DESC, t.created_at DESC LIMIT 50`,
      wp.values,
    ),
    query<{ id: string; name: string; active: boolean; ends_on: string | null }>(
      `SELECT id::text AS id, name, active, to_char(ends_on, 'YYYY-MM-DD') AS ends_on FROM contract
        WHERE lower(btrim(client)) = lower(btrim($1)) ORDER BY active DESC, lower(name)`,
      [r.name],
    ),
  ]);
  const recent: SiteWorkOrder[] = wos.rows.map((w) => ({ ...w, asset: null, created_at: iso(w.created_at)! }));
  return {
    ...mapClient(r),
    billing_email: r.billing_email,
    address: r.address,
    payment_terms: r.payment_terms,
    notes: r.notes,
    site_list: sites.items,
    recent_work_orders: recent,
    contracts: contracts.rows.map((c) => ({ id: c.id, name: c.name, status: c.active ? (c.ends_on ? `until ${c.ends_on}` : 'active') : 'inactive' })),
    updated_at: iso(r.updated_at)!,
    can: { edit: can(actor, CLIENTS_PERM_KEY, 'edit'), delete: can(actor, CLIENTS_PERM_KEY, 'delete') },
  };
}

export async function getClient(id: string, actor: ActingPrincipal): Promise<ClientDetail> {
  requireClientsView(actor);
  if (!UUID_RE.test(id)) throw notFound('Client not found');
  return loadClient(id, actor);
}

const CLIENT_TEXT: (keyof ClientInput)[] = [
  'code', 'billing_entity', 'contact_name', 'contact_email', 'contact_phone', 'billing_email', 'address', 'portal_type', 'payment_terms', 'notes',
];

function checkManager(input: ClientInput): void {
  if (input.account_manager && !UUID_RE.test(input.account_manager)) throw badRequest('That is not a person', { field: 'account_manager' });
}

export async function createClient(input: ClientInput, actor: ActingPrincipal): Promise<ClientDetail> {
  requirePerm(actor, CLIENTS_PERM_KEY, 'create', 'You cannot add clients');
  const name = clean(input.name);
  if (!name) throw badRequest('A client needs a name', { field: 'name' });
  checkManager(input);
  const dup = await query<{ id: string }>(`SELECT id::text AS id FROM client WHERE deleted_at IS NULL AND lower(btrim(name)) = lower($1)`, [name]);
  if (dup.rows[0]) throw conflict(`${name} is already on file`, { field: 'name', existing_id: dup.rows[0].id });
  const cols = ['name', 'created_by'];
  const vals: unknown[] = [name, actor.id];
  for (const c of CLIENT_TEXT) {
    const v = clean(input[c] as string | null);
    if (v !== null) { cols.push(c); vals.push(v); }
  }
  if (input.account_manager) { cols.push('account_manager'); vals.push(input.account_manager); }
  const ins = await query<{ id: string }>(
    `INSERT INTO client (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text AS id`,
    vals,
  );
  await logAdminEvent({ actorId: actor.id, entity: 'client', entityId: ins.rows[0].id, action: 'client_created', after: { name } });
  return loadClient(ins.rows[0].id, actor);
}

const CLIENT_DIFF: (keyof ClientDetail)[] = [
  'name', 'code', 'billing_entity', 'contact_name', 'contact_email', 'contact_phone', 'billing_email', 'address',
  'portal_type', 'payment_terms', 'notes', 'is_active',
];

export async function updateClient(id: string, input: ClientInput, actor: ActingPrincipal): Promise<ClientDetail> {
  requirePerm(actor, CLIENTS_PERM_KEY, 'edit', 'You cannot edit clients');
  if (!UUID_RE.test(id)) throw notFound('Client not found');
  checkManager(input);
  const before = await loadClient(id, actor);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (input.name !== undefined) {
    const name = clean(input.name);
    if (!name) throw badRequest('A client needs a name', { field: 'name' });
    if (name !== before.name) {
      // The name is what work orders and sites are matched by. A change of
      // capitals or spacing still matches; anything else would orphan them.
      const sameKey = name.toLowerCase() === before.name.trim().toLowerCase();
      if (!sameKey) {
        const used = await query<{ n: number }>(
          `SELECT (SELECT count(*) FROM task WHERE deleted_at IS NULL AND lower(btrim(client)) = lower(btrim($1)))::int
                + (SELECT count(*) FROM site WHERE deleted_at IS NULL AND lower(btrim(client)) = lower(btrim($1)))::int AS n`,
          [before.name],
        );
        if ((used.rows[0]?.n ?? 0) > 0) {
          throw conflict('Work orders and sites are filed under this name, so it cannot be changed here. Only its capitals and spacing can.', { field: 'name' });
        }
        const dup = await query<{ id: string }>(`SELECT id::text AS id FROM client WHERE deleted_at IS NULL AND lower(btrim(name)) = lower($1) AND id <> $2`, [name, id]);
        if (dup.rows[0]) throw conflict(`${name} is already on file`, { field: 'name' });
      }
      set('name', name);
    }
  }
  for (const c of CLIENT_TEXT) if (input[c] !== undefined) set(c, clean(input[c] as string | null));
  if (input.account_manager !== undefined) set('account_manager', input.account_manager);
  if (input.is_active !== undefined) set('is_active', input.is_active);
  if (sets.length > 0) {
    vals.push(id);
    await query(`UPDATE client SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }
  const after = await loadClient(id, actor);
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of CLIENT_DIFF) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    b[k] = before[k];
    a[k] = after[k];
  }
  if ((before.account_manager?.id ?? null) !== (after.account_manager?.id ?? null)) {
    b.account_manager = before.account_manager?.name ?? null;
    a.account_manager = after.account_manager?.name ?? null;
  }
  if (Object.keys(a).length > 0) {
    await logAdminEvent({ actorId: actor.id, entity: 'client', entityId: id, action: 'client_updated', before: { name: before.name, ...b }, after: { name: after.name, ...a } });
  }
  return after;
}

export async function deleteClient(id: string, actor: ActingPrincipal): Promise<void> {
  requirePerm(actor, CLIENTS_PERM_KEY, 'delete', 'You cannot remove clients');
  if (!UUID_RE.test(id)) throw notFound('Client not found');
  const cur = await query<{ name: string; used: number }>(
    `SELECT c.name,
            (SELECT count(*) FROM task t WHERE t.deleted_at IS NULL AND lower(btrim(t.client)) = lower(btrim(c.name)))::int
          + (SELECT count(*) FROM site s WHERE s.deleted_at IS NULL AND lower(btrim(s.client)) = lower(btrim(c.name)))::int AS used
       FROM client c WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [id],
  );
  if (!cur.rows[0]) throw notFound('Client not found');
  // A client with work orders or sites would simply be adopted again on the
  // next look. It can be marked inactive instead.
  if (cur.rows[0].used > 0) throw conflict('This client still has work orders or sites. Mark it inactive instead.');
  await query(`UPDATE client SET deleted_at = now(), is_active = false WHERE id = $1`, [id]);
  await logAdminEvent({ actorId: actor.id, entity: 'client', entityId: id, action: 'client_deleted', before: { name: cur.rows[0].name } });
}

export async function clientHistory(id: string, actor: ActingPrincipal): Promise<PortfolioHistoryEntry[]> {
  requireClientsView(actor);
  if (!UUID_RE.test(id)) throw notFound('Client not found');
  const res = await query<{ id: string; action: string; a_id: string | null; a_name: string | null; a_kind: 'human' | 'service' | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; created_at: Date }>(
    `SELECT a.id::text AS id, a.action, p.id::text AS a_id, p.display_name AS a_name, p.kind AS a_kind, a.before, a.after, a.created_at
       FROM activity_log a LEFT JOIN principal p ON p.id = a.actor_principal_id
      WHERE a.entity_type = 'client' AND a.entity_id = $1::text
      ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    [id],
  );
  return res.rows.map((r) => ({ id: r.id, action: r.action, actor: actorOf(r.a_id, r.a_name, r.a_kind), before: r.before, after: r.after, created_at: iso(r.created_at)! }));
}

// ═══ Asset management requests ═══════════════════════════════════════════════

type RequestRow = {
  id: string;
  type: AssetRequestType;
  a_id: string | null;
  a_name: string | null;
  s_id: string | null;
  s_name: string | null;
  reason: string;
  proposed: AssetRequestProposal | null;
  wo_number: string | null;
  status: AssetRequestStatus;
  rq_id: string | null;
  rq_name: string | null;
  rq_kind: 'human' | 'service' | null;
  d_id: string | null;
  d_name: string | null;
  d_kind: 'human' | 'service' | null;
  decided_at: Date | null;
  decision_note: string | null;
  r_id: string | null;
  r_name: string | null;
  created_at: Date;
};

const REQUEST_SELECT = `
  SELECT q.id::text AS id, q.type, x.id::text AS a_id, x.name AS a_name,
         s.id::text AS s_id, COALESCE(s.name, s.client) AS s_name,
         q.reason, q.proposed, q.wo_number, q.status,
         rq.id::text AS rq_id, rq.display_name AS rq_name, rq.kind AS rq_kind,
         d.id::text AS d_id, d.display_name AS d_name, d.kind AS d_kind,
         q.decided_at, q.decision_note, ra.id::text AS r_id, ra.name AS r_name, q.created_at
    FROM asset_request q
    LEFT JOIN asset x ON x.id = q.asset_id
    LEFT JOIN site s ON s.id = q.site_id
    LEFT JOIN principal rq ON rq.id = q.requested_by
    LEFT JOIN principal d ON d.id = q.decided_by
    LEFT JOIN asset ra ON ra.id = q.result_asset_id`;

function mapRequest(r: RequestRow, actor: ActingPrincipal): AssetRequest {
  const open = r.status === 'open';
  return {
    id: r.id,
    type: r.type,
    asset: r.a_id ? { id: r.a_id, name: r.a_name ?? 'Asset' } : null,
    site: r.s_id ? { id: r.s_id, name: r.s_name ?? 'Site' } : null,
    reason: r.reason,
    proposed: r.proposed ?? {},
    wo_number: r.wo_number,
    status: r.status,
    requested_by: actorOf(r.rq_id, r.rq_name, r.rq_kind),
    decided_by: actorOf(r.d_id, r.d_name, r.d_kind),
    decided_at: iso(r.decided_at),
    decision_note: r.decision_note,
    result_asset: r.r_id ? { id: r.r_id, name: r.r_name ?? 'Asset' } : null,
    created_at: iso(r.created_at)!,
    can: { decide: open && can(actor, ASSET_REQUESTS_PERM_KEY, 'approve'), withdraw: open && r.rq_id === actor.id },
  };
}

export async function listAssetRequests(q: { status?: AssetRequestStatus | 'all'; asset?: string }, actor: ActingPrincipal): Promise<AssetRequestsResponse> {
  requirePerm(actor, ASSETS_PERM_KEY, 'view', 'You cannot open Assets');
  const p = new Params();
  const where: string[] = [];
  const acc = siteAccessSql(actor, p, 'q.site_id');
  if (acc) where.push(acc);
  if (q.status && q.status !== 'all') where.push(`q.status = ${p.add(q.status)}`);
  if (q.asset && UUID_RE.test(q.asset)) where.push(`(q.asset_id = ${p.add(q.asset)} OR q.result_asset_id = ${p.add(q.asset)})`);
  const res = await query<RequestRow>(
    `${REQUEST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (q.status <> 'open'), q.created_at ${q.status === 'open' ? 'ASC' : 'DESC'} LIMIT 300`,
    p.values,
  );
  const op = new Params();
  const oacc = siteAccessSql(actor, op, 'q.site_id');
  const open = await query<{ n: number }>(`SELECT count(*)::int AS n FROM asset_request q WHERE q.status = 'open' ${oacc ? `AND ${oacc}` : ''}`, op.values);
  return {
    requests: res.rows.map((r) => mapRequest(r, actor)),
    open: open.rows[0]?.n ?? 0,
    can: { create: can(actor, ASSET_REQUESTS_PERM_KEY, 'create'), approve: can(actor, ASSET_REQUESTS_PERM_KEY, 'approve') },
  };
}

async function loadRequest(id: string, actor: ActingPrincipal): Promise<{ row: RequestRow; request: AssetRequest }> {
  if (!UUID_RE.test(id)) throw notFound('Request not found');
  const res = await query<RequestRow>(`${REQUEST_SELECT} WHERE q.id = $1`, [id]);
  if (!res.rows[0]) throw notFound('Request not found');
  await assertSiteAccess(actor, res.rows[0].s_id);
  return { row: res.rows[0], request: mapRequest(res.rows[0], actor) };
}

/** Everyone whose ROLE decides asset requests, plus super admins (overrides
 *  are not read — the same trade as the vendor review notices, 0059). */
async function requestDeciderIds(): Promise<string[]> {
  const res = await query<{ id: string }>(
    `SELECT p.id::text AS id FROM principal p LEFT JOIN role r ON r.code = p.role
      WHERE p.kind = 'human' AND p.status <> 'disabled'
        AND (p.is_super_admin OR (r.permissions -> $1 ->> 'approve') = 'true')`,
    [ASSET_REQUESTS_PERM_KEY],
  );
  return res.rows.map((r) => r.id);
}

const PROPOSAL_KEYS: (keyof AssetRequestProposal)[] = ['name', 'category', 'asset_type', 'manufacturer', 'model_number', 'serial_number', 'location_id'];

export async function createAssetRequest(input: AssetRequestInput, actor: ActingPrincipal): Promise<AssetRequest> {
  requirePerm(actor, ASSET_REQUESTS_PERM_KEY, 'create', 'You cannot raise asset requests');
  const problem = assetRequestProblem(input);
  if (problem) throw badRequest(problem);

  let siteId = input.site_id ?? null;
  let assetName: string | null = null;
  if (input.type !== 'add') {
    const a = await getAsset(input.asset_id!, actor); // 404 / 403 as the record itself would give
    assetName = a.name;
    // A move names the site it goes to; the others are about the asset where it is.
    if (input.type !== 'move' || !siteId) siteId = a.site?.id ?? null;
  }
  if (siteId) {
    if (!UUID_RE.test(siteId)) throw badRequest('That site does not exist', { field: 'site_id' });
    await assertSiteAccess(actor, siteId);
    const s = await query<{ id: string }>(`SELECT id FROM site WHERE id = $1 AND deleted_at IS NULL`, [siteId]);
    if (!s.rows[0]) throw badRequest('That site does not exist', { field: 'site_id' });
  }
  const proposed: Record<string, string> = {};
  for (const k of PROPOSAL_KEYS) {
    const v = clean(input.proposed?.[k] ?? null);
    if (v !== null) proposed[k] = v.slice(0, 200);
  }
  if (proposed.location_id) {
    const l = UUID_RE.test(proposed.location_id)
      ? await query<{ site_id: string }>(`SELECT site_id::text AS site_id FROM site_location WHERE id = $1`, [proposed.location_id])
      : { rows: [] };
    if (!l.rows[0] || l.rows[0].site_id !== siteId) throw badRequest('That place is not at the site', { field: 'location_id' });
  }
  const wo = clean(input.wo_number);
  if (wo) {
    const t = await query<{ id: string }>(`SELECT id FROM task WHERE wo_number = $1 AND deleted_at IS NULL`, [wo]);
    if (!t.rows[0]) throw badRequest(`There is no work order ${wo}`, { field: 'wo_number' });
  }
  if (input.asset_id) {
    const dup = await query<{ id: string }>(`SELECT id FROM asset_request WHERE status = 'open' AND asset_id = $1 AND type = $2`, [input.asset_id, input.type]);
    if (dup.rows[0]) throw conflict('The same request is already waiting on this asset');
  }
  const ins = await query<{ id: string }>(
    `INSERT INTO asset_request (type, asset_id, site_id, reason, proposed, wo_number, requested_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id::text AS id`,
    [input.type, input.asset_id ?? null, siteId, input.reason.trim().slice(0, 2000), JSON.stringify(proposed), wo, actor.id],
  );
  const id = ins.rows[0].id;
  const what = input.type === 'add' ? `add ${proposed.name}` : `${input.type} ${assetName}`;
  await logAdminEvent({ actorId: actor.id, entity: 'asset_request', entityId: id, action: 'asset_request_created', after: { name: what, type: input.type, reason: input.reason.trim() } });
  await notify(await requestDeciderIds(), { kind: 'asset_request', title: `Asset request: ${what}`, body: input.reason.trim(), link: '/assets?view=requests', actorId: actor.id });
  return (await loadRequest(id, actor)).request;
}

/** Approve = the change is made, as the approver, through the ordinary asset
 *  functions — so it is validated and logged like any other edit. If the
 *  change cannot be made the request stays open and the reason is the error. */
export async function decideAssetRequest(id: string, decision: 'approve' | 'reject', note: string | null, actor: ActingPrincipal): Promise<AssetRequest> {
  requirePerm(actor, ASSET_REQUESTS_PERM_KEY, 'approve', 'Deciding an asset request is a manager’s job');
  const { row: r } = await loadRequest(id, actor);
  if (r.status !== 'open') throw conflict('That request has already been decided');
  const text = clean(note);
  if (decision === 'reject' && !text) throw badRequest('Say why it is rejected', { field: 'note' });
  const p = r.proposed ?? {};
  let resultId: string | null = null;

  if (decision === 'approve') {
    if (r.type !== 'add' && !r.a_id) throw conflict('The asset this request was about is no longer on file. Reject it instead.');
    if (r.type === 'add') {
      if (!r.s_id) throw conflict('The site this request named is no longer on file. Reject it instead.');
      const made = await createAsset({ name: p.name ?? 'New asset', site_id: r.s_id, category: p.category, asset_type: p.asset_type, manufacturer: p.manufacturer, model_number: p.model_number, serial_number: p.serial_number, location_id: p.location_id ?? null }, actor);
      resultId = made.id;
    } else if (r.type === 'retire') {
      await updateAsset(r.a_id!, { status: 'retired' }, actor);
    } else if (r.type === 'move') {
      await updateAsset(r.a_id!, { ...(r.s_id ? { site_id: r.s_id } : {}), location_id: p.location_id ?? null }, actor);
    } else {
      // replace: the new one takes the old one's place; the old one is retired, not removed.
      const old = await getAsset(r.a_id!, actor);
      if (!old.site) throw conflict('The asset has no site to put its replacement at');
      const made = await createAsset({
        name: p.name ?? old.name,
        site_id: old.site.id,
        category: p.category ?? old.category,
        asset_type: p.asset_type ?? old.asset_type,
        manufacturer: p.manufacturer,
        model_number: p.model_number,
        serial_number: p.serial_number,
        location_id: p.location_id ?? old.location_id,
        parent_asset_id: old.parent?.id ?? null,
        notes: `Replaces ${old.name}${old.serial_number ? ` (serial ${old.serial_number})` : ''}.`,
      }, actor);
      resultId = made.id;
      await updateAsset(old.id, { status: 'retired' }, actor);
    }
  }
  const done = await query<{ id: string }>(
    `UPDATE asset_request SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, result_asset_id = $5
      WHERE id = $1 AND status = 'open' RETURNING id`,
    [id, decision === 'approve' ? 'approved' : 'rejected', actor.id, text, resultId],
  );
  if (!done.rows[0]) throw conflict('That request has already been decided');
  const what = r.type === 'add' ? `add ${p.name ?? 'an asset'}` : `${r.type} ${r.a_name ?? 'an asset'}`;
  await logAdminEvent({ actorId: actor.id, entity: 'asset_request', entityId: id, action: decision === 'approve' ? 'asset_request_approved' : 'asset_request_rejected', after: { name: what, note: text } });
  await notify([r.rq_id], {
    kind: 'asset_request_decided',
    title: `${actor.name} ${decision === 'approve' ? 'approved' : 'rejected'} your request to ${what}`,
    body: text,
    link: resultId ? `/assets/${resultId}` : r.a_id ? `/assets/${r.a_id}` : '/assets?view=requests',
    actorId: actor.id,
  });
  return (await loadRequest(id, actor)).request;
}

export async function withdrawAssetRequest(id: string, actor: ActingPrincipal): Promise<AssetRequest> {
  const { row: r } = await loadRequest(id, actor);
  if (r.rq_id !== actor.id) throw forbidden('Only the person who raised a request can withdraw it');
  const done = await query<{ id: string }>(`UPDATE asset_request SET status = 'withdrawn', decided_at = now() WHERE id = $1 AND status = 'open' RETURNING id`, [id]);
  if (!done.rows[0]) throw conflict('That request has already been decided');
  await logAdminEvent({ actorId: actor.id, entity: 'asset_request', entityId: id, action: 'asset_request_withdrawn', after: { name: r.type === 'add' ? `add ${r.proposed?.name ?? 'an asset'}` : `${r.type} ${r.a_name ?? 'an asset'}` } });
  return (await loadRequest(id, actor)).request;
}

// ═══ Admin › Sites & assets ══════════════════════════════════════════════════

const ADMIN_KEY = 'admin/portfolio';
const LISTS: Record<PortfolioListName, { table: string; target: string; column: string; label: string }> = {
  'site-types': { table: 'site_type', target: 'site', column: 'site_type', label: 'site type' },
  'asset-categories': { table: 'asset_category', target: 'asset', column: 'category', label: 'asset category' },
};

async function loadList(list: PortfolioListName): Promise<PortfolioListItem[]> {
  const l = LISTS[list];
  const res = await query<PortfolioListItem>(
    `SELECT v.name, v.position, v.is_active,
            (SELECT count(*)::int FROM ${l.target} r WHERE r.deleted_at IS NULL AND lower(btrim(r.${l.column})) = lower(v.name)) AS in_use
       FROM ${l.table} v ORDER BY v.position, lower(v.name)`,
  );
  return res.rows;
}

export async function adminPortfolio(actor: ActingPrincipal): Promise<AdminPortfolioResponse> {
  requirePerm(actor, ADMIN_KEY, 'view', 'You cannot open Admin › Sites & assets');
  const [siteTypes, categories, people] = await Promise.all([
    loadList('site-types'),
    loadList('asset-categories'),
    query<FeedActor & { role_label: string | null; is_super_admin: boolean }>(
      `SELECT p.id::text AS id, p.display_name AS name, p.kind, r.label AS role_label, p.is_super_admin
         FROM principal p LEFT JOIN role r ON r.code = p.role
        WHERE p.kind = 'human' AND p.status <> 'disabled' ORDER BY lower(p.display_name)`,
    ),
  ]);
  let access: SiteAccessPerson[] | null = null;
  if (actor.isSuperAdmin) {
    const rows = await query<{ p_id: string; p_name: string; p_kind: 'human' | 'service'; role_label: string | null; s_id: string; s_name: string | null; city: string | null; state: string | null }>(
      `SELECT p.id::text AS p_id, p.display_name AS p_name, p.kind AS p_kind, r.label AS role_label,
              s.id::text AS s_id, COALESCE(s.name, s.client) AS s_name, s.city, s.state
         FROM principal_site ps
         JOIN principal p ON p.id = ps.principal_id
         LEFT JOIN role r ON r.code = p.role
         JOIN site s ON s.id = ps.site_id AND s.deleted_at IS NULL
        ORDER BY lower(p.display_name), lower(COALESCE(s.name, s.client))`,
    );
    const by = new Map<string, SiteAccessPerson>();
    for (const r of rows.rows) {
      const cur = by.get(r.p_id) ?? { principal: { id: r.p_id, name: r.p_name, kind: r.p_kind }, role_label: r.role_label, sites: [] };
      cur.sites.push({ id: r.s_id, name: r.s_name ?? 'Site', city: r.city, state: r.state });
      by.set(r.p_id, cur);
    }
    access = [...by.values()];
  }
  return { site_types: siteTypes, asset_categories: categories, site_access: access, people: people.rows };
}

export async function addListValue(list: PortfolioListName, name: string, actor: ActingPrincipal): Promise<AdminPortfolioResponse> {
  requirePerm(actor, ADMIN_KEY, 'edit', 'You cannot edit these lists');
  const l = LISTS[list];
  const v = clean(name);
  if (!v) throw badRequest('It needs a name', { field: 'name' });
  const dup = await query<{ name: string }>(`SELECT name FROM ${l.table} WHERE lower(name) = lower($1)`, [v]);
  if (dup.rows[0]) throw conflict(`${dup.rows[0].name} is already on the list`);
  await query(`INSERT INTO ${l.table} (name, position) VALUES ($1, (SELECT COALESCE(max(position), -1) + 1 FROM ${l.table}))`, [v]);
  await logAdminEvent({ actorId: actor.id, entity: 'portfolio_list', entityId: `${list}:${v}`, action: 'portfolio_list_value_added', after: { name: v, list: l.label } });
  return adminPortfolio(actor);
}

/** Rename and / or switch on and off. A rename carries every record that
 *  holds the old value across, so nothing is left filed under a name that is
 *  no longer on the list. */
export async function updateListValue(list: PortfolioListName, name: string, patch: { name?: string; is_active?: boolean }, actor: ActingPrincipal): Promise<AdminPortfolioResponse> {
  requirePerm(actor, ADMIN_KEY, 'edit', 'You cannot edit these lists');
  const l = LISTS[list];
  const cur = await query<{ name: string; is_active: boolean }>(`SELECT name, is_active FROM ${l.table} WHERE lower(name) = lower($1)`, [name]);
  if (!cur.rows[0]) throw notFound('That value is not on the list');
  const old = cur.rows[0].name;
  const next = patch.name !== undefined ? clean(patch.name) : old;
  if (!next) throw badRequest('It needs a name', { field: 'name' });
  let moved = 0;
  await withTransaction(async (tx) => {
    if (next !== old) {
      if (next.toLowerCase() !== old.toLowerCase()) {
        const dup = (await tx.query(`SELECT name FROM ${l.table} WHERE lower(name) = lower($1)`, [next])) as { rows: { name: string }[] };
        if (dup.rows[0]) throw conflict(`${dup.rows[0].name} is already on the list`);
      }
      await tx.query(`UPDATE ${l.table} SET name = $2 WHERE name = $1`, [old, next]);
      const upd = (await tx.query(`UPDATE ${l.target} SET ${l.column} = $2 WHERE lower(btrim(${l.column})) = lower($1) RETURNING id`, [old, next])) as { rows: unknown[] };
      moved = upd.rows.length;
    }
    if (patch.is_active !== undefined) await tx.query(`UPDATE ${l.table} SET is_active = $2 WHERE name = $1`, [next, patch.is_active]);
  });
  await logAdminEvent({
    actorId: actor.id,
    entity: 'portfolio_list',
    entityId: `${list}:${next}`,
    action: 'portfolio_list_value_updated',
    before: { name: old, list: l.label, is_active: cur.rows[0].is_active },
    after: { name: next, list: l.label, is_active: patch.is_active ?? cur.rows[0].is_active, records_renamed: moved },
  });
  return adminPortfolio(actor);
}

/** Replace one person's site list. Empty = no restriction. Super admins only,
 *  like the per-person permission overrides. */
export async function setSiteAccess(principalId: string, siteIds: string[], actor: ActingPrincipal): Promise<AdminPortfolioResponse> {
  if (!actor.isSuperAdmin) throw forbidden('Only a super admin can restrict a person to a list of sites');
  if (!UUID_RE.test(principalId)) throw notFound('Person not found');
  const who = await query<{ name: string; is_super_admin: boolean }>(`SELECT display_name AS name, is_super_admin FROM principal WHERE id = $1`, [principalId]);
  if (!who.rows[0]) throw notFound('Person not found');
  const ids = [...new Set(siteIds.filter((s) => UUID_RE.test(s)))];
  if (ids.length > 0 && who.rows[0].is_super_admin) throw badRequest('A super admin sees everything and cannot be restricted');
  const before = await query<{ name: string }>(
    `SELECT COALESCE(s.name, s.client, 'Site') AS name FROM principal_site ps JOIN site s ON s.id = ps.site_id WHERE ps.principal_id = $1 ORDER BY 1`,
    [principalId],
  );
  await withTransaction(async (tx) => {
    await tx.query(`DELETE FROM principal_site WHERE principal_id = $1`, [principalId]);
    if (ids.length > 0) {
      await tx.query(
        `INSERT INTO principal_site (principal_id, site_id, granted_by)
         SELECT $1, s.id, $3 FROM site s WHERE s.id = ANY($2::uuid[]) AND s.deleted_at IS NULL`,
        [principalId, ids, actor.id],
      );
    }
  });
  const after = await query<{ name: string }>(
    `SELECT COALESCE(s.name, s.client, 'Site') AS name FROM principal_site ps JOIN site s ON s.id = ps.site_id WHERE ps.principal_id = $1 ORDER BY 1`,
    [principalId],
  );
  await logAdminEvent({
    actorId: actor.id,
    entity: 'principal',
    entityId: principalId,
    action: 'user_site_access_changed',
    before: { name: who.rows[0].name, sites: before.rows.map((r) => r.name) },
    after: { name: who.rows[0].name, sites: after.rows.map((r) => r.name) },
  });
  return adminPortfolio(actor);
}
