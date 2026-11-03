/* Twelve fields retired, Ecotrak ID kept off the screens (Elise, 2026-11-03,
 * migration 0121). Retired = out of the catalogue, Admin › Custom fields, Add
 * work order, the import and the ClickUp push, yet still resolvable by key so
 * a saved view, tracker or automation that names one keeps loading. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RETIRED_FIELD_LABELS, SCREEN_HIDDEN_FIELD_KEYS } from '@theone/shared';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('retired fields', () => {
  const sql = read('packages/db/migrations/0121_retire_fields.sql');

  it('0121 retires every label on the list, and only those', () => {
    expect(RETIRED_FIELD_LABELS).toHaveLength(12);
    for (const label of RETIRED_FIELD_LABELS) expect(sql).toContain(`'${label}'`);
    for (const kept of ['Parts Required', 'Total Invoiced', 'Ecotrak ID']) {
      expect(RETIRED_FIELD_LABELS).not.toContain(kept);
      expect(sql).not.toContain(`'${kept}'`);
    }
  });

  it('the seed no longer creates them', () => {
    const seed = read('packages/db/src/seed.ts');
    for (const label of RETIRED_FIELD_LABELS) expect(seed).not.toMatch(new RegExp(`label: '${label}',`));
  });

  it('the catalogue drops them but resolveField still finds them', () => {
    const fields = read('apps/api/src/services/woFields.ts');
    expect(fields).toContain('retired_at IS NOT NULL AS retired');
    expect(fields).toContain('listCustomFields({ includeRetired: true })');
    expect(fields).toContain('!SCREEN_HIDDEN_FIELD_KEYS.includes(f.key)');
    expect(SCREEN_HIDDEN_FIELD_KEYS).toEqual(['fields.Ecotrak ID']);
  });

  it('Admin › Custom fields and Add work order leave them out', () => {
    expect(read('apps/api/src/services/adminMeta.ts')).toContain('WHERE f.retired_at IS NULL');
    expect(read('apps/api/src/services/woCreate.ts')).toContain(`f.create_mode <> 'off' AND f.retired_at IS NULL`);
  });
});
