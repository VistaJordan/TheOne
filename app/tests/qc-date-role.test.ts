// 0133 · QC Date is filled by the QC person only (Elise, 2026-11-13).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fieldPermKey,
  isViewLevelField,
  onlyHeaderFlags,
  onlyViewLevelFields,
  permAllows,
  type PermissionSet,
} from '@theone/shared';

const root = join(__dirname, '..');
const MIGRATION = readFileSync(join(root, 'packages/db/migrations/0133_qc_role.sql'), 'utf8');
const ROUTE = readFileSync(join(root, 'apps/api/src/routes/workOrders.ts'), 'utf8');

/** The JSON literal 0133 inserts for the role. */
function qcRolePerms(): Record<string, Record<string, boolean>> {
  const m = MIGRATION.match(/'qc',[\s\S]*?'(\{[\s\S]*?\})'::jsonb/);
  if (!m) throw new Error('0133 role literal not found');
  return JSON.parse(m[1]);
}

describe('0133 · QC Date', () => {
  it('is a view-level field, alongside the header flags', () => {
    expect(isViewLevelField('fields.QC Date')).toBe(true);
    expect(onlyViewLevelFields(['fields.QC Date'])).toBe(true);
    expect(onlyViewLevelFields(['fields.QC Date', 'fields.Emergency'])).toBe(true);
    expect(onlyViewLevelFields(['fields.QC Date', 'fields.Assignee'])).toBe(false);
    expect(onlyViewLevelFields([])).toBe(false);
    // the header-flag rule is unchanged
    expect(onlyHeaderFlags(['fields.QC Date'])).toBe(false);
  });

  it('the field route asks only work_orders view for a QC-only save', () => {
    expect(ROUTE).toContain(`else if (onlyViewLevelFields(catalogueKeys)) requirePerm(p, 'work_orders', 'view'`);
  });

  it('the QC role sees work orders, writes QC Date, and nothing else', () => {
    const set: PermissionSet = { role: qcRolePerms(), overrides: {} };
    const qcDate = fieldPermKey('fields.QC Date');
    expect(qcDate).toBe('work_orders/fields/qc/fields.QC Date');
    expect(permAllows(set, 'work_orders', 'view')).toBe(true);
    expect(permAllows(set, 'work_orders', 'edit')).toBe(false);
    expect(permAllows(set, qcDate, 'view')).toBe(true);
    expect(permAllows(set, qcDate, 'edit')).toBe(true);
    expect(permAllows(set, fieldPermKey('fields.QC Notes'), 'edit')).toBe(false);
    expect(permAllows(set, fieldPermKey('fields.34. Cost'), 'view')).toBe(false);
    expect(permAllows(set, 'work_orders/status', 'edit')).toBe(false);
    expect(permAllows(set, 'work_orders/status', 'create')).toBe(false);
    for (const section of ['quotes', 'payments', 'invoicing', 'vendors', 'approvals', 'dashboard', 'intake']) {
      expect(permAllows(set, section, 'view')).toBe(false);
    }
  });

  it('locks QC Date for every other role but the service account', () => {
    expect(MIGRATION).toMatch(/'work_orders\/fields\/qc\/fields\.QC Date'[\s\S]*'\{"edit": false\}'::jsonb\)\s*WHERE code NOT IN \('qc', 'service'\);/);
  });
});
