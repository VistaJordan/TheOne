// The permission tree, enforced (0015).
//
// Every gate in the API goes through `allowFor(principal)` → `allow(path, action)`.
// The decision itself lives in @theone/shared (permAllows) so the browser hides
// exactly what this file refuses. What is local here is the shape of the
// refusal (a 403 that names the missing permission) and the two places where
// permissions change DATA rather than block a request: the field catalogue and
// work-order payloads, which are trimmed to the fields the caller may see.

import {
  fieldPermKey,
  normalizePermMap,
  permAllows,
  type PermAction,
  type PermissionSet,
  type PermMap,
} from '@theone/shared';
import { ApiError } from '../errors.js';

export type Allow = (key: string, action: PermAction) => boolean;

export interface PermissionBearer {
  isSuperAdmin: boolean;
  perms: PermissionSet;
}

export function allowFor(p: PermissionBearer): Allow {
  return (key, action) => permAllows(p.perms, key, action, p.isSuperAdmin);
}

/** 403 unless the bearer may `action` on `key`. */
export function requirePerm(
  p: PermissionBearer,
  key: string,
  action: PermAction,
  message: string,
): void {
  if (!permAllows(p.perms, key, action, p.isSuperAdmin)) {
    throw new ApiError('FORBIDDEN', message, { required_permission: `${key}:${action}` });
  }
}

/** Request bodies arrive as unknown JSON; keep only well-formed grants. */
export function parsePermMap(raw: unknown): PermMap {
  const map = normalizePermMap(raw);
  if (Object.keys(map).length > 2000) {
    throw new ApiError('BAD_REQUEST', 'Too many permission entries');
  }
  return map;
}

// ── Field visibility ─────────────────────────────────────────────────────────

export function canViewField(allow: Allow, catalogueKey: string): boolean {
  return allow(fieldPermKey(catalogueKey), 'view');
}

/** Editing a field you cannot see is never meant: view is a precondition. */
export function canEditField(allow: Allow, catalogueKey: string): boolean {
  const key = fieldPermKey(catalogueKey);
  return allow(key, 'view') && allow(key, 'edit');
}

/** The catalogue as this caller may see it. */
export function visibleFields<T extends { key: string }>(allow: Allow, fields: T[]): T[] {
  return fields.filter((f) => canViewField(allow, f.key));
}

/** Column keys the caller asked for, minus the ones they may not see. */
export function visibleColumns(allow: Allow, columns: string[] | undefined): string[] | undefined {
  if (!columns) return columns;
  return columns.filter((k) => canViewField(allow, k));
}

/** 403 naming the first field the caller may not write. Keys are catalogue
    keys (`fields.<json key>` or a promoted column). */
export function assertFieldWrites(allow: Allow, catalogueKeys: string[]): void {
  for (const key of catalogueKeys) {
    if (!canEditField(allow, key)) {
      throw new ApiError('FORBIDDEN', `You cannot edit "${key.replace(/^fields\./, '')}"`, {
        required_permission: `${fieldPermKey(key)}:edit`,
      });
    }
  }
}

// The promoted columns a work-order payload can go without. Identity (id,
// wo_number, title, status) always ships — a row you cannot name is not a row.
const REDACTABLE_CORE = [
  'ext_name',
  'description',
  'client',
  'city',
  'state',
  'trade',
  'billing_entity',
  'nte',
  'priority',
  'date_received',
] as const;

/**
 * Trim a work-order payload (list item or detail) to what the caller may see:
 * hidden promoted columns become null, hidden keys leave the `fields` bag and
 * the projected `custom` map. Mutates and returns the same object. Cheap —
 * every check is a few map lookups — so it runs on every row of every page.
 */
export function redactWorkOrder<
  T extends {
    fields?: Record<string, unknown>;
    custom?: Record<string, string | null>;
    money?: unknown;
  },
>(allow: Allow, wo: T): T {
  const rec = wo as unknown as Record<string, unknown>;
  for (const col of REDACTABLE_CORE) {
    if (col in rec && !canViewField(allow, col)) rec[col] = null;
  }
  if (wo.fields) {
    for (const k of Object.keys(wo.fields)) {
      if (!canViewField(allow, `fields.${k}`)) delete wo.fields[k];
    }
  }
  if (wo.custom) {
    for (const k of Object.keys(wo.custom)) {
      if (!canViewField(allow, k)) delete wo.custom[k];
    }
  }
  // The derived money block is built from Cost / Total Invoiced / NTE; when
  // NTE is hidden the whole block is, since every number in it leans on it.
  if (wo.money && !canViewField(allow, 'nte')) rec.money = null;
  return wo;
}
