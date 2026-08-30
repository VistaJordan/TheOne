// Work-order service: list (filtered), detail, and the S1 status write path.
// All SQL is parameterized and run through @theone/db. Numeric/date columns are
// cast so the JSON matches the §5 contract (numbers not strings, dates as
// 'YYYY-MM-DD', timestamps as ISO-8601 UTC).

import { query, getDb } from '../db.js';
import type {
  WorkOrderListItem,
  WorkOrderListResponse,
  WorkOrderDetail,
  Status,
  StatusRef,
  Phase,
} from '@theone/shared';
import { PHASE_BY_STATUS_NAME } from '@theone/shared';
import { ApiError } from '../errors.js';
import { logTaskChanges } from './woAudit.js';
import { UUID_RE, CREATED_AT_SQL, getActivityForTask } from './activity.js';
import { computeMoney } from './money.js';
import { getBindableQuoteTotal } from './quotes.js';
import {
  Params,
  compileFilters,
  compileGroupExpr,
  compileSort,
  resolveField,
  type FilterSet,
  type SortSpec,
} from './woFields.js';

/**
 * Status name → lifecycle phase (S2 contract item 3). The map is a code-level
 * constant in @theone/shared (no DDL change); unknown names resolve to null so
 * a future status can be seeded without breaking this endpoint.
 */
function phaseFor(statusName: string): Phase | null {
  return PHASE_BY_STATUS_NAME[statusName] ?? null;
}

export interface ListFilters {
  status_group?: string;
  status_id?: string;
  search?: string;
  /** The saved-view filter set — any field, any operator (services/woFields.ts). */
  filters?: FilterSet;
  sort?: SortSpec | null;
  /** Bucket the whole filtered set by this field and return per-bucket counts. */
  group_by?: string | null;
  /** Column keys the caller will render. Custom ones are projected onto `custom`. */
  columns?: string[];
  limit: number;
  offset: number;
}

interface WoRow {
  id: string;
  wo_number: string;
  ext_name: string | null;
  title: string;
  client: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  billing_entity: string | null;
  nte: number | null;
  priority: string | null;
  date_received: string | null;
  home_list: string | null;
  status_id: string;
  status_name: string;
  status_group: StatusRef['group'];
  status_color: string;
  age_days: number | null;
  created_at: string | null;
  updated_at: string | null;
  /** Aliased custom-field columns (c0, c1, …), present only when requested. */
  [alias: string]: unknown;
}

/** `customByAlias` maps the c0/c1/… aliases back to their field keys. */
function mapListItem(r: WoRow, customByAlias: Map<string, string>): WorkOrderListItem {
  const custom: Record<string, string | null> = {};
  for (const [alias, key] of customByAlias) {
    const v = r[alias];
    custom[key] = v === undefined || v === null ? null : String(v);
  }
  return {
    id: r.id,
    wo_number: r.wo_number,
    ext_name: r.ext_name,
    title: r.title,
    client: r.client,
    city: r.city,
    state: r.state,
    trade: r.trade,
    billing_entity: r.billing_entity,
    nte: r.nte === null ? null : Number(r.nte),
    priority: (r.priority as WorkOrderListItem['priority']) ?? null,
    date_received: r.date_received,
    home_list: r.home_list,
    status: { id: r.status_id, name: r.status_name, group: r.status_group, color: r.status_color },
    age_days: r.age_days === null ? null : Number(r.age_days),
    created_at: r.created_at,
    updated_at: r.updated_at,
    custom: customByAlias.size > 0 ? custom : undefined,
  };
}

// Shared SELECT projection for a work-order row (list + detail base columns).
const WO_SELECT = `
  t.id, t.wo_number, t.ext_name, t.title, t.client, t.city, t.state, t.trade,
  t.billing_entity, t.nte::float8 AS nte, t.priority,
  t.date_received::text AS date_received,
  hl.name AS home_list,
  s.id AS status_id, s.name AS status_name, s.status_group AS status_group, s.color AS status_color,
  (now()::date - t.date_received) AS age_days,
  to_char((t.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char((t.updated_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
`;

const WO_FROM = `
  FROM task t
  JOIN status s ON s.id = t.status_id
  LEFT JOIN container hl ON hl.id = t.home_list_id
`;

/**
 * The WHERE clause every list-shaped read shares — the list itself, the export,
 * the group counts, and "select every row that matches, not just the page I can
 * see". Built once so those four can never drift apart and show the user a
 * different set than the one they are acting on.
 *
 * Returns the clause plus the parameter accumulator it was built into; the
 * caller keeps appending to that same accumulator for ORDER BY / LIMIT.
 */
async function buildListWhere(
  f: Omit<ListFilters, 'limit' | 'offset'>,
): Promise<{ sql: string; p: Params }> {
  const p = new Params();
  const where: string[] = ['t.deleted_at IS NULL'];

  // The three legacy scalar params still work: the segmented status-group tabs
  // and the topbar search predate the filter builder and are cheaper to express
  // as their own arguments than as a synthesised rule.
  if (f.status_group) where.push(`t.status_group = ${p.add(f.status_group)}`);
  if (f.status_id) where.push(`t.status_id = ${p.add(f.status_id)}`);
  if (f.search) {
    const hole = p.add(`%${f.search}%`);
    // The topbar search is now global, so this is what "find a work order by
    // anything you can see on the row" has to cover — title and trade included.
    where.push(
      `(t.wo_number ILIKE ${hole} OR t.ext_name ILIKE ${hole} OR t.title ILIKE ${hole}
        OR t.client ILIKE ${hole} OR t.city ILIKE ${hole} OR t.state ILIKE ${hole}
        OR t.trade ILIKE ${hole})`,
    );
  }

  const compiled = await compileFilters(f.filters ?? { match: 'all', rules: [] }, p);
  if (compiled) where.push(compiled);

  return { sql: `WHERE ${where.join(' AND ')}`, p };
}

/** A `group_by` bucket over the WHOLE filtered set, not just the current page —
    a collapsed group has to be able to say how many rows it is hiding. */
async function groupCounts(
  f: Omit<ListFilters, 'limit' | 'offset'>,
  whereSql: string,
  whereParams: unknown[],
): Promise<{ key: string | null; count: number }[]> {
  const p = new Params();
  for (const v of whereParams) p.add(v);
  const expr = await compileGroupExpr(f.group_by as string, p);

  const res = await query<{ gkey: string | null; n: number | string }>(
    `SELECT ${expr} AS gkey, COUNT(*)::int AS n
       ${WO_FROM} ${whereSql}
      GROUP BY 1
      ORDER BY 1 ASC NULLS LAST`,
    p.values,
  );
  return res.rows.map((r) => ({
    // '' and NULL are the same thing to a reader — one "(empty)" bucket.
    key: r.gkey == null || r.gkey === '' ? null : r.gkey,
    count: Number(r.n),
  }));
}

export async function listWorkOrders(f: ListFilters): Promise<WorkOrderListResponse> {
  const { sql: whereSql, p } = await buildListWhere(f);
  // Snapshot before ORDER BY / LIMIT append to the same accumulator: the count
  // and the group query need the WHERE parameters and nothing after them.
  const whereParams = [...p.values];

  const totalRes = await query<{ total: number | string }>(
    `SELECT COUNT(*)::int AS total ${WO_FROM} ${whereSql}`,
    whereParams,
  );
  const total = Number(totalRes.rows[0].total);

  // Custom-field columns are projected on demand. Sending the whole `fields`
  // bag would put ~100 keys on every row to render the two the user picked.
  const { selectSql, customByAlias } = await customProjection(f.columns ?? [], p);

  // A grouped list has to sort by its group key first, or the buckets interleave.
  const groupOrder = f.group_by ? `${await compileGroupExpr(f.group_by, p)} ASC NULLS LAST, ` : '';
  const orderSql = groupOrder + (await compileSort(f.sort ?? null, p));

  const rows = await query<WoRow>(
    `SELECT ${WO_SELECT}${selectSql} ${WO_FROM} ${whereSql}
      ORDER BY ${orderSql}
      LIMIT ${p.add(f.limit)} OFFSET ${p.add(f.offset)}`,
    p.values,
  );

  return {
    items: rows.rows.map((r) => mapListItem(r, customByAlias)),
    total,
    limit: f.limit,
    offset: f.offset,
    groups: f.group_by ? await groupCounts(f, whereSql, whereParams) : undefined,
  };
}

/** SELECT fragment + alias→key map for the custom fields among `columns`. */
async function customProjection(
  columns: string[],
  p: Params,
): Promise<{ selectSql: string; customByAlias: Map<string, string> }> {
  const customByAlias = new Map<string, string>();
  const parts: string[] = [];
  for (const key of columns) {
    if (!key.startsWith('fields.')) continue;
    const f = await resolveField(key);
    const alias = `c${customByAlias.size}`;
    customByAlias.set(alias, key);
    parts.push(`(t.fields->>${p.add(f.jsonKey)}) AS ${alias}`);
  }
  return { selectSql: parts.length ? `, ${parts.join(', ')}` : '', customByAlias };
}

/**
 * Every id matching the current filters — what "select all 1,240" and the CSV
 * export both need. Capped: a bulk edit is a deliberate act on a set the user
 * can describe, not a way to rewrite the entire database in one request.
 */
export const BULK_SELECTION_CAP = 5000;

export async function listMatchingIds(
  f: Omit<ListFilters, 'limit' | 'offset'>,
): Promise<string[]> {
  const { sql: whereSql, p } = await buildListWhere(f);
  const res = await query<{ id: string }>(
    `SELECT t.id ${WO_FROM} ${whereSql} ORDER BY t.created_at DESC LIMIT ${p.add(BULK_SELECTION_CAP)}`,
    p.values,
  );
  return res.rows.map((r) => r.id);
}

interface DetailBaseRow extends WoRow {
  description: string | null;
  fields: Record<string, unknown>;
}

/** Full detail object (§5 GET /:id). Returns null when the WO does not exist. */
export async function getWorkOrderDetail(idOrWo: string): Promise<WorkOrderDetail | null> {
  const col = UUID_RE.test(idOrWo) ? 't.id' : 't.wo_number';
  const baseRes = await query<DetailBaseRow>(
    `SELECT ${WO_SELECT}, t.description, t.fields
     ${WO_FROM}
     WHERE ${col} = $1 AND t.deleted_at IS NULL
     LIMIT 1`,
    [idOrWo],
  );
  if (baseRes.rows.length === 0) return null;
  const r = baseRes.rows[0];

  const memRes = await query<{ list_id: string; list_name: string; is_home: boolean }>(
    `SELECT m.list_id, c.name AS list_name, m.is_home
       FROM task_list_membership m
       JOIN container c ON c.id = m.list_id
      WHERE m.task_id = $1
      ORDER BY m.is_home DESC, c.name ASC`,
    [r.id],
  );

  const recent = await getActivityForTask(r.id, 50);

  // S4 · a real quote outranks the (absent) ClickUp field. Only an APPROVED or
  // SENT quote counts — a draft is not a price the NTE meter may bind to
  // (product/quotes-payments.md §1) — so `quote` stays null until then.
  const money = computeMoney(r.fields, r.nte === null ? null : Number(r.nte));
  const quoteTotal = await getBindableQuoteTotal(r.id);
  if (quoteTotal !== null) money.quote = quoteTotal;

  return {
    id: r.id,
    wo_number: r.wo_number,
    ext_name: r.ext_name,
    title: r.title,
    description: r.description,
    client: r.client,
    city: r.city,
    state: r.state,
    trade: r.trade,
    billing_entity: r.billing_entity,
    nte: r.nte === null ? null : Number(r.nte),
    priority: (r.priority as WorkOrderDetail['priority']) ?? null,
    date_received: r.date_received,
    status: {
      id: r.status_id,
      name: r.status_name,
      group: r.status_group,
      color: r.status_color,
    },
    fields: r.fields ?? {},
    money,
    memberships: memRes.rows.map((m) => ({
      list_id: m.list_id,
      list_name: m.list_name,
      is_home: m.is_home,
    })),
    recent_activity: recent,
  };
}

export async function listStatuses(): Promise<Status[]> {
  const res = await query<{
    id: string;
    name: string;
    group: StatusRef['group'];
    color: string;
    position: number | string;
    is_archive: boolean;
  }>(
    `SELECT id, name, status_group AS "group", color, position, is_archive
       FROM status ORDER BY position ASC`,
  );
  return res.rows.map((s) => ({
    id: s.id,
    name: s.name,
    group: s.group,
    color: s.color,
    position: Number(s.position),
    is_archive: s.is_archive,
    phase: phaseFor(s.name),
  }));
}

/**
 * The S1 write path (§5 PATCH /:id/status). In one transaction: read current
 * status; if changed, UPDATE task + INSERT a 'status_changed' activity row.
 * No-op change writes nothing. Returns the updated detail object.
 * Throws ApiError NOT_FOUND (missing WO) / BAD_REQUEST (unknown status_id).
 */
export async function changeStatus(
  idOrWo: string,
  statusId: string,
  actorId: string,
): Promise<WorkOrderDetail> {
  const col = UUID_RE.test(idOrWo) ? 'id' : 'wo_number';
  const db = getDb();

  // Resolve the actor BEFORE opening the transaction. PGlite is single-connection:
  // calling the non-transactional query() from inside db.transaction() would queue
  // behind the open transaction and self-deadlock.

  await db.transaction(async (tx) => {
    // Current task + status.
    const cur = await tx.query<{ task_id: string; status_id: string; status_name: string }>(
      `SELECT t.id AS task_id, t.status_id, s.name AS status_name
         FROM task t JOIN status s ON s.id = t.status_id
        WHERE t.${col} = $1 AND t.deleted_at IS NULL
        LIMIT 1`,
      [idOrWo],
    );
    if (cur.rows.length === 0) {
      throw new ApiError('NOT_FOUND', 'Work order not found');
    }
    const { task_id, status_id: currentStatusId, status_name: currentStatusName } = cur.rows[0];

    // Target status must exist.
    const target = await tx.query<{ id: string; name: string; status_group: string }>(
      `SELECT id, name, status_group FROM status WHERE id = $1 LIMIT 1`,
      [statusId],
    );
    if (target.rows.length === 0) {
      throw new ApiError('BAD_REQUEST', 'Unknown status_id', { status_id: statusId });
    }
    const { name: newStatusName, status_group: newGroup } = target.rows[0];

    // No-op change: return without writing a log row.
    if (currentStatusId === statusId) return;

    await tx.query(
      `UPDATE task SET status_id = $1, status_group = $2, updated_at = now() WHERE id = $3`,
      [statusId, newGroup, task_id],
    );

    await logTaskChanges(tx, actorId, task_id, [
      {
        field: 'status_id',
        before: { status_id: currentStatusId, status_name: currentStatusName },
        after: { status_id: statusId, status_name: newStatusName },
      },
    ]);
  });

  // Return the fresh detail object (same shape as GET /:id).
  const detail = await getWorkOrderDetail(idOrWo);
  if (!detail) throw new ApiError('NOT_FOUND', 'Work order not found');
  return detail;
}
