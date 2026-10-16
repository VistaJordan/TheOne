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

import { REDACTABLE_CORE_KEYS, auditTimestampET } from '@theone/shared';
import { query } from '../db.js';
import { CREATED_AT_SQL } from './activity.js';
import { toCsv } from './woBulk.js';
import { activityValuesVisible, redactActivityValues, type Allow } from './permissions.js';

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
  /** M28 · the values were withheld: the row names a field the reader cannot see. */
  redacted?: boolean;
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

/**
 * The WHERE clause of the audit list and its export. UAT T6: the free-text
 * search may match a row by its WO #, field name or entity, but its before /
 * after VALUES only on a row about no field, about something that is not a
 * catalogue field (status moves, visits, money records — activityFieldKey
 * names no field for them), or about a field on `visibleFields`, the reader's
 * allow-list. An allow-list, not a deny-list: a `fields.*` key nobody defined
 * (a deleted field_def) or a promoted core column the reader may not see is
 * never on it, so its values are never searched. Pure (exported for the
 * tests): it only builds SQL text and parameters.
 */
export function buildAuditWhere(
  f: Omit<AuditLogFilters, 'limit' | 'offset'>,
  visibleFields: readonly string[],
): { sql: string; params: unknown[] } {
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
    const visible = add([...visibleFields]);
    const core = add([...REDACTABLE_CORE_KEYS]);
    // 'fields.%' has no LIKE wildcard but the %: the dot and the word are literal.
    const valueSearchable = `(a.field IS NULL OR a.field = ANY(${visible}::text[]) OR (a.field NOT LIKE 'fields.%' AND NOT (a.field = ANY(${core}::text[]))))`;
    where.push(
      `(t.wo_number ILIKE ${h} OR t.ext_name ILIKE ${h} OR COALESCE(a.field, '') ILIKE ${h}
        OR a.entity_type ILIKE ${h}
        OR (${valueSearchable} AND (COALESCE(a.before::text, '') ILIKE ${h} OR COALESCE(a.after::text, '') ILIKE ${h})))`,
    );
  }
  return { sql: `WHERE ${where.join(' AND ')}`, params };
}

/** UAT T6 · the field spellings among `candidates` this reader may see
    (`visible` is activityValuesVisible bound to their grants). Pure. */
export function visibleAuditFields(candidates: readonly string[], visible: (key: string) => boolean): string[] {
  return candidates.filter((k) => visible(k));
}

/** Every catalogue field an audit row can name: the custom fields on file and
    the promoted core columns M28 redacts. A `fields.*` key with no field_def
    is not here, so the search never reads its values. */
async function auditFieldCandidates(): Promise<string[]> {
  const defs = await query<{ key: string }>(`SELECT DISTINCT key FROM field_def`);
  return [...defs.rows.map((r) => `fields.${r.key}`), ...REDACTABLE_CORE_KEYS];
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

export async function listAuditLog(
  f: AuditLogFilters,
  /** M28 · the reader's grants: a row on a field they cannot see keeps its
      who / when / what but loses its before and after. Required, so no
      caller can forget it. */
  allow: Allow,
): Promise<AuditLogPage> {
  // T6: the allow-list is only needed when there is text to search.
  const visible = f.q
    ? visibleAuditFields(await auditFieldCandidates(), (k) => activityValuesVisible(allow, k))
    : [];
  const { sql: whereSql, params } = buildAuditWhere(f, visible);

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
    items: rows.rows.map(mapRow).map((e) => redactActivityValues(allow, e)),
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
  fm_cico_method: 'Check-in method',
  saved_view: 'Saved view',
  export: 'Export',
  integration: 'Integration',
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
  allow: Allow,
): Promise<{ csv: string; rows: number }> {
  const page = await listAuditLog({ ...f, limit: AUDIT_EXPORT_CAP, offset: 0 }, allow);
  const csv = toCsv(
    // L2 (UAT Wave D): Eastern time, labelled; the UTC instant stays beside it.
    ['Time (ET)', 'Time (UTC)', 'User', 'Action', 'Entity', 'Name', 'WO #', 'Ext ref', 'Field', 'From', 'To'],
    page.items.map((e) => {
      const admin = e.entity_type !== 'task';
      const diff = admin ? snapshotDiff(e.before, e.after) : null;
      return [
        auditTimestampET(e.created_at),
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
  return { csv, rows: page.items.length };
}
