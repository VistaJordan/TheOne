// Dashboards (0042) — the records behind Home › Dashboard.
//
// Sharing and scope are different questions, and keeping them apart is the
// whole safety argument of this file:
//
//   sharing   decides who may OPEN a dashboard: its owner, super admins
//             always, and since 0050 every role (or person) granted
//             `dashboard/boards/<ref>` view in the permission tree. The Share
//             button writes those same role grants; shared_roles / shared_all
//             on the row are kept in step for older readers but decide nothing.
//   scope     decides what the numbers on it COUNT, and is applied per viewer
//             by metricWidget → woScopeSql (0026/0032). 0050 lets a role pick
//             it per dashboard (`…/scope`: everything / only theirs); unset,
//             it is the person's own "Which work orders".
//
// So two dispatchers open the same shared "Dispatch Center" and each sees
// their own book in it — unless the Roles screen says that dashboard counts
// everything for them, which is a decision made there on purpose. The list a
// card opens is always scoped by "Which work orders", never by the dashboard.
//
// The three dashboards we ship live in packages/shared/src/dashboards.ts and
// are upserted here by system_key on first read — never in the migration and
// never in seed.ts, which is the pair that has drifted before. The upsert
// only INSERTS what is missing: rename one, reshare it, delete a widget from
// it, and the change sticks.

import {
  dashboardPermKey,
  dashboardRef,
  permAllows,
  withDashboardScope,
  type PermDashboardInfo,
  type PermMap,
  LIVE_MIN_SECONDS,
  PREBUILT_DASHBOARDS,
  SOURCE_FIELDS,
  WIDGET_KINDS,
  WIDGET_SOURCES,
  WIDGET_WIDTHS,
  widgetAsksQuestion,
  type WoFilterSet,
  type Dashboard,
  type DashboardFolder,
  type DashboardWidget,
  type DashboardsResponse,
  type WidgetConfig,
  type WidgetKind,
  type WidgetResult,
  type WidgetWidth,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { requirePerm } from './permissions.js';
import type { ActingPrincipal } from './activity.js';
import { metricWidget } from './woMetrics.js';
import { updateRole } from './roles.js';

const PERM_KEY = 'dashboard';

export function requireDashboardView(p: ActingPrincipal): void {
  requirePerm(p, PERM_KEY, 'view', 'You cannot view dashboards');
}

/** 0050 · one dashboard page (a built-in ref or a record's ref) must be ticked
    for this person under Dashboard › Which dashboards. */
export function requireBoardView(p: ActingPrincipal, ref: string): void {
  requireDashboardView(p);
  requirePerm(p, dashboardPermKey(ref), 'view', 'You cannot open this dashboard');
}

/** 0050 · the viewer a dashboard's cards are counted as: the same person,
    with "Which work orders" replaced by that dashboard's own choice. */
export function boardViewer(p: ActingPrincipal, ref: string): ActingPrincipal {
  return { ...p, perms: withDashboardScope(p.perms, ref) };
}

/** Building and sharing a dashboard is a create grant on the same path. */
export function requireDashboardCreate(p: ActingPrincipal): void {
  requireDashboardView(p);
  requirePerm(p, PERM_KEY, 'create', 'You cannot build dashboards');
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface DashRow {
  id: string;
  folder_id: string | null;
  folder_name: string | null;
  name: string;
  description: string | null;
  system_key: string | null;
  owner_id: string | null;
  owner_name: string | null;
  shared_roles: string[] | null;
  shared_all: boolean;
  position: number;
}

interface WidgetRow {
  id: string;
  dashboard_id: string;
  kind: string;
  label: string;
  config: unknown;
  width: string;
  position: number;
}

const refOf = (row: { id: string; system_key: string | null }) => dashboardRef(row);

/** A super admin, its builder, or anyone ticked for it in the permission
    tree (0050 — their role, or their own Adjust override). */
function canSee(row: DashRow, viewer: ActingPrincipal): boolean {
  if (viewer.isSuperAdmin) return true;
  if (row.owner_id && row.owner_id === viewer.id) return true;
  return permAllows(viewer.perms, dashboardPermKey(refOf(row)), 'view');
}

interface RolePerms {
  id: string;
  code: string;
  permissions: PermMap;
}

async function rolePerms(): Promise<RolePerms[]> {
  const res = await query<RolePerms>(
    `SELECT id::text AS id, code, permissions FROM role ORDER BY position, label`,
  );
  return res.rows.map((r) => ({ ...r, permissions: r.permissions ?? {} }));
}

/** Which roles open this dashboard, read back from their grants. "Everyone"
    = every role that can open the Dashboard section at all. */
function sharingOf(ref: string, roles: RolePerms[]): { shared_roles: string[]; shared_all: boolean } {
  const opens = (r: RolePerms, key: string) => permAllows({ role: r.permissions, overrides: {} }, key, 'view');
  const withSection = roles.filter((r) => opens(r, 'dashboard'));
  const shared = withSection.filter((r) => opens(r, dashboardPermKey(ref)));
  return {
    shared_roles: shared.map((r) => r.code),
    shared_all: withSection.length > 0 && shared.length === withSection.length,
  };
}

/** The Share button (0050): write the dashboard's view grant on every role
    whose answer changes, through updateRole so each change is a role_updated
    row in the audit log, exactly like an edit on the Roles screen. */
async function applySharing(
  row: DashRow,
  input: { shared_roles?: string[]; shared_all?: boolean },
  viewer: ActingPrincipal,
): Promise<void> {
  if (input.shared_roles === undefined && input.shared_all === undefined) return;
  const ref = refOf(row);
  const key = dashboardPermKey(ref);
  const wanted = new Set(input.shared_roles ?? []);
  const roles = await rolePerms();
  const current = sharingOf(ref, roles);
  for (const r of roles) {
    // Only the roles that can open the section at all are offered; the rest
    // are left exactly as they are.
    if (!permAllows({ role: r.permissions, overrides: {} }, 'dashboard', 'view')) continue;
    const want = input.shared_all === true || wanted.has(r.code);
    if (want === current.shared_roles.includes(r.code)) continue;
    await updateRole(
      r.id,
      { permissions: { ...r.permissions, [key]: { ...r.permissions[key], view: want } } },
      viewer.id,
    );
  }
  const after = sharingOf(ref, await rolePerms());
  await query(`UPDATE dashboard SET shared_roles = $2::text[], shared_all = $3 WHERE id = $1`, [
    row.id,
    after.shared_roles,
    after.shared_all,
  ]);
}

/** Dashboard › Which dashboards on the Roles screen: every record, in the
    order the Dashboard page shows them. */
export async function listDashboardPermInfo(): Promise<PermDashboardInfo[]> {
  await ensureSystemDashboards();
  const res = await query<{ id: string; name: string; system_key: string | null; owner_name: string | null }>(
    `SELECT d.id::text AS id, d.name, d.system_key, p.display_name AS owner_name
       FROM dashboard d
       LEFT JOIN dashboard_folder f ON f.id = d.folder_id
       LEFT JOIN principal p ON p.id = d.owner_id
      ORDER BY f.position NULLS LAST, d.position, d.name`,
  );
  return res.rows.map((r) => ({
    ref: refOf(r),
    label: r.name,
    note: r.system_key ? undefined : `Built by ${r.owner_name ?? 'someone no longer here'}`,
  }));
}

/** Its owner or a super admin. A shared dashboard is read-only to everyone
    else: one person edits it, the team reads the same numbers. */
function canEdit(row: DashRow, viewer: ActingPrincipal): boolean {
  if (viewer.isSuperAdmin) return true;
  return Boolean(row.owner_id) && row.owner_id === viewer.id;
}

function widgetOf(r: WidgetRow): DashboardWidget {
  const config = (r.config ?? {}) as WidgetConfig;
  return {
    id: r.id,
    dashboard_id: r.dashboard_id,
    kind: r.kind as WidgetKind,
    label: r.label,
    config,
    width: r.width as WidgetWidth,
    position: r.position,
  };
}

export async function listDashboards(viewer: ActingPrincipal): Promise<DashboardsResponse> {
  requireDashboardView(viewer);
  await ensureSystemDashboards();

  const rows = await query<DashRow>(
    `SELECT d.id::text AS id,
            d.folder_id::text AS folder_id,
            f.name AS folder_name,
            d.name, d.description, d.system_key,
            d.owner_id::text AS owner_id,
            p.display_name AS owner_name,
            d.shared_roles, d.shared_all, d.position
       FROM dashboard d
       LEFT JOIN dashboard_folder f ON f.id = d.folder_id
       LEFT JOIN principal p ON p.id = d.owner_id
      ORDER BY f.position NULLS LAST, d.position, d.name`,
  );

  const visible = rows.rows.filter((r) => canSee(r, viewer));
  const widgets = await query<WidgetRow>(
    `SELECT id::text AS id, dashboard_id::text AS dashboard_id, kind, label, config, width, position
       FROM dashboard_widget
      ORDER BY position, created_at`,
  );
  const byDash = new Map<string, DashboardWidget[]>();
  for (const w of widgets.rows) {
    const list = byDash.get(w.dashboard_id) ?? [];
    list.push(widgetOf(w));
    byDash.set(w.dashboard_id, list);
  }

  const folders = await query<DashboardFolder>(
    `SELECT id::text AS id, name, position FROM dashboard_folder ORDER BY position, name`,
  );

  const roles = await rolePerms();
  const items: Dashboard[] = visible.map((r) => ({
    ...sharingOf(refOf(r), roles),
    id: r.id,
    folder_id: r.folder_id,
    folder_name: r.folder_name,
    name: r.name,
    description: r.description,
    system_key: r.system_key,
    owner: r.owner_id ? { id: r.owner_id, display_name: r.owner_name ?? '—' } : null,
    position: r.position,
    can_edit: canEdit(r, viewer),
    widgets: byDash.get(r.id) ?? [],
  }));

  return { folders: folders.rows, items };
}

async function rowById(id: string): Promise<DashRow> {
  const res = await query<DashRow>(
    `SELECT d.id::text AS id, d.folder_id::text AS folder_id, f.name AS folder_name,
            d.name, d.description, d.system_key, d.owner_id::text AS owner_id,
            p.display_name AS owner_name, d.shared_roles, d.shared_all, d.position
       FROM dashboard d
       LEFT JOIN dashboard_folder f ON f.id = d.folder_id
       LEFT JOIN principal p ON p.id = d.owner_id
      WHERE d.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound('No such dashboard');
  return row;
}

/** Every widget's answer for one dashboard, each evaluated for THIS viewer. */
export async function readDashboardData(
  id: string,
  viewer: ActingPrincipal,
  /** 0044 · the board's period: one window, applied to every card on it. */
  period?: { from?: string | null; to?: string | null },
  /** 0049 · the board's filter bar, applied to every work-order card. */
  page?: WoFilterSet | null,
): Promise<{ results: WidgetResult[] }> {
  requireDashboardView(viewer);
  const row = await rowById(id);
  if (!canSee(row, viewer)) throw notFound('No such dashboard');
  // 0050 · the cards count what this dashboard's scope choice says.
  const counted = boardViewer(viewer, refOf(row));

  const widgets = await query<WidgetRow>(
    `SELECT id::text AS id, dashboard_id::text AS dashboard_id, kind, label, config, width, position
       FROM dashboard_widget WHERE dashboard_id = $1 ORDER BY position, created_at`,
    [id],
  );

  // One bad widget must not take the page down: a card whose field was since
  // deleted reports its own error and the rest still draw.
  const results = await Promise.all(
    widgets.rows.map(async (w): Promise<WidgetResult> => {
      const widget = widgetOf(w);
      // 0049 · text, a picture or a button asks nothing of the records.
      if (!widgetAsksQuestion(widget.kind)) {
        return { widget_id: widget.id, total: 0, buckets: [], other: 0 };
      }
      try {
        const out = await metricWidget(widget.config, counted, period, page);
        return { widget_id: widget.id, ...out };
      } catch (err) {
        return {
          widget_id: widget.id,
          total: 0,
          buckets: [],
          other: 0,
          error: err instanceof ApiError ? err.message : 'This card could not be worked out',
        };
      }
    }),
  );

  return { results };
}

/** The editor's live preview: an unsaved config, answered for this viewer. */
export async function previewWidget(
  config: WidgetConfig,
  viewer: ActingPrincipal,
  period?: { from?: string | null; to?: string | null },
  page?: WoFilterSet | null,
  /** 0050 · the dashboard being edited, so the preview counts what it will. */
  dashboardId?: string | null,
): Promise<WidgetResult> {
  requireDashboardView(viewer);
  let counted = viewer;
  if (dashboardId) {
    const row = await rowById(dashboardId);
    if (!canSee(row, viewer)) throw notFound('No such dashboard');
    counted = boardViewer(viewer, refOf(row));
  }
  const out = await metricWidget(config, counted, period, page);
  return { widget_id: 'preview', ...out };
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface DashboardInput {
  name?: string;
  description?: string | null;
  folder_id?: string | null;
  shared_roles?: string[];
  shared_all?: boolean;
  position?: number;
}

export async function createDashboard(
  input: DashboardInput,
  viewer: ActingPrincipal,
): Promise<Dashboard> {
  requireDashboardCreate(viewer);
  const name = (input.name ?? '').trim();
  if (name.length === 0) throw badRequest('A dashboard needs a name');

  const res = await query<{ id: string }>(
    `INSERT INTO dashboard (name, description, folder_id, owner_id, shared_roles, shared_all, position)
     VALUES ($1, $2, $3::uuid, $4, $5::text[], $6, $7)
     RETURNING id::text AS id`,
    [
      name,
      input.description ?? null,
      input.folder_id ?? null,
      viewer.id,
      [],
      false,
      input.position ?? 0,
    ],
  );
  const id = res.rows[0].id;
  // 0050 · sharing is a role grant; a new dashboard starts with its builder.
  await applySharing(await rowById(id), input, viewer);
  return getOne(id, viewer);
}

export async function updateDashboard(
  id: string,
  input: DashboardInput,
  viewer: ActingPrincipal,
): Promise<Dashboard> {
  requireDashboardCreate(viewer);
  const row = await rowById(id);
  if (!canEdit(row, viewer)) {
    throw new ApiError('FORBIDDEN', 'This dashboard belongs to someone else');
  }
  const name = input.name?.trim();
  if (name !== undefined && name.length === 0) throw badRequest('A dashboard needs a name');

  await query(
    `UPDATE dashboard
        SET name = COALESCE($2, name),
            description = COALESCE($3, description),
            folder_id = COALESCE($4::uuid, folder_id),
            position = COALESCE($5, position)
      WHERE id = $1`,
    [id, name ?? null, input.description ?? null, input.folder_id ?? null, input.position ?? null],
  );
  await applySharing(row, input, viewer);
  return getOne(id, viewer);
}

export async function deleteDashboard(id: string, viewer: ActingPrincipal): Promise<void> {
  requireDashboardCreate(viewer);
  const row = await rowById(id);
  if (!canEdit(row, viewer)) {
    throw new ApiError('FORBIDDEN', 'This dashboard belongs to someone else');
  }
  // Widgets go with it (ON DELETE CASCADE). A shipped dashboard can be
  // deleted too — it simply comes back on the next read, which is the least
  // surprising behaviour for something the app provides.
  await query(`DELETE FROM dashboard WHERE id = $1`, [id]);
}

export interface WidgetInput {
  kind?: string;
  label?: string;
  config?: WidgetConfig;
  width?: string;
  position?: number;
}

function assertWidget(input: WidgetInput): void {
  if (input.kind !== undefined && !(WIDGET_KINDS as readonly string[]).includes(input.kind)) {
    throw badRequest(`Unknown card type "${input.kind}"`);
  }
  if (input.width !== undefined && !(WIDGET_WIDTHS as readonly string[]).includes(input.width)) {
    throw badRequest(`Unknown card width "${input.width}"`);
  }
  const cfg = input.config;
  const kind = input.kind as (typeof WIDGET_KINDS)[number] | undefined;

  // 0049 · the furniture: no question, so no field rules — just its own bit.
  if (kind === 'narrative') {
    if (cfg && !(cfg.text ?? '').trim()) throw badRequest('A text card needs some text');
    return;
  }
  if (kind === 'image' || kind === 'link') {
    const url = (cfg?.url ?? '').trim();
    if (cfg && !url) throw badRequest(kind === 'image' ? 'A picture needs a URL' : 'A button needs somewhere to go');
    if (url && !/^(https?:\/\/|\/)/.test(url)) throw badRequest('The URL must start with http(s):// or /');
    return;
  }

  if (cfg && cfg.source !== undefined && !(WIDGET_SOURCES as readonly string[]).includes(cfg.source)) {
    throw badRequest(`Unknown source "${cfg.source}"`);
  }
  if (cfg && cfg.metric !== 'count' && !cfg.value_field) {
    throw badRequest('Totalling and averaging both need a field to work on');
  }
  // A card over the money records may only name the columns the source has.
  if (cfg && cfg.source && cfg.source !== 'work_orders') {
    const allowed = SOURCE_FIELDS[cfg.source];
    for (const [what, key] of [
      ['number', cfg.value_field],
      ['field', cfg.group_field],
      ['date', cfg.time_field],
    ] as const) {
      if (key && !allowed.some((f) => f.key === key)) {
        throw badRequest(`"${key}" is not a ${what} the ${cfg.source} source has`);
      }
    }
  }
  // A line cuts by time; bar / donut / table cut by a category. Either way a
  // per-bucket drawing with nothing to cut by has nothing to draw.
  if (cfg && kind === 'line' && !cfg.time_field) {
    throw badRequest('A line needs a date field to run along');
  }
  const figure = kind === 'number' || kind === 'gauge' || kind === 'live';
  if (cfg && kind && !figure && kind !== 'line' && !cfg.group_field) {
    throw badRequest('This card needs a field to group by');
  }
  if (cfg && kind === 'gauge' && cfg.target !== undefined && !(cfg.target > 0)) {
    throw badRequest('A gauge reads against a target above zero');
  }
  if (cfg && kind === 'live' && cfg.refresh_seconds !== undefined && cfg.refresh_seconds < LIVE_MIN_SECONDS) {
    throw badRequest(`A live card re-reads no faster than every ${LIVE_MIN_SECONDS} seconds`);
  }
}

export async function addWidget(
  dashboardId: string,
  input: WidgetInput,
  viewer: ActingPrincipal,
): Promise<Dashboard> {
  requireDashboardCreate(viewer);
  const row = await rowById(dashboardId);
  if (!canEdit(row, viewer)) {
    throw new ApiError('FORBIDDEN', 'This dashboard belongs to someone else');
  }
  assertWidget(input);
  const label = (input.label ?? '').trim();
  if (label.length === 0) throw badRequest('A card needs a name');

  await query(
    `INSERT INTO dashboard_widget (dashboard_id, kind, label, config, width, position)
     VALUES ($1, $2, $3, $4::jsonb, $5,
             COALESCE($6, (SELECT COALESCE(MAX(position), -1) + 1 FROM dashboard_widget WHERE dashboard_id = $1)))`,
    [
      dashboardId,
      input.kind ?? 'number',
      label,
      JSON.stringify(input.config ?? { metric: 'count' }),
      input.width ?? 'half',
      input.position ?? null,
    ],
  );
  return getOne(dashboardId, viewer);
}

export async function updateWidget(
  widgetId: string,
  input: WidgetInput,
  viewer: ActingPrincipal,
): Promise<Dashboard> {
  requireDashboardCreate(viewer);
  const owner = await query<{ dashboard_id: string }>(
    `SELECT dashboard_id::text AS dashboard_id FROM dashboard_widget WHERE id = $1`,
    [widgetId],
  );
  if (!owner.rows[0]) throw notFound('No such card');
  const row = await rowById(owner.rows[0].dashboard_id);
  if (!canEdit(row, viewer)) {
    throw new ApiError('FORBIDDEN', 'This dashboard belongs to someone else');
  }
  assertWidget(input);

  await query(
    `UPDATE dashboard_widget
        SET kind = COALESCE($2, kind),
            label = COALESCE($3, label),
            config = COALESCE($4::jsonb, config),
            width = COALESCE($5, width),
            position = COALESCE($6, position)
      WHERE id = $1`,
    [
      widgetId,
      input.kind ?? null,
      input.label?.trim() || null,
      input.config ? JSON.stringify(input.config) : null,
      input.width ?? null,
      input.position ?? null,
    ],
  );
  return getOne(row.id, viewer);
}

export async function deleteWidget(widgetId: string, viewer: ActingPrincipal): Promise<void> {
  requireDashboardCreate(viewer);
  const owner = await query<{ dashboard_id: string }>(
    `SELECT dashboard_id::text AS dashboard_id FROM dashboard_widget WHERE id = $1`,
    [widgetId],
  );
  if (!owner.rows[0]) throw notFound('No such card');
  const row = await rowById(owner.rows[0].dashboard_id);
  if (!canEdit(row, viewer)) {
    throw new ApiError('FORBIDDEN', 'This dashboard belongs to someone else');
  }
  await query(`DELETE FROM dashboard_widget WHERE id = $1`, [widgetId]);
}

async function getOne(id: string, viewer: ActingPrincipal): Promise<Dashboard> {
  const all = await listDashboards(viewer);
  const found = all.items.find((d) => d.id === id);
  if (!found) throw notFound('No such dashboard');
  return found;
}

// ── The dashboards we ship ───────────────────────────────────────────────────

let ensured = false;

/**
 * Upsert the prebuilt dashboards by system_key. Runs once per process, on the
 * first read — a seeded laptop and production get them by the same path, so
 * neither the migration nor seed.ts carries a copy to drift.
 *
 * INSERT only. If someone renames "Money", reshares it or deletes a card from
 * it, that is their dashboard now and this leaves it alone.
 */
export async function ensureSystemDashboards(): Promise<void> {
  if (ensured) return;
  ensured = true;

  const existing = await query<{ system_key: string }>(
    `SELECT system_key FROM dashboard WHERE system_key IS NOT NULL`,
  );
  const have = new Set(existing.rows.map((r) => r.system_key));
  const missing = PREBUILT_DASHBOARDS.filter((d) => !have.has(d.key));
  if (missing.length === 0) return;

  await withTransaction(async (tx) => {
    for (const d of missing) {
      const folder = await tx.query<{ id: string }>(
        `INSERT INTO dashboard_folder (name, position)
         SELECT $1, (SELECT COALESCE(MAX(position), -1) + 1 FROM dashboard_folder)
          WHERE NOT EXISTS (SELECT 1 FROM dashboard_folder WHERE name = $1)
         RETURNING id::text AS id`,
        [d.folder],
      );
      const folderId =
        folder.rows[0]?.id ??
        (
          await tx.query<{ id: string }>(
            `SELECT id::text AS id FROM dashboard_folder WHERE name = $1 LIMIT 1`,
            [d.folder],
          )
        ).rows[0]?.id ??
        null;

      const ins = await tx.query<{ id: string }>(
        `INSERT INTO dashboard (name, description, system_key, folder_id, shared_roles, shared_all, position)
         VALUES ($1, $2, $3, $4::uuid, $5::text[], $6,
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM dashboard))
         ON CONFLICT (system_key) DO NOTHING
         RETURNING id::text AS id`,
        [d.name, d.description, d.key, folderId, d.shared_roles, d.shared_all],
      );
      const dashId = ins.rows[0]?.id;
      if (!dashId) continue; // another process won the race; its widgets are in

      // 0050 · who opens it is a role grant now. Its shipped sharing becomes
      // the grant on every role that has not decided yet, so a re-created
      // dashboard keeps whatever the Roles screen already says about it.
      await tx.query(
        `UPDATE role
            SET permissions = permissions
              || jsonb_build_object($1::text, jsonb_build_object('view', $2::boolean OR code = ANY($3::text[])))
          WHERE NOT (permissions ? $1::text)`,
        [dashboardPermKey(d.key), d.shared_all, d.shared_roles],
      );

      let position = 0;
      for (const w of d.widgets) {
        await tx.query(
          `INSERT INTO dashboard_widget (dashboard_id, kind, label, config, width, position)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [dashId, w.kind, w.label, JSON.stringify(w.config), w.width, position++],
        );
      }
    }
  });
}
