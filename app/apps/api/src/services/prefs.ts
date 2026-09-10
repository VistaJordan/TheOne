// Per-ACCOUNT preferences (user_pref, 0007) — one JSONB value per (user, key).
//
// This is the server-side counterpart of the localStorage the web already uses
// for per-TAB state. The dividing line: localStorage for "a property of the tab
// you are working in" (which view is open, a collapsed header), user_pref for
// "a property of ME, on every machine" — the first tenant is the detail page's
// field order. Prefs always belong to the REAL signed-in user: a super admin
// viewing as somebody else is still arranging their own screen.

import { query } from '../db.js';
import { ApiError } from '../errors.js';

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** A pref value is a convenience blob, not a data store. */
const MAX_VALUE_BYTES = 32 * 1024;

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) throw new ApiError('BAD_REQUEST', 'Malformed preference key');
}

export async function getPref(principalId: string, key: string): Promise<unknown> {
  assertKey(key);
  const res = await query<{ value: unknown }>(
    `SELECT value FROM user_pref WHERE principal_id = $1 AND key = $2 LIMIT 1`,
    [principalId, key],
  );
  return res.rows[0]?.value ?? null;
}

export async function setPref(principalId: string, key: string, value: unknown): Promise<void> {
  assertKey(key);
  const json = JSON.stringify(value ?? null);
  if (json.length > MAX_VALUE_BYTES) {
    throw new ApiError('BAD_REQUEST', 'That preference is too large to store');
  }
  await query(
    `INSERT INTO user_pref (principal_id, key, value)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (principal_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [principalId, key, json],
  );
}
