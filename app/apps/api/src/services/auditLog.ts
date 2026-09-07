// The global audit log — every activity_log row across the product, joined to
// who did it and (for work-order rows) which WO it touched. The per-WO trail
// on the detail page reads the same table filtered to one task; this is the
// admin's view across all of them, filterable and exportable.
//
// Rows are not only work orders: admin changes (custom fields, statuses and
// phase groups, roles, users, automation rules — see adminAudit.ts) sit in the
// same table with their own entity_type, and `entity_name` carries what they
// touched (read off the snapshot, so a renamed or deleted thing still reads).
//
// Read-only on purpose: the log is append-only, and this module never writes.

import { query } from '../db.js';
import { CREATED_AT_SQL } from './activity.js';
import { toCsv } from './woBulk.js';

export interface AuditLogFilters {
  /** Inclusive start / end days, 'YYYY-MM-DD'. */
  from?: string;
  to?: string;
  actor_id?: string;
  action?: string;
  /** Exact field key: 'status_id', 'nte', 'fields.<custom key>'. */
  field?: string;
  /** Free text over WO #, ext ref, field key, and both values. */
  q?: string;
  limit: number;
  offset: number;
}

export interface AuditLogEntryRow {
  id: number;
  action: string;
  field: string | null;
  before: unknown;
  after: unknown;
  entity_type: string;
  entity_id: string;
  /** For non-work-order rows: the name of the field / status / role / user /
      rule at the time of the change (after it, or before it for a delete). */
  entity_name: string | null;
  wo_number: string | null;
  ext_name: string | null;
  actor: { id: string; display_name: string; kind: 'human' | 'service' };
  created_at: string;
}

interface Row {
  id: number | string;
  action: string;
  field: string | null;
  before: unknown;
  after: unknown;
  entity_type: string;
  entity_id: string;
  entity_name: string | null;
  wo_number: string | null;
  ext_name: string | null;
  actor_id: string;
  actor_name: string;
  actor_kind: 'human' | 'service';
  created_at: string;
}

function buildWhere(f: Omit<AuditLogFilters, 'limit' | 'offset'>): { sql: string; params: unknown[] } {
  const where: string[] = ['TRUE'];
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.from) where.push(`a.created_at >= ${add(f.from)}::date`);
  if (f.to) where.push(`a.created_at < (${add(f.to)}::date + INTERVAL '1 day')`);
  if (f.actor_id) where.push(`a.actor_principal_id = ${add(f.actor_id)}`);
  if (f.action) where.push(`a.action = ${add(f.action)}`);
  if (f.field) where.push(`a.field = ${add(f.field)}`);
  if (f.q) {
    const h = add(`%${f.q}%`);
    where.push(
      `(t.wo_number ILIKE ${h} OR t.ext_name ILIKE ${h} OR COALESCE(a.field, '') ILIKE ${h}
        OR a.entity_type ILIKE ${h}
        OR COALESCE(a.before::text, '') ILIKE ${h} OR COALESCE(a.after::text, '') ILIKE ${h})`,
    );
  }
  return { sql: `WHERE ${where.join(' AND ')}`, params };
}

// entity_id is text since 0023 (phase groups are keyed by code), hence the cast.
const FROM_SQL = `
  FROM activity_log a
  JOIN principal p ON p.id = a.actor_principal_id
  LEFT JOIN task t ON a.entity_type = 'task' AND t.id::text = a.entity_id`;

/** Admin rows keep a `name` in both snapshots; for the account rows written
    by sign-in (no snapshot) fall back to the principal's current name. */
const ENTITY_NAME_SQL = `
  CASE WHEN a.entity_type = 'task' THEN NULL
       ELSE COALESCE(a.after->>'name', a.before->>'name',
                     (SELECT display_name FROM principal x
                       WHERE a.entity_type = 'principal' AND x.id::text = a.entity_id))
  END`;

export interface AuditLogPage {
  items: AuditLogEntryRow[];
  total: number;
  facets: {
    actors: { id: string; name: string }[];
    actions: string[];
  };
}

export async function listAuditLog(f: AuditLogFilters): Promise<AuditLogPage> {
  const { sql: whereSql, params } = buildWhere(f);

  const rows = await query<Row>(
    `SELECT a.id, a.action, a.field, a.before, a.after, a.entity_type, a.entity_id,
            ${ENTITY_NAME_SQL} AS entity_name,
            t.wo_number, t.ext_name,
            p.id AS actor_id, p.display_name AS actor_name, p.kind AS actor_kind,
            ${CREATED_AT_SQL} AS created_at
       ${FROM_SQL}
       ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.limit, f.offset],
  );

  const count = await query<{ n: string | number }>(
    `SELECT COUNT(*) AS n ${FROM_SQL} ${whereSql}`,
    params,
  );

  // Facets are unfiltered on purpose: the selects must keep offering the other
  // choices while one of them is applied.
  const actors = await query<{ id: string; name: string }>(
    `SELECT DISTINCT p.id, p.display_name AS name
       FROM activity_log a JOIN principal p ON p.id = a.actor_principal_id
      ORDER BY name ASC`,
  );
  const actions = await query<{ action: string }>(
    `SELECT DISTINCT action FROM activity_log ORDER BY action ASC`,
  );

  return {
    items: rows.rows.map(mapRow),
    total: Number(count.rows[0]?.n ?? 0),
    facets: { actors: actors.rows, actions: actions.rows.map((r) => r.action) },
  };
}

function mapRow(r: Row): AuditLogEntryRow {
  return {
    id: Number(r.id),
    action: r.action,
    field: r.field,
    before: r.before,
    after: r.after,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    entity_name: r.entity_name,
    wo_number: r.wo_number,
    ext_name: r.ext_name,
    actor: { id: r.actor_id, display_name: r.actor_name, kind: r.actor_kind },
    created_at: r.created_at,
  };
}

// ── CSV export ───────────────────────────────────────────────────────────────

export const AUDIT_EXPORT_CAP = 10_000;

/** The most human value inside a before/after blob (see woAudit.ts shapes). */
function plainValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.status_name === 'string') return o.status_name;
    if (typeof o.list_name === 'string') return o.list_name;
    if ('value' in o) return plainValue(o.value);
    return JSON.stringify(v);
  }
  return String(v);
}

const ENTITY_LABELS: Record<string, string> = {
  task: 'Work order',
  principal: 'User',
  field_def: 'Custom field',
  status: 'Status',
  status_group: 'Phase',
  role: 'Role',
  automation: 'Automation',
};

/** Admin rows hold whole snapshots; the CSV lists only the keys that changed,
    as "key: from → to", one per line. */
function snapshotDiff(before: unknown, after: unknown): { from: string; to: string } {
  const b = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const fromLines: string[] = [];
  const toLines: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
    const show = (v: unknown) =>
      v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    fromLines.push(`${k}: ${show(b[k])}`);
    toLines.push(`${k}: ${show(a[k])}`);
  }
  return { from: fromLines.join('\n'), to: toLines.join('\n') };
}

export async function exportAuditCsv(
  f: Omit<AuditLogFilters, 'limit' | 'offset'>,
): Promise<string> {
  const page = await listAuditLog({ ...f, limit: AUDIT_EXPORT_CAP, offset: 0 });
  return toCsv(
    ['Time (UTC)', 'User', 'Action', 'Entity', 'Name', 'WO #', 'Ext ref', 'Field', 'From', 'To'],
    page.items.map((e) => {
      const admin = e.entity_type !== 'task';
      const diff = admin ? snapshotDiff(e.before, e.after) : null;
      return [
        e.created_at,
        e.actor.display_name,
        e.action,
        ENTITY_LABELS[e.entity_type] ?? e.entity_type,
        e.entity_name ?? '',
        e.wo_number ?? '',
        e.ext_name ?? '',
        e.field ?? '',
        diff ? diff.from : plainValue(e.before),
        diff ? diff.to : plainValue(e.after),
      ];
    }),
  );
}
