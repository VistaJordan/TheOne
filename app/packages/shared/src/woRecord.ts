// 0064 · The work-order record: the right rail (who answers for it, where it
// is, how long it has taken, what it costs), the things a person can do to
// it (assign a vendor, pause, give an ETA, cancel, complete the service, ask
// for more NTE), and the four tabs that read it (checklist, cost breakdown,
// timelog, related). Also the leftovers that ride the same migration: form
// layouts, the geofence check on a visit, site events, the space viewer.
//
// The pure rules live here so the API and the browser agree: which layout a
// form uses, what a distance means against a boundary, when an event is
// running, how minutes read.

import type { FeedActor } from './index';
import type { WoCreateField, WoCreateForm, WoCreateMode } from './woCreate';
import type { SiteLocation } from './portfolio';

// ── State on the work order ──────────────────────────────────────────────────

export interface WoStamp {
  at: string;
  by: FeedActor | null;
}

export interface WoRecordState {
  paused: (WoStamp & { reason: string | null }) | null;
  cancelled: (WoStamp & { reason: string | null }) | null;
  eta: (WoStamp & { eta_at: string; note: string | null }) | null;
  completion: (WoStamp & {
    note: string | null;
    fault_code: string | null;
    action_code: string | null;
    temporary_fix: boolean | null;
  }) | null;
}

export interface WoResponsibility {
  /** The one vendor answering for the job. */
  vendor: {
    id: string;
    name: string;
    phone: string | null;
    primary_trade: string | null;
    blacklisted: boolean;
    compliance_status: string;
  } | null;
  assignee: string | null;
  am: string | null;
  /** Everyone hired onto the work order and not released (0057). */
  technicians: { id: string; name: string; phone: string | null }[];
}

export interface WoTimeDetails {
  created_at: string;
  date_received: string | null;
  due_date: string | null;
  sla_due: string | null;
  scheduled: string | null;
  first_check_in: string | null;
  last_check_out: string | null;
  /** A technician is on site right now (a visit checked in, not out). */
  on_site_since: string | null;
  /** Minutes on site across every finished visit. */
  on_site_minutes: number;
  visits: number;
  /** When it entered the status it is in now. */
  status_since: string | null;
  /** Minutes it has stood paused, finished pauses only. */
  paused_minutes: number;
}

export interface WoCostSummary {
  nte: number | null;
  /** The work order's own Cost field: the final vendor cost. */
  cost: number | null;
  quote_total: number | null;
  quote_status: string | null;
  /** Sent or paid invoices. */
  invoiced: number | null;
  /** Payment requests that are not rejected. */
  payables_requested: number | null;
  payables_paid: number | null;
  vendor_bills: number | null;
  /** What the client pays minus what the job costs, best figures available. */
  profit: number | null;
  margin_pct: number | null;
  over_nte: boolean;
}

// ── Checklist, tags, NTE requests ────────────────────────────────────────────

export interface WoChecklistItem {
  id: string;
  title: string;
  done: boolean;
  done_by: FeedActor | null;
  done_at: string | null;
  note: string | null;
  position: number;
}

export interface WoTag {
  id: string;
  tag: string;
  reason: string | null;
  created_by: FeedActor | null;
  created_at: string;
}

export type NteRequestStatus = 'open' | 'approved' | 'rejected' | 'withdrawn';

export interface WoNteRequest {
  id: string;
  current_nte: number | null;
  requested_nte: number;
  reason: string;
  status: NteRequestStatus;
  requested_by: FeedActor | null;
  decided_by: FeedActor | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  can: { decide: boolean; withdraw: boolean };
}

// ── Timelog ──────────────────────────────────────────────────────────────────

export interface WoStatusSpan {
  status: string;
  from: string;
  /** Null = it is still there. */
  to: string | null;
  minutes: number;
  by: FeedActor | null;
}

export interface WoVisitSpan {
  id: string;
  seq: number;
  visit_type: string;
  tech_name: string | null;
  checked_in_at: string | null;
  checked_out_at: string | null;
  minutes: number | null;
  geofence_result: GeofenceResult | null;
  geofence_ft: number | null;
}

export interface WoPauseSpan {
  id: string;
  paused_at: string;
  resumed_at: string | null;
  minutes: number;
  reason: string | null;
  paused_by: FeedActor | null;
}

export interface WoTimelog {
  statuses: WoStatusSpan[];
  visits: WoVisitSpan[];
  pauses: WoPauseSpan[];
  /** Minutes from received (or created) to the first check-in. */
  response_minutes: number | null;
  /** Minutes from received (or created) to service completed / now. */
  open_minutes: number;
}

// ── Cost breakdown ───────────────────────────────────────────────────────────

export interface WoCostLine {
  label: string;
  detail: string | null;
  amount: number;
  status?: string | null;
  link?: string | null;
}

export interface WoCostBreakdown {
  /** What the client is asked for: the quote, cut by line type. */
  quote: { status: string; by_type: { type: string; count: number; amount: number }[]; tax: number; total: number } | null;
  invoices: WoCostLine[];
  /** What the job costs us. */
  payables: WoCostLine[];
  vendor_bills: WoCostLine[];
  revenue: number | null;
  cost: number | null;
  /** Where each of the two figures above came from, in words. */
  revenue_basis: string;
  cost_basis: string;
}

// ── Related ──────────────────────────────────────────────────────────────────

export interface WoRelatedWorkOrder {
  wo_number: string;
  title: string;
  status: string;
  status_group: string;
  trade: string | null;
  date_received: string | null;
}

export interface WoRelated {
  same_asset: WoRelatedWorkOrder[];
  same_site: WoRelatedWorkOrder[];
  /** Approval tasks and NTE requests raised on this work order. */
  approvals: { kind: string; title: string; status: string; created_at: string }[];
  records: { kind: string; label: string; status: string | null; link: string | null }[];
}

// ── Codes ────────────────────────────────────────────────────────────────────

export type WoCodeKind = 'fault' | 'action';

export interface WoCode {
  id: string;
  kind: WoCodeKind;
  code: string;
  label: string;
  position: number;
  is_active: boolean;
}

// ── The whole record ─────────────────────────────────────────────────────────

/** GET /work-orders/:id/record. */
export interface WoRecord {
  state: WoRecordState;
  responsibility: WoResponsibility;
  time: WoTimeDetails;
  cost: WoCostSummary;
  checklist: WoChecklistItem[];
  tags: WoTag[];
  /** Tags already in use on other work orders, most used first. */
  tag_suggestions: string[];
  nte_requests: WoNteRequest[];
  timelog: WoTimelog;
  breakdown: WoCostBreakdown;
  related: WoRelated;
  /** Events running at the work order's site today. */
  site_events: SiteEvent[];
  codes: { fault: WoCode[]; action: WoCode[] };
  can: {
    edit: boolean;
    /** May approve or reject an NTE increase. */
    decide_nte: boolean;
    see_money: boolean;
    see_vendors: boolean;
  };
}

export interface WoCompleteInput {
  note?: string | null;
  fault_code?: string | null;
  action_code?: string | null;
  temporary_fix?: boolean | null;
}

/** "3d 4h", "2h 15m", "40m", "under a minute". */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'under a minute';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
  return `${mm}m`;
}

export function minutesBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 60_000));
}

// ── Form layouts ─────────────────────────────────────────────────────────────

export interface WoFormLayout {
  id: string;
  name: string;
  client: string | null;
  trade: string | null;
  /** Per field key: off / optional / required, over the form's own setting. */
  fields: Record<string, WoCreateMode>;
  is_active: boolean;
}

export interface WoFormLayoutInput {
  name: string;
  client?: string | null;
  trade?: string | null;
  fields: Record<string, WoCreateMode>;
  is_active?: boolean;
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/** The layout a form uses for this client and trade: the most specific active
 *  one — client and trade, then client alone, then trade alone. A layout that
 *  names neither applies to nothing. Null = the form as configured. */
export function pickFormLayout(layouts: WoFormLayout[], client: string | null | undefined, trade: string | null | undefined): WoFormLayout | null {
  const live = layouts.filter((l) => l.is_active && (l.client || l.trade));
  const score = (l: WoFormLayout): number => {
    const c = l.client ? (same(l.client, client) ? 2 : -1) : 0;
    const t = l.trade ? (same(l.trade, trade) ? 1 : -1) : 0;
    return c < 0 || t < 0 ? -1 : c + t;
  };
  let best: WoFormLayout | null = null;
  let bestScore = 0;
  for (const l of live) {
    const s = score(l);
    if (s > bestScore) {
      best = l;
      bestScore = s;
    }
  }
  return best;
}

/** The form with a layout laid over it: a field the layout turns off is gone,
 *  one it names changes mode, the rest stay as configured. The fields that
 *  DECIDE the layout (Client, Trade) can never be turned off by it. */
export function applyFormLayout(form: WoCreateForm, layout: WoFormLayout | null): WoCreateForm {
  if (!layout) return form;
  const fields: WoCreateField[] = [];
  for (const f of form.fields) {
    const mode = layout.fields[f.key];
    if (mode === 'off' && f.key !== 'Client' && f.key !== 'Trade') continue;
    fields.push(mode === 'optional' || mode === 'required' ? { ...f, mode } : f);
  }
  return { ...form, fields };
}

// ── The geofence ─────────────────────────────────────────────────────────────

export type GeofenceResult = 'inside' | 'outside' | 'no_site' | 'no_boundary';

export const GEOFENCE_RESULT_LABELS: Record<GeofenceResult, string> = {
  inside: 'Inside the site boundary',
  outside: 'Outside the site boundary',
  no_site: 'The work order has no placed site',
  no_boundary: 'The site has no boundary set',
};

const EARTH_FEET = 20_902_231;

/** Great-circle distance in feet. */
export function distanceFeet(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_FEET * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Where a check-in stands against a site. The boundary is inclusive. */
export function geofenceCheck(
  at: { lat: number; lng: number },
  site: { lat: number | null; lng: number | null; boundary_radius_ft: number | null } | null,
): { result: GeofenceResult; feet: number | null; limit: number | null } {
  if (!site || site.lat === null || site.lng === null) return { result: 'no_site', feet: null, limit: null };
  const feet = distanceFeet(at, { lat: site.lat, lng: site.lng });
  if (site.boundary_radius_ft === null) return { result: 'no_boundary', feet, limit: null };
  return { result: feet <= site.boundary_radius_ft ? 'inside' : 'outside', feet, limit: site.boundary_radius_ft };
}

/** "320 ft", "0.4 mi". */
export function formatFeet(feet: number | null | undefined): string {
  if (feet === null || feet === undefined) return '—';
  return feet < 1000 ? `${feet.toLocaleString('en-US')} ft` : `${(feet / 5280).toFixed(1)} mi`;
}

// ── Site events ──────────────────────────────────────────────────────────────

export const SITE_EVENT_KINDS = ['closure', 'restricted_access', 'remodel', 'incident', 'inspection', 'weather', 'notice'] as const;
export type SiteEventKind = (typeof SITE_EVENT_KINDS)[number];

export const SITE_EVENT_KIND_LABELS: Record<SiteEventKind, string> = {
  closure: 'Closure',
  restricted_access: 'Restricted access',
  remodel: 'Remodel',
  incident: 'Incident',
  inspection: 'Inspection',
  weather: 'Weather',
  notice: 'Notice',
};

export type SiteEventPhase = 'upcoming' | 'running' | 'ended';

export interface SiteEvent {
  id: string;
  site: { id: string; name: string; client: string | null; city: string | null; state: string | null };
  kind: SiteEventKind;
  title: string;
  detail: string | null;
  starts_on: string;
  ends_on: string | null;
  phase: SiteEventPhase;
  created_by: FeedActor | null;
  created_at: string;
}

export interface SiteEventInput {
  kind?: SiteEventKind;
  title?: string;
  detail?: string | null;
  starts_on?: string;
  ends_on?: string | null;
}

/** Where an event stands on `today` (all YYYY-MM-DD). Both ends are inclusive;
 *  no end date means it runs until somebody ends it. */
export function siteEventPhase(startsOn: string, endsOn: string | null, today: string): SiteEventPhase {
  if (today < startsOn) return 'upcoming';
  if (endsOn !== null && today > endsOn) return 'ended';
  return 'running';
}

// ── The space viewer ─────────────────────────────────────────────────────────

/** One place at a site with what stands in it and what is open against it. */
export interface SpaceView extends SiteLocation {
  asset_list: { id: string; name: string; asset_type: string | null; status: string; condition: string | null; open_work_orders: number }[];
  open_work_orders: { wo_number: string; title: string; status: string; asset: string | null }[];
}

export interface SpaceViewerResponse {
  site: { id: string; name: string };
  spaces: SpaceView[];
  /** Assets at the site that have not been placed anywhere. */
  unplaced: SpaceView['asset_list'];
}
