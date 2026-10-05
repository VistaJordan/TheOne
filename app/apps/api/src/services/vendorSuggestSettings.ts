// 0069 · The `suggest` row of vendor_setting: how the suggested-vendors list
// is put together. Its own small file so vendorMap.ts (the admin read) and
// vendorSuggest.ts (the list) can both use it without importing each other.

import { SUGGEST_DEFAULTS, adminPermKey, ADMIN_VENDORS_SLUG, cleanSuggestSettings } from '@theone/shared';
import type { SuggestSettings } from '@theone/shared';
import { query } from '../db.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { requirePerm } from './permissions.js';

export async function getSuggestSettings(): Promise<SuggestSettings> {
  const res = await query<{ value: unknown }>(`SELECT value FROM vendor_setting WHERE key = 'suggest'`);
  return res.rows[0] ? cleanSuggestSettings(res.rows[0].value) : { ...SUGGEST_DEFAULTS, order: [...SUGGEST_DEFAULTS.order] };
}

/** A partial save: what is posted is laid over what is stored, then made whole. */
export async function saveSuggestSettings(input: unknown, actor: ActingPrincipal): Promise<SuggestSettings> {
  requirePerm(actor, adminPermKey(ADMIN_VENDORS_SLUG), 'edit', 'You cannot change the vendor and map settings');
  const before = await getSuggestSettings();
  const next = cleanSuggestSettings({ ...before, ...(input && typeof input === 'object' ? input : {}) });
  if (JSON.stringify(before) === JSON.stringify(next)) return before;
  await query(
    `INSERT INTO vendor_setting (key, value, updated_by) VALUES ('suggest', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(next), actor.id],
  );
  await logAdminEvent({
    actorId: actor.id,
    entity: 'vendor_setting',
    entityId: 'suggest',
    action: 'vendor_settings_updated',
    before: { name: 'Suggested vendors', ...before },
    after: { name: 'Suggested vendors', ...next },
  });
  return next;
}
