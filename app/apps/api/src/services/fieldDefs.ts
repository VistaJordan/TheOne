// Field-definition WRITES — the engine behind Admin › Custom fields (S7).
//
// What an admin may change, and what stays fixed:
//   label     rename freely. The label is the display name everywhere; the KEY
//             is the address inside task.fields and never changes (renaming the
//             key would orphan every value, saved view and audit row under it).
//   type      change freely. Values already in the bag are untouched — the
//             filter compiler's guarded casts (woFields.exprFor) treat a value
//             that no longer parses as "not set" instead of erroring.
//   options   the dropdown vocabulary, replaced whole (add/remove/reorder in
//             the editor, save the resulting list).
//   position  the ADMIN DEFAULT order of the detail page's All-fields tab —
//             each user may override it for themselves via user_pref.
//
// New fields get key = label verbatim: that is the convention the seeded
// catalogue already follows (a key is a human-readable name), and it keeps CSV
// import headers guessable. Deleting is deliberately absent for now — a field
// with values behind it should be hidden/retired, not destroyed, and that
// lifecycle is future work.

import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { invalidateFieldCache } from './woFields.js';
import type { FieldDefItem } from './adminMeta.js';
import { listFieldDefs } from './adminMeta.js';

/** Everything the field_type enum accepts (0001 + phone from 0007). */
export const FIELD_DEF_TYPES = [
  'short_text',
  'long_text',
  'dropdown',
  'checkbox',
  'date',
  'currency',
  'number',
  'users',
  'url',
  'phone',
  'location',
  'attachment',
  'formula',
  'rating',
] as const;

export type FieldDefType = (typeof FIELD_DEF_TYPES)[number];

function assertType(type: string): asserts type is FieldDefType {
  if (!FIELD_DEF_TYPES.includes(type as FieldDefType)) {
    throw new ApiError('BAD_REQUEST', `Unknown field type "${type}"`);
  }
}

function cleanOptions(raw: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of raw ?? []) {
    const s = o.trim();
    if (s.length === 0 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function typeConfigFor(type: FieldDefType, options: string[]): Record<string, unknown> {
  if (type === 'dropdown') return { options };
  if (type === 'formula') return { formula: true };
  return {};
}

async function getDef(id: string): Promise<FieldDefItem> {
  const all = await listFieldDefs();
  const found = all.find((f) => f.id === id);
  if (!found) throw new ApiError('NOT_FOUND', 'No such field');
  return found;
}

export interface FieldDefInput {
  label: string;
  type: string;
  options?: string[];
}

export async function createFieldDef(input: FieldDefInput): Promise<FieldDefItem> {
  const label = input.label.trim();
  if (label.length === 0) throw new ApiError('BAD_REQUEST', 'A field needs a name');
  assertType(input.type);

  const clash = await query<{ id: string }>(`SELECT id FROM field_def WHERE key = $1 LIMIT 1`, [
    label,
  ]);
  if (clash.rows[0]) {
    throw new ApiError('BAD_REQUEST', `A field named "${label}" already exists`);
  }

  // All defs live on the one seeded space; a fresh DB with none falls back to
  // the workspace so the INSERT still has a container to hang off.
  const container = await query<{ id: string }>(
    `SELECT container_id AS id FROM field_def LIMIT 1`,
  );
  const containerId =
    container.rows[0]?.id ??
    (await query<{ id: string }>(`SELECT id FROM container ORDER BY created_at ASC LIMIT 1`))
      .rows[0]?.id;
  if (!containerId) throw new ApiError('INTERNAL', 'No container exists to attach the field to');

  const options = cleanOptions(input.options);
  const res = await query<{ id: string }>(
    `INSERT INTO field_def (container_id, key, label, type, type_config, position)
     VALUES ($1, $2, $2, $3, $4::jsonb,
             (SELECT COALESCE(MAX(position), -1) + 1 FROM field_def))
     RETURNING id`,
    [containerId, label, input.type, JSON.stringify(typeConfigFor(input.type, options))],
  );

  invalidateFieldCache();
  return getDef(res.rows[0].id);
}

export interface FieldDefPatch {
  label?: string;
  type?: string;
  options?: string[];
}

export async function updateFieldDef(id: string, patch: FieldDefPatch): Promise<FieldDefItem> {
  const current = await getDef(id);

  const label = patch.label?.trim();
  if (label !== undefined && label.length === 0) {
    throw new ApiError('BAD_REQUEST', 'A field needs a name');
  }
  const type = patch.type ?? current.type;
  assertType(type);

  const options = patch.options !== undefined ? cleanOptions(patch.options) : current.options;

  await query(
    `UPDATE field_def
        SET label = COALESCE($2, label),
            type = $3,
            type_config = $4::jsonb
      WHERE id = $1`,
    [id, label ?? null, type, JSON.stringify(typeConfigFor(type, options))],
  );

  invalidateFieldCache();
  return getDef(id);
}

/** The admin default order: position = index in `ids`. Ids not listed keep
    their position but sink below the listed ones (they get max+offset). */
export async function reorderFieldDefs(ids: string[]): Promise<FieldDefItem[]> {
  if (ids.length === 0) throw new ApiError('BAD_REQUEST', 'Nothing to reorder');

  const existing = await query<{ id: string }>(`SELECT id FROM field_def`);
  const known = new Set(existing.rows.map((r) => r.id));
  for (const id of ids) {
    if (!known.has(id)) throw new ApiError('BAD_REQUEST', 'Unknown field in the new order');
  }

  for (let i = 0; i < ids.length; i++) {
    await query(`UPDATE field_def SET position = $2 WHERE id = $1`, [ids[i], i]);
  }

  invalidateFieldCache();
  return listFieldDefs();
}
