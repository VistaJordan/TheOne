// Roles — list, create, edit, delete.
//
// Replaces the hardcoded QUOTE_EDIT_ROLES / QUOTE_APPROVE_ROLES arrays as the
// source of truth. Those constants still exist in @theone/shared for the
// migration's benefit, but nothing reads them for an authorization decision
// any more: the capabilities travel on the session (services/auth.ts).

import { query } from '../db.js';
import { ApiError } from '../errors.js';

export interface RoleRecord {
  id: string;
  code: string;
  label: string;
  description: string | null;
  is_system: boolean;
  can_edit_quote: boolean;
  can_approve_quote: boolean;
  can_manage_users: boolean;
  can_edit_wo_fields: boolean;
  can_view_field_history: boolean;
  position: number;
  /** How many non-disabled humans currently hold it. */
  user_count: number;
}

const SELECT_ROLE = `
  SELECT r.id, r.code, r.label, r.description, r.is_system,
         r.can_edit_quote, r.can_approve_quote, r.can_manage_users,
         r.can_edit_wo_fields, r.can_view_field_history, r.position,
         (SELECT COUNT(*)::int FROM principal p
           WHERE p.role = r.code AND p.status <> 'disabled') AS user_count
    FROM role r`;

export async function listRoles(): Promise<RoleRecord[]> {
  const res = await query<RoleRecord>(`${SELECT_ROLE} ORDER BY r.position ASC, r.label ASC`);
  return res.rows;
}

async function getRole(id: string): Promise<RoleRecord> {
  const res = await query<RoleRecord>(`${SELECT_ROLE} WHERE r.id = $1 LIMIT 1`, [id]);
  if (!res.rows[0]) throw new ApiError('NOT_FOUND', 'No such role');
  return res.rows[0];
}

/** Codes are what land in `principal.role`, so keep them machine-shaped. */
function normalizeCode(raw: string): string {
  const code = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (code.length < 2) {
    throw new ApiError('BAD_REQUEST', 'A role code needs at least two letters or digits');
  }
  return code;
}

export interface RoleInput {
  code?: string;
  label: string;
  description?: string | null;
  can_edit_quote?: boolean;
  can_approve_quote?: boolean;
  can_manage_users?: boolean;
  can_edit_wo_fields?: boolean;
  can_view_field_history?: boolean;
}

export async function createRole(input: RoleInput): Promise<RoleRecord> {
  // Derive the code from the label when none is supplied — "Regional Manager"
  // becomes `regional_manager`, which is what an operator expects and saves
  // them inventing an identifier they will never see again.
  const code = normalizeCode(input.code?.trim() || input.label);

  const clash = await query<{ code: string }>(`SELECT code FROM role WHERE code = $1`, [code]);
  if (clash.rows[0]) {
    throw new ApiError('BAD_REQUEST', `A role with the code "${code}" already exists`);
  }

  const res = await query<{ id: string }>(
    `INSERT INTO role (code, label, description, is_system,
                       can_edit_quote, can_approve_quote, can_manage_users,
                       can_edit_wo_fields, can_view_field_history, position)
     VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8,
             (SELECT COALESCE(MAX(position), 100) + 10 FROM role))
     RETURNING id`,
    [
      code,
      input.label.trim(),
      input.description?.trim() || null,
      input.can_edit_quote ?? false,
      input.can_approve_quote ?? false,
      input.can_manage_users ?? false,
      input.can_edit_wo_fields ?? false,
      input.can_view_field_history ?? false,
    ],
  );
  return getRole(res.rows[0].id);
}

export async function updateRole(id: string, input: Partial<RoleInput>): Promise<RoleRecord> {
  const current = await getRole(id);

  // A system role's CODE is referenced by the seed and by migration 0005, so it
  // is fixed. Its label, description and capabilities stay editable — renaming
  // "ATL" or changing what it may approve is exactly what this screen is for.
  if (input.code && input.code !== current.code && current.is_system) {
    throw new ApiError('BAD_REQUEST', `"${current.label}" is a built-in role — its code cannot change`);
  }

  const code = input.code ? normalizeCode(input.code) : null;
  if (code && code !== current.code) {
    const clash = await query<{ code: string }>(`SELECT code FROM role WHERE code = $1`, [code]);
    if (clash.rows[0]) throw new ApiError('BAD_REQUEST', `The code "${code}" is already taken`);
  }

  // Never let the last user-managing role lose that capability: it is the only
  // way back into this screen if every super admin is also gone.
  if (input.can_manage_users === false && current.can_manage_users) {
    const others = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM role WHERE can_manage_users = true AND id <> $1`,
      [id],
    );
    if (others.rows[0].n === 0) {
      throw new ApiError('BAD_REQUEST', 'This is the only role that can manage users');
    }
  }

  await query(
    `UPDATE role
        SET code                   = COALESCE($2, code),
            label                  = COALESCE($3, label),
            description            = COALESCE($4, description),
            can_edit_quote         = COALESCE($5, can_edit_quote),
            can_approve_quote      = COALESCE($6, can_approve_quote),
            can_manage_users       = COALESCE($7, can_manage_users),
            can_edit_wo_fields     = COALESCE($8, can_edit_wo_fields),
            can_view_field_history = COALESCE($9, can_view_field_history)
      WHERE id = $1`,
    [
      id,
      code,
      input.label?.trim() ?? null,
      input.description === undefined ? null : (input.description?.trim() ?? null),
      input.can_edit_quote ?? null,
      input.can_approve_quote ?? null,
      input.can_manage_users ?? null,
      input.can_edit_wo_fields ?? null,
      input.can_view_field_history ?? null,
    ],
  );
  // principal.role carries ON UPDATE CASCADE, so a code change follows through
  // to everyone holding it rather than orphaning them.
  return getRole(id);
}

export async function deleteRole(id: string): Promise<void> {
  const role = await getRole(id);

  if (role.is_system) {
    throw new ApiError('BAD_REQUEST', `"${role.label}" is a built-in role and cannot be deleted`);
  }
  // Deleting out from under people would either break the foreign key or
  // silently strip their permissions. Reassigning first is the operator's call.
  if (role.user_count > 0) {
    throw new ApiError(
      'BAD_REQUEST',
      `${role.user_count} user${role.user_count === 1 ? ' still has' : 's still have'} the "${role.label}" role — move ${role.user_count === 1 ? 'them' : 'them all'} to another role first`,
    );
  }

  await query(`DELETE FROM role WHERE id = $1`, [id]);
}
