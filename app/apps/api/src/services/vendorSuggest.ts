// 0069 · Suggested vendors for a work order: the top few by its trade, its
// location and its client. This file gathers the facts; the order is decided
// by the pure rankSuggestions() in @theone/shared, under the settings of
// Admin › Vendors & map (vendorSuggestSettings.ts).
//
// WHO a person may be shown is their technician-map grants, exactly as on the
// map (resolveVendorMapScope): VR vendors, all technicians or only theirs,
// subcontractors, and whether statewide / nationwide reach counts for them.
// A hand-picked preferred vendor is listed however far away it is — somebody
// chose it for this client / trade / place — but still only to a person
// allowed to see that kind of vendor.
//
// Nothing here writes: hiring from the list is the map's own Hire
// (POST /work-orders/:id/technicians), with the same warning.
//
// The dispatch cascade (vendorExtras.ts) asks dispatchCandidates(): the
// hand-picked vendors as before and, only when Admin switched `cascade_auto`
// on, the automatic picks after them.

import { VENDOR_MAP_PERM_KEY, complianceWarning, normalizeState, preferredRuleScore, preferredRuleText, rankSuggestions } from '@theone/shared';
import type { DispatchCandidate, MapReach, SuggestCandidate, SuggestedVendorsResponse, TriState, VendorKind, VendorMapScope } from '@theone/shared';
import { query } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { workOrderPlace } from './geo.js';
import { getVendorSettings, mapScope } from './vendorMap.js';
import { listPreferred, loadExpiries } from './vendors.js';
import { getSuggestSettings } from './vendorSuggestSettings.js';

const today = (): string => new Date().toISOString().slice(0, 10);

/** The cascade has no viewer: it may consider every vendor on file. */
const SYSTEM_SCOPE: VendorMapScope = { open: true, hire: false, allTechs: true, vr: true, statewide: true, nationwide: true, subcontractors: true, add: false };

// More than anybody will read, few enough to sort in memory.
const MAX_CANDIDATES = 4000;

type Head = {
  id: string;
  wo_number: string;
  client: string | null;
  trade: string | null;
  state: string | null;
  city: string | null;
  emergency: boolean;
};

async function workOrderHead(taskId: string): Promise<Head> {
  const res = await query<Head>(
    `SELECT id::text AS id, wo_number, client, trade, state, city,
            lower(COALESCE(fields->>'Emergency', '')) IN ('true', 'yes') AS emergency
       FROM task WHERE id = $1`,
    [taskId],
  );
  if (!res.rows[0]) throw notFound('Work order not found');
  return res.rows[0];
}

type Row = {
  id: string;
  kind: VendorKind;
  name: string;
  phone: string | null;
  city: string | null;
  state: string | null;
  primary_trade: string | null;
  secondary_trades: string[] | null;
  miles: number | null;
  statewide: boolean;
  nationwide: boolean;
  coverage_states: string[] | null;
  work_orders_count: number;
  regular_hourly_rate: string | null;
  emergency_same_day: boolean | null;
  coi_received: TriState;
  is_subcontractor: boolean;
  mine: boolean;
  hired: boolean;
};

interface Gathered {
  head: Head;
  placed: boolean;
  candidates: SuggestCandidate[];
}

async function gather(taskId: string, scope: VendorMapScope, actorId: string | null): Promise<Gathered> {
  const [wo, place, mapSettings, settings, rules] = await Promise.all([
    workOrderHead(taskId),
    workOrderPlace(taskId),
    getVendorSettings(),
    getSuggestSettings(),
    listPreferred(),
  ]);
  const state = place.state ?? normalizeState(wo.state);
  const head: Head = { ...wo, state, city: wo.city ?? place.point?.city ?? null };
  const woTrade = (wo.trade ?? '').trim().toLowerCase();

  // Best rule per vendor: the most specific that fits, then the lowest rank.
  const preferred = new Map<string, NonNullable<SuggestCandidate['preferred']>>();
  for (const rule of rules) {
    const score = preferredRuleScore(rule, head);
    if (score === 0) continue;
    const cur = preferred.get(rule.vendor.id);
    if (!cur || score > cur.score || (score === cur.score && rule.rank < cur.rank)) {
      preferred.set(rule.vendor.id, { score, rank: rule.rank, note: rule.note, rule: preferredRuleText(rule) });
    }
  }

  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const task = add(taskId);
  const picked = add([...preferred.keys()]);
  const center = place.point;
  let nearest = '';
  let milesCol = 'NULL::float8';
  if (center) {
    const lat = add(center.lat);
    const lng = add(center.lng);
    const miles = `3958.8 * 2 * asin(least(1, sqrt(
        power(sin(radians(l.lat - ${lat}) / 2), 2)
        + cos(radians(${lat})) * cos(radians(l.lat)) * power(sin(radians(l.lng - ${lng}) / 2), 2))))`;
    nearest = `WITH nearest AS (
       SELECT DISTINCT ON (l.vendor_id) l.vendor_id, ${miles} AS miles
         FROM vendor_location l
        WHERE l.lat IS NOT NULL
        ORDER BY l.vendor_id, ${miles}
     )`;
    milesCol = 'n.miles';
  }
  const where = ['v.deleted_at IS NULL', 'NOT v.blacklisted'];
  // The trade filter narrows the read; the hand-picked are fetched regardless.
  if (settings.match_trade && woTrade !== '') {
    const t = add(woTrade);
    where.push(`(v.id = ANY(${picked}::uuid[]) OR lower(v.primary_trade) = ${t}::text
                 OR EXISTS (SELECT 1 FROM unnest(v.secondary_trades) s WHERE lower(s) = ${t}::text))`);
  }
  const mine = actorId
    ? `EXISTS (SELECT 1 FROM vendor_dispatcher d WHERE d.vendor_id = v.id AND d.principal_id = ${add(actorId)})`
    : 'false';

  const res = await query<Row>(
    `${nearest}
     SELECT v.id::text AS id, v.kind, v.name, v.phone, v.city, v.state, v.primary_trade, v.secondary_trades,
            ${milesCol} AS miles, v.statewide, v.nationwide, v.coverage_states, v.work_orders_count,
            v.regular_hourly_rate, v.emergency_same_day, v.coi_received, v.is_subcontractor,
            ${mine} AS mine,
            EXISTS (SELECT 1 FROM wo_technician w
                     WHERE w.vendor_id = v.id AND w.task_id = ${task} AND w.released_at IS NULL) AS hired
       FROM vendor v
       ${center ? 'LEFT JOIN nearest n ON n.vendor_id = v.id' : ''}
      WHERE ${where.join(' AND ')}
      ORDER BY (v.id = ANY(${picked}::uuid[])) DESC, ${center ? 'n.miles NULLS LAST, ' : ''}lower(v.name)
      LIMIT ${MAX_CANDIDATES}`,
    params,
  );

  // Who this person may be shown at all — the map's own rule.
  const visible = res.rows.filter((r) => {
    if (r.hired) return true;
    if (r.is_subcontractor && !scope.subcontractors) return false;
    return r.kind === 'vendor' ? scope.vr : scope.allTechs || r.mine;
  });

  const ids = visible.map((r) => r.id);
  const [expiries, history] = await Promise.all([
    loadExpiries(visible.filter((r) => r.kind === 'vendor').map((r) => r.id)),
    wo.client && wo.client.trim() !== '' && ids.length > 0
      ? query<{ vendor_id: string; n: number }>(
          `SELECT x.vendor_id::text AS vendor_id, count(DISTINCT x.task_id)::int AS n
             FROM (SELECT w.vendor_id, w.task_id FROM wo_technician w
                   UNION
                   SELECT t.vendor_id, t.id FROM task t WHERE t.vendor_id IS NOT NULL) x
             JOIN task t ON t.id = x.task_id
            WHERE t.deleted_at IS NULL AND t.id <> $1 AND lower(t.client) = lower($2::text)
              AND x.vendor_id = ANY($3::uuid[])
            GROUP BY x.vendor_id`,
          [taskId, wo.client.trim(), ids],
        )
      : Promise.resolve({ rows: [] as { vendor_id: string; n: number }[] }),
  ]);
  const clientJobs = new Map(history.rows.map((r) => [r.vendor_id, r.n]));
  const day = today();

  const candidates: SuggestCandidate[] = visible.map((r) => {
    const miles = r.miles === null ? null : Number(r.miles);
    const local = miles !== null && miles <= mapSettings.map_radius_miles;
    const inState =
      scope.statewide && r.statewide && state !== null && ((r.state ?? '').toUpperCase() === state || (r.coverage_states ?? []).includes(state));
    const reach: MapReach | null = local ? 'local' : inState ? 'statewide' : scope.nationwide && r.nationwide ? 'nationwide' : null;
    const trades = [r.primary_trade, ...(r.secondary_trades ?? [])].map((t) => (t ?? '').trim().toLowerCase());
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      phone: r.phone,
      city: r.city,
      state: r.state,
      primary_trade: r.primary_trade,
      trade_match: woTrade !== '' && trades.includes(woTrade),
      distance_miles: miles === null ? null : Math.round(miles * 10) / 10,
      reach,
      client_jobs: clientJobs.get(r.id) ?? 0,
      work_orders_count: r.work_orders_count,
      regular_hourly_rate: r.regular_hourly_rate === null ? null : Number(r.regular_hourly_rate),
      emergency_same_day: r.emergency_same_day,
      compliance_warning: complianceWarning(r, expiries.get(r.id) ?? [], day),
      blacklisted: false,
      hired: r.hired,
      preferred: preferred.get(r.id) ?? null,
    };
  });
  return { head, placed: center !== null, candidates };
}

export async function suggestedVendors(taskId: string, actor: ActingPrincipal): Promise<SuggestedVendorsResponse> {
  const scope = mapScope(actor);
  if (!scope.open) throw forbidden('You cannot see vendor suggestions', { required_permission: `${VENDOR_MAP_PERM_KEY}:view` });
  const [settings, g] = await Promise.all([getSuggestSettings(), gather(taskId, scope, actor.id)]);
  return {
    work_order: g.head,
    vendors: rankSuggestions(g.candidates, settings, { emergency: g.head.emergency, has_trade: (g.head.trade ?? '').trim() !== '' }),
    placed: g.placed,
    auto_fill: settings.auto_fill,
    can: { hire: scope.hire },
  };
}

/**
 * Who a dispatch run offers the job to, in order, each vendor once: the
 * preferred vendors for the work order's client, trade and place, the most
 * specific rule first — and after them the automatic picks, only when Admin
 * allowed that (`cascade_auto`, with the automatic fill itself on).
 */
export async function dispatchCandidates(taskId: string, offered: Set<string>): Promise<DispatchCandidate[]> {
  const [wo, place, settings, rules] = await Promise.all([workOrderHead(taskId), workOrderPlace(taskId), getSuggestSettings(), listPreferred()]);
  const head = { ...wo, state: place.state ?? normalizeState(wo.state), city: wo.city ?? place.point?.city ?? null };
  const fits = rules
    .map((rule) => ({ rule, score: preferredRuleScore(rule, head) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.rule.rank - b.rule.rank || a.rule.vendor.name.localeCompare(b.rule.vendor.name));
  const seen = new Set<string>();
  const out: DispatchCandidate[] = [];
  for (const { rule } of fits) {
    if (seen.has(rule.vendor.id)) continue;
    seen.add(rule.vendor.id);
    out.push({
      vendor_id: rule.vendor.id,
      name: rule.vendor.name,
      rank: out.length + 1,
      rule: preferredRuleText(rule),
      blacklisted: rule.vendor.blacklisted,
      offered: offered.has(rule.vendor.id),
    });
  }
  if (!settings.cascade_auto || !settings.auto_fill) return out;

  const g = await gather(taskId, SYSTEM_SCOPE, null);
  const ranked = rankSuggestions(g.candidates, settings, { emergency: g.head.emergency, has_trade: (g.head.trade ?? '').trim() !== '' }, Number.POSITIVE_INFINITY);
  // As many automatic picks as the list is long — a run does not walk the whole file.
  let room = settings.size;
  for (const v of ranked) {
    if (room <= 0) break;
    if (v.source !== 'auto' || seen.has(v.id)) continue;
    seen.add(v.id);
    room -= 1;
    out.push({
      vendor_id: v.id,
      name: v.name,
      rank: out.length + 1,
      rule: 'Suggested by trade and location',
      blacklisted: false,
      offered: offered.has(v.id),
    });
  }
  return out;
}
