// 0057 · Vendors and technicians — the record.
//
// One `vendor` table holds both kinds: 'vendor' (a company the VR team
// recruited) and 'tech' (a technician a dispatcher has worked with). This
// service is the Vendors section: the list, the record, add / edit / remove,
// notes and the blacklist, insurance dates. The map and hiring are in
// vendorMap.ts; placing a city is geo.ts.
//
// Rules worth knowing:
//  · Scope. `vendors/scope` = everything, or only theirs: the vendors they
//    own or created, and the technicians linked to them (vendor_dispatcher).
//  · Duplicates. A new vendor whose name (case and spacing aside) or any
//    phone matches one on file is refused with 409 VENDOR_DUPLICATE unless
//    the caller sends override_duplicate; it is then saved flagged, pointing
//    at the first match.
//  · Compliance. compliance_status is DERIVED, never typed: a current
//    insurance date in the past → EXPIRED; W-9, MSA and COI all received and
//    the COI approved → APPROVED; COI sent back (approved = NO) → REJECTED;
//    anything received → IN_REVIEW; else MISSING_DOCS. A vendor still being
//    onboarded (New / Interested / Ready) turns Active when it first reads
//    APPROVED — on the COI approval, not on the upload.
//  · Removal is a soft delete: payables, payment requests and vendor bills
//    point at vendors. Dispatchers do not remove technicians; they blacklist.
//  · The blacklist is a flag on the record with a required reason; marking
//    and clearing are both notes, so the story stays with the vendor.
//  · `trades` (0001) is kept as primary + secondary — the Quo thread and the
//    payables still read it.
//
// Audit (activity_log, entity 'vendor'): vendor_created | vendor_updated |
// vendor_deleted | vendor_note_added | vendor_blacklisted |
// vendor_blacklist_cleared | vendor_expiry_added | vendor_expiry_removed,
// with before / after snapshots carrying a `name`.

import {
  VENDORS_PERM_KEY,
  VENDOR_BLACKLIST_PERM_KEY,
  VENDOR_BOARD_COLUMN_LIMIT,
  VENDOR_FILTER_FIELDS,
  VENDOR_DETAIL_KEYS,
  VENDOR_SCOPE_PERM_KEY,
  VENDOR_STATUS_ACTIVE,
  complianceWarning,
  currentExpiries,
  normalizeState,
  permAllows,
  missingFields,
  phoneDigits,
  preferredRuleScore,
  zip5,
} from '@theone/shared';
import type {
  ComplianceStatus,
  FeedActor,
  PreferredVendorRule,
  TriState,
  VendorBoardResponse,
  VendorDetail,
  VendorFilter,
  VendorFilterRule,
  VendorExpiry,
  VendorInput,
  VendorKind,
  VendorNote,
  VendorPriority,
  VendorRow,
  VendorsListResponse,
  VendorsMetaResponse,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import type { Queryable } from '../db.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { geoLookup } from './geo.js';
import { notify } from './notices.js';
import { requirePerm } from './permissions.js';
import { autoCloseTasks, openVendorTask, recomputeMissing, requiredKeys } from './vendorTasks.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = (): string => new Date().toISOString().slice(0, 10);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

// ── Gates and scope ──────────────────────────────────────────────────────────

export function requireVendorsView(a: ActingPrincipal): void {
  requirePerm(a, VENDORS_PERM_KEY, 'view', 'You cannot open the Vendors section');
}

const seesAllVendors = (a: ActingPrincipal): boolean =>
  permAllows(a.perms, VENDOR_SCOPE_PERM_KEY, 'view', a.isSuperAdmin);

/** The row predicate of "only theirs" — null when the actor sees everything. */
export function vendorScopeSql(a: ActingPrincipal, add: (v: unknown) => string, alias = 'v'): string | null {
  return scopeSql(a, add, alias);
}

function scopeSql(a: ActingPrincipal, add: (v: unknown) => string, alias = 'v'): string | null {
  if (seesAllVendors(a)) return null;
  const me = add(a.id);
  return `(${alias}.owner_id = ${me} OR ${alias}.created_by = ${me}
           OR EXISTS (SELECT 1 FROM vendor_dispatcher vd WHERE vd.vendor_id = ${alias}.id AND vd.principal_id = ${me}))`;
}

/** 403 unless the vendor is one the actor may see (404 when it does not exist). */
export async function assertVendorInScope(a: ActingPrincipal, vendorId: string): Promise<void> {
  if (!UUID_RE.test(vendorId)) throw notFound('Vendor not found');
  if (!(await inScope(a, vendorId))) throw forbidden('This vendor is outside the vendors you can see');
}

async function inScope(a: ActingPrincipal, vendorId: string): Promise<boolean> {
  const params: unknown[] = [vendorId];
  const scope = scopeSql(a, (v) => {
    params.push(v);
    return `$${params.length}`;
  });
  const res = await query<{ ok: boolean }>(
    `SELECT ${scope ?? 'TRUE'} AS ok FROM vendor v WHERE v.id = $1 AND v.deleted_at IS NULL`,
    params,
  );
  if (!res.rows[0]) throw notFound('Vendor not found');
  return res.rows[0].ok;
}

/** The Vendors-section row scope as a standalone predicate over alias v. */
export function vendorScopeFor(a: ActingPrincipal): { sql: string | null; params: unknown[] } {
  const params: unknown[] = [];
  const sql = scopeSql(a, (v) => {
    params.push(v);
    return `${params.length}`;
  });
  return { sql, params };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export type VendorSqlRow = {
  id: string;
  kind: VendorKind;
  name: string;
  status: string;
  brand_source: string | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_kind: 'human' | 'service' | null;
  priority: VendorPriority | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  primary_trade: string | null;
  secondary_trades: string[];
  compliance_status: ComplianceStatus;
  w9_received: TriState;
  msa_signed: TriState;
  coi_received: TriState;
  nationwide: boolean;
  statewide: boolean;
  is_subcontractor: boolean;
  work_orders_count: number;
  blacklisted: boolean;
  flagged_duplicate: boolean;
  flagged_missing: boolean;
  on_map: boolean;
  created_at: Date;
  zip: string | null;
  primary_contact_name: string | null;
  regular_hourly_rate: string | number | null;
  trip_charge: string | number | null;
  coi_approved: TriState;
  last_contact?: string | null;
  updated_at: Date;
};

export const VENDOR_ROW_SELECT = `
  SELECT v.id::text AS id, v.kind, v.name, v.status, v.brand_source,
         o.id::text AS owner_id, o.display_name AS owner_name, o.kind AS owner_kind,
         v.priority, v.email, v.phone, v.city, v.state, v.primary_trade, v.secondary_trades,
         v.compliance_status, v.w9_received, v.msa_signed, v.coi_received,
         v.nationwide, v.statewide, v.is_subcontractor, v.work_orders_count,
         v.blacklisted, v.flagged_duplicate, v.flagged_missing,
         EXISTS (SELECT 1 FROM vendor_location l WHERE l.vendor_id = v.id AND l.lat IS NOT NULL) AS on_map,
         v.created_at, v.zip, v.primary_contact_name, v.regular_hourly_rate, v.trip_charge, v.coi_approved,
         v.details->>'lastContactDate' AS last_contact, v.updated_at
    FROM vendor v
    LEFT JOIN principal o ON o.id = v.owner_id`;

export function mapVendorRow(r: VendorSqlRow): VendorRow {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    status: r.status,
    brand_source: r.brand_source,
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name ?? 'Unknown', kind: r.owner_kind ?? 'human' } : null,
    priority: r.priority,
    email: r.email,
    phone: r.phone,
    city: r.city,
    state: r.state,
    primary_trade: r.primary_trade,
    secondary_trades: r.secondary_trades ?? [],
    compliance_status: r.compliance_status,
    w9_received: r.w9_received,
    msa_signed: r.msa_signed,
    coi_received: r.coi_received,
    nationwide: r.nationwide,
    statewide: r.statewide,
    is_subcontractor: r.is_subcontractor,
    work_orders_count: r.work_orders_count,
    blacklisted: r.blacklisted,
    flagged_duplicate: r.flagged_duplicate,
    flagged_missing: r.flagged_missing,
    on_map: r.on_map,
    created_at: iso(r.created_at)!,
    zip: r.zip,
    primary_contact_name: r.primary_contact_name,
    regular_hourly_rate: num(r.regular_hourly_rate),
    trip_charge: num(r.trip_charge),
    coi_approved: r.coi_approved,
    last_contact: r.last_contact ?? null,
    updated_at: iso(r.updated_at)!,
  };
}

// ── List ─────────────────────────────────────────────────────────────────────

export interface VendorListQuery {
  search?: string;
  kind?: VendorKind;
  status?: string[];
  trade?: string;
  state?: string;
  owner?: string; // uuid | 'unassigned'
  brand_source?: string;
  compliance?: ComplianceStatus;
  flag?: 'blacklisted' | 'duplicate' | 'missing' | 'not_on_map';
  /** Only these records (the bulk-search result, a selection). */
  ids?: string[];
  /** 0059 · rules joined by AND or OR, on top of everything above. */
  filter?: VendorFilter | null;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
}

const SORTS: Record<string, string> = {
  name: 'lower(v.name)',
  status: 'v.status',
  trade: 'lower(v.primary_trade)',
  state: 'v.state',
  city: 'lower(v.city)',
  owner: 'lower(o.display_name)',
  compliance: 'v.compliance_status',
  jobs: 'v.work_orders_count',
  added: 'v.created_at',
  // 0059 · the columns the picker adds.
  zip: 'v.zip',
  email: 'lower(v.email)',
  contact: 'lower(v.primary_contact_name)',
  brand: 'v.brand_source',
  priority: "CASE v.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 END",
  rate: 'v.regular_hourly_rate',
  trip: 'v.trip_charge',
  last_contact: "v.details->>'lastContactDate'",
  updated: 'v.updated_at',
};

/** The list's WHERE (scope + filters) over alias v, with owner joined as o —
    shared by the list, "select everything that matches", the CSV export and
    bulk edit, so all four always mean the same rows. */
export function vendorListWhere(q: VendorListQuery, actor: ActingPrincipal): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = ['v.deleted_at IS NULL'];
  const scope = scopeSql(actor, add);
  if (scope) where.push(scope);

  const search = (q.search ?? '').trim();
  if (search !== '') {
    const like = add(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    const parts = [`v.name ILIKE ${like}`, `v.email ILIKE ${like}`, `v.legal_name ILIKE ${like}`];
    const digits = search.replace(/\D/g, '');
    if (digits.length >= 3 && !/[a-z]/i.test(search)) {
      const d = add(`%${digits}%`);
      parts.push(`EXISTS (SELECT 1 FROM vendor_phone ph WHERE ph.vendor_id = v.id AND ph.digits LIKE ${d})`);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  if (q.kind) where.push(`v.kind = ${add(q.kind)}`);
  if (q.status && q.status.length > 0) where.push(`v.status = ANY(${add(q.status)}::text[])`);
  if (q.trade) {
    const t = add(q.trade.toLowerCase());
    where.push(`(lower(v.primary_trade) = ${t} OR EXISTS (SELECT 1 FROM unnest(v.secondary_trades) st WHERE lower(st) = ${t}))`);
  }
  if (q.state) where.push(`upper(v.state) = ${add(q.state.toUpperCase())}`);
  if (q.owner === 'unassigned') where.push('v.owner_id IS NULL');
  else if (q.owner && UUID_RE.test(q.owner)) where.push(`v.owner_id = ${add(q.owner)}`);
  if (q.brand_source) where.push(`v.brand_source = ${add(q.brand_source)}`);
  if (q.compliance) where.push(`v.compliance_status = ${add(q.compliance)}`);
  if (q.flag === 'blacklisted') where.push('v.blacklisted');
  if (q.flag === 'duplicate') where.push('v.flagged_duplicate');
  if (q.flag === 'missing') where.push('v.flagged_missing');
  if (q.flag === 'not_on_map') {
    where.push('NOT EXISTS (SELECT 1 FROM vendor_location l WHERE l.vendor_id = v.id AND l.lat IS NOT NULL)');
  }
  if (q.ids && q.ids.length > 0) where.push(`v.id = ANY(${add(q.ids)}::uuid[])`);
  const advanced = compileVendorFilter(q.filter, add);
  if (advanced) where.push(advanced);
  return { where: where.join(' AND '), params };
}

// ── Advanced filters (0059) ──────────────────────────────────────────────────
//
// The SQL behind each field of shared/vendorFilters.ts. A rule compiles only
// when its field is a key here AND cleanVendorFilter accepted it, so nothing
// a person types ever becomes a column name; values are always bound.

const ON_MAP_SQL = 'EXISTS (SELECT 1 FROM vendor_location l WHERE l.vendor_id = v.id AND l.lat IS NOT NULL)';

const FILTER_SQL: Record<string, string> = {
  name: 'v.name',
  kind: 'v.kind',
  status: 'v.status',
  primary_trade: 'v.primary_trade',
  secondary_trades: 'v.secondary_trades',
  city: 'v.city',
  state: 'v.state',
  zip: 'v.zip',
  coverage_states: 'v.coverage_states',
  nationwide: 'v.nationwide',
  statewide: 'v.statewide',
  owner: 'v.owner_id::text',
  brand_source: 'v.brand_source',
  priority: 'v.priority',
  email: 'v.email',
  phone: `(SELECT string_agg(ph.digits, ' ') FROM vendor_phone ph WHERE ph.vendor_id = v.id)`,
  legal_name: 'v.legal_name',
  primary_contact_name: 'v.primary_contact_name',
  compliance_status: 'v.compliance_status',
  w9_received: 'v.w9_received',
  msa_signed: 'v.msa_signed',
  coi_received: 'v.coi_received',
  coi_approved: 'v.coi_approved',
  emergency_same_day: 'v.emergency_same_day',
  after_hours: 'v.after_hours',
  weekends: 'v.weekends',
  holiday_emergency: 'v.holiday_emergency',
  is_subcontractor: 'v.is_subcontractor',
  blacklisted: 'v.blacklisted',
  flagged_duplicate: 'v.flagged_duplicate',
  flagged_missing: 'v.flagged_missing',
  on_map: ON_MAP_SQL,
  regular_hourly_rate: 'v.regular_hourly_rate',
  after_hours_rate: 'v.after_hours_rate',
  weekend_emergency_rate: 'v.weekend_emergency_rate',
  trip_charge: 'v.trip_charge',
  diagnostic_fee: 'v.diagnostic_fee',
  minimum_charge: 'v.minimum_charge',
  work_orders_count: 'v.work_orders_count',
  created_at: 'v.created_at',
  updated_at: 'v.updated_at',
};

const likeEscape = (s: string) => s.replace(/[\\%_]/g, '\\$&');

function compileFilterRule(rule: VendorFilterRule, add: (v: unknown) => string): string | null {
  const def = VENDOR_FILTER_FIELDS.find((f) => f.key === rule.field);
  const e = FILTER_SQL[rule.field];
  if (!def || !e) return null;
  let value = rule.value ?? '';
  // A phone is compared by its digits, however it was typed.
  if (rule.field === 'phone' && /\d/.test(value)) value = value.replace(/\D/g, '');
  // Stored digits carry the country code and a vendor may have several
  // phones, so "is" on a phone means "one of its numbers holds these digits".
  if (rule.field === 'phone' && (rule.op === 'is' || rule.op === 'is_not')) {
    rule = { ...rule, op: rule.op === 'is' ? 'contains' : 'not_contains' };
  }

  switch (def.type) {
    case 'text':
    case 'choice': {
      const blank = `(${e} IS NULL OR btrim(${e}) = '')`;
      switch (rule.op) {
        case 'empty': return blank;
        case 'not_empty': return `NOT ${blank}`;
        case 'is': return `lower(${e}) = lower(${add(value)})`;
        case 'is_not': return `(${e} IS NULL OR lower(${e}) <> lower(${add(value)}))`;
        case 'contains': return `${e} ILIKE ${add(`%${likeEscape(value)}%`)}`;
        case 'not_contains': return `(${e} IS NULL OR ${e} NOT ILIKE ${add(`%${likeEscape(value)}%`)})`;
        case 'starts_with': return `${e} ILIKE ${add(`${likeEscape(value)}%`)}`;
        default: return null;
      }
    }
    case 'number': {
      const ops: Record<string, string> = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
      if (rule.op === 'empty') return `${e} IS NULL`;
      if (rule.op === 'not_empty') return `${e} IS NOT NULL`;
      return ops[rule.op] ? `${e} ${ops[rule.op]} ${add(Number(value))}::numeric` : null;
    }
    case 'bool':
      // A tri-valued tick (yes / no / never said): "no" includes never said.
      return rule.op === 'yes' ? `(${e}) IS TRUE` : rule.op === 'no' ? `(${e}) IS NOT TRUE` : null;
    case 'date': {
      // A day is a day in Chicago, like every other date here (0024).
      const day = `(${e} AT TIME ZONE 'America/Chicago')::date`;
      if (rule.op === 'empty') return `${e} IS NULL`;
      if (rule.op === 'not_empty') return `${e} IS NOT NULL`;
      const ops: Record<string, string> = { on: '=', before: '<', after: '>' };
      return ops[rule.op] ? `${day} ${ops[rule.op]} ${add(value)}::date` : null;
    }
    case 'list': {
      if (rule.op === 'empty') return `cardinality(${e}) = 0`;
      if (rule.op === 'not_empty') return `cardinality(${e}) > 0`;
      const has = `EXISTS (SELECT 1 FROM unnest(${e}) fx WHERE lower(fx) = lower(${add(value)}))`;
      return rule.op === 'has' ? has : rule.op === 'has_not' ? `NOT ${has}` : null;
    }
  }
}

/** The filter as one parenthesised predicate, or null when it holds no rule. */
function compileVendorFilter(filter: VendorFilter | null | undefined, add: (v: unknown) => string): string | null {
  if (!filter) return null;
  const parts = filter.rules.map((r) => compileFilterRule(r, add)).filter((s): s is string => s !== null);
  if (parts.length === 0) return null;
  return `(${parts.map((p) => `(${p})`).join(filter.join === 'or' ? ' OR ' : ' AND ')})`;
}

export function vendorSortSql(q: VendorListQuery): string {
  const sort = SORTS[q.sort ?? 'name'] ?? SORTS.name;
  return `${sort} ${q.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, lower(v.name), v.id`;
}

export async function listVendors(q: VendorListQuery, actor: ActingPrincipal): Promise<VendorsListResponse> {
  requireVendorsView(actor);
  const { where, params } = vendorListWhere(q, actor);
  const pageSize = Math.min(100, Math.max(1, q.page_size ?? 50));
  const page = Math.max(1, q.page ?? 1);

  const total = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM vendor v LEFT JOIN principal o ON o.id = v.owner_id WHERE ${where}`,
    params,
  );
  const rows = await query<VendorSqlRow>(
    `${VENDOR_ROW_SELECT} WHERE ${where}
      ORDER BY ${vendorSortSql(q)}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { items: rows.rows.map(mapVendorRow), total: total.rows[0]?.n ?? 0, page, page_size: pageSize };
}

/** 0059 · The list's rows stacked by status: every active status is a column
    (plus any status the rows still hold), each with its true count and its
    most recently changed cards. Same WHERE as the list, so the dropdowns, the
    advanced filter and the viewer's scope all apply. */
export async function vendorBoard(q: VendorListQuery, actor: ActingPrincipal): Promise<VendorBoardResponse> {
  requireVendorsView(actor);
  const { where, params } = vendorListWhere(q, actor);
  const [statuses, counts, rows] = await Promise.all([
    listStatuses(),
    query<{ status: string; n: number }>(
      `SELECT v.status, count(*)::int AS n FROM vendor v LEFT JOIN principal o ON o.id = v.owner_id WHERE ${where} GROUP BY v.status`,
      params,
    ),
    query<VendorSqlRow>(
      `SELECT z.* FROM (
         SELECT r.*, row_number() OVER (PARTITION BY r.status ORDER BY r.updated_at DESC, r.id) AS rn
           FROM (${VENDOR_ROW_SELECT} WHERE ${where}) r
       ) z WHERE z.rn <= $${params.length + 1}
       ORDER BY z.status, z.rn`,
      [...params, VENDOR_BOARD_COLUMN_LIMIT],
    ),
  ]);
  const countOf = new Map(counts.rows.map((c) => [c.status, c.n]));
  const keys = statuses.filter((s) => s.is_active || countOf.has(s.key)).map((s) => s.key);
  for (const k of countOf.keys()) if (!keys.includes(k)) keys.push(k);
  return {
    columns: keys.map((status) => ({
      status,
      total: countOf.get(status) ?? 0,
      items: rows.rows.filter((r) => r.status === status).map(mapVendorRow),
    })),
  };
}

export async function vendorsMeta(actor: ActingPrincipal): Promise<VendorsMetaResponse> {
  requireVendorsView(actor);
  const params: unknown[] = [];
  const scope = scopeSql(actor, (v) => {
    params.push(v);
    return `$${params.length}`;
  });
  const [statuses, brands, trades, owners, counts] = await Promise.all([
    listStatuses(),
    listBrandSources(),
    listVendorTrades(),
    query<{ id: string; name: string; kind: 'human' | 'service' }>(
      `SELECT id::text AS id, display_name AS name, kind FROM principal
        WHERE kind = 'human' AND status <> 'disabled'
        ORDER BY lower(display_name)`,
    ),
    query<{ vendors: number; techs: number; blacklisted: number; not_on_map: number }>(
      `SELECT count(*) FILTER (WHERE v.kind = 'vendor')::int AS vendors,
              count(*) FILTER (WHERE v.kind = 'tech')::int AS techs,
              count(*) FILTER (WHERE v.blacklisted)::int AS blacklisted,
              count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM vendor_location l WHERE l.vendor_id = v.id AND l.lat IS NOT NULL))::int AS not_on_map
         FROM vendor v WHERE v.deleted_at IS NULL AND ${scope ?? 'TRUE'}`,
      params,
    ),
  ]);
  const can = (action: 'create' | 'edit' | 'delete') =>
    permAllows(actor.perms, VENDORS_PERM_KEY, action, actor.isSuperAdmin);
  return {
    statuses,
    brand_sources: brands,
    trades: trades.filter((t) => t.is_active).map((t) => t.name),
    owners: owners.rows,
    counts: counts.rows[0] ?? { vendors: 0, techs: 0, blacklisted: 0, not_on_map: 0 },
    can: { create: can('create'), edit: can('edit'), delete: can('delete'), all: seesAllVendors(actor) },
  };
}

// ── The config lists ─────────────────────────────────────────────────────────

export async function listStatuses() {
  const res = await query<{ key: string; label: string; color: string; position: number; is_system: boolean; is_active: boolean }>(
    `SELECT key, label, color, position, is_system, is_active FROM vendor_status ORDER BY position, label`,
  );
  return res.rows;
}

export async function listBrandSources() {
  const res = await query<{ key: string; label: string; position: number; is_active: boolean }>(
    `SELECT key, label, position, is_active FROM vendor_brand_source ORDER BY position, label`,
  );
  return res.rows;
}

export async function listVendorTrades() {
  const res = await query<{ name: string; position: number; is_active: boolean }>(
    `SELECT name, position, is_active FROM vendor_trade ORDER BY position, name`,
  );
  return res.rows;
}

// ── Detail ───────────────────────────────────────────────────────────────────

type DetailRow = VendorSqlRow & {
  legal_name: string | null;
  dba_name: string | null;
  zip: string | null;
  coverage_states: string[];
  max_travel_radius: string | null;
  emergency_same_day: boolean | null;
  after_hours: boolean | null;
  weekends: boolean | null;
  holiday_emergency: boolean | null;
  estimated_response_time: string | null;
  regular_hourly_rate: string | null;
  after_hours_rate: string | null;
  weekend_emergency_rate: string | null;
  trip_charge: string | null;
  diagnostic_fee: string | null;
  minimum_charge: string | null;
  payment_methods: string[];
  accepts_payment_after_30_days: boolean | null;
  primary_contact_name: string | null;
  primary_contact_role: string | null;
  dispatch_phone: string | null;
  billing_email: string | null;
  coi_approved: TriState;
  blacklist_reason: string | null;
  blacklisted_at: Date | null;
  bl_id: string | null;
  bl_name: string | null;
  bl_kind: 'human' | 'service' | null;
  dup_id: string | null;
  dup_name: string | null;
  notes: string | null;
  details: Record<string, unknown>;
  updated_at: Date;
};

export async function loadExpiries(vendorIds: string[]): Promise<Map<string, VendorExpiry[]>> {
  const out = new Map<string, VendorExpiry[]>();
  if (vendorIds.length === 0) return out;
  const res = await query<{ id: string; vendor_id: string; entity: string | null; insurance_type: string; expires_on: string }>(
    `SELECT id::text AS id, vendor_id::text AS vendor_id, entity, insurance_type,
            to_char(expires_on, 'YYYY-MM-DD') AS expires_on
       FROM vendor_expiry WHERE vendor_id = ANY($1::uuid[])
      ORDER BY expires_on DESC`,
    [vendorIds],
  );
  const byVendor = new Map<string, typeof res.rows>();
  for (const r of res.rows) {
    const list = byVendor.get(r.vendor_id) ?? [];
    list.push(r);
    byVendor.set(r.vendor_id, list);
  }
  for (const [vendorId, rows] of byVendor) {
    const current = new Set(currentExpiries(rows).map((r) => r.id));
    out.set(
      vendorId,
      rows.map((r) => ({
        id: r.id,
        entity: r.entity,
        insurance_type: r.insurance_type,
        expires_on: r.expires_on,
        current: current.has(r.id),
      })),
    );
  }
  return out;
}

export async function loadNotes(vendorId: string): Promise<VendorNote[]> {
  const res = await query<{ id: string; kind: VendorNote['kind']; body: string; a_id: string | null; a_name: string | null; a_kind: 'human' | 'service' | null; wo_number: string | null; created_at: Date }>(
    `SELECT n.id::text AS id, n.kind, n.body, p.id::text AS a_id, p.display_name AS a_name, p.kind AS a_kind,
            t.wo_number, n.created_at
       FROM vendor_note n
       LEFT JOIN principal p ON p.id = n.author_id
       LEFT JOIN task t ON t.id = n.task_id
      WHERE n.vendor_id = $1 ORDER BY n.created_at DESC LIMIT 200`,
    [vendorId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    body: r.body,
    author: r.a_id ? { id: r.a_id, name: r.a_name ?? 'Unknown', kind: r.a_kind ?? 'human' } : null,
    wo_number: r.wo_number,
    created_at: iso(r.created_at)!,
  }));
}

export async function getVendor(id: string, actor: ActingPrincipal): Promise<VendorDetail> {
  requireVendorsView(actor);
  if (!UUID_RE.test(id)) throw notFound('Vendor not found');
  if (!(await inScope(actor, id))) throw forbidden('This vendor is outside the vendors you can see');
  return loadVendor(id, actor);
}

async function loadVendor(id: string, actor: ActingPrincipal): Promise<VendorDetail> {
  const res = await query<DetailRow>(
    `SELECT v.id::text AS id, v.kind, v.name, v.status, v.brand_source,
            o.id::text AS owner_id, o.display_name AS owner_name, o.kind AS owner_kind,
            v.priority, v.email, v.phone, v.city, v.state, v.primary_trade, v.secondary_trades,
            v.compliance_status, v.w9_received, v.msa_signed, v.coi_received, v.coi_approved,
            v.nationwide, v.statewide, v.is_subcontractor, v.work_orders_count,
            v.blacklisted, v.flagged_duplicate, v.flagged_missing,
            EXISTS (SELECT 1 FROM vendor_location l WHERE l.vendor_id = v.id AND l.lat IS NOT NULL) AS on_map,
            v.created_at, v.updated_at,
            v.legal_name, v.dba_name, v.zip, v.coverage_states, v.max_travel_radius,
            v.emergency_same_day, v.after_hours, v.weekends, v.holiday_emergency, v.estimated_response_time,
            v.regular_hourly_rate, v.after_hours_rate, v.weekend_emergency_rate, v.trip_charge,
            v.diagnostic_fee, v.minimum_charge, v.payment_methods, v.accepts_payment_after_30_days,
            v.primary_contact_name, v.primary_contact_role, v.dispatch_phone, v.billing_email,
            v.blacklist_reason, v.blacklisted_at,
            b.id::text AS bl_id, b.display_name AS bl_name, b.kind AS bl_kind,
            d.id::text AS dup_id, d.name AS dup_name,
            v.notes, v.details
       FROM vendor v
       LEFT JOIN principal o ON o.id = v.owner_id
       LEFT JOIN principal b ON b.id = v.blacklisted_by
       LEFT JOIN vendor d ON d.id = v.duplicate_of AND d.deleted_at IS NULL
      WHERE v.id = $1 AND v.deleted_at IS NULL`,
    [id],
  );
  const r = res.rows[0];
  if (!r) throw notFound('Vendor not found');

  const [phones, contacts, locations, expiries, dispatchers, notes, workOrders, preferred] = await Promise.all([
    query<{ digits: string; display: string; label: string | null }>(
      `SELECT digits, display, label FROM vendor_phone WHERE vendor_id = $1 ORDER BY position, created_at`,
      [id],
    ),
    query<{ id: string; name: string; role: string | null; phone: string | null; email: string | null }>(
      `SELECT id::text AS id, name, role, phone, email FROM vendor_contact WHERE vendor_id = $1 ORDER BY position, created_at`,
      [id],
    ),
    query<{ id: string; city: string | null; state: string | null; zip: string | null; lat: number | null; lng: number | null; is_primary: boolean }>(
      `SELECT id::text AS id, city, state, zip, lat, lng, is_primary FROM vendor_location
        WHERE vendor_id = $1 ORDER BY is_primary DESC, created_at`,
      [id],
    ),
    loadExpiries([id]),
    query<{ id: string; name: string; kind: 'human' | 'service'; source: string; since: Date }>(
      `SELECT p.id::text AS id, p.display_name AS name, p.kind, d.source, d.created_at AS since
         FROM vendor_dispatcher d JOIN principal p ON p.id = d.principal_id
        WHERE d.vendor_id = $1 ORDER BY d.created_at`,
      [id],
    ),
    loadNotes(id),
    query<{ wo_number: string; title: string; hired_at: Date; released_at: Date | null }>(
      `SELECT t.wo_number, t.title, w.hired_at, w.released_at
         FROM wo_technician w JOIN task t ON t.id = w.task_id
        WHERE w.vendor_id = $1 AND t.deleted_at IS NULL
        ORDER BY w.hired_at DESC LIMIT 50`,
      [id],
    ),
    listPreferred(id),
  ]);

  const exp = expiries.get(id) ?? [];
  const can = (key: string, action: 'edit' | 'delete' | 'create') =>
    permAllows(actor.perms, key, action, actor.isSuperAdmin);
  return {
    ...mapVendorRow(r),
    legal_name: r.legal_name,
    dba_name: r.dba_name,
    zip: r.zip,
    coverage_states: r.coverage_states ?? [],
    max_travel_radius: r.max_travel_radius,
    emergency_same_day: r.emergency_same_day,
    after_hours: r.after_hours,
    weekends: r.weekends,
    holiday_emergency: r.holiday_emergency,
    estimated_response_time: r.estimated_response_time,
    regular_hourly_rate: num(r.regular_hourly_rate),
    after_hours_rate: num(r.after_hours_rate),
    weekend_emergency_rate: num(r.weekend_emergency_rate),
    trip_charge: num(r.trip_charge),
    diagnostic_fee: num(r.diagnostic_fee),
    minimum_charge: num(r.minimum_charge),
    payment_methods: r.payment_methods ?? [],
    accepts_payment_after_30_days: r.accepts_payment_after_30_days,
    primary_contact_name: r.primary_contact_name,
    primary_contact_role: r.primary_contact_role,
    dispatch_phone: r.dispatch_phone,
    billing_email: r.billing_email,
    coi_approved: r.coi_approved,
    blacklist_reason: r.blacklist_reason,
    blacklisted_at: iso(r.blacklisted_at),
    blacklisted_by: r.bl_id ? { id: r.bl_id, name: r.bl_name ?? 'Unknown', kind: r.bl_kind ?? 'human' } : null,
    duplicate_of: r.dup_id ? { id: r.dup_id, name: r.dup_name ?? '' } : null,
    notes: r.notes,
    details: r.details ?? {},
    phones: phones.rows,
    contacts: contacts.rows,
    locations: locations.rows,
    expiries: exp,
    dispatchers: dispatchers.rows.map((d) => ({ id: d.id, name: d.name, kind: d.kind, source: d.source, since: iso(d.since)! })),
    note_log: notes,
    work_orders: workOrders.rows.map((w) => ({
      wo_number: w.wo_number,
      title: w.title,
      hired_at: iso(w.hired_at)!,
      released_at: iso(w.released_at),
    })),
    preferred_for: preferred,
    compliance_warning: complianceWarning(r, exp, today()),
    updated_at: iso(r.updated_at)!,
    can: {
      edit: can(VENDORS_PERM_KEY, 'edit'),
      delete: can(VENDORS_PERM_KEY, 'delete'),
      note: can(VENDOR_BLACKLIST_PERM_KEY, 'create'),
      clear_blacklist: can(VENDOR_BLACKLIST_PERM_KEY, 'edit'),
    },
  };
}

// ── Preferred rules of one vendor (the full CRUD is in vendorMap.ts) ─────────

export async function listPreferred(vendorId?: string): Promise<PreferredVendorRule[]> {
  const res = await query<{ id: string; client: string | null; trade: string | null; state: string | null; city: string | null; rank: number; note: string | null; v_id: string; v_name: string; v_phone: string | null; v_bl: boolean }>(
    `SELECT pv.id::text AS id, pv.client, pv.trade, pv.state, pv.city, pv.rank, pv.note,
            v.id::text AS v_id, v.name AS v_name, v.phone AS v_phone, v.blacklisted AS v_bl
       FROM preferred_vendor pv JOIN vendor v ON v.id = pv.vendor_id AND v.deleted_at IS NULL
      WHERE ($1::uuid IS NULL OR pv.vendor_id = $1)
      ORDER BY lower(COALESCE(pv.client, '')), lower(COALESCE(pv.trade, '')), COALESCE(pv.state, ''), lower(COALESCE(pv.city, '')), pv.rank, lower(v.name)`,
    [vendorId ?? null],
  );
  return res.rows.map((r) => ({
    id: r.id,
    client: r.client,
    trade: r.trade,
    state: r.state,
    city: r.city,
    vendor: { id: r.v_id, name: r.v_name, phone: r.v_phone, blacklisted: r.v_bl },
    rank: r.rank,
    note: r.note,
  }));
}

export { preferredRuleScore };

// ── Writes ───────────────────────────────────────────────────────────────────

const TEXT_COLS = [
  'status', 'brand_source', 'priority', 'email', 'legal_name', 'dba_name', 'primary_trade', 'city', 'state', 'zip',
  'max_travel_radius', 'estimated_response_time', 'primary_contact_name', 'primary_contact_role', 'dispatch_phone',
  'billing_email', 'w9_received', 'msa_signed', 'coi_received', 'coi_approved', 'notes',
] as const;
const BOOL_COLS = [
  'nationwide', 'statewide', 'emergency_same_day', 'after_hours', 'weekends', 'holiday_emergency',
  'accepts_payment_after_30_days', 'is_subcontractor',
] as const;
const NUM_COLS = [
  'regular_hourly_rate', 'after_hours_rate', 'weekend_emergency_rate', 'trip_charge', 'diagnostic_fee', 'minimum_charge',
] as const;
const ARRAY_COLS = ['secondary_trades', 'coverage_states', 'payment_methods'] as const;

const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

/** Only the keys the catalogue knows; an empty answer removes the key. */
function cleanDetails(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!VENDOR_DETAIL_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

async function assertListValue(table: 'vendor_status' | 'vendor_brand_source', key: string | null, label: string): Promise<void> {
  if (key === null) return;
  const res = await query(`SELECT 1 FROM ${table} WHERE key = $1`, [key]);
  if (res.rows.length === 0) throw badRequest(`"${key}" is not a ${label}`, { field: label });
}

export interface DuplicateMatch {
  id: string;
  name: string;
  phone: string | null;
  kind: VendorKind;
}

/** Vendors on file with the same name (case and spacing aside) or any of
    these phones. */
export async function findDuplicates(name: string, digits: string[], exceptId?: string): Promise<DuplicateMatch[]> {
  const res = await query<DuplicateMatch>(
    `SELECT DISTINCT v.id::text AS id, v.name, v.phone, v.kind
       FROM vendor v
      WHERE v.deleted_at IS NULL
        AND ($3::uuid IS NULL OR v.id <> $3)
        AND (lower(regexp_replace(btrim(v.name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim($1), '\\s+', ' ', 'g'))
             OR EXISTS (SELECT 1 FROM vendor_phone ph WHERE ph.vendor_id = v.id AND ph.digits = ANY($2::text[])))
      LIMIT 10`,
    [name, digits, exceptId ?? null],
  );
  return res.rows;
}

function phoneRows(input: VendorInput['phones']): { digits: string; display: string; label: string | null }[] {
  const seen = new Set<string>();
  const out: { digits: string; display: string; label: string | null }[] = [];
  for (const p of input ?? []) {
    const display = (p.phone ?? '').trim();
    if (display === '') continue;
    const digits = phoneDigits(display);
    if (!digits) throw badRequest(`"${display}" is not a phone number`, { field: 'phones' });
    if (seen.has(digits)) continue;
    seen.add(digits);
    out.push({ digits, display, label: clean(p.label) });
  }
  return out;
}

async function writePhones(tx: Queryable, vendorId: string, rows: ReturnType<typeof phoneRows>): Promise<void> {
  await tx.query(`DELETE FROM vendor_phone WHERE vendor_id = $1`, [vendorId]);
  let i = 0;
  for (const p of rows) {
    await tx.query(
      `INSERT INTO vendor_phone (vendor_id, digits, display, label, position) VALUES ($1, $2, $3, $4, $5)`,
      [vendorId, p.digits, p.display, p.label, i++],
    );
  }
  await tx.query(`UPDATE vendor SET phone = $2 WHERE id = $1`, [vendorId, rows[0]?.display ?? null]);
}

async function writeContacts(tx: Queryable, vendorId: string, contacts: NonNullable<VendorInput['contacts']>): Promise<void> {
  await tx.query(`DELETE FROM vendor_contact WHERE vendor_id = $1`, [vendorId]);
  let i = 0;
  for (const c of contacts) {
    const name = clean(c.name);
    if (!name) continue;
    await tx.query(
      `INSERT INTO vendor_contact (vendor_id, name, role, phone, email, position) VALUES ($1, $2, $3, $4, $5, $6)`,
      [vendorId, name, clean(c.role), clean(c.phone), clean(c.email), i++],
    );
  }
}

/** The vendor's home city as its primary map point. Not placed → the row
    stays with NULL coordinates and the record reads "not on the map". */
export async function syncPrimaryLocation(vendorId: string): Promise<void> {
  const v = await query<{ city: string | null; state: string | null; zip: string | null }>(
    `SELECT city, state, zip FROM vendor WHERE id = $1`,
    [vendorId],
  );
  const r = v.rows[0];
  if (!r) return;
  if (!clean(r.city) && !zip5(r.zip)) {
    await query(`DELETE FROM vendor_location WHERE vendor_id = $1 AND is_primary`, [vendorId]);
    return;
  }
  const point = await geoLookup({ zip: r.zip, city: r.city, state: r.state });
  await query(
    `INSERT INTO vendor_location (vendor_id, city, state, zip, lat, lng, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     ON CONFLICT (vendor_id) WHERE is_primary
     DO UPDATE SET city = EXCLUDED.city, state = EXCLUDED.state, zip = EXCLUDED.zip,
                   lat = EXCLUDED.lat, lng = EXCLUDED.lng`,
    [vendorId, clean(r.city), normalizeState(r.state) ?? clean(r.state), zip5(r.zip), point?.lat ?? null, point?.lng ?? null],
  );
}

/** Re-derive compliance_status (and Active, on the first APPROVED). */
export async function recomputeCompliance(vendorId: string): Promise<void> {
  const v = await query<{ status: string; w9_received: TriState; msa_signed: TriState; coi_received: TriState; coi_approved: TriState; compliance_status: ComplianceStatus }>(
    `SELECT status, w9_received, msa_signed, coi_received, coi_approved, compliance_status FROM vendor WHERE id = $1`,
    [vendorId],
  );
  const r = v.rows[0];
  if (!r) return;
  const exp = (await loadExpiries([vendorId])).get(vendorId) ?? [];
  const expired = exp.some((e) => e.current && e.expires_on < today());
  const allIn = r.w9_received === 'YES' && r.msa_signed === 'YES' && r.coi_received === 'YES';
  const anyIn = r.w9_received === 'YES' || r.msa_signed === 'YES' || r.coi_received === 'YES';
  const next: ComplianceStatus = expired
    ? 'EXPIRED'
    : r.coi_approved === 'NO'
      ? 'REJECTED'
      : allIn && r.coi_approved === 'YES'
        ? 'APPROVED'
        : anyIn
          ? 'IN_REVIEW'
          : 'MISSING_DOCS';
  if (next === r.compliance_status) return;
  const activate = next === 'APPROVED' && ['NEW', 'INTERESTED', 'READY'].includes(r.status);
  await query(`UPDATE vendor SET compliance_status = $2, status = $3 WHERE id = $1`, [
    vendorId,
    next,
    activate ? VENDOR_STATUS_ACTIVE : r.status,
  ]);
}

function tradesOf(primary: string | null, secondary: string[]): string[] {
  const out: string[] = [];
  for (const t of [primary, ...secondary]) {
    const s = (t ?? '').trim();
    if (s !== '' && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

export async function createVendor(input: VendorInput, actor: ActingPrincipal): Promise<VendorDetail> {
  requirePerm(actor, VENDORS_PERM_KEY, 'create', 'You cannot add vendors');
  // 0058 · a VR vendor must carry the required fields, unless the person
  // saving says "add anyway" — it is then flagged and a review is raised.
  if (input.kind !== 'tech' && !input.override_missing) {
    const subject = {
      ...input,
      owner_id: input.owner_id === undefined ? actor.id : input.owner_id,
      phones: (input.phones ?? []).map((p) => p.phone),
    };
    const missing = missingFields(subject as never, await requiredKeys()).filter((p) => p.problem === 'missing');
    if (missing.length > 0) {
      throw conflict(`Still needed: ${missing.map((m) => m.label).join(', ')}`, {
        code: 'VENDOR_MISSING_FIELDS',
        missing: missing.map((m) => ({ key: m.key, label: m.label })),
      });
    }
  }
  const id = await insertVendor(input, actor);
  // 0059 · added straight into somebody else's hands: they are told.
  if (input.owner_id && input.owner_id !== actor.id) {
    await notify([input.owner_id], {
      kind: 'vendor_assigned',
      title: `${actor.name} added ${(input.name ?? '').trim()} and made you its owner`,
      link: `/vendors/${id}`,
      actorId: actor.id,
    });
  }
  return loadVendor(id, actor);
}

/** The insert itself, without the Vendors-section gate — the map's "add a
    technician" has its own permission and calls this. */
export async function insertVendor(
  input: VendorInput,
  actor: ActingPrincipal,
  /** An import decides for itself whether a flagged duplicate needs a review. */
  opts: { duplicateTask?: boolean } = {},
): Promise<string> {
  const name = clean(input.name);
  if (!name) throw badRequest('A vendor needs a name', { field: 'name' });
  const phones = phoneRows(input.phones);
  const kind: VendorKind = input.kind === 'tech' ? 'tech' : 'vendor';
  // Two technicians may share a name; a technician is a duplicate by phone only.
  const matches = await findDuplicates(kind === 'tech' ? '' : name, phones.map((p) => p.digits));
  if (matches.length > 0 && !input.override_duplicate) {
    throw conflict('A vendor with this name or phone is already on file', { code: 'VENDOR_DUPLICATE', matches });
  }
  await assertListValue('vendor_status', clean(input.status), 'status');
  await assertListValue('vendor_brand_source', clean(input.brand_source), 'brand source');

  const primary = clean(input.primary_trade);
  const secondary = (input.secondary_trades ?? []).map((t) => t.trim()).filter(Boolean);
  const cols: string[] = ['name', 'kind', 'trades', 'created_by', 'flagged_duplicate', 'duplicate_of', 'details'];
  const vals: unknown[] = [name, kind, tradesOf(primary, secondary), actor.id, matches.length > 0, matches[0]?.id ?? null, JSON.stringify(cleanDetails(input.details))];
  const push = (col: string, v: unknown) => {
    cols.push(col);
    vals.push(v);
  };
  for (const c of TEXT_COLS) {
    if (input[c] === undefined) continue;
    const v = c === 'state' ? (normalizeState(input.state) ?? clean(input.state)) : clean(input[c] as string | null);
    if (v === null && ['status', 'w9_received', 'msa_signed', 'coi_received', 'coi_approved'].includes(c)) continue;
    push(c, v);
  }
  if (input.owner_id !== undefined) push('owner_id', input.owner_id);
  else if (kind === 'vendor') push('owner_id', actor.id);
  for (const c of BOOL_COLS) if (input[c] !== undefined) push(c, input[c]);
  for (const c of NUM_COLS) if (input[c] !== undefined) push(c, input[c]);
  for (const c of ARRAY_COLS) if (input[c] !== undefined) push(c, (input[c] ?? []).map((s) => s.trim()).filter(Boolean));

  const id = await withTransaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO vendor (${cols.join(', ')})
       VALUES (${cols.map((c, i) => (c === 'details' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})
       RETURNING id::text AS id`,
      vals,
    );
    const vid = ins.rows[0].id;
    await writePhones(tx, vid, phones);
    if (input.contacts) await writeContacts(tx, vid, input.contacts);
    return vid;
  });
  await syncPrimaryLocation(id);
  await recomputeCompliance(id);
  await logAdminEvent({
    actorId: actor.id,
    entity: 'vendor',
    entityId: id,
    action: 'vendor_created',
    after: { name, kind, phone: phones[0]?.display ?? null, primary_trade: primary, flagged_duplicate: matches.length > 0 },
  });
  // 0058 · the reviews a new record can raise.
  if (matches.length > 0 && opts.duplicateTask !== false) {
    await openVendorTask({ type: 'DUPLICATE_REVIEW', title: `Review possible duplicate: ${name}`, vendorId: id, createdBy: actor.id });
  }
  const problems = (await recomputeMissing(id)).filter((p) => p.problem === 'missing');
  if (problems.length > 0) {
    await openVendorTask({
      type: 'MISSING_INFO_REVIEW',
      title: `Review incomplete profile: ${name} (missing: ${problems.map((p) => p.label).join(', ')})`,
      vendorId: id,
      createdBy: actor.id,
    });
  }
  return id;
}

export async function updateVendor(id: string, input: VendorInput, actor: ActingPrincipal): Promise<VendorDetail> {
  requirePerm(actor, VENDORS_PERM_KEY, 'edit', 'You cannot edit vendors');
  if (!UUID_RE.test(id)) throw notFound('Vendor not found');
  if (!(await inScope(actor, id))) throw forbidden('This vendor is outside the vendors you can see');
  const before = await loadVendor(id, actor);

  if (input.status !== undefined) await assertListValue('vendor_status', clean(input.status), 'status');
  if (input.brand_source !== undefined) await assertListValue('vendor_brand_source', clean(input.brand_source), 'brand source');

  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown, cast = '') => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}${cast}`);
  };
  if (input.name !== undefined) {
    const name = clean(input.name);
    if (!name) throw badRequest('A vendor needs a name', { field: 'name' });
    set('name', name);
  }
  if (input.kind !== undefined) set('kind', input.kind === 'tech' ? 'tech' : 'vendor');
  for (const c of TEXT_COLS) {
    if (input[c] === undefined) continue;
    const v = c === 'state' ? (normalizeState(input.state) ?? clean(input.state)) : clean(input[c] as string | null);
    if (v === null && ['status', 'w9_received', 'msa_signed', 'coi_received', 'coi_approved'].includes(c)) continue;
    set(c, v);
  }
  if (input.owner_id !== undefined) set('owner_id', input.owner_id);
  for (const c of BOOL_COLS) if (input[c] !== undefined) set(c, input[c]);
  for (const c of NUM_COLS) if (input[c] !== undefined) set(c, input[c]);
  for (const c of ARRAY_COLS) if (input[c] !== undefined) set(c, (input[c] ?? []).map((s) => s.trim()).filter(Boolean));
  if (input.primary_trade !== undefined || input.secondary_trades !== undefined) {
    const primary = input.primary_trade !== undefined ? clean(input.primary_trade) : before.primary_trade;
    const secondary = input.secondary_trades !== undefined ? input.secondary_trades : before.secondary_trades;
    set('trades', tradesOf(primary, secondary ?? []));
  }
  if (input.details !== undefined) {
    // Merge: a key sent as null / '' / [] is removed, the rest overwrite.
    const merged: Record<string, unknown> = { ...before.details };
    for (const [k, v] of Object.entries(cleanDetails(input.details))) {
      const empty = v === null || v === '' || (Array.isArray(v) && v.length === 0);
      if (empty) delete merged[k];
      else merged[k] = v;
    }
    set('details', JSON.stringify(merged), '::jsonb');
  }
  const phones = input.phones !== undefined ? phoneRows(input.phones) : null;

  await withTransaction(async (tx) => {
    if (sets.length > 0) {
      vals.push(id);
      await tx.query(`UPDATE vendor SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    }
    if (phones) await writePhones(tx, id, phones);
    if (input.contacts !== undefined) await writeContacts(tx, id, input.contacts);
  });
  if (input.city !== undefined || input.state !== undefined || input.zip !== undefined) await syncPrimaryLocation(id);
  await recomputeCompliance(id);
  await recomputeMissing(id);

  const after = await loadVendor(id, actor);
  // 0059 · a vendor handed to someone: they are told.
  if (after.owner && after.owner.id !== before.owner?.id) {
    await notify([after.owner.id], {
      kind: 'vendor_assigned',
      title: `${actor.name} made you the owner of ${after.name}`,
      link: `/vendors/${id}`,
      actorId: actor.id,
    });
  }
  const diff = diffVendor(before, after);
  if (Object.keys(diff.after).length > 0) {
    await logAdminEvent({
      actorId: actor.id,
      entity: 'vendor',
      entityId: id,
      action: 'vendor_updated',
      before: { name: before.name, ...diff.before },
      after: { name: after.name, ...diff.after },
    });
  }
  return after;
}

const DIFF_KEYS: (keyof VendorDetail)[] = [
  'name', 'kind', 'status', 'brand_source', 'priority', 'email', 'phone', 'city', 'state', 'zip', 'primary_trade',
  'secondary_trades', 'legal_name', 'dba_name', 'nationwide', 'statewide', 'coverage_states', 'max_travel_radius',
  'emergency_same_day', 'after_hours', 'weekends', 'holiday_emergency', 'estimated_response_time',
  'regular_hourly_rate', 'after_hours_rate', 'weekend_emergency_rate', 'trip_charge', 'diagnostic_fee',
  'minimum_charge', 'payment_methods', 'accepts_payment_after_30_days', 'primary_contact_name',
  'primary_contact_role', 'dispatch_phone', 'billing_email', 'w9_received', 'msa_signed', 'coi_received',
  'coi_approved', 'compliance_status', 'is_subcontractor', 'notes', 'details',
];

function diffVendor(a: VendorDetail, b: VendorDetail): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of DIFF_KEYS) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    before[k] = a[k];
    after[k] = b[k];
  }
  if ((a.owner?.id ?? null) !== (b.owner?.id ?? null)) {
    before.owner = a.owner?.name ?? null;
    after.owner = b.owner?.name ?? null;
  }
  const phones = (v: VendorDetail) => v.phones.map((p) => p.display);
  if (JSON.stringify(phones(a)) !== JSON.stringify(phones(b))) {
    before.phones = phones(a);
    after.phones = phones(b);
  }
  const contacts = (v: VendorDetail) => v.contacts.map((c) => [c.name, c.role, c.phone, c.email]);
  if (JSON.stringify(contacts(a)) !== JSON.stringify(contacts(b))) {
    before.contacts = a.contacts.map((c) => c.name);
    after.contacts = b.contacts.map((c) => c.name);
  }
  return { before, after };
}

export async function deleteVendor(id: string, actor: ActingPrincipal): Promise<void> {
  requirePerm(actor, VENDORS_PERM_KEY, 'delete', 'You cannot remove vendors');
  if (!UUID_RE.test(id)) throw notFound('Vendor not found');
  if (!(await inScope(actor, id))) throw forbidden('This vendor is outside the vendors you can see');
  const res = await query<{ name: string }>(
    `UPDATE vendor SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING name`,
    [id],
  );
  if (!res.rows[0]) throw notFound('Vendor not found');
  // Anything flagged as its duplicate is no longer a duplicate of anything,
  // and the reviews that asked about either of them have their answer.
  const twins = await query<{ id: string }>(`SELECT id::text AS id FROM vendor WHERE duplicate_of = $1`, [id]);
  for (const t of twins.rows) await autoCloseTasks(t.id, 'DUPLICATE_REVIEW');
  await query(`UPDATE vendor SET flagged_duplicate = false, duplicate_of = NULL WHERE duplicate_of = $1`, [id]);
  await query(
    `UPDATE vendor_task SET status = 'DONE', outcome = 'auto', completed_at = now() WHERE vendor_id = $1 AND status = 'OPEN'`,
    [id],
  );
  await logAdminEvent({ actorId: actor.id, entity: 'vendor', entityId: id, action: 'vendor_deleted', before: { name: res.rows[0].name } });
}

// ── Notes and the blacklist ──────────────────────────────────────────────────

async function liveVendorName(id: string): Promise<string> {
  if (!UUID_RE.test(id)) throw notFound('Vendor not found');
  const res = await query<{ name: string }>(`SELECT name FROM vendor WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!res.rows[0]) throw notFound('Vendor not found');
  return res.rows[0].name;
}

export async function listNotes(id: string, actor: ActingPrincipal): Promise<VendorNote[]> {
  if (
    !permAllows(actor.perms, VENDOR_BLACKLIST_PERM_KEY, 'create', actor.isSuperAdmin) &&
    !permAllows(actor.perms, VENDORS_PERM_KEY, 'view', actor.isSuperAdmin)
  ) {
    throw forbidden('You cannot read vendor notes');
  }
  await liveVendorName(id);
  return loadNotes(id);
}

export async function addNote(id: string, body: string, taskId: string | null, actor: ActingPrincipal): Promise<VendorNote[]> {
  requirePerm(actor, VENDOR_BLACKLIST_PERM_KEY, 'create', 'You cannot add notes to vendors');
  const name = await liveVendorName(id);
  const text = body.trim();
  if (text === '') throw badRequest('The note is empty', { field: 'body' });
  await query(`INSERT INTO vendor_note (vendor_id, author_id, kind, body, task_id) VALUES ($1, $2, 'note', $3, $4)`, [
    id,
    actor.id,
    text,
    taskId,
  ]);
  await logAdminEvent({ actorId: actor.id, entity: 'vendor', entityId: id, action: 'vendor_note_added', after: { name, note: text } });
  return loadNotes(id);
}

export async function blacklistVendor(id: string, reason: string, taskId: string | null, actor: ActingPrincipal): Promise<void> {
  requirePerm(actor, VENDOR_BLACKLIST_PERM_KEY, 'create', 'You cannot blacklist vendors');
  const name = await liveVendorName(id);
  const text = reason.trim();
  if (text === '') throw badRequest('Say why — a blacklist needs a reason', { field: 'reason' });
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE vendor SET blacklisted = true, blacklisted_at = now(), blacklisted_by = $2, blacklist_reason = $3 WHERE id = $1`,
      [id, actor.id, text],
    );
    await tx.query(`INSERT INTO vendor_note (vendor_id, author_id, kind, body, task_id) VALUES ($1, $2, 'blacklist', $3, $4)`, [
      id,
      actor.id,
      text,
      taskId,
    ]);
  });
  await logAdminEvent({ actorId: actor.id, entity: 'vendor', entityId: id, action: 'vendor_blacklisted', after: { name, reason: text } });
  const owner = await query<{ owner_id: string | null }>(`SELECT owner_id::text AS owner_id FROM vendor WHERE id = $1`, [id]);
  await notify([owner.rows[0]?.owner_id], {
    kind: 'vendor_blacklisted',
    title: `${actor.name} blacklisted ${name}`,
    body: text,
    link: `/vendors/${id}`,
    actorId: actor.id,
  });
}

export async function clearBlacklist(id: string, note: string | null, actor: ActingPrincipal): Promise<void> {
  requirePerm(actor, VENDOR_BLACKLIST_PERM_KEY, 'edit', 'Clearing a blacklist is a manager’s decision');
  const name = await liveVendorName(id);
  const was = await query<{ blacklist_reason: string | null }>(`SELECT blacklist_reason FROM vendor WHERE id = $1`, [id]);
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE vendor SET blacklisted = false, blacklisted_at = NULL, blacklisted_by = NULL, blacklist_reason = NULL WHERE id = $1`,
      [id],
    );
    await tx.query(`INSERT INTO vendor_note (vendor_id, author_id, kind, body) VALUES ($1, $2, 'blacklist_cleared', $3)`, [
      id,
      actor.id,
      (note ?? '').trim() || 'Blacklist cleared',
    ]);
  });
  await logAdminEvent({
    actorId: actor.id,
    entity: 'vendor',
    entityId: id,
    action: 'vendor_blacklist_cleared',
    before: { name, reason: was.rows[0]?.blacklist_reason ?? null },
    after: { name, note: (note ?? '').trim() || null },
  });
}

// ── Insurance dates ──────────────────────────────────────────────────────────

export async function addExpiry(
  id: string,
  input: { entity: string | null; insurance_type: string; expires_on: string },
  actor: ActingPrincipal,
): Promise<VendorDetail> {
  requirePerm(actor, VENDORS_PERM_KEY, 'edit', 'You cannot edit vendors');
  const name = await liveVendorName(id);
  if (!(await inScope(actor, id))) throw forbidden('This vendor is outside the vendors you can see');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expires_on)) throw badRequest('The date must be YYYY-MM-DD', { field: 'expires_on' });
  const type = input.insurance_type.trim();
  if (type === '') throw badRequest('Say which insurance this date is for', { field: 'insurance_type' });
  await query(`INSERT INTO vendor_expiry (vendor_id, entity, insurance_type, expires_on, created_by) VALUES ($1, $2, $3, $4, $5)`, [
    id,
    clean(input.entity),
    type,
    input.expires_on,
    actor.id,
  ]);
  await recomputeCompliance(id);
  await logAdminEvent({
    actorId: actor.id,
    entity: 'vendor',
    entityId: id,
    action: 'vendor_expiry_added',
    after: { name, insurance_type: type, entity: clean(input.entity), expires_on: input.expires_on },
  });
  return loadVendor(id, actor);
}

export async function removeExpiry(id: string, expiryId: string, actor: ActingPrincipal): Promise<VendorDetail> {
  requirePerm(actor, VENDORS_PERM_KEY, 'edit', 'You cannot edit vendors');
  const name = await liveVendorName(id);
  if (!(await inScope(actor, id))) throw forbidden('This vendor is outside the vendors you can see');
  if (!UUID_RE.test(expiryId)) throw notFound('Date not found');
  const res = await query<{ insurance_type: string; expires_on: string }>(
    `DELETE FROM vendor_expiry WHERE id = $1 AND vendor_id = $2
     RETURNING insurance_type, to_char(expires_on, 'YYYY-MM-DD') AS expires_on`,
    [expiryId, id],
  );
  if (!res.rows[0]) throw notFound('Date not found');
  await recomputeCompliance(id);
  await logAdminEvent({
    actorId: actor.id,
    entity: 'vendor',
    entityId: id,
    action: 'vendor_expiry_removed',
    before: { name, ...res.rows[0] },
  });
  return loadVendor(id, actor);
}

// ── History ──────────────────────────────────────────────────────────────────

export interface VendorHistoryEntry {
  id: string;
  action: string;
  actor: FeedActor | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

export async function vendorHistory(id: string, actor: ActingPrincipal): Promise<VendorHistoryEntry[]> {
  requireVendorsView(actor);
  await liveVendorName(id);
  if (!(await inScope(actor, id))) throw forbidden('This vendor is outside the vendors you can see');
  // entity_id is text (0023): the id travels as text, never as a uuid here.
  const res = await query<{ id: string; action: string; a_id: string | null; a_name: string | null; a_kind: 'human' | 'service' | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; created_at: Date }>(
    `SELECT a.id::text AS id, a.action, p.id::text AS a_id, p.display_name AS a_name, p.kind AS a_kind,
            a.before, a.after, a.created_at
       FROM activity_log a LEFT JOIN principal p ON p.id = a.actor_principal_id
      WHERE a.entity_type = 'vendor' AND a.entity_id = $1::text
      ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    [id],
  );
  return res.rows.map((r) => ({
    id: r.id,
    action: r.action,
    actor: r.a_id ? { id: r.a_id, name: r.a_name ?? 'Unknown', kind: r.a_kind ?? 'human' } : null,
    before: r.before,
    after: r.after,
    created_at: iso(r.created_at)!,
  }));
}

/** Guard used by callers that only hold an id from the URL. */
export function assertVendorId(id: string): void {
  if (!UUID_RE.test(id)) throw new ApiError('NOT_FOUND', 'Vendor not found');
}
