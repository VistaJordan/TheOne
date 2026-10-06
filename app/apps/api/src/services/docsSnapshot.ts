// 0075 · Admin › Documentation — the live half of the documents.
//
// The prose lives in packages/shared/src/docs; this reads what the instance
// holds right now (statuses, fields, roles, automations, integrations,
// approval tiers, holidays, dashboards, counts, the migration ledger) so the
// BRD's appendix, the SOP's revision history and the lifecycle's live counts
// describe the system as it is. Read-only; nothing here writes.

import {
  COMPUTED_KEYS,
  FIELD_SECTIONS,
  HEADER_SECTION_TITLE,
  MORE_SECTION_TITLE,
  PHASE_BY_STATUS_NAME,
  VISIT_OWNED_KEYS,
  buildPermissionTree,
  fieldSectionSlug,
  permAllows,
  resolveWoScope,
  type DocsSnapshot,
  type DocsSnapshotRole,
  type PermAction,
  type PermissionSet,
} from '@theone/shared';
import { query } from '../db.js';
import { config } from '../config.js';
import { listFieldDefs, listWorkflow } from './adminMeta.js';
import { listRoles } from './roles.js';
import { listAutomations } from './automations.js';
import { listIntegrations } from './integrations.js';
import { listApprovalTiers } from './approvalTiers.js';
import { listHolidays } from './holidays.js';
import { listStatusGroups } from './statusAdmin.js';
import type { PermissionBearer } from './permissions.js';

const SECTION_TITLE_BY_SLUG = new Map(FIELD_SECTIONS.map((s) => [s.slug, s.title]));

function sectionTitle(fieldKey: string): string {
  const slug = fieldSectionSlug(`fields.${fieldKey}`);
  if (slug === 'header') return HEADER_SECTION_TITLE;
  return SECTION_TITLE_BY_SLUG.get(slug) ?? MORE_SECTION_TITLE;
}

function describeTrigger(t: { kind: string; field?: string | null; to?: string | null; to_op?: string | null; to_field?: string | null; delay_minutes?: number | null }): string {
  if (t.kind === 'created') return 'A work order is created';
  if (t.kind === 'manual') return 'Manually enrolled';
  const field = t.field ? t.field.replace(/^fields\./, '') : 'Any field';
  const op = t.to_op && t.to_op !== 'eq' ? { gt: 'more than', gte: 'at least', lt: 'less than', lte: 'at most' }[t.to_op] ?? t.to_op : '';
  let s = `${field} changes`;
  if (t.to_field) s += ` to ${op || 'more than'} ${t.to_field.replace(/^fields\./, '')}`;
  else if (t.to) s += ` to ${op ? `${op} ` : ''}${t.to}`;
  return s;
}

/** Level-one rows of the permission tree, the work-order scope and the
    status-change mode, evaluated for one role (no per-person overrides). */
function roleView(set: PermissionSet): Pick<DocsSnapshotRole, 'sections' | 'wo_scope' | 'status_mode'> {
  const actions: PermAction[] = ['view', 'create', 'edit', 'delete', 'approve'];
  const sections = buildPermissionTree([]).map((node) => {
    const row: Record<string, boolean> = {};
    for (const a of actions) row[a] = node.actions.includes(a) ? permAllows(set, node.key, a) : false;
    return { key: node.key, label: node.label, view: row.view, create: row.create, edit: row.edit, delete: row.delete, approve: row.approve };
  });
  return {
    sections,
    wo_scope: resolveWoScope(set).all ? 'everything' : 'only_theirs',
    status_mode: permAllows(set, 'work_orders/status', 'edit') ? 'direct' : permAllows(set, 'work_orders/status', 'create') ? 'request' : 'none',
  };
}

export async function docsSnapshot(user: PermissionBearer & { id: string }): Promise<DocsSnapshot> {
  const [workflow, groups, fields, roles, automations, tiers, holidays] = await Promise.all([
    listWorkflow(),
    listStatusGroups(),
    listFieldDefs(),
    listRoles(),
    listAutomations(),
    listApprovalTiers(),
    listHolidays(),
  ]);

  // The connector list is read-only here and the page is already gated on
  // admin/docs, so the Integrations section's own view grant is not asked
  // again — a reviewer of the BRD sees which connectors are on.
  const integrations = await listIntegrations({ id: user.id, perms: user.perms, isSuperAdmin: true });

  const [counts, people, dashboards, migrations, instance] = await Promise.all([
    query<Record<string, number>>(
      `SELECT (SELECT COUNT(*)::int FROM task WHERE deleted_at IS NULL)                        AS work_orders,
              (SELECT COUNT(*)::int FROM principal WHERE kind = 'human' AND status <> 'disabled') AS users,
              (SELECT COUNT(*)::int FROM role)                                                   AS roles,
              (SELECT COUNT(*)::int FROM status)                                                 AS statuses,
              (SELECT COUNT(*)::int FROM field_def)                                              AS fields,
              (SELECT COUNT(*)::int FROM automation)                                             AS automations,
              (SELECT COUNT(*)::int FROM saved_view)                                             AS saved_views,
              (SELECT COUNT(*)::int FROM dashboard)                                              AS dashboards,
              (SELECT COUNT(*)::int FROM vendor WHERE deleted_at IS NULL)                        AS vendors,
              (SELECT COUNT(*)::int FROM site WHERE deleted_at IS NULL)                          AS sites,
              (SELECT COUNT(*)::int FROM asset)                                                  AS assets,
              (SELECT COUNT(*)::int FROM client)                                                 AS clients,
              (SELECT COUNT(*)::int FROM quote)                                                  AS quotes,
              (SELECT COUNT(*)::int FROM invoice)                                                AS invoices,
              (SELECT COUNT(*)::int FROM payment_request)                                        AS payment_requests,
              (SELECT COUNT(*)::int FROM activity_log)                                           AS audit_rows`,
    ),
    query<{ display_name: string; kind: string; is_super_admin: boolean }>(
      `SELECT display_name, kind::text AS kind, is_super_admin
         FROM principal
        WHERE status <> 'disabled' AND (kind = 'service' OR is_super_admin)
        ORDER BY kind, display_name`,
    ),
    query<{ name: string; folder: string | null; system_key: string | null; widgets: number }>(
      `SELECT d.name, f.name AS folder, d.system_key,
              (SELECT COUNT(*)::int FROM dashboard_widget w WHERE w.dashboard_id = d.id) AS widgets
         FROM dashboard d LEFT JOIN dashboard_folder f ON f.id = d.folder_id
        ORDER BY f.name NULLS LAST, d.position, d.name`,
    ),
    query<{ filename: string; applied_at: Date | string | null }>(`SELECT filename, applied_at FROM _migrations ORDER BY filename`),
    query<{ n: number; latest: string | null }>(`SELECT COUNT(*)::int AS n, MAX(filename) AS latest FROM _migrations`),
  ]);

  const c = counts.rows[0] ?? {};
  const num = (k: string) => Number(c[k] ?? 0);

  return {
    generated_at: new Date().toISOString(),
    instance: {
      auth_mode: config.authMode,
      node_env: config.nodeEnv,
      web_origin: config.webOrigin,
      database: process.env.DATABASE_URL ? 'Postgres (Neon)' : 'PGlite (embedded Postgres 16)',
      migrations_applied: instance.rows[0]?.n ?? 0,
      latest_migration: instance.rows[0]?.latest ?? null,
    },
    counts: {
      work_orders: num('work_orders'),
      users: num('users'),
      roles: num('roles'),
      statuses: num('statuses'),
      fields: num('fields'),
      automations: num('automations'),
      saved_views: num('saved_views'),
      dashboards: num('dashboards'),
      vendors: num('vendors'),
      sites: num('sites'),
      assets: num('assets'),
      clients: num('clients'),
      quotes: num('quotes'),
      invoices: num('invoices'),
      payment_requests: num('payment_requests'),
      audit_rows: num('audit_rows'),
    },
    super_admins: people.rows.filter((p) => p.kind === 'human' && p.is_super_admin).map((p) => p.display_name),
    service_principals: people.rows.filter((p) => p.kind === 'service').map((p) => p.display_name),
    status_groups: groups.map((g) => ({ code: g.code, label: g.label, position: g.position, is_builtin: g.is_builtin, status_count: g.status_count })),
    statuses: workflow.map((s) => ({
      name: s.name,
      group: s.status_group,
      color: s.color,
      position: s.position,
      is_archive: s.is_archive,
      phase: PHASE_BY_STATUS_NAME[s.name] ?? null,
      wo_count: s.wo_count,
    })),
    fields: fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      section: sectionTitle(f.key),
      options: f.options,
      create_mode: f.create_mode,
      used_by: f.used_by,
      computed: COMPUTED_KEYS.includes(f.key),
      visit_owned: VISIT_OWNED_KEYS.includes(f.key),
    })),
    roles: roles.map((r) => ({
      ...roleView({ role: r.permissions, overrides: {} }),
      code: r.code,
      label: r.label,
      description: r.description,
      is_system: r.is_system,
      user_count: r.user_count,
    })),
    automations: automations.map((a) => ({
      name: a.name,
      enabled: a.enabled,
      trigger: describeTrigger(a.trigger),
      conditions: a.conditions?.rules?.length ?? 0,
      actions: a.actions.map((x) =>
        x.kind === 'approval_task' || x.field === 'approval_task'
          ? `Raise an approval task (${x.value ?? ''}${x.assign_role ? `, ${x.assign_role}` : ''})`
          : `Set ${x.field.replace(/^fields\./, '')} = ${x.value ?? '(clear)'}`,
      ),
      run_count: a.run_count,
    })),
    integrations: integrations.items.map((i) => ({
      key: i.key,
      name: i.name,
      group: i.group,
      enabled: i.enabled,
      built: i.built !== false,
      configured: i.configured,
      summary: i.summary,
    })),
    approval_tiers: tiers.map((t) => ({ kind: t.kind, label: t.label, min_amount: t.min_amount, max_amount: t.max_amount, roles: t.roles })),
    holidays: holidays.map((h) => ({ day: h.day, name: h.name })),
    dashboards: dashboards.rows.map((d) => ({ name: d.name, folder: d.folder, system_key: d.system_key, widgets: Number(d.widgets) })),
    migrations: migrations.rows.map((m) => {
      const match = /^(\d+)_(.+)\.sql$/.exec(m.filename);
      return {
        n: match ? Number(match[1]) : 0,
        filename: m.filename,
        title: match ? match[2].replace(/_/g, ' ') : m.filename,
        applied_at: m.applied_at ? new Date(m.applied_at).toISOString() : null,
      };
    }),
  };
}
