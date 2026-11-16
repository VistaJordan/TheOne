/**
 * 0154 (Elise, 2026-11-16): OM, Senior OM and OM Under Probation are
 * view-only on the whole People section of a work order.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREATE_FILLABLE_FIELD_KEYS, PEOPLE_LOCKED_ROLES, PROBATION_PEOPLE_LOCK_PATH } from '@theone/shared';

const root = resolve(__dirname, '..');
const sql = readFileSync(join(root, 'packages/db/migrations/0154_dispatchers_people_view_only.sql'), 'utf8');

describe('the dispatchers change nobody (0154)', () => {
  it('names the three dispatcher tiers', () => {
    expect([...PEOPLE_LOCKED_ROLES].sort()).toEqual(['om', 'om_probation', 'senior_om']);
    expect(sql).toContain("unnest(ARRAY['om', 'senior_om', 'om_probation'])");
  });
  it('sets the People section and every explicit child grant to edit false', () => {
    expect(sql).toContain(`'${PROBATION_PEOPLE_LOCK_PATH}', '{"edit": false}'`);
    expect(sql).toContain("k.key LIKE 'work_orders/fields/people/%'");
    expect(sql).not.toContain('"edit": true');
  });
  it('Add work order still fills the team seats', () => {
    for (const k of ['fields.AM', 'fields.TL', 'fields.ATL', 'fields.Sales Owner'])
      expect(CREATE_FILLABLE_FIELD_KEYS as readonly string[]).toContain(k);
  });
});
