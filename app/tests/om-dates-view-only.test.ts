/* 0160 (Elise, 2026-11-19): every OM tier is view-only on the Dates — 0151
 * did OM Under Probation, 0160 does OM and Senior OM. The resolver is run on
 * the role grants as the migrations leave them; no database. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIELD_SECTIONS, permAllows, CREATE_FILLABLE_FIELD_KEYS } from '../packages/shared/src/index';

const sql = readFileSync(join(__dirname, '..', 'packages/db/migrations/0160_om_dates_view_only.sql'), 'utf8');

describe('0160 · OM and Senior OM cannot edit the dates', () => {
  it('names the two roles and the whole Dates section', () => {
    expect(sql).toContain("WHERE code IN ('om', 'senior_om')");
    expect(sql).toContain("k LIKE 'work_orders/fields/dates/%' THEN v - 'edit'");
    expect(sql).toContain(`'work_orders/fields/dates'`);
    expect(sql).toContain(`'{"edit": false}'`);
  });

  it('leaves every date view-only once applied', () => {
    // OM's grants after 0085 + 0160: work orders edit, the section edit false,
    // the four 0085 field rows with their edit removed.
    const perms = {
      work_orders: { view: true, edit: true, create: true },
      'work_orders/fields/dates': { edit: false },
      'work_orders/fields/dates/fields.Due Date': {},
      'work_orders/fields/dates/fields.SLA Due Date': {},
    };
    const dates = FIELD_SECTIONS.find((s) => s.slug === 'dates');
    expect(dates).toBeDefined();
    const before = { work_orders: perms.work_orders };
    for (const key of dates!.keys) {
      const path = `work_orders/fields/dates/${key}`;
      expect(permAllows(perms, path, 'edit', false), key).toBe(false);
      // Seeing a date is unchanged by the lock.
      expect(permAllows(perms, path, 'view', false), key).toBe(permAllows(before, path, 'view', false));
    }
  });

  it('Add work order still takes the dates it asks for', () => {
    for (const k of ['fields.Date-Time Received', 'fields.Due Date', 'fields.SLA Due Date']) {
      expect(CREATE_FILLABLE_FIELD_KEYS as readonly string[]).toContain(k);
    }
  });
});
