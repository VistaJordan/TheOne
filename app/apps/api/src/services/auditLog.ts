// The global audit log — every activity_log row across the product, joined to
// who did it and (for work-order rows) which WO it touched. The per-WO trail
// on the detail page reads the same table filtered to one task; this is the
// admin's view across all of them, filterable and exportable.
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
        OR COALESCE(a.before::text, '') ILIKE ${h} OR COALESCE(a.after::text, '') ILIKE ${h})`,
    );
  }
  return { sql: `WHERE ${where.join(' AND ')}`, params };
}

const FROM_SQL = `
  FROM activity_log a
  JOIN principal p ON p.id = a.actor_principal_id
  LEFT JOIN task t ON a.entity_type = 'task' AND t.id = a.entity_id`;

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
    `SELECT a.id, a.action, a.field, a.before, a.after, a.entity_type,
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

export async function exportAuditCsv(
  f: Omit<AuditLogFilters, 'limit' | 'offset'>,
): Promise<string> {
  const page = await listAuditLog({ ...f, limit: AUDIT_EXPORT_CAP, offset: 0 });
  return toCsv(
    ['Time (UTC)', 'User', 'Action', 'WO #', 'Ext ref', 'Field', 'From', 'To'],
    page.items.map((e) => [
      e.created_at,
      e.actor.display_name,
      e.action,
      e.wo_number ?? '',
      e.ext_name ?? '',
      e.field ?? '',
      plainValue(e.before),
      plainValue(e.after),
    ]),
  );
}
