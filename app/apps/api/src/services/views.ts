// Saved views — the stored arrangements of the work-order list.
//
// A view is columns + filters + grouping + sorting under a name. It belongs to
// the principal who made it; marking it shared publishes it read-only to
// everyone else, which is how a team standardises on "AR chase list" without
// each person rebuilding it.
//
// Validation is deliberately strict on the way IN. A view outlives the session
// that made it, so a rule naming a field that does not exist would only surface
// later as a 400 on somebody else's screen — better to refuse it here, while
// the person who wrote it is still looking at the dialog.

import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { resolveField, OPS_BY_TYPE, type FilterSet, type SortSpec } from './woFields.js';

export interface SavedViewRecord {
  id: string;
  name: string;
  entity: string;
  columns: string[];
  filters: FilterSet;
  group_by: string | null;
  sort: SortSpec | null;
  is_shared: boolean;
  position: number;
  owner: { id: string; name: string };
  can_edit: boolean;
  created_at: string;
  updated_at: string;
}

interface ViewRow {
  id: string;
  name: string;
  entity: string;
  columns: unknown;
  filters: unknown;
  group_by: string | null;
  sort: unknown;
  is_shared: boolean;
  position: number | string;
  owner_principal_id: string;
  owner_name: string;
  created_at: string;
  updated_at: string;
}

const SELECT_VIEW = `
  SELECT v.id, v.name, v.entity, v.columns, v.filters, v.group_by, v.sort,
         v.is_shared, v.position, v.owner_principal_id,
         p.display_name AS owner_name,
         to_char((v.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
         to_char((v.updated_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
    FROM saved_view v
    JOIN principal p ON p.id = v.owner_principal_id`;

function mapView(r: ViewRow, viewerId: string): SavedViewRecord {
  return {
    id: r.id,
    name: r.name,
    entity: r.entity,
    columns: Array.isArray(r.columns) ? (r.columns as string[]) : [],
    filters: normalizeFilters(r.filters),
    group_by: r.group_by,
    sort: (r.sort as SortSpec | null) ?? null,
    is_shared: r.is_shared,
    position: Number(r.position),
    owner: { id: r.owner_principal_id, name: r.owner_name },
    // Sharing publishes a view; it does not hand over the pen.
    can_edit: r.owner_principal_id === viewerId,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function normalizeFilters(raw: unknown): FilterSet {
  const f = raw as FilterSet | null;
  if (!f || !Array.isArray(f.rules)) return { match: 'all', rules: [] };
  return { match: f.match === 'any' ? 'any' : 'all', rules: f.rules };
}

/** Mine, plus everyone's shared ones. Mine sort first: the view you built is
    the one you reach for. */
export async function listViews(viewerId: string, entity = 'work_order'): Promise<SavedViewRecord[]> {
  const res = await query<ViewRow>(
    `${SELECT_VIEW}
      WHERE v.entity = $1 AND (v.owner_principal_id = $2 OR v.is_shared)
      ORDER BY (v.owner_principal_id = $2) DESC, v.position ASC, v.name ASC`,
    [entity, viewerId],
  );
  return res.rows.map((r) => mapView(r, viewerId));
}

async function getViewRow(id: string): Promise<ViewRow> {
  const res = await query<ViewRow>(`${SELECT_VIEW} WHERE v.id = $1 LIMIT 1`, [id]);
  if (!res.rows[0]) throw new ApiError('NOT_FOUND', 'No such view');
  return res.rows[0];
}

export interface ViewInput {
  name: string;
  columns?: string[];
  filters?: FilterSet;
  group_by?: string | null;
  sort?: SortSpec | null;
  is_shared?: boolean;
  entity?: string;
}

/** Reject a view whose vocabulary the list cannot honour. See the header note. */
async function validate(input: ViewInput): Promise<void> {
  for (const key of input.columns ?? []) {
    await resolveField(key);
  }
  for (const rule of input.filters?.rules ?? []) {
    const f = await resolveField(rule.field);
    if (!OPS_BY_TYPE[f.type].includes(rule.op)) {
      throw new ApiError('BAD_REQUEST', `"${f.label}" does not support the "${rule.op}" test`, {
        field: rule.field,
        op: rule.op,
      });
    }
  }
  if (input.group_by) await resolveField(input.group_by);
  if (input.sort) await resolveField(input.sort.field);
}

export async function createView(ownerId: string, input: ViewInput): Promise<SavedViewRecord> {
  await validate(input);
  const entity = input.entity ?? 'work_order';

  const clash = await query<{ id: string }>(
    `SELECT id FROM saved_view WHERE owner_principal_id = $1 AND entity = $2 AND name = $3`,
    [ownerId, entity, input.name],
  );
  if (clash.rows[0]) {
    throw new ApiError('BAD_REQUEST', `You already have a view called "${input.name}"`);
  }

  const res = await query<{ id: string }>(
    `INSERT INTO saved_view
       (owner_principal_id, entity, name, columns, filters, group_by, sort, is_shared, position)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8,
             (SELECT COALESCE(MAX(position), 100) + 10 FROM saved_view WHERE owner_principal_id = $1))
     RETURNING id`,
    [
      ownerId,
      entity,
      input.name,
      JSON.stringify(input.columns ?? []),
      JSON.stringify(input.filters ?? { match: 'all', rules: [] }),
      input.group_by ?? null,
      input.sort ? JSON.stringify(input.sort) : null,
      input.is_shared ?? false,
    ],
  );
  return mapView(await getViewRow(res.rows[0].id), ownerId);
}

export async function updateView(
  id: string,
  viewerId: string,
  input: Partial<ViewInput>,
): Promise<SavedViewRecord> {
  const existing = await getViewRow(id);
  if (existing.owner_principal_id !== viewerId) {
    throw new ApiError('FORBIDDEN', 'Only the person who created a view can change it');
  }
  await validate(input as ViewInput);

  // COALESCE on the parameter, so an omitted key means "leave it" while an
  // explicitly-null group_by/sort means "clear it" — hence the flags.
  // Every parameter is cast explicitly. Postgres cannot infer the type of a
  // bare `$n` that only ever appears opposite NULL or inside a CASE, and an
  // uninferable parameter is an error, not a default.
  await query(
    `UPDATE saved_view
        SET name      = COALESCE($2::text, name),
            columns   = COALESCE($3::jsonb, columns),
            filters   = COALESCE($4::jsonb, filters),
            group_by  = CASE WHEN $5::boolean THEN $6::text ELSE group_by END,
            sort      = CASE WHEN $7::boolean THEN $8::jsonb ELSE sort END,
            is_shared = COALESCE($9::boolean, is_shared)
      WHERE id = $1`,
    [
      id,
      input.name ?? null,
      input.columns ? JSON.stringify(input.columns) : null,
      input.filters ? JSON.stringify(input.filters) : null,
      'group_by' in input,
      input.group_by ?? null,
      'sort' in input,
      input.sort ? JSON.stringify(input.sort) : null,
      input.is_shared ?? null,
    ],
  );
  return mapView(await getViewRow(id), viewerId);
}

export async function deleteView(id: string, viewerId: string): Promise<void> {
  const existing = await getViewRow(id);
  if (existing.owner_principal_id !== viewerId) {
    throw new ApiError('FORBIDDEN', 'Only the person who created a view can delete it');
  }
  await query(`DELETE FROM saved_view WHERE id = $1`, [id]);
}
