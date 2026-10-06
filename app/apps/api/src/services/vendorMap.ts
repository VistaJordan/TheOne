// 0057 · The technician map on a work order, hiring, and Admin › Vendors & map.
//
// THE MAP is opened from a work order only and is centred on the work order's
// own ZIP / city (geo.ts). What a person sees on it is their role's
// `vendor_map/*` grants (resolveVendorMapScope), the way Tech Locator's flags
// worked:
//
//   VR vendors          kind 'vendor'                    vendor_map/vr
//   technicians         kind 'tech' — all of them, or    vendor_map/techs
//                       only the ones linked to the viewer (vendor_dispatcher)
//   subcontractors      is_subcontractor                 vendor_map/subcontractors
//   within the radius   always (Admin › Vendors & map sets the miles)
//   statewide           vendor.statewide, in the work    vendor_map/statewide
//                       order's state, however far
//   nationwide          vendor.nationwide                vendor_map/nationwide
//
// A vendor already hired on the work order is always listed. Nothing filters
// on vendor status or paperwork — the popup says what is wrong and Hire warns
// (never blocks) when a VR vendor's COI is missing or expired. Blacklisted
// records stay visible, marked, and sort last. Preferred vendors for the work
// order's client / trade sort first.
//
// Availability filters match the vendor's answer; a technician nobody has
// asked (NULL) stays in the results, and the popup says "not asked".
//
// A statewide / nationwide vendor whose city we could not place comes back
// with lat / lng NULL; the map pins it at the work order (as Tech Locator
// did) and says so.
//
// Every open is logged (vendor_map_log). More than `map_daily_alert` opens in
// a day raises an alert row in Admin › Vendors & map — alert only, nobody is
// blocked.
//
// HIRING writes wo_technician (the People tab's Technicians) and links the
// vendor to the person who hired — so does logging a visit with a picked
// technician (linkVisitVendor) — which is what puts a technician on an
// "only theirs" dispatcher's map next time.
//
// Audit: tech_hired / tech_released / tech_added on the work order
// (entity 'task'); settings, lists and preferred vendors on their own entities.

import {
  VENDOR_MAP_PERM_KEY,
  VENDOR_SETTING_DEFAULTS,
  adminPermKey,
  ADMIN_VENDORS_SLUG,
  compareMapVendors,
  complianceWarning,
  haversineMiles,
  normalizeState,
  phoneDigits,
  preferredRuleScore,
  preferredRuleText,
  resolveVendorMapScope,
} from '@theone/shared';
import type {
  AdminVendorsResponse,
  AvailabilityKey,
  FeedActor,
  MapReach,
  MapUsageRow,
  MapVendor,
  NewTechInput,
  PreferredVendorInput,
  PreferredVendorRule,
  TechSearchHit,
  TriState,
  VendorKind,
  VendorMapScope,
  VendorSettings,
  WoMapResponse,
  WoTechnician,
  WoTechniciansResponse,
} from '@theone/shared';
import { query } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { geoLookup, workOrderPlace } from './geo.js';
import { requirePerm } from './permissions.js';
import { getSuggestSettings } from './vendorSuggestSettings.js';
import {
  insertVendor,
  listBrandSources,
  listPreferred,
  listStatuses,
  listVendorTrades,
  loadExpiries,
} from './vendors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = (): string => new Date().toISOString().slice(0, 10);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getVendorSettings(): Promise<VendorSettings> {
  const res = await query<{ key: string; value: unknown }>(`SELECT key, value FROM vendor_setting`);
  const out: VendorSettings = { ...VENDOR_SETTING_DEFAULTS };
  for (const r of res.rows) {
    if (r.key === 'map_radius_miles' && typeof r.value === 'number') out.map_radius_miles = r.value;
    if (r.key === 'map_daily_alert' && typeof r.value === 'number') out.map_daily_alert = r.value;
    if (r.key === 'hire_warn_compliance' && typeof r.value === 'boolean') out.hire_warn_compliance = r.value;
  }
  return out;
}

// ── The map ──────────────────────────────────────────────────────────────────

export function mapScope(actor: ActingPrincipal): VendorMapScope {
  return resolveVendorMapScope(actor.perms, actor.isSuperAdmin);
}

export interface MapFilters {
  trades: string[] | null;
  availability: AvailabilityKey[];
  /** true on the first load of a map session — the one that is logged. */
  opened: boolean;
}

type MapRow = {
  id: string;
  kind: VendorKind;
  name: string;
  status: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  miles: number | null;
  loc_city: string | null;
  loc_state: string | null;
  primary_trade: string | null;
  secondary_trades: string[];
  emergency_same_day: boolean | null;
  after_hours: boolean | null;
  weekends: boolean | null;
  holiday_emergency: boolean | null;
  regular_hourly_rate: string | null;
  after_hours_rate: string | null;
  weekend_emergency_rate: string | null;
  trip_charge: string | null;
  diagnostic_fee: string | null;
  minimum_charge: string | null;
  estimated_response_time: string | null;
  max_travel_radius: string | null;
  work_orders_count: number;
  is_subcontractor: boolean;
  blacklisted: boolean;
  blacklist_reason: string | null;
  statewide: boolean;
  nationwide: boolean;
  coverage_states: string[];
  coi_received: TriState;
  mine: boolean;
  hired: boolean;
};

const AVAILABILITY_COLS: Record<AvailabilityKey, string> = {
  emergency_same_day: 'emergency_same_day',
  after_hours: 'after_hours',
  weekends: 'weekends',
  holiday_emergency: 'holiday_emergency',
};

const MAX_RESULTS = 600;

async function workOrderHead(taskId: string) {
  const res = await query<{ id: string; wo_number: string; client: string | null; trade: string | null; state: string | null; city: string | null }>(
    `SELECT id::text AS id, wo_number, client, trade, state, city FROM task WHERE id = $1`,
    [taskId],
  );
  if (!res.rows[0]) throw notFound('Work order not found');
  return res.rows[0];
}

export async function workOrderMap(taskId: string, filters: MapFilters, actor: ActingPrincipal): Promise<WoMapResponse> {
  const scope = mapScope(actor);
  if (!scope.open) throw forbidden('You cannot open the technician map', { required_permission: `${VENDOR_MAP_PERM_KEY}:view` });

  const [wo, place, settings, tradeList] = await Promise.all([
    workOrderHead(taskId),
    workOrderPlace(taskId),
    getVendorSettings(),
    listVendorTrades(),
  ]);
  const trades = tradeList.filter((t) => t.is_active).map((t) => t.name);
  const { city: woCity, ...head } = wo;
  // What a preferred-vendor rule is matched against: a city rule (0069) reads
  // the work order's own city, else the one its ZIP sits in.
  const ruleTarget = { ...head, state: place.state ?? normalizeState(wo.state), city: woCity ?? place.point?.city ?? null };
  const base = {
    work_order: { ...head, state: ruleTarget.state },
    radius_miles: settings.map_radius_miles,
    trades,
    scope,
  };
  if (!place.point) return { ...base, center: null, vendors: [], unplaced: 0 };
  const center = place.point;

  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const lat = add(center.lat);
  const lng = add(center.lng);
  const radius = add(settings.map_radius_miles);
  const me = add(actor.id);
  const task = add(taskId);

  const miles = `3958.8 * 2 * asin(least(1, sqrt(
      power(sin(radians(l.lat - ${lat}) / 2), 2)
      + cos(radians(${lat})) * cos(radians(l.lat)) * power(sin(radians(l.lng - ${lng}) / 2), 2))))`;

  const reach: string[] = [`x.miles <= ${radius}`];
  // A parameter Postgres never meets in the statement cannot be typed, so the
  // state is only bound for the roles whose query names it.
  if (scope.statewide && place.state) {
    const st = add(place.state);
    reach.push(`(x.statewide AND (upper(x.state) = ${st}::text OR ${st}::text = ANY(x.coverage_states)))`);
  }
  if (scope.nationwide) reach.push('x.nationwide');

  const who: string[] = [];
  if (scope.vr) who.push(`x.kind = 'vendor'`);
  who.push(scope.allTechs ? `x.kind = 'tech'` : `(x.kind = 'tech' AND x.mine)`);

  const where: string[] = [`(${reach.join(' OR ')})`, `(${who.join(' OR ')})`];
  if (!scope.subcontractors) where.push('NOT x.is_subcontractor');
  if (filters.trades && filters.trades.length > 0) {
    const t = add(filters.trades.map((s) => s.toLowerCase()));
    where.push(`(lower(x.primary_trade) = ANY(${t}::text[])
                 OR EXISTS (SELECT 1 FROM unnest(x.secondary_trades) s WHERE lower(s) = ANY(${t}::text[])))`);
  }
  for (const key of filters.availability) {
    const col = AVAILABILITY_COLS[key];
    if (!col) continue;
    // A technician nobody has asked stays in; a vendor must have said yes.
    where.push(`(x.${col} IS TRUE OR (x.kind = 'tech' AND x.${col} IS NULL))`);
  }

  const res = await query<MapRow>(
    `WITH nearest AS (
       SELECT DISTINCT ON (l.vendor_id) l.vendor_id, l.lat, l.lng, l.city, l.state, ${miles} AS miles
         FROM vendor_location l
        WHERE l.lat IS NOT NULL
        ORDER BY l.vendor_id, ${miles}
     )
     SELECT * FROM (
       SELECT v.id::text AS id, v.kind, v.name, v.status, v.phone, v.email, v.city, v.state,
              n.lat, n.lng, n.miles, n.city AS loc_city, n.state AS loc_state,
              v.primary_trade, v.secondary_trades,
              v.emergency_same_day, v.after_hours, v.weekends, v.holiday_emergency,
              v.regular_hourly_rate, v.after_hours_rate, v.weekend_emergency_rate, v.trip_charge,
              v.diagnostic_fee, v.minimum_charge, v.estimated_response_time, v.max_travel_radius,
              v.work_orders_count, v.is_subcontractor, v.blacklisted, v.blacklist_reason,
              v.statewide, v.nationwide, v.coverage_states, v.coi_received,
              EXISTS (SELECT 1 FROM vendor_dispatcher d WHERE d.vendor_id = v.id AND d.principal_id = ${me}) AS mine,
              EXISTS (SELECT 1 FROM wo_technician w
                       WHERE w.vendor_id = v.id AND w.task_id = ${task} AND w.released_at IS NULL) AS hired
         FROM vendor v
         LEFT JOIN nearest n ON n.vendor_id = v.id
        WHERE v.deleted_at IS NULL
     ) x
     WHERE x.hired OR (${where.join(' AND ')})
     ORDER BY x.miles NULLS LAST, lower(x.name)
     LIMIT ${MAX_RESULTS}`,
    params,
  );

  const ids = res.rows.map((r) => r.id);
  const [phones, expiries, rules] = await Promise.all([
    ids.length === 0
      ? Promise.resolve({ rows: [] as { vendor_id: string; display: string }[] })
      : query<{ vendor_id: string; display: string }>(
          `SELECT vendor_id::text AS vendor_id, display FROM vendor_phone
            WHERE vendor_id = ANY($1::uuid[]) ORDER BY position, created_at`,
          [ids],
        ),
    loadExpiries(ids),
    listPreferred(),
  ]);
  const phonesBy = new Map<string, string[]>();
  for (const p of phones.rows) {
    const list = phonesBy.get(p.vendor_id) ?? [];
    list.push(p.display);
    phonesBy.set(p.vendor_id, list);
  }
  // Best rule per vendor: the most specific that fits, then the lowest rank.
  const preferred = new Map<string, { score: number; rank: number; note: string | null }>();
  for (const rule of rules) {
    const score = preferredRuleScore(rule, ruleTarget);
    if (score === 0) continue;
    const cur = preferred.get(rule.vendor.id);
    if (!cur || score > cur.score || (score === cur.score && rule.rank < cur.rank)) {
      preferred.set(rule.vendor.id, { score, rank: rule.rank, note: rule.note });
    }
  }

  let unplaced = 0;
  const day = today();
  const vendors: MapVendor[] = res.rows.map((r) => {
    const local = r.miles !== null && r.miles <= settings.map_radius_miles;
    const inState =
      r.statewide && place.state !== null && ((r.state ?? '').toUpperCase() === place.state || (r.coverage_states ?? []).includes(place.state));
    const reachOf: MapReach = local ? 'local' : inState ? 'statewide' : r.nationwide ? 'nationwide' : 'local';
    if (r.lat === null) unplaced += 1;
    const pref = preferred.get(r.id) ?? null;
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      status: r.status,
      phone: r.phone,
      phones: phonesBy.get(r.id) ?? (r.phone ? [r.phone] : []),
      email: r.email,
      city: r.loc_city ?? r.city,
      state: r.loc_state ?? r.state,
      lat: r.lat,
      lng: r.lng,
      distance_miles: r.miles === null ? null : Math.round(r.miles * 10) / 10,
      reach: reachOf,
      primary_trade: r.primary_trade,
      secondary_trades: r.secondary_trades ?? [],
      emergency_same_day: r.emergency_same_day,
      after_hours: r.after_hours,
      weekends: r.weekends,
      holiday_emergency: r.holiday_emergency,
      regular_hourly_rate: num(r.regular_hourly_rate),
      after_hours_rate: num(r.after_hours_rate),
      weekend_emergency_rate: num(r.weekend_emergency_rate),
      trip_charge: num(r.trip_charge),
      diagnostic_fee: num(r.diagnostic_fee),
      minimum_charge: num(r.minimum_charge),
      estimated_response_time: r.estimated_response_time,
      max_travel_radius: r.max_travel_radius,
      work_orders_count: r.work_orders_count,
      is_subcontractor: r.is_subcontractor,
      blacklisted: r.blacklisted,
      blacklist_reason: r.blacklist_reason,
      mine: r.mine,
      preferred_rank: pref?.rank ?? null,
      preferred_note: pref?.note ?? null,
      hired: r.hired,
      compliance_warning: settings.hire_warn_compliance ? complianceWarning(r, expiries.get(r.id) ?? [], day) : null,
    };
  });
  vendors.sort(compareMapVendors);

  if (filters.opened) {
    await query(`INSERT INTO vendor_map_log (principal_id, task_id, place, results_count) VALUES ($1, $2, $3, $4)`, [
      actor.id,
      taskId,
      center.label,
      vendors.length,
    ]);
  }
  return {
    ...base,
    center: { lat: center.lat, lng: center.lng, label: center.label, from: center.from },
    vendors,
    unplaced,
  };
}

// ── The work order's technicians ─────────────────────────────────────────────

type TechRow = {
  id: string;
  v_id: string;
  v_kind: VendorKind;
  v_name: string;
  v_phone: string | null;
  v_trade: string | null;
  v_city: string | null;
  v_state: string | null;
  v_bl: boolean;
  v_coi: TriState;
  h_id: string | null;
  h_name: string | null;
  h_kind: 'human' | 'service' | null;
  hired_at: Date;
  released_at: Date | null;
  note: string | null;
};

export async function listTechnicians(taskId: string, actor: ActingPrincipal): Promise<WoTechniciansResponse> {
  const res = await query<TechRow>(
    `SELECT w.id::text AS id, v.id::text AS v_id, v.kind AS v_kind, v.name AS v_name, v.phone AS v_phone,
            v.primary_trade AS v_trade, v.city AS v_city, v.state AS v_state, v.blacklisted AS v_bl,
            v.coi_received AS v_coi,
            p.id::text AS h_id, p.display_name AS h_name, p.kind AS h_kind,
            w.hired_at, w.released_at, w.note
       FROM wo_technician w
       JOIN vendor v ON v.id = w.vendor_id
       LEFT JOIN principal p ON p.id = w.hired_by
      WHERE w.task_id = $1
      ORDER BY (w.released_at IS NOT NULL), w.hired_at`,
    [taskId],
  );
  const expiries = await loadExpiries(res.rows.map((r) => r.v_id));
  const day = today();
  const scope = mapScope(actor);
  const technicians: WoTechnician[] = res.rows.map((r) => ({
    id: r.id,
    vendor: {
      id: r.v_id,
      kind: r.v_kind,
      name: r.v_name,
      phone: r.v_phone,
      primary_trade: r.v_trade,
      city: r.v_city,
      state: r.v_state,
      blacklisted: r.v_bl,
    },
    hired_by: r.h_id ? { id: r.h_id, name: r.h_name ?? 'Unknown', kind: r.h_kind ?? 'human' } : null,
    hired_at: iso(r.hired_at)!,
    released_at: iso(r.released_at),
    note: r.note,
    compliance_warning: complianceWarning({ kind: r.v_kind, coi_received: r.v_coi }, expiries.get(r.v_id) ?? [], day),
  }));
  return { technicians, can: { open_map: scope.open, hire: scope.hire } };
}

async function liveVendor(vendorId: string) {
  if (!UUID_RE.test(vendorId)) throw notFound('Technician not found');
  const res = await query<{ id: string; name: string; phone: string | null; kind: VendorKind; blacklisted: boolean; coi_received: TriState }>(
    `SELECT id::text AS id, name, phone, kind, blacklisted, coi_received FROM vendor WHERE id = $1 AND deleted_at IS NULL`,
    [vendorId],
  );
  if (!res.rows[0]) throw notFound('Technician not found');
  return res.rows[0];
}

/** Tech Locator's ownership link: this person has worked with this vendor. */
export async function linkDispatcher(vendorId: string, principalId: string, source: 'added' | 'visit' | 'hire' | 'manual'): Promise<void> {
  await query(
    `INSERT INTO vendor_dispatcher (vendor_id, principal_id, source) VALUES ($1, $2, $3)
     ON CONFLICT (vendor_id, principal_id) DO NOTHING`,
    [vendorId, principalId, source],
  );
}

async function logTask(actorId: string, taskId: string, action: string, after: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, $3, NULL, NULL, $4::jsonb)`,
    [actorId, taskId, action, JSON.stringify(after)],
  );
}

export interface HireResult extends WoTechniciansResponse {
  /** Said once, after the hire went through: the COI is missing / expired, or
      the technician is blacklisted. Never a refusal. */
  warning: string | null;
}

export async function hireTechnician(taskId: string, vendorId: string, note: string | null, actor: ActingPrincipal): Promise<HireResult> {
  requirePerm(actor, VENDOR_MAP_PERM_KEY, 'create', 'You cannot hire technicians onto a work order');
  const v = await liveVendor(vendorId);
  const settings = await getVendorSettings();
  await query(
    `INSERT INTO wo_technician (task_id, vendor_id, hired_by, note) VALUES ($1, $2, $3, $4)
     ON CONFLICT (task_id, vendor_id)
     DO UPDATE SET released_at = NULL, released_by = NULL, hired_by = EXCLUDED.hired_by,
                   hired_at = CASE WHEN wo_technician.released_at IS NULL THEN wo_technician.hired_at ELSE now() END,
                   note = COALESCE(EXCLUDED.note, wo_technician.note)`,
    [taskId, vendorId, actor.id, (note ?? '').trim() || null],
  );
  await linkDispatcher(vendorId, actor.id, 'hire');
  await logTask(actor.id, taskId, 'tech_hired', { vendor_id: vendorId, name: v.name, phone: v.phone, kind: v.kind });

  const expiries = (await loadExpiries([vendorId])).get(vendorId) ?? [];
  const compliance = settings.hire_warn_compliance ? complianceWarning(v, expiries, today()) : null;
  const warning = v.blacklisted
    ? `${v.name} is blacklisted${compliance ? ` · ${compliance}` : ''}`
    : compliance
      ? `${v.name}: ${compliance}`
      : null;
  return { ...(await listTechnicians(taskId, actor)), warning };
}

export async function releaseTechnician(taskId: string, vendorId: string, actor: ActingPrincipal): Promise<WoTechniciansResponse> {
  requirePerm(actor, VENDOR_MAP_PERM_KEY, 'create', 'You cannot change the technicians on a work order');
  const v = await liveVendor(vendorId);
  const res = await query(
    `UPDATE wo_technician SET released_at = now(), released_by = $3
      WHERE task_id = $1 AND vendor_id = $2 AND released_at IS NULL`,
    [taskId, vendorId, actor.id],
  );
  if ((res.rowCount ?? 0) === 0) throw notFound('That technician is not on this work order');
  await logTask(actor.id, taskId, 'tech_released', { vendor_id: vendorId, name: v.name });
  return listTechnicians(taskId, actor);
}

/** Any technician or vendor, whoever owns it — a visit may name anyone. */
export async function searchTechs(taskId: string, q: string): Promise<TechSearchHit[]> {
  const text = q.trim();
  const params: unknown[] = [taskId];
  const parts: string[] = [];
  if (text !== '') {
    params.push(`%${text.replace(/[\\%_]/g, '\\$&')}%`);
    parts.push(`v.name ILIKE $${params.length}`);
    const digits = text.replace(/\D/g, '');
    if (digits.length >= 3) {
      params.push(`%${digits}%`);
      parts.push(`EXISTS (SELECT 1 FROM vendor_phone ph WHERE ph.vendor_id = v.id AND ph.digits LIKE $${params.length})`);
    }
  }
  const res = await query<TechSearchHit>(
    `SELECT v.id::text AS id, v.kind, v.name, v.phone, v.primary_trade, v.city, v.state, v.blacklisted,
            EXISTS (SELECT 1 FROM wo_technician w
                     WHERE w.vendor_id = v.id AND w.task_id = $1 AND w.released_at IS NULL) AS hired
       FROM vendor v
      WHERE v.deleted_at IS NULL
        AND (${parts.length > 0 ? parts.join(' OR ') : `EXISTS (SELECT 1 FROM wo_technician w WHERE w.vendor_id = v.id AND w.task_id = $1 AND w.released_at IS NULL)`})
      ORDER BY hired DESC, v.blacklisted, lower(v.name)
      LIMIT 15`,
    params,
  );
  return res.rows;
}

/** A visit named a technician from the records: remember which one, and link
    them to whoever logged it. `vendorId` null = the name was typed by hand. */
export async function linkVisitVendor(visitId: string, vendorId: string | null, actor: ActingPrincipal): Promise<void> {
  if (vendorId === null) {
    await query(`UPDATE wo_visit SET vendor_id = NULL WHERE id = $1`, [visitId]);
    return;
  }
  await liveVendor(vendorId);
  const visit = await query<{ task_id: string; was: string | null }>(
    `SELECT task_id::text AS task_id, vendor_id::text AS was FROM wo_visit WHERE id = $1`,
    [visitId],
  );
  if (!visit.rows[0]) return;
  if (visit.rows[0].was === vendorId) return;
  // First visit of this technician on this work order → one more job to their name.
  const first = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM wo_visit WHERE task_id = $1 AND vendor_id = $2`,
    [visit.rows[0].task_id, vendorId],
  );
  await query(`UPDATE wo_visit SET vendor_id = $2 WHERE id = $1`, [visitId, vendorId]);
  if ((first.rows[0]?.n ?? 0) === 0) {
    await query(`UPDATE vendor SET work_orders_count = work_orders_count + 1 WHERE id = $1`, [vendorId]);
  }
  await linkDispatcher(vendorId, actor.id, 'visit');
}

export interface AddTechResult extends WoTechniciansResponse {
  /** created = a new record; linked = the phone was already on file and the
      record is now theirs too. */
  outcome: 'created' | 'linked';
  vendor_id: string;
  on_map: boolean;
  warning: string | null;
}

export async function addTechnician(taskId: string, input: NewTechInput, actor: ActingPrincipal): Promise<AddTechResult> {
  const scope = mapScope(actor);
  if (!scope.add) throw forbidden('You cannot add technicians');
  const name = input.name.trim();
  const digits = phoneDigits(input.phone);
  if (name === '') throw badRequest('The technician needs a name', { field: 'name' });
  if (!digits) throw badRequest('That is not a phone number', { field: 'phone' });
  const state = normalizeState(input.state);
  if (!state) throw badRequest('Pick the state', { field: 'state' });
  if (input.city.trim() === '') throw badRequest('The technician needs a city', { field: 'city' });
  if (input.trade.trim() === '') throw badRequest('Pick the trade', { field: 'trade' });

  const existing = await query<{ id: string }>(
    `SELECT v.id::text AS id FROM vendor v JOIN vendor_phone ph ON ph.vendor_id = v.id
      WHERE ph.digits = $1 AND v.deleted_at IS NULL ORDER BY v.created_at LIMIT 1`,
    [digits],
  );
  let vendorId: string;
  let outcome: 'created' | 'linked';
  if (existing.rows[0]) {
    vendorId = existing.rows[0].id;
    outcome = 'linked';
  } else {
    vendorId = await insertVendor(
      {
        kind: 'tech',
        name,
        status: 'ACTIVE',
        primary_trade: input.trade.trim(),
        city: input.city.trim(),
        state,
        zip: input.zip ?? null,
        phones: [{ phone: input.phone.trim() }],
      },
      actor,
    );
    outcome = 'created';
  }
  await linkDispatcher(vendorId, actor.id, 'added');
  await logTask(actor.id, taskId, 'tech_added', { vendor_id: vendorId, name, outcome });

  let warning: string | null = null;
  if (input.hire && scope.hire) warning = (await hireTechnician(taskId, vendorId, null, actor)).warning;
  const onMap = await query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM vendor_location WHERE vendor_id = $1 AND lat IS NOT NULL) AS ok`,
    [vendorId],
  );
  return { ...(await listTechnicians(taskId, actor)), outcome, vendor_id: vendorId, on_map: onMap.rows[0]?.ok ?? false, warning };
}

// ── The coverage map (Vendors › Coverage map) ────────────────────────────────

export interface CoveragePoint {
  id: string;
  kind: VendorKind;
  name: string;
  status: string;
  primary_trade: string | null;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
  nationwide: boolean;
  statewide: boolean;
  blacklisted: boolean;
  compliance_status: string;
}

/** Every placed vendor location — for deciding where to recruit next. The
    Vendors-section scope applies (routes/vendors.ts passes the predicate). */
export async function coveragePoints(
  filters: { trade?: string; state?: string; kind?: VendorKind; status?: string },
  scopeSql: string | null,
  scopeParams: unknown[],
): Promise<CoveragePoint[]> {
  const params = [...scopeParams];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = ['v.deleted_at IS NULL', 'l.lat IS NOT NULL'];
  if (scopeSql) where.push(scopeSql);
  if (filters.trade) {
    const t = add(filters.trade.toLowerCase());
    where.push(`(lower(v.primary_trade) = ${t} OR EXISTS (SELECT 1 FROM unnest(v.secondary_trades) s WHERE lower(s) = ${t}))`);
  }
  if (filters.state) where.push(`upper(l.state) = ${add(filters.state.toUpperCase())}`);
  if (filters.kind) where.push(`v.kind = ${add(filters.kind)}`);
  if (filters.status) where.push(`v.status = ${add(filters.status)}`);
  const res = await query<CoveragePoint>(
    `SELECT v.id::text AS id, v.kind, v.name, v.status, v.primary_trade, l.city, l.state, l.lat, l.lng,
            v.nationwide, v.statewide, v.blacklisted, v.compliance_status
       FROM vendor_location l JOIN vendor v ON v.id = l.vendor_id
      WHERE ${where.join(' AND ')}
      ORDER BY lower(v.name)
      LIMIT 20000`,
    params,
  );
  return res.rows;
}

// ── Admin › Vendors & map ────────────────────────────────────────────────────

const ADMIN_KEY = adminPermKey(ADMIN_VENDORS_SLUG);

export function requireVendorAdmin(actor: ActingPrincipal, action: 'view' | 'edit'): void {
  requirePerm(actor, ADMIN_KEY, action, 'You cannot change the vendor and map settings');
}

async function mapUsage(limit: number): Promise<MapUsageRow[]> {
  const res = await query<{ id: string; name: string; kind: 'human' | 'service'; day: string; opens: number }>(
    `SELECT p.id::text AS id, p.display_name AS name, p.kind,
            to_char(l.created_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS day, count(*)::int AS opens
       FROM vendor_map_log l JOIN principal p ON p.id = l.principal_id
      WHERE l.created_at >= now() - interval '14 days'
      GROUP BY p.id, p.display_name, p.kind, day
      ORDER BY day DESC, opens DESC
      LIMIT 300`,
  );
  return res.rows.map((r) => ({
    principal: { id: r.id, name: r.name, kind: r.kind } as FeedActor,
    day: r.day,
    opens: r.opens,
    over_limit: r.opens >= limit,
  }));
}

export async function adminVendors(actor: ActingPrincipal): Promise<AdminVendorsResponse> {
  requireVendorAdmin(actor, 'view');
  const settings = await getVendorSettings();
  const [statuses, brands, trades, preferred, suggest, usage, clients, woTrades] = await Promise.all([
    listStatuses(),
    listBrandSources(),
    listVendorTrades(),
    listPreferred(),
    getSuggestSettings(),
    mapUsage(settings.map_daily_alert),
    query<{ v: string }>(
      `SELECT DISTINCT client AS v FROM task WHERE deleted_at IS NULL AND client IS NOT NULL AND btrim(client) <> '' ORDER BY 1`,
    ),
    query<{ v: string }>(
      `SELECT DISTINCT trade AS v FROM task WHERE deleted_at IS NULL AND trade IS NOT NULL AND btrim(trade) <> '' ORDER BY 1`,
    ),
  ]);
  return {
    settings,
    statuses,
    brand_sources: brands,
    trades,
    preferred,
    suggest,
    usage,
    clients: clients.rows.map((r) => r.v),
    wo_trades: woTrades.rows.map((r) => r.v),
  };
}

export async function saveVendorSettings(input: Partial<VendorSettings>, actor: ActingPrincipal): Promise<VendorSettings> {
  requireVendorAdmin(actor, 'edit');
  const before = await getVendorSettings();
  const next: VendorSettings = { ...before };
  if (input.map_radius_miles !== undefined) {
    if (!Number.isFinite(input.map_radius_miles) || input.map_radius_miles < 5 || input.map_radius_miles > 500) {
      throw badRequest('The radius must be between 5 and 500 miles', { field: 'map_radius_miles' });
    }
    next.map_radius_miles = Math.round(input.map_radius_miles);
  }
  if (input.map_daily_alert !== undefined) {
    if (!Number.isFinite(input.map_daily_alert) || input.map_daily_alert < 1 || input.map_daily_alert > 10000) {
      throw badRequest('The daily number must be between 1 and 10,000', { field: 'map_daily_alert' });
    }
    next.map_daily_alert = Math.round(input.map_daily_alert);
  }
  if (input.hire_warn_compliance !== undefined) next.hire_warn_compliance = Boolean(input.hire_warn_compliance);
  for (const [key, value] of Object.entries(next)) {
    await query(
      `INSERT INTO vendor_setting (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), actor.id],
    );
  }
  if (JSON.stringify(before) !== JSON.stringify(next)) {
    await logAdminEvent({
      actorId: actor.id,
      entity: 'vendor_setting',
      entityId: 'map',
      action: 'vendor_settings_updated',
      before: { name: 'Vendors & map settings', ...before },
      after: { name: 'Vendors & map settings', ...next },
    });
  }
  return next;
}

// Preferred vendors ───────────────────────────────────────────────────────────

const cleanText = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

const ruleName = (r: { client: string | null; trade: string | null; state: string | null; city?: string | null }, vendor: string): string =>
  `${vendor} · ${preferredRuleText(r)}`;

export async function createPreferred(input: PreferredVendorInput, actor: ActingPrincipal): Promise<PreferredVendorRule[]> {
  requireVendorAdmin(actor, 'edit');
  const client = cleanText(input.client);
  const trade = cleanText(input.trade);
  const state = input.state ? normalizeState(input.state) : null;
  if (!client && !trade) throw badRequest('Pick a client, a trade, or both');
  if (input.state && !state) throw badRequest('That is not a state', { field: 'state' });
  const city = cleanText(input.city);
  if (city && !state) throw badRequest('Pick the state the city is in', { field: 'state' });
  if (!input.vendor_id) throw badRequest('Pick the vendor', { field: 'vendor_id' });
  const v = await liveVendor(input.vendor_id);
  const dup = await query(
    `SELECT 1 FROM preferred_vendor
      WHERE vendor_id = $1 AND lower(COALESCE(client, '')) = lower(COALESCE($2, ''))
        AND lower(COALESCE(trade, '')) = lower(COALESCE($3, '')) AND COALESCE(state, '') = COALESCE($4, '')
        AND lower(COALESCE(city, '')) = lower(COALESCE($5, ''))`,
    [v.id, client, trade, state, city],
  );
  if (dup.rows.length > 0) throw conflict('That vendor is already preferred for this client / trade');
  const rank = Number.isFinite(input.rank) && (input.rank ?? 0) > 0 ? Math.round(input.rank!) : 1;
  const ins = await query<{ id: string }>(
    `INSERT INTO preferred_vendor (client, trade, state, city, vendor_id, rank, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text AS id`,
    [client, trade, state, city, v.id, rank, cleanText(input.note), actor.id],
  );
  await logAdminEvent({
    actorId: actor.id,
    entity: 'preferred_vendor',
    entityId: ins.rows[0].id,
    action: 'preferred_vendor_created',
    after: { name: ruleName({ client, trade, state, city }, v.name), rank },
  });
  return listPreferred();
}

export async function updatePreferred(id: string, input: PreferredVendorInput, actor: ActingPrincipal): Promise<PreferredVendorRule[]> {
  requireVendorAdmin(actor, 'edit');
  if (!UUID_RE.test(id)) throw notFound('Rule not found');
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (input.rank !== undefined) {
    if (!Number.isFinite(input.rank) || input.rank < 1) throw badRequest('Rank starts at 1', { field: 'rank' });
    set('rank', Math.round(input.rank));
  }
  if (input.note !== undefined) set('note', cleanText(input.note));
  if (sets.length === 0) return listPreferred();
  vals.push(id);
  const res = await query(`UPDATE preferred_vendor SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  if ((res.rowCount ?? 0) === 0) throw notFound('Rule not found');
  await logAdminEvent({
    actorId: actor.id,
    entity: 'preferred_vendor',
    entityId: id,
    action: 'preferred_vendor_updated',
    after: { name: 'Preferred vendor rule', rank: input.rank, note: input.note },
  });
  return listPreferred();
}

export async function deletePreferred(id: string, actor: ActingPrincipal): Promise<PreferredVendorRule[]> {
  requireVendorAdmin(actor, 'edit');
  if (!UUID_RE.test(id)) throw notFound('Rule not found');
  const res = await query<{ client: string | null; trade: string | null; state: string | null; city: string | null; name: string }>(
    `DELETE FROM preferred_vendor pv USING vendor v
      WHERE pv.id = $1 AND v.id = pv.vendor_id
      RETURNING pv.client, pv.trade, pv.state, pv.city, v.name`,
    [id],
  );
  if (!res.rows[0]) throw notFound('Rule not found');
  await logAdminEvent({
    actorId: actor.id,
    entity: 'preferred_vendor',
    entityId: id,
    action: 'preferred_vendor_deleted',
    before: { name: ruleName(res.rows[0], res.rows[0].name) },
  });
  return listPreferred();
}

// The lists ───────────────────────────────────────────────────────────────────

export type VendorListName = 'statuses' | 'brand-sources' | 'trades';

const keyOf = (label: string): string =>
  label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

export async function addListValue(
  list: VendorListName,
  input: { label: string; color?: string },
  actor: ActingPrincipal,
): Promise<void> {
  requireVendorAdmin(actor, 'edit');
  const label = input.label.trim();
  if (label === '') throw badRequest('It needs a name', { field: 'label' });
  if (list === 'trades') {
    const res = await query(
      `INSERT INTO vendor_trade (name, position)
       VALUES ($1, (SELECT COALESCE(max(position), 0) + 1 FROM vendor_trade)) ON CONFLICT DO NOTHING`,
      [label],
    );
    if ((res.rowCount ?? 0) === 0) throw conflict('That trade is already on the list');
  } else {
    const key = keyOf(label);
    if (key === '') throw badRequest('It needs a name with letters or digits', { field: 'label' });
    const res =
      list === 'statuses'
        ? await query(
            `INSERT INTO vendor_status (key, label, color, position)
             VALUES ($1, $2, $3, (SELECT COALESCE(max(position), 0) + 1 FROM vendor_status)) ON CONFLICT DO NOTHING`,
            [key, label, input.color ?? 'slate'],
          )
        : await query(
            `INSERT INTO vendor_brand_source (key, label, position)
             VALUES ($1, $2, (SELECT COALESCE(max(position), 0) + 1 FROM vendor_brand_source)) ON CONFLICT DO NOTHING`,
            [key, label],
          );
    if ((res.rowCount ?? 0) === 0) throw conflict('That one is already on the list');
  }
  await logAdminEvent({
    actorId: actor.id,
    entity: 'vendor_setting',
    entityId: list,
    action: 'vendor_list_value_added',
    after: { name: label, list },
  });
}

export async function updateListValue(
  list: VendorListName,
  key: string,
  input: { label?: string; color?: string; is_active?: boolean },
  actor: ActingPrincipal,
): Promise<void> {
  requireVendorAdmin(actor, 'edit');
  if (list === 'trades') {
    if (input.is_active === undefined) return;
    const res = await query(`UPDATE vendor_trade SET is_active = $2 WHERE name = $1`, [key, input.is_active]);
    if ((res.rowCount ?? 0) === 0) throw notFound('Trade not found');
  } else {
    const table = list === 'statuses' ? 'vendor_status' : 'vendor_brand_source';
    const sets: string[] = [];
    const vals: unknown[] = [key];
    if (input.label !== undefined) {
      const label = input.label.trim();
      if (label === '') throw badRequest('It needs a name', { field: 'label' });
      vals.push(label);
      sets.push(`label = $${vals.length}`);
    }
    if (input.color !== undefined && list === 'statuses') {
      vals.push(input.color);
      sets.push(`color = $${vals.length}`);
    }
    if (input.is_active !== undefined) {
      vals.push(input.is_active);
      sets.push(`is_active = $${vals.length}`);
    }
    if (sets.length === 0) return;
    const res = await query(`UPDATE ${table} SET ${sets.join(', ')} WHERE key = $1`, vals);
    if ((res.rowCount ?? 0) === 0) throw notFound('Not found');
  }
  await logAdminEvent({
    actorId: actor.id,
    entity: 'vendor_setting',
    entityId: list,
    action: 'vendor_list_value_updated',
    after: { name: input.label ?? key, list, ...input },
  });
}

/** Where a typed city sits, for the add-technician form's "we can place this" tick. */
export async function canPlace(city: string, state: string, zip: string | null): Promise<boolean> {
  return (await geoLookup({ city, state, zip })) !== null;
}

export { haversineMiles };
