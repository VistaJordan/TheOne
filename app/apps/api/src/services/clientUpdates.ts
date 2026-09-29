// Client Updates (0055) — per-client trackers over the work orders, shared
// with the client by a read-only link or by email from contact@seamlessfm.com.
//
// A tracker stores the QUESTION (client, filter, columns, charts), never the
// answer: every read and every send runs the work-order list again, so what
// the client sees is what the work orders say at that moment. The pure parts
// (how filters combine, when a schedule fires, how a value reads) live in
// packages/shared/src/clientUpdates.ts; the email body in lib/clientUpdateEmail.
//
// Two audiences, two row scopes:
//   our team on the page   — the list, tiles and charts respect the viewer's
//                             "Which work orders" scope (rule 8.5), like every
//                             other list.
//   the client             — the link, the email and the client CSV carry the
//                             WHOLE tracker (it is the client's book, not one
//                             dispatcher's), and only the columns ticked
//                             "shared". Only people with client_updates/share
//                             can send or open that door.

import { randomBytes } from 'node:crypto';
import {
  AGE_BANDS,
  CLIENT_UPDATES_PERM_KEY,
  CLIENT_UPDATES_SHARE_PERM_KEY,
  CLIENT_UPDATE_CHART_KINDS,
  DEFAULT_CLIENT_UPDATE_CHARTS,
  DEFAULT_CLIENT_UPDATE_COLUMNS,
  DEFAULT_NOTE_FIELD,
  MAX_RECIPIENTS,
  MAX_TRACKER_CHARTS,
  MAX_TRACKER_COLUMNS,
  SCHEDULE_FREQUENCIES,
  SHARE_ROW_CAP,
  SUMMARY_TILES,
  defaultSubject,
  describeSchedule,
  formatClientValue,
  isEmail,
  isShareTokenShape,
  isValidScheduleTime,
  nextRunAt,
  permAllows,
  sharePath,
  shareLinkLive,
  sharedColumns,
  trackerFilters,
  type ClientUpdate,
  type ClientUpdateChart,
  type ClientUpdateChartResult,
  type ClientUpdateColumn,
  type ClientUpdateDelivery,
  type ClientUpdateEmailSettings,
  type ClientUpdateInput,
  type ClientUpdateInsights,
  type ClientUpdatePublicView,
  type ClientUpdateRecipient,
  type ClientUpdateSchedule,
  type ClientUpdateSummary,
  type ClientUpdatesResponse,
  type DeliveryTrigger,
  type WoFilterSet,
  type WoSort,
  type WorkOrderListItem,
} from '@theone/shared';
import { query } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { config } from '../config.js';
import { buildClientUpdateEmail, sectionRows } from '../lib/clientUpdateEmail.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent, snapshotsDiffer } from './adminAudit.js';
import { MailNotConfiguredError, mailStatus, sendEmail } from './mailer.js';
import { requirePerm } from './permissions.js';
import { serviceActorId } from './serviceActors.js';
import { toCsv } from './woBulk.js';
import { Params, compileFilters, resolveField, type FilterSet } from './woFields.js';
import { metricBreakdown } from './woMetrics.js';
import { woScopeSql } from './woScope.js';
import { listWorkOrders } from './workOrders.js';

// ── Gates ────────────────────────────────────────────────────────────────────

export function requireClientUpdatesView(p: ActingPrincipal): void {
  requirePerm(p, CLIENT_UPDATES_PERM_KEY, 'view', 'You cannot see client updates');
}
function requireClientUpdatesEdit(p: ActingPrincipal, action: 'create' | 'edit' | 'delete'): void {
  requireClientUpdatesView(p);
  requirePerm(p, CLIENT_UPDATES_PERM_KEY, action, 'You cannot change client updates');
}
export function requireClientUpdatesShare(p: ActingPrincipal): void {
  requireClientUpdatesView(p);
  requirePerm(p, CLIENT_UPDATES_SHARE_PERM_KEY, 'edit', 'You cannot share client updates with clients');
}
function canShare(p: ActingPrincipal): boolean {
  return p.isSuperAdmin || permAllows(p.perms, CLIENT_UPDATES_SHARE_PERM_KEY, 'edit');
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  name: string;
  client: string | null;
  description: string | null;
  filters: WoFilterSet | null;
  columns: ClientUpdateColumn[] | null;
  sort: WoSort | null;
  group_by: string | null;
  charts: ClientUpdateChart[] | null;
  note_field: string | null;
  share_enabled: boolean;
  share_token: string | null;
  share_expires_at: string | null;
  share_charts: boolean;
  share_summary: boolean;
  share_origin: string | null;
  email: Partial<ClientUpdateEmailSettings> | null;
  schedule: ClientUpdateSchedule | null;
  next_run_at: string | null;
  last_sent_at: string | null;
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const SELECT = `
  SELECT c.id::text AS id, c.name, c.client, c.description, c.filters, c.columns, c.sort,
         c.group_by, c.charts, c.note_field,
         c.share_enabled, c.share_token, ${ISO('c.share_expires_at')} AS share_expires_at,
         c.share_charts, c.share_summary, c.share_origin,
         c.email, c.schedule,
         ${ISO('c.next_run_at')} AS next_run_at, ${ISO('c.last_sent_at')} AS last_sent_at,
         c.created_by::text AS created_by_id, p.display_name AS created_by_name,
         ${ISO('c.created_at')} AS created_at, ${ISO('c.updated_at')} AS updated_at
    FROM client_update c
    LEFT JOIN principal p ON p.id = c.created_by`;

const EMPTY_FILTERS: WoFilterSet = { match: 'all', rules: [] };

function emailOf(e: Partial<ClientUpdateEmailSettings> | null): ClientUpdateEmailSettings {
  return {
    subject: e?.subject ?? null,
    intro: e?.intro ?? null,
    to: Array.isArray(e?.to) ? e!.to : [],
    cc: Array.isArray(e?.cc) ? e!.cc : [],
    attach_csv: e?.attach_csv ?? true,
    include_link: e?.include_link ?? true,
  };
}

/** `revealToken` = the viewer may share; others never see the token. */
function mapRow(r: Row, revealToken: boolean): ClientUpdate {
  return {
    id: r.id,
    name: r.name,
    client: r.client,
    description: r.description,
    filters: r.filters ?? EMPTY_FILTERS,
    columns: r.columns ?? [],
    sort: r.sort ?? null,
    group_by: r.group_by,
    charts: r.charts ?? [],
    note_field: r.note_field,
    share: {
      enabled: r.share_enabled,
      token: revealToken ? r.share_token : null,
      expires_at: r.share_expires_at,
      charts: r.share_charts,
      summary: r.share_summary,
    },
    email: emailOf(r.email),
    schedule: r.schedule,
    next_run_at: r.next_run_at,
    last_sent_at: r.last_sent_at,
    created_by: r.created_by_id ? { id: r.created_by_id, display_name: r.created_by_name ?? '—' } : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function rowById(id: string): Promise<Row | null> {
  const res = await query<Row>(`${SELECT} WHERE c.id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function listClientUpdates(actor: ActingPrincipal): Promise<ClientUpdatesResponse> {
  requireClientUpdatesView(actor);
  const res = await query<Row>(`${SELECT} ORDER BY c.client NULLS LAST, c.name`);
  const reveal = canShare(actor);
  return { items: res.rows.map((r) => mapRow(r, reveal)), mail: mailStatus() };
}

export async function getClientUpdate(id: string, actor: ActingPrincipal): Promise<ClientUpdate> {
  requireClientUpdatesView(actor);
  const r = await rowById(id);
  if (!r) throw notFound('No such client update');
  return mapRow(r, canShare(actor));
}

// ── Writing ──────────────────────────────────────────────────────────────────

interface Clean {
  name: string;
  client: string | null;
  description: string | null;
  filters: WoFilterSet;
  columns: ClientUpdateColumn[];
  sort: WoSort | null;
  group_by: string | null;
  charts: ClientUpdateChart[];
  note_field: string | null;
  share_charts: boolean;
  share_summary: boolean;
  share_expires_at: string | null;
  email: ClientUpdateEmailSettings;
  schedule: ClientUpdateSchedule | null;
}

function cleanRecipients(list: ClientUpdateRecipient[] | undefined, what: string): ClientUpdateRecipient[] {
  const out: ClientUpdateRecipient[] = [];
  const seen = new Set<string>();
  for (const r of list ?? []) {
    const email = String(r?.email ?? '').trim();
    if (!isEmail(email)) throw badRequest(`"${email}" is not an email address (${what})`);
    const k = email.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ email, name: r.name?.trim() || null });
  }
  if (out.length > MAX_RECIPIENTS) throw badRequest(`At most ${MAX_RECIPIENTS} recipients (${what})`);
  return out;
}

function cleanSchedule(s: ClientUpdateSchedule | null | undefined): ClientUpdateSchedule | null {
  if (!s) return null;
  if (!(SCHEDULE_FREQUENCIES as readonly string[]).includes(s.frequency)) throw badRequest('Unknown schedule frequency');
  if (!isValidScheduleTime(s.time)) throw badRequest('A schedule time is HH:MM (24-hour)');
  const weekdays = [...new Set((s.weekdays ?? []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (s.frequency === 'weekly' && weekdays.length === 0) throw badRequest('Pick at least one day of the week');
  const dom = Math.round(Number(s.day_of_month ?? 1));
  if (!(dom >= 1 && dom <= 28)) throw badRequest('The day of the month is 1 to 28');
  return { enabled: Boolean(s.enabled), frequency: s.frequency, weekdays, day_of_month: dom, time: s.time };
}

async function clean(input: ClientUpdateInput, prev: ClientUpdate | null): Promise<Clean> {
  const name = String(input.name ?? prev?.name ?? '').trim();
  if (!name) throw badRequest('A client update needs a name');
  if (name.length > 200) throw badRequest('That name is too long');

  const filters = input.filters ?? prev?.filters ?? EMPTY_FILTERS;
  // Compiling is the validation: an unknown field or a bad value throws here.
  await compileFilters(filters as FilterSet, new Params());

  const columns = input.columns ?? prev?.columns ?? DEFAULT_CLIENT_UPDATE_COLUMNS;
  if (columns.length === 0) throw badRequest('Pick at least one column');
  if (columns.length > MAX_TRACKER_COLUMNS) throw badRequest(`At most ${MAX_TRACKER_COLUMNS} columns`);
  const seenCols = new Set<string>();
  const cleanCols: ClientUpdateColumn[] = [];
  for (const c of columns) {
    if (seenCols.has(c.key)) continue;
    seenCols.add(c.key);
    await resolveField(c.key);
    cleanCols.push({ key: c.key, label: c.label?.trim() ? c.label.trim().slice(0, 80) : null, shared: Boolean(c.shared) });
  }

  const charts = input.charts ?? prev?.charts ?? DEFAULT_CLIENT_UPDATE_CHARTS;
  if (charts.length > MAX_TRACKER_CHARTS) throw badRequest(`At most ${MAX_TRACKER_CHARTS} charts`);
  const cleanCharts: ClientUpdateChart[] = [];
  for (const ch of charts) {
    await resolveField(ch.field);
    const kind = (CLIENT_UPDATE_CHART_KINDS as readonly string[]).includes(ch.kind) ? ch.kind : 'bar';
    cleanCharts.push({ field: ch.field, kind, shared: Boolean(ch.shared) });
  }

  const sort = input.sort !== undefined ? input.sort : prev?.sort ?? null;
  if (sort) await resolveField(sort.field);
  const group_by = input.group_by !== undefined ? input.group_by || null : prev ? prev.group_by : 'status';
  if (group_by) await resolveField(group_by);

  const note_field = input.note_field !== undefined ? input.note_field || null : prev ? prev.note_field : DEFAULT_NOTE_FIELD;
  if (note_field) {
    if (!note_field.startsWith('fields.')) throw badRequest('The client-note field must be a work-order text field');
    const f = await resolveField(note_field);
    if (f.type !== 'text') throw badRequest(`"${f.label}" is not a text field`);
  }

  const prevEmail = prev?.email ?? emailOf(null);
  const e = input.email ?? {};
  const email: ClientUpdateEmailSettings = {
    subject: e.subject !== undefined ? e.subject?.trim().slice(0, 300) || null : prevEmail.subject,
    intro: e.intro !== undefined ? e.intro?.trim().slice(0, 4000) || null : prevEmail.intro,
    to: e.to !== undefined ? cleanRecipients(e.to, 'to') : prevEmail.to,
    cc: e.cc !== undefined ? cleanRecipients(e.cc, 'cc') : prevEmail.cc,
    attach_csv: e.attach_csv ?? prevEmail.attach_csv,
    include_link: e.include_link ?? prevEmail.include_link,
  };

  const schedule = input.schedule !== undefined ? cleanSchedule(input.schedule) : prev?.schedule ?? null;
  const expires = input.share?.expires_at !== undefined ? input.share.expires_at : prev?.share.expires_at ?? null;
  if (expires && Number.isNaN(new Date(expires).getTime())) throw badRequest('The link expiry is not a date');

  return {
    name,
    client: input.client !== undefined ? input.client?.trim() || null : prev?.client ?? null,
    description: input.description !== undefined ? input.description?.trim().slice(0, 2000) || null : prev?.description ?? null,
    filters,
    columns: cleanCols,
    sort,
    group_by,
    charts: cleanCharts,
    note_field,
    share_charts: input.share?.charts ?? prev?.share.charts ?? true,
    share_summary: input.share?.summary ?? prev?.share.summary ?? true,
    share_expires_at: expires,
    email,
    schedule,
  };
}

function snapshot(t: ClientUpdate): { name: string } & Record<string, unknown> {
  // The token is a secret: the trail says the link is on, never what it is.
  const { share, ...rest } = t;
  return {
    ...rest,
    name: t.client ? `${t.client} · ${t.name}` : t.name,
    share: { ...share, token: share.token ? '(set)' : null },
    schedule_text: describeSchedule(t.schedule),
  };
}

/** Did anything change that reaches the client (who, when, how)? */
function sharingChanged(a: Clean, prev: ClientUpdate): boolean {
  return (
    JSON.stringify(a.email) !== JSON.stringify(prev.email) ||
    JSON.stringify(a.schedule) !== JSON.stringify(prev.schedule) ||
    a.share_expires_at !== prev.share.expires_at ||
    a.share_charts !== prev.share.charts ||
    a.share_summary !== prev.share.summary
  );
}

export async function createClientUpdate(input: ClientUpdateInput, actor: ActingPrincipal): Promise<ClientUpdate> {
  requireClientUpdatesEdit(actor, 'create');
  const c = await clean(input, null);
  if (c.schedule?.enabled || c.email.to.length || c.email.cc.length) requireClientUpdatesShare(actor);
  const next = nextRunAt(c.schedule, new Date());
  const res = await query<{ id: string }>(
    `INSERT INTO client_update
       (name, client, description, filters, columns, sort, group_by, charts, note_field,
        share_charts, share_summary, share_expires_at, email, schedule, next_run_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9,
             $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16)
     RETURNING id::text AS id`,
    [
      c.name, c.client, c.description, JSON.stringify(c.filters), JSON.stringify(c.columns),
      c.sort ? JSON.stringify(c.sort) : null, c.group_by, JSON.stringify(c.charts), c.note_field,
      c.share_charts, c.share_summary, c.share_expires_at, JSON.stringify(c.email),
      c.schedule ? JSON.stringify(c.schedule) : null, next ? next.toISOString() : null, actor.id,
    ],
  );
  const created = mapRow((await rowById(res.rows[0].id))!, canShare(actor));
  await logAdminEvent({
    actorId: actor.id,
    entity: 'client_update',
    entityId: created.id,
    action: 'client_update_created',
    after: snapshot(created),
  });
  return created;
}

export async function updateClientUpdate(id: string, input: ClientUpdateInput, actor: ActingPrincipal): Promise<ClientUpdate> {
  requireClientUpdatesEdit(actor, 'edit');
  const r = await rowById(id);
  if (!r) throw notFound('No such client update');
  const before = mapRow(r, true);
  const c = await clean(input, before);
  if (sharingChanged(c, before)) requireClientUpdatesShare(actor);
  const scheduleChanged = JSON.stringify(c.schedule) !== JSON.stringify(before.schedule);
  const next = scheduleChanged ? nextRunAt(c.schedule, new Date()) : null;
  await query(
    `UPDATE client_update
        SET name = $2, client = $3, description = $4, filters = $5::jsonb, columns = $6::jsonb,
            sort = $7::jsonb, group_by = $8, charts = $9::jsonb, note_field = $10,
            share_charts = $11, share_summary = $12, share_expires_at = $13,
            email = $14::jsonb, schedule = $15::jsonb,
            next_run_at = CASE WHEN $16 THEN $17::timestamptz ELSE next_run_at END
      WHERE id = $1`,
    [
      id, c.name, c.client, c.description, JSON.stringify(c.filters), JSON.stringify(c.columns),
      c.sort ? JSON.stringify(c.sort) : null, c.group_by, JSON.stringify(c.charts), c.note_field,
      c.share_charts, c.share_summary, c.share_expires_at, JSON.stringify(c.email),
      c.schedule ? JSON.stringify(c.schedule) : null, scheduleChanged, next ? next.toISOString() : null,
    ],
  );
  const after = mapRow((await rowById(id))!, true);
  const b = snapshot(before);
  const a = snapshot(after);
  delete (b as Record<string, unknown>).updated_at;
  delete (a as Record<string, unknown>).updated_at;
  if (snapshotsDiffer(b, a)) {
    await logAdminEvent({ actorId: actor.id, entity: 'client_update', entityId: id, action: 'client_update_updated', before: b, after: a });
  }
  return mapRow((await rowById(id))!, canShare(actor));
}

export async function deleteClientUpdate(id: string, actor: ActingPrincipal): Promise<void> {
  requireClientUpdatesEdit(actor, 'delete');
  const r = await rowById(id);
  if (!r) throw notFound('No such client update');
  const before = mapRow(r, true);
  await query(`DELETE FROM client_update WHERE id = $1`, [id]);
  await logAdminEvent({ actorId: actor.id, entity: 'client_update', entityId: id, action: 'client_update_deleted', before: snapshot(before), after: null });
}

// ── The read-only link ───────────────────────────────────────────────────────

function newToken(): string {
  return randomBytes(24).toString('base64url'); // 32 url-safe characters
}

export interface ShareLinkInput {
  enabled: boolean;
  /** Issue a new token; the old link stops working at once. */
  regenerate?: boolean;
  expires_at?: string | null;
  /** The site the person is on (window.location.origin), for scheduled emails. */
  origin?: string | null;
}

export async function setShareLink(id: string, input: ShareLinkInput, actor: ActingPrincipal): Promise<ClientUpdate> {
  requireClientUpdatesShare(actor);
  const r = await rowById(id);
  if (!r) throw notFound('No such client update');
  const token = input.enabled && (!r.share_token || input.regenerate) ? newToken() : r.share_token;
  const origin = cleanOrigin(input.origin) ?? r.share_origin;
  const expires = input.expires_at !== undefined ? input.expires_at : r.share_expires_at;
  if (expires && Number.isNaN(new Date(expires).getTime())) throw badRequest('The link expiry is not a date');
  await query(
    `UPDATE client_update SET share_enabled = $2, share_token = $3, share_expires_at = $4, share_origin = $5 WHERE id = $1`,
    [id, input.enabled, token, expires, origin],
  );
  const action = !input.enabled
    ? 'client_update_link_disabled'
    : input.regenerate && r.share_token
      ? 'client_update_link_regenerated'
      : r.share_enabled
        ? 'client_update_link_updated'
        : 'client_update_link_enabled';
  const after = mapRow((await rowById(id))!, true);
  await logAdminEvent({
    actorId: actor.id,
    entity: 'client_update',
    entityId: id,
    action,
    before: snapshot(mapRow(r, true)),
    after: snapshot(after),
  });
  return after;
}

function cleanOrigin(o: string | null | undefined): string | null {
  if (!o) return null;
  try {
    const u = new URL(o);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function linkFor(r: Row): string | null {
  if (!shareLinkLive({ enabled: r.share_enabled, token: r.share_token, expires_at: r.share_expires_at }, new Date())) {
    return null;
  }
  const origin = r.share_origin ?? config.webOrigin;
  return `${origin}${sharePath(r.share_token!)}`;
}

/** The tracker behind a public token, or a 404 that says nothing about why. */
async function rowByToken(token: string): Promise<Row> {
  const gone = notFound('This link is not available. Ask Seamless FM for a new one.');
  if (!isShareTokenShape(token)) throw gone;
  const res = await query<Row>(`${SELECT} WHERE c.share_token = $1`, [token]);
  const r = res.rows[0];
  if (!r) throw gone;
  if (!shareLinkLive({ enabled: r.share_enabled, token: r.share_token, expires_at: r.share_expires_at }, new Date())) throw gone;
  return r;
}

// ── Tiles and charts ─────────────────────────────────────────────────────────

const WO_FROM = `
  FROM task t
  JOIN status s ON s.id = t.status_id
  LEFT JOIN container hl ON hl.id = t.home_list_id`;

/** Counts behind the headline tiles over a filter set (and a viewer's scope). */
export async function summarize(filters: WoFilterSet, viewer?: ActingPrincipal): Promise<ClientUpdateSummary> {
  const p = new Params();
  const where = ['t.deleted_at IS NULL'];
  const scope = viewer ? woScopeSql(viewer, p) : null;
  if (scope) where.push(scope);
  const base = await compileFilters(filters as FilterSet, p);
  if (base) where.push(base);
  const cols: string[] = ['COUNT(*)::float8 AS total'];
  for (const tile of SUMMARY_TILES) {
    const cond = (await compileFilters({ match: 'all', rules: tile.rules } as FilterSet, p)) ?? 'true';
    cols.push(
      tile.money
        ? `COALESCE(SUM(t.nte) FILTER (WHERE ${cond}), 0)::float8 AS "${tile.key}"`
        : `COUNT(*) FILTER (WHERE ${cond})::float8 AS "${tile.key}"`,
    );
  }
  const res = await query<Record<string, number | string>>(
    `SELECT ${cols.join(', ')} ${WO_FROM} WHERE ${where.join(' AND ')}`,
    p.values,
  );
  const row = res.rows[0] ?? {};
  const tiles = Object.fromEntries(SUMMARY_TILES.map((t) => [t.key, Number(row[t.key] ?? 0)])) as ClientUpdateSummary['tiles'];
  return { total: Number(row.total ?? 0), tiles };
}

async function chartsFor(
  charts: ClientUpdateChart[],
  filters: WoFilterSet,
  viewer?: ActingPrincipal,
): Promise<ClientUpdateChartResult[]> {
  return Promise.all(
    charts.map(async (c) => {
      const b = await metricBreakdown(c.field, filters as FilterSet, 12, viewer);
      let buckets = b.items.map((i) => ({ value: i.value, n: i.count }));
      // Age bands read youngest to oldest, not biggest first.
      if (c.field === 'age_band') {
        const order = (v: string | null) => (v === null ? 99 : (AGE_BANDS as readonly string[]).indexOf(v));
        buckets = buckets.sort((x, y) => order(x.value) - order(y.value));
      }
      return { field: c.field, label: b.label, kind: c.kind, total: b.total, other: b.other, buckets };
    }),
  );
}

/** Our page: tiles + charts over any filter set, scoped to the viewer. */
export async function insights(
  filters: WoFilterSet,
  charts: ClientUpdateChart[],
  viewer: ActingPrincipal,
): Promise<ClientUpdateInsights> {
  requireClientUpdatesView(viewer);
  if (charts.length > MAX_TRACKER_CHARTS) throw badRequest(`At most ${MAX_TRACKER_CHARTS} charts`);
  await compileFilters(filters as FilterSet, new Params());
  const [summary, chartResults] = await Promise.all([summarize(filters, viewer), chartsFor(charts, filters, viewer)]);
  return { summary, charts: chartResults };
}

// ── What the client sees ─────────────────────────────────────────────────────

function cellOf(item: WorkOrderListItem, key: string): string | number | null {
  if (item.custom && key in item.custom) return item.custom[key] ?? null;
  if (key.startsWith('fields.')) return null;
  if (key === 'status') return item.status.name;
  if (key === 'status_group') return item.status.group;
  const v = (item as unknown as Record<string, unknown>)[key];
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : String(v);
}

interface BuiltView extends ClientUpdatePublicView {
  taskIds: string[];
  /** Type per shared column, for server-side formatting. */
  types: string[];
}

/**
 * The client's view of a tracker: the WHOLE tracker (no viewer scope), only
 * the shared columns, the shared charts' facets, capped at SHARE_ROW_CAP.
 */
async function buildView(r: Row): Promise<BuiltView> {
  const t = mapRow(r, false);
  const cols = sharedColumns(t.columns);
  const described = await Promise.all(cols.map(async (c) => ({ c, f: await resolveField(c.key) })));
  const sharedCharts = t.share.charts ? t.charts.filter((c) => c.shared) : [];
  const facetKeys = [...new Set(sharedCharts.map((c) => c.field))];
  const filters = trackerFilters(t);
  // Section by the tracker's group field only when the client can see it.
  const groupBy = t.group_by && cols.some((c) => c.key === t.group_by) ? t.group_by : null;

  const list = await listWorkOrders({
    filters: filters as FilterSet,
    columns: [...new Set([...cols.map((c) => c.key), ...facetKeys])],
    sort: t.sort,
    group_by: groupBy,
    limit: SHARE_ROW_CAP,
    offset: 0,
  });

  const [summary, charts] = await Promise.all([
    t.share.summary ? summarize(filters) : Promise.resolve(null),
    sharedCharts.length ? chartsFor(sharedCharts, filters) : Promise.resolve([]),
  ]);

  return {
    name: t.name,
    client: t.client,
    intro: t.email.intro,
    generated_at: new Date().toISOString(),
    columns: described.map(({ c, f }) => ({ key: c.key, label: c.label ?? f.label, type: f.type })),
    types: described.map(({ f }) => f.type),
    rows: list.items.map((item) => ({
      cells: cols.map((c) => cellOf(item, c.key)),
      facets: Object.fromEntries(facetKeys.map((k) => [k, (() => { const v = cellOf(item, k); return v === null || v === '' ? null : String(v); })()])),
    })),
    truncated: list.total > list.items.length,
    summary,
    charts,
    group_by: groupBy,
    taskIds: list.items.map((i) => i.id),
  };
}

function publicOf(v: BuiltView): ClientUpdatePublicView {
  const { taskIds: _t, types: _ty, ...rest } = v;
  return rest;
}

export async function publicView(token: string): Promise<ClientUpdatePublicView> {
  return publicOf(await buildView(await rowByToken(token)));
}

function formattedRows(v: BuiltView): string[][] {
  return v.rows.map((row) => row.cells.map((cell, i) => formatClientValue(cell, v.types[i], v.columns[i].key)));
}

function csvOf(v: BuiltView): string {
  return toCsv(
    v.columns.map((c) => c.label),
    formattedRows(v),
  );
}

export function csvFilename(name: string, client: string | null): string {
  const base = `${client ? `${client} ` : ''}${name}`.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'client-update';
  return `${base}-${new Date().toISOString().slice(0, 10)}.csv`;
}

export async function publicCsv(token: string): Promise<{ csv: string; filename: string }> {
  const r = await rowByToken(token);
  return { csv: csvOf(await buildView(r)), filename: csvFilename(r.name, r.client) };
}

/** The client columns as a CSV, downloaded from our page (logged like any export). */
export async function clientCsv(id: string, actor: ActingPrincipal): Promise<{ csv: string; filename: string }> {
  requireClientUpdatesShare(actor);
  const r = await rowById(id);
  if (!r) throw notFound('No such client update');
  const v = await buildView(r);
  await logAdminEvent({
    actorId: actor.id,
    entity: 'client_update',
    entityId: id,
    action: 'client_update_exported',
    after: { name: r.client ? `${r.client} · ${r.name}` : r.name, rows: v.rows.length, columns: v.columns.map((c) => c.key) },
  });
  return { csv: csvOf(v), filename: csvFilename(r.name, r.client) };
}

// ── Email ────────────────────────────────────────────────────────────────────

function renderEmail(r: Row, v: BuiltView, subjectOverride?: string | null, introOverride?: string | null) {
  const t = mapRow(r, false);
  const now = new Date();
  const groupIndex = v.group_by ? v.columns.findIndex((c) => c.key === v.group_by) : -1;
  const rows = formattedRows(v);
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const summary = v.summary
    ? [
        { label: 'Work orders', value: String(v.summary.total) },
        ...SUMMARY_TILES.filter((tile) => !tile.money || v.columns.some((c) => c.key === 'nte')).map((tile) => ({
          label: tile.label,
          value: tile.money ? money.format(v.summary!.tiles[tile.key]) : String(v.summary!.tiles[tile.key]),
        })),
      ]
    : null;
  const subject = subjectOverride?.trim() || t.email.subject || defaultSubject(t.client ? `${t.client} · ${t.name}` : t.name, now);
  const { html, text } = buildClientUpdateEmail({
    trackerName: t.name,
    client: t.client,
    intro: introOverride !== undefined && introOverride !== null ? introOverride : t.email.intro,
    generatedAt: now,
    headers: v.columns.map((c) => c.label),
    sections: sectionRows(rows, groupIndex >= 0 ? groupIndex : null),
    rowCount: v.rows.length,
    truncated: v.truncated,
    summary,
    charts: v.charts.map((c) => ({
      label: c.label,
      total: c.total,
      buckets: [
        ...c.buckets.map((b) => ({ label: b.value ?? 'Not set', n: b.n })),
        ...(c.other > 0 ? [{ label: 'Everything else', n: c.other }] : []),
      ],
    })),
    link: t.email.include_link ? linkFor(r) : null,
    fromName: config.mail.fromName,
    fromAddress: config.mail.from,
  });
  return { subject, html, text };
}

export async function emailPreview(id: string, actor: ActingPrincipal) {
  requireClientUpdatesShare(actor);
  const r = await rowById(id);
  if (!r) throw notFound('No such client update');
  const v = await buildView(r);
  const { subject, html } = renderEmail(r, v);
  const t = mapRow(r, false);
  return {
    subject,
    html,
    from: config.mail.from,
    to: t.email.to,
    cc: t.email.cc,
    row_count: v.rows.length,
    link: t.email.include_link ? linkFor(r) : null,
    mail: mailStatus(),
  };
}

export interface SendInput {
  trigger: DeliveryTrigger;
  /** Override the tracker's recipients for this one send. */
  to?: ClientUpdateRecipient[];
  cc?: ClientUpdateRecipient[];
  subject?: string | null;
  intro?: string | null;
}

interface DeliveryRow {
  id: string;
  trigger: DeliveryTrigger;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  status: 'sent' | 'failed';
  error: string | null;
  row_count: number;
  columns: string[];
  sent_by_id: string | null;
  sent_by_name: string | null;
  created_at: string;
}

const DELIVERY_SELECT = `
  SELECT d.id::text AS id, d.trigger, d.to_addresses, d.cc_addresses, d.subject, d.status, d.error,
         d.row_count, d.columns, d.sent_by::text AS sent_by_id, p.display_name AS sent_by_name,
         ${ISO('d.created_at')} AS created_at
    FROM client_update_delivery d
    LEFT JOIN principal p ON p.id = d.sent_by`;

function mapDelivery(d: DeliveryRow): ClientUpdateDelivery {
  return {
    id: d.id,
    trigger: d.trigger,
    to: d.to_addresses ?? [],
    cc: d.cc_addresses ?? [],
    subject: d.subject,
    status: d.status,
    error: d.error,
    row_count: d.row_count,
    columns: d.columns ?? [],
    sent_by: d.sent_by_id ? { id: d.sent_by_id, display_name: d.sent_by_name ?? '—' } : null,
    created_at: d.created_at,
  };
}

export async function listDeliveries(id: string, actor: ActingPrincipal): Promise<ClientUpdateDelivery[]> {
  requireClientUpdatesView(actor);
  const res = await query<DeliveryRow>(`${DELIVERY_SELECT} WHERE d.client_update_id = $1 ORDER BY d.created_at DESC LIMIT 100`, [id]);
  return res.rows.map(mapDelivery);
}

async function principalEmail(id: string): Promise<string | null> {
  const res = await query<{ email: string | null }>(`SELECT email FROM principal WHERE id = $1`, [id]);
  return res.rows[0]?.email ?? null;
}

/**
 * Send one tracker. Records a delivery row either way; on success stamps
 * last_sent_at and writes a `client_update_sent` row on every work order in
 * the email (the chase the approval follow-up clock listens for). A test send
 * goes to the sender only and touches no work order.
 */
async function sendRow(r: Row, input: SendInput, actorId: string, actorEmail: string | null): Promise<ClientUpdateDelivery> {
  const t = mapRow(r, false);
  let to: ClientUpdateRecipient[];
  let cc: ClientUpdateRecipient[];
  if (input.trigger === 'test') {
    if (!actorEmail || !isEmail(actorEmail)) throw badRequest('Your account has no email address to send a test to');
    to = [{ email: actorEmail, name: null }];
    cc = [];
  } else {
    to = input.to ? cleanRecipients(input.to, 'to') : t.email.to;
    cc = input.cc ? cleanRecipients(input.cc, 'cc') : t.email.cc;
  }
  const v = await buildView(r);
  const { subject, html, text } = renderEmail(r, v, input.subject, input.intro);
  const cols = v.columns.map((c) => c.key);

  let status: 'sent' | 'failed' = 'sent';
  let error: string | null = null;
  let provider: string | null = null;
  let messageId: string | null = null;
  if (to.length === 0) {
    status = 'failed';
    error = 'No recipients: add at least one address to send to.';
  } else {
    try {
      const sent = await sendEmail({
        to: to.map((x) => x.email),
        cc: cc.map((x) => x.email),
        subject: input.trigger === 'test' ? `[Test] ${subject}` : subject,
        html,
        text,
        attachments: t.email.attach_csv
          ? [{ filename: csvFilename(t.name, t.client), contentType: 'text/csv', content: Buffer.from(csvOf(v), 'utf8') }]
          : [],
      });
      provider = sent.provider;
      messageId = sent.messageId;
    } catch (e) {
      status = 'failed';
      error = e instanceof MailNotConfiguredError || e instanceof Error ? e.message : 'The email could not be sent';
    }
  }

  const ins = await query<{ id: string }>(
    `INSERT INTO client_update_delivery
       (client_update_id, trigger, to_addresses, cc_addresses, subject, status, error, row_count, columns,
        provider, provider_message_id, sent_by)
     VALUES ($1, $2, $3::text[], $4::text[], $5, $6, $7, $8, $9::text[], $10, $11, $12)
     RETURNING id::text AS id`,
    [r.id, input.trigger, to.map((x) => x.email), cc.map((x) => x.email), subject, status, error,
     v.rows.length, cols, provider, messageId, actorId],
  );
  const deliveryId = ins.rows[0].id;
  const label = t.client ? `${t.client} · ${t.name}` : t.name;

  if (status === 'sent' && input.trigger !== 'test') {
    await query(`UPDATE client_update SET last_sent_at = now() WHERE id = $1`, [r.id]);
    if (v.taskIds.length) {
      await query(
        `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, after)
         SELECT $1, 'task', x::text, 'client_update_sent', $3::jsonb FROM unnest($2::uuid[]) AS x`,
        [actorId, v.taskIds, JSON.stringify({ name: label, client_update_id: r.id, delivery_id: deliveryId, to: to.map((x) => x.email), trigger: input.trigger })],
      );
    }
  }
  await logAdminEvent({
    actorId,
    entity: 'client_update',
    entityId: r.id,
    action: status !== 'sent' ? 'client_update_send_failed' : input.trigger === 'test' ? 'client_update_test_sent' : 'client_update_sent',
    after: {
      name: label,
      trigger: input.trigger,
      to: to.map((x) => x.email),
      cc: cc.map((x) => x.email),
      subject,
      rows: v.rows.length,
      columns: cols,
      status,
      error,
    },
  });

  const d = await query<DeliveryRow>(`${DELIVERY_SELECT} WHERE d.id = $1`, [deliveryId]);
  return mapDelivery(d.rows[0]);
}

export async function sendClientUpdate(id: string, input: SendInput, actor: ActingPrincipal): Promise<ClientUpdateDelivery> {
  requireClientUpdatesShare(actor);
  if (input.trigger === 'scheduled') throw badRequest('Only the scheduler sends scheduled updates');
  const r = await rowById(id);
  if (!r) throw notFound('No such client update');
  return sendRow(r, input, actor.id, await principalEmail(actor.id));
}

/**
 * The cron: every tracker whose schedule is due. Each row is CLAIMED by
 * moving next_run_at forward first (compare-and-set), so two overlapping
 * cron calls can never send the same update twice.
 */
export async function runDueClientUpdates(now = new Date()): Promise<{ sent: number; failed: number }> {
  const due = await query<{ id: string; next_run_at: string; schedule: ClientUpdateSchedule | null }>(
    `SELECT id::text AS id, next_run_at::text AS next_run_at, schedule
       FROM client_update WHERE next_run_at IS NOT NULL AND next_run_at <= $1`,
    [now.toISOString()],
  );
  let sent = 0;
  let failed = 0;
  if (due.rows.length === 0) return { sent, failed };
  const actorId = await serviceActorId('Client updates', 'CU');
  for (const d of due.rows) {
    const next = nextRunAt(d.schedule, now);
    const claim = await query(
      `UPDATE client_update SET next_run_at = $2 WHERE id = $1 AND next_run_at = $3::timestamptz`,
      [d.id, next ? next.toISOString() : null, d.next_run_at],
    );
    if ((claim as { rowCount?: number | null }).rowCount === 0) continue;
    if (!d.schedule?.enabled) continue;
    const r = await rowById(d.id);
    if (!r) continue;
    try {
      const out = await sendRow(r, { trigger: 'scheduled' }, actorId, null);
      if (out.status === 'sent') sent += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}

