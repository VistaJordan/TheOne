// Dashboards (0042) — the records behind Home › Dashboard.
//
// Sharing and scope are different questions, and keeping them apart is the
// whole safety argument of this file:
//
//   sharing   decides who may OPEN a dashboard: its owner, the roles named in
//             shared_roles, everyone if shared_all, and super admins always.
//   scope     decides what the numbers on it COUNT, and is applied per viewer
//             by metricWidget → woScopeSql (0026/0032).
//
// So two dispatchers open the same shared "Dispatch Center" and each sees
// their own book in it. Sharing a dashboard cannot leak a work order; the
// worst it can do is show someone a question whose answer is zero.
//
// The three dashboards we ship live in packages/shared/src/dashboards.ts and
// are upserted here by system_key on first read — never in the migration and
// never in seed.ts, which is the pair that has drifted before. The upsert
// only INSERTS what is missing: rename one, reshare it, delete a widget from
// it, and the change sticks.

import {
  PREBUILT_DASHBOARDS,
  WIDGET_KINDS,
  WIDGET_WIDTHS,
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

const PERM_KEY = 'dashboard';

export function requireDashboardView(p: ActingPrincipal): void {
  requirePerm(p, PERM_KEY, 'view', 'You cannot view dashboards');
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

/** Owner, a named role, everyone, or a super admin. */
function canSee(row: DashRow, viewer: ActingPrincipal): boolean {
  if (viewer.isSuperAdmin) return true;
  if (row.shared_all) return true;
  if (row.owner_id && row.owner_id === viewer.id) return true;
  const role = viewer.role ?? '';
  return role !== '' && (row.shared_roles ?? []).includes(role);
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

  const items: Dashboard[] = visible.map((r) => ({
    id: r.id,
    folder_id: r.folder_id,
    folder_name: r.folder_name,
    name: r.name,
    description: r.description,
    system_key: r.system_key,
    owner: r.owner_id ? { id: r.owner_id, display_name: r.owner_name ?? '—' } : null,
    shared_roles: r.shared_roles ?? [],
    shared_all: r.shared_all,
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
): Promise<{ results: WidgetResult[] }> {
  requireDashboardView(viewer);
  const row = await rowById(id);
  if (!canSee(row, viewer)) throw notFound('No such dashboard');

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
      try {
        const out = await metricWidget(widget.config, viewer, period);
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
): Promise<WidgetResult> {
  requireDashboardView(viewer);
  const out = await metricWidget(config, viewer, period);
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
      input.shared_roles ?? [],
      input.shared_all ?? false,
      input.position ?? 0,
    ],
  );
  return getOne(res.rows[0].id, viewer);
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
            shared_roles = COALESCE($5::text[], shared_roles),
            shared_all = COALESCE($6, shared_all),
            position = COALESCE($7, position)
      WHERE id = $1`,
    [
      id,
      name ?? null,
      input.description ?? null,
      input.folder_id ?? null,
      input.shared_roles ?? null,
      input.shared_all ?? null,
      input.position ?? null,
    ],
  );
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
  if (cfg && cfg.metric !== 'count' && !cfg.value_field) {
    throw badRequest('Totalling and averaging both need a field to work on');
  }
  // A line cuts by time; bar / donut / table cut by a category. Either way a
  // per-bucket drawing with nothing to cut by has nothing to draw.
  if (cfg && input.kind === 'line' && !cfg.time_field) {
    throw badRequest('A line needs a date field to run along');
  }
  if (cfg && input.kind && input.kind !== 'number' && input.kind !== 'line' && !cfg.group_field) {
    throw badRequest('This card needs a field to group by');
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
