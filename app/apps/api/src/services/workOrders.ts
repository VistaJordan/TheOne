// Work-order service: list (filtered), detail, and the S1 status write path.
// All SQL is parameterized and run through @theone/db. Numeric/date columns are
// cast so the JSON matches the §5 contract (numbers not strings, dates as
// 'YYYY-MM-DD', timestamps as ISO-8601 UTC).

import { query, withTransaction } from '../db.js';
import type {
  WorkOrderListItem,
  WorkOrderListResponse,
  WorkOrderDetail,
  ObligationSummary,
  Status,
  StatusRef,
  Phase,
} from '@theone/shared';
import { PHASE_BY_STATUS_NAME } from '@theone/shared';
import { ApiError } from '../errors.js';
import { UUID_RE, CREATED_AT_SQL, resolveActorId, getActivityForTask } from './activity.js';
import { computeMoney } from './money.js';
import { getBindableQuoteTotal } from './quotes.js';
import { obligationsReady, worstObligationsByTask, evaluateForTask } from './obligations.js';

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
  limit: number;
  offset: number;
  /** S5 · `breach` = worst obligation first (tier desc, then closest to breach). */
  sort?: 'breach';
}

/**
 * S5 · a list row carrying its worst live obligation — the table's Clock column.
 *
 * Declared HERE, not by widening `WorkOrderListItem` in @theone/shared: apps/web
 * already extends that interface (`WorkOrderListItemV2`) with an OPTIONAL member
 * of its own, and adding a required one upstream would make its declaration
 * illegal. The extra key simply rides on the wire.
 */
export interface WorkOrderListItemS5 extends WorkOrderListItem {
  worst_obligation: ObligationSummary | null;
}

export interface WorkOrderListResponseS5 extends Omit<WorkOrderListResponse, 'items'> {
  items: WorkOrderListItemS5[];
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
}

function mapListItem(r: WoRow): WorkOrderListItem {
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
  };
}

// Shared SELECT projection for a work-order row (list + detail base columns).
const WO_SELECT = `
  t.id, t.wo_number, t.ext_name, t.title, t.client, t.city, t.state, t.trade,
  t.billing_entity, t.nte::float8 AS nte, t.priority,
  t.date_received::text AS date_received,
  hl.name AS home_list,
  s.id AS status_id, s.name AS status_name, s.status_group AS status_group, s.color AS status_color,
  (now()::date - t.date_received) AS age_days
`;

const WO_FROM = `
  FROM task t
  JOIN status s ON s.id = t.status_id
  LEFT JOIN container hl ON hl.id = t.home_list_id
`;

export async function listWorkOrders(f: ListFilters): Promise<WorkOrderListResponseS5> {
  const where: string[] = ['t.deleted_at IS NULL'];
  const params: unknown[] = [];

  if (f.status_group) {
    params.push(f.status_group);
    where.push(`t.status_group = $${params.length}`);
  }
  if (f.status_id) {
    params.push(f.status_id);
    where.push(`t.status_id = $${params.length}`);
  }
  if (f.search) {
    params.push(`%${f.search}%`);
    const p = `$${params.length}`;
    where.push(
      `(t.wo_number ILIKE ${p} OR t.ext_name ILIKE ${p} OR t.client ILIKE ${p} OR t.city ILIKE ${p})`,
    );
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const totalRes = await query<{ total: number | string }>(
    `SELECT COUNT(*)::int AS total FROM task t ${whereSql}`,
    params,
  );
  const total = Number(totalRes.rows[0].total);

  // S5 · `?sort=breach`. The ordering has to happen in SQL, not after the fact:
  // sorting the current page would only reorder 50 arbitrary rows, whereas the
  // point of the toggle is to bring the worst work orders in the WHOLE list to
  // the top of page one. The LATERAL join picks each task's worst live
  // obligation; rows with none sort last, then the previous default ordering
  // breaks every remaining tie so the sequence stays deterministic.
  //
  // Guarded by obligationsReady(): before migration 0004 the `obligation` table
  // does not exist, and a running API must keep answering this endpoint.
  const ready = await obligationsReady();
  const breachSort = f.sort === 'breach' && ready;
  const breachJoin = breachSort
    ? `LEFT JOIN LATERAL (
         SELECT o.tier, o.due_at
           FROM obligation o
          WHERE o.task_id = t.id AND o.status <> 'resolved'
          ORDER BY o.tier DESC, o.due_at ASC
          LIMIT 1
       ) ob ON true`
    : '';
  const orderSql = breachSort
    ? `ORDER BY (ob.tier IS NULL) ASC, ob.tier DESC, ob.due_at ASC, t.created_at DESC, t.wo_number ASC`
    : `ORDER BY t.created_at DESC, t.wo_number ASC`;

  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;
  const rows = await query<WoRow>(
    `SELECT ${WO_SELECT} ${WO_FROM} ${breachJoin} ${whereSql}
     ${orderSql}
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, f.limit, f.offset],
  );

  // The Clock column is decorated with a SECOND, small query rather than folded
  // into the projection above: one `IN (…)` over the page's ids is cheaper than
  // a correlated subquery per row, and it keeps the S1 projection untouched.
  const worst = await worstObligationsByTask(rows.rows.map((r) => r.id));
  const items: WorkOrderListItemS5[] = rows.rows.map((r) => {
    const w = worst.get(r.id);
    return {
      ...mapListItem(r),
      worst_obligation: w
        ? {
            id: w.id,
            rule_key: w.rule_key,
            label: w.label,
            tier: w.tier,
            state: w.state,
            due_at: w.due_at,
            started_at: w.started_at,
            wo_id: r.id,
            wo_number: r.wo_number,
          }
        : null,
    };
  });

  return { items, total, limit: f.limit, offset: f.offset };
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
  actorHeader: string | undefined,
): Promise<WorkOrderDetail> {
  const col = UUID_RE.test(idOrWo) ? 'id' : 'wo_number';

  // Resolve the actor BEFORE opening the transaction. PGlite is single-connection:
  // calling the non-transactional query() from inside db.transaction() would queue
  // behind the open transaction and self-deadlock.
  const actorId = await resolveActorId(actorHeader);

  await withTransaction(async (tx) => {
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

    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'status_changed', 'status_id', $3::jsonb, $4::jsonb)`,
      [
        actorId,
        task_id,
        JSON.stringify({ status_id: currentStatusId, status_name: currentStatusName }),
        JSON.stringify({ status_id: statusId, status_name: newStatusName }),
      ],
    );
  });

  // Return the fresh detail object (same shape as GET /:id).
  const detail = await getWorkOrderDetail(idOrWo);
  if (!detail) throw new ApiError('NOT_FOUND', 'Work order not found');

  // S5 · a status change is the single biggest silencer in the engine — it ends
  // schedule_owed, approval_followup, quote_owed and sla_blown, and starts
  // whatever the new status owes. Re-evaluate this work order inline, AFTER the
  // transaction has committed (PGlite is single-connection). evaluateForTask
  // never throws, so the status change cannot fail because of a clock.
  await evaluateForTask(detail.id);
  return detail;
}
