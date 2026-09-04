// Status & phase-group WRITES — the engine behind Admin › Workflows.
//
// What an admin may change, and the guard rails:
//   status name    rename freely. Work orders point at the status by id, so
//                  nothing is orphaned — but the two KPI tiles and the phase
//                  bar match by NAME, so renaming those statuses degrades them
//                  (the admin page says which ones).
//   status color   any #rrggbb. Feeds pills, dots and the menu circles.
//   new status     appended to the chosen group (position = max+1).
//   delete status  only when NO work order sits at it (trashed ones count too —
//                  the FK still points at it); otherwise the caller is told to
//                  move them first.
//   phase group    add freely; rename the label (the CODE is the stable id
//                  saved views filter on and never changes); delete only a
//                  non-built-in group with no statuses left in it.

import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { invalidateFieldCache } from './woFields.js';
import type { WorkflowItem } from './adminMeta.js';

export interface StatusGroupRow {
  code: string;
  label: string;
  position: number;
  is_builtin: boolean;
  status_count: number;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function listStatusGroups(): Promise<StatusGroupRow[]> {
  const res = await query<StatusGroupRow>(
    `SELECT g.code, g.label, g.position, g.is_builtin,
            (SELECT COUNT(*)::int FROM status s WHERE s.status_group = g.code) AS status_count
       FROM status_group_def g
      ORDER BY g.position ASC`,
  );
  return res.rows;
}

async function getStatusRow(id: string): Promise<WorkflowItem> {
  const res = await query<WorkflowItem>(
    `SELECT s.id, s.name, s.status_group, s.color, s.position, s.is_archive,
            (SELECT COUNT(*)::int FROM task t
              WHERE t.status_id = s.id AND t.deleted_at IS NULL) AS wo_count
       FROM status s WHERE s.id = $1 LIMIT 1`,
    [id],
  );
  if (!res.rows[0]) throw new ApiError('NOT_FOUND', 'No such status');
  return res.rows[0];
}

function assertColor(color: string): void {
  if (!COLOR_RE.test(color)) {
    throw new ApiError('BAD_REQUEST', 'Color must be a #rrggbb hex value');
  }
}

// ── Statuses ─────────────────────────────────────────────────────────────────

export interface CreateStatusInput {
  name: string;
  group: string;
  color?: string;
}

export async function createStatus(input: CreateStatusInput): Promise<WorkflowItem> {
  const name = input.name.trim();
  if (name.length === 0) throw new ApiError('BAD_REQUEST', 'A status needs a name');
  const color = input.color ?? '#656f7d';
  assertColor(color);

  const group = await query<{ code: string }>(
    `SELECT code FROM status_group_def WHERE code = $1 LIMIT 1`,
    [input.group],
  );
  if (!group.rows[0]) throw new ApiError('BAD_REQUEST', `Unknown phase group "${input.group}"`);

  // All statuses live on the one seeded pipeline set.
  const set = await query<{ id: string }>(
    `SELECT status_set_id AS id FROM status LIMIT 1`,
  );
  const setId =
    set.rows[0]?.id ??
    (await query<{ id: string }>(`SELECT id FROM status_set LIMIT 1`)).rows[0]?.id;
  if (!setId) throw new ApiError('INTERNAL', 'No status set exists to attach the status to');

  const clash = await query<{ id: string }>(
    `SELECT id FROM status WHERE status_set_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [setId, name],
  );
  if (clash.rows[0]) throw new ApiError('BAD_REQUEST', `A status named "${name}" already exists`);

  const res = await query<{ id: string }>(
    `INSERT INTO status (status_set_id, name, status_group, color, position, is_archive)
     VALUES ($1, $2, $3, $4,
             (SELECT COALESCE(MAX(position), -1) + 1 FROM status), false)
     RETURNING id`,
    [setId, name, input.group, color],
  );

  invalidateFieldCache();
  return getStatusRow(res.rows[0].id);
}

export interface StatusPatch {
  name?: string;
  color?: string;
}

export async function updateStatus(id: string, patch: StatusPatch): Promise<WorkflowItem> {
  const current = await getStatusRow(id);

  const name = patch.name?.trim();
  if (name !== undefined && name.length === 0) {
    throw new ApiError('BAD_REQUEST', 'A status needs a name');
  }
  if (patch.color !== undefined) assertColor(patch.color);

  if (name && name.toLowerCase() !== current.name.toLowerCase()) {
    const clash = await query<{ id: string }>(
      `SELECT id FROM status WHERE lower(name) = lower($1) AND id <> $2 LIMIT 1`,
      [name, id],
    );
    if (clash.rows[0]) throw new ApiError('BAD_REQUEST', `A status named "${name}" already exists`);
  }

  await query(
    `UPDATE status
        SET name = COALESCE($2, name),
            color = COALESCE($3, color),
            updated_at = now()
      WHERE id = $1`,
    [id, name ?? null, patch.color ?? null],
  );

  invalidateFieldCache();
  return getStatusRow(id);
}

export async function deleteStatus(id: string): Promise<void> {
  await getStatusRow(id); // 404 before any counting

  // Trashed work orders still reference the status (hard FK), so they block
  // the delete too — restoring one must not resurrect a dangling status_id.
  const refs = await query<{ n: number; trashed: number }>(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS trashed
       FROM task WHERE status_id = $1`,
    [id],
  );
  const { n, trashed } = refs.rows[0];
  if (n > 0) {
    const trashNote = trashed > 0 ? ` (${trashed} in the trash)` : '';
    throw new ApiError(
      'BAD_REQUEST',
      `${n} work order${n === 1 ? ' is' : 's are'} at this status${trashNote} — move them to another status first`,
      { wo_count: n, trashed },
    );
  }

  await query(`DELETE FROM status WHERE id = $1`, [id]);
  invalidateFieldCache();
}

// ── Phase groups ─────────────────────────────────────────────────────────────

/** label → a stable code: lower-case, runs of non-alphanumerics collapse to _ . */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export async function createStatusGroup(label: string): Promise<StatusGroupRow> {
  const clean = label.trim();
  if (clean.length === 0) throw new ApiError('BAD_REQUEST', 'A phase needs a name');

  let code = slugify(clean);
  if (code.length === 0) throw new ApiError('BAD_REQUEST', 'The phase name needs at least one letter or digit');

  const taken = await query<{ code: string }>(`SELECT code FROM status_group_def`);
  const existing = new Set(taken.rows.map((r) => r.code));
  if (existing.has(code)) {
    let i = 2;
    while (existing.has(`${code}_${i}`)) i++;
    code = `${code}_${i}`;
  }

  await query(
    `INSERT INTO status_group_def (code, label, position)
     VALUES ($1, $2, (SELECT COALESCE(MAX(position), -1) + 1 FROM status_group_def))`,
    [code, clean],
  );

  invalidateFieldCache();
  const rows = await listStatusGroups();
  return rows.find((g) => g.code === code)!;
}

export async function renameStatusGroup(code: string, label: string): Promise<StatusGroupRow> {
  const clean = label.trim();
  if (clean.length === 0) throw new ApiError('BAD_REQUEST', 'A phase needs a name');

  const res = await query<{ code: string }>(
    `UPDATE status_group_def SET label = $2 WHERE code = $1 RETURNING code`,
    [code, clean],
  );
  if (!res.rows[0]) throw new ApiError('NOT_FOUND', 'No such phase group');

  invalidateFieldCache();
  const rows = await listStatusGroups();
  return rows.find((g) => g.code === code)!;
}

export async function deleteStatusGroup(code: string): Promise<void> {
  const res = await query<{ is_builtin: boolean; status_count: number }>(
    `SELECT g.is_builtin,
            (SELECT COUNT(*)::int FROM status s WHERE s.status_group = g.code) AS status_count
       FROM status_group_def g WHERE g.code = $1 LIMIT 1`,
    [code],
  );
  if (!res.rows[0]) throw new ApiError('NOT_FOUND', 'No such phase group');
  if (res.rows[0].is_builtin) {
    throw new ApiError('BAD_REQUEST', 'The built-in phases cannot be deleted');
  }
  if (res.rows[0].status_count > 0) {
    throw new ApiError('BAD_REQUEST', 'Delete or move its statuses first');
  }

  await query(`DELETE FROM status_group_def WHERE code = $1`, [code]);
  invalidateFieldCache();
}
