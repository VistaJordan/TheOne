/* Elise, 2026-11-05 — INV/COLL, ClickUp's checkbox, joins the work-order
 * fields (migration 0125): AR section of All fields, admins only for now,
 * never client-safe. Pinned to the source (no database).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIELD_SECTIONS, fieldPermKey, permAllows } from '@theone/shared';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('INV/COLL', () => {
  it('sits in AR under the ClickUp key, so the values on file show', () => {
    const section = FIELD_SECTIONS.find((s) => s.keys.includes('fields.INV/COLL'))?.slug;
    expect(section).toBe('ar');
    expect(fieldPermKey('fields.INV/COLL')).toBe('work_orders/fields/ar/fields.INV/COLL');
  });

  it('the migration adds a checkbox, hides it from every role but admin, never client-safe', () => {
    const mig = read('packages/db/migrations/0125_inv_coll.sql');
    expect(mig).toContain(`'INV/COLL', 'INV/COLL', 'checkbox'::field_type`);
    expect(mig).toContain(`'work_orders/fields/ar/fields.INV/COLL', '{"view": false, "edit": false}'`);
    expect(mig).toContain(`WHERE r.code NOT IN ('admin', 'service')`);
    expect(mig).toContain(`UPDATE field_def SET client_safe = false WHERE key = 'INV/COLL'`);
  });

  it('the seed carries the same row (keep in step)', () => {
    const seed = read('packages/db/src/seed.ts');
    expect(seed).toContain(`{ key: 'INV/COLL',                 label: 'INV/COLL',             type: 'checkbox' }`);
    expect(seed).toContain(`UPDATE field_def SET client_safe = false WHERE key = 'INV/COLL'`);
  });

  it('a grant on the full path wins over the slash in the key', () => {
    const path = fieldPermKey('fields.INV/COLL');
    const role = { work_orders: { view: true, edit: true }, [path]: { view: false, edit: false } };
    expect(permAllows({ role, overrides: {} }, path, 'view')).toBe(false);
    expect(permAllows({ role: { work_orders: { view: true } }, overrides: {} }, path, 'view')).toBe(true);
  });
});
