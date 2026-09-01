// Read models behind the Admin Studio's non-user sections.
//
// The writes live elsewhere: fields in services/fieldDefs.ts (S7), statuses and
// phase groups in services/statusAdmin.ts. Trash's restore is below — it is
// safe and reversible. Note the KPI tiles still match two statuses by NAME
// (services/kpis.ts); the Workflows page warns before those are renamed.

import { query } from '../db.js';
import { config } from '../config.js';
import { ApiError } from '../errors.js';

// ── Custom fields ────────────────────────────────────────────────────────────

export interface FieldDefItem {
  id: string;
  key: string;
  label: string;
  type: string;
  container: string | null;
  position: number | null;
  /** Dropdown option count, when the type config carries one. */
  option_count: number;
  /** The dropdown vocabulary itself, for the S7 options editor. */
  options: string[];
  /** How many work orders actually carry a value for this key. */
  used_by: number;
}

export async function listFieldDefs(): Promise<FieldDefItem[]> {
  const res = await query<Omit<FieldDefItem, 'options'> & { options: unknown }>(
    `SELECT f.id, f.key, f.label, f.type::text AS type, f.position,
            c.name AS container,
            COALESCE(jsonb_array_length(
              CASE WHEN jsonb_typeof(f.type_config->'options') = 'array'
                   THEN f.type_config->'options' END), 0) AS option_count,
            CASE WHEN jsonb_typeof(f.type_config->'options') = 'array'
                 THEN f.type_config->'options' ELSE '[]'::jsonb END AS options,
            (SELECT COUNT(*)::int FROM task t
              WHERE t.deleted_at IS NULL AND t.fields ? f.key) AS used_by
       FROM field_def f
       LEFT JOIN container c ON c.id = f.container_id
      ORDER BY f.position NULLS LAST, f.key ASC`,
  );
  // Older exports stored options as {name,color} objects; the editor works on
  // plain strings, so both shapes collapse to the display string here.
  return res.rows.map((r) => ({
    ...r,
    options: Array.isArray(r.options)
      ? (r.options as unknown[])
          .map((o) =>
            typeof o === 'string'
              ? o
              : String((o as Record<string, unknown>)?.name ?? (o as Record<string, unknown>)?.label ?? ''),
          )
          .filter((s) => s.length > 0)
      : [],
  }));
}

// ── Statuses & workflow ──────────────────────────────────────────────────────

export interface WorkflowItem {
  id: string;
  name: string;
  /** A status_group_def code — the four built-ins plus admin-added groups. */
  status_group: string;
  color: string;
  position: number;
  is_archive: boolean;
  /** Live work orders sitting at this status right now. */
  wo_count: number;
}

export async function listWorkflow(): Promise<WorkflowItem[]> {
  const res = await query<WorkflowItem>(
    `SELECT s.id, s.name, s.status_group::text AS status_group, s.color,
            s.position, s.is_archive,
            (SELECT COUNT(*)::int FROM task t
              WHERE t.status_id = s.id AND t.deleted_at IS NULL) AS wo_count
       FROM status s
      ORDER BY s.position ASC`,
  );
  return res.rows;
}

// ── Trash ────────────────────────────────────────────────────────────────────

export interface TrashItem {
  id: string;
  wo_number: string;
  title: string;
  client: string | null;
  status: string;
  deleted_at: string;
}

export async function listTrash(): Promise<TrashItem[]> {
  const res = await query<TrashItem>(
    `SELECT t.id, t.wo_number, t.title, t.client, s.name AS status,
            to_char((t.deleted_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS deleted_at
       FROM task t
       JOIN status s ON s.id = t.status_id
      WHERE t.deleted_at IS NOT NULL
      ORDER BY t.deleted_at DESC`,
  );
  return res.rows;
}

export async function restoreTask(id: string, actorId: string): Promise<{ wo_number: string }> {
  const res = await query<{ wo_number: string }>(
    `UPDATE task SET deleted_at = NULL
      WHERE id = $1 AND deleted_at IS NOT NULL
      RETURNING wo_number`,
    [id],
  );
  if (!res.rows[0]) throw new ApiError('NOT_FOUND', 'That work order is not in the trash');

  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, after)
     VALUES ($1, 'task', $2, 'restored', $3)`,
    [actorId, id, JSON.stringify({ wo_number: res.rows[0].wo_number })],
  );
  return { wo_number: res.rows[0].wo_number };
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface SettingsResponse {
  auth: {
    mode: 'entra' | 'bypass';
    tenant_id: string | null;
    redirect_uri: string | null;
    session_ttl_hours: number;
    invite_only: true;
  };
  server: { node_env: string; web_origin: string; api_port: number; cookie_secure: boolean };
  database: { engine: string; migrations_applied: number; latest_migration: string | null };
  counts: { users: number; roles: number; work_orders: number; statuses: number; fields: number };
}

/**
 * Read-only. Everything here is set by environment variables or by migration,
 * and a settings screen that pretends otherwise would offer edits that silently
 * do nothing. The secret is never included — only whether one is configured.
 */
export async function getSettings(): Promise<SettingsResponse> {
  const migrations = await query<{ n: number; latest: string | null }>(
    `SELECT COUNT(*)::int AS n, MAX(filename) AS latest FROM _migrations`,
  );
  const counts = await query<{
    users: number;
    roles: number;
    work_orders: number;
    statuses: number;
    fields: number;
  }>(
    `SELECT (SELECT COUNT(*)::int FROM principal WHERE kind = 'human')       AS users,
            (SELECT COUNT(*)::int FROM role)                                 AS roles,
            (SELECT COUNT(*)::int FROM task WHERE deleted_at IS NULL)        AS work_orders,
            (SELECT COUNT(*)::int FROM status)                               AS statuses,
            (SELECT COUNT(*)::int FROM field_def)                            AS fields`,
  );

  return {
    auth: {
      mode: config.authMode,
      tenant_id: config.entra?.tenantId ?? null,
      redirect_uri: config.entra?.redirectUri ?? null,
      session_ttl_hours: config.sessionTtlHours,
      invite_only: true,
    },
    server: {
      node_env: config.nodeEnv,
      web_origin: config.webOrigin,
      api_port: config.port,
      cookie_secure: config.cookieSecure,
    },
    database: {
      engine: 'PGlite (embedded Postgres 16)',
      migrations_applied: migrations.rows[0].n,
      latest_migration: migrations.rows[0].latest,
    },
    counts: counts.rows[0],
  };
}
