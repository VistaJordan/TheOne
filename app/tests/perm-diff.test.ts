/* Role and "Adjust" edits in Admin › Audit: the permission map is listed path
   by path (shared permDiff.ts), on the screen and in the CSV. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { permChangeLine, permMapChanges, permPathLabel } from '@theone/shared';

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

describe('permMapChanges', () => {
  it('lists every action whose stored grant moved, with inherit as null', () => {
    const before = { work_orders: { view: true, edit: true }, 'work_orders/status': { edit: true, create: true } };
    const after = { work_orders: { view: true }, 'work_orders/status': { edit: false, create: true }, invoicing: { view: true } };
    const changes = permMapChanges(before, after);
    expect(changes.map((c) => [c.path, c.action, c.from, c.to])).toEqual([
      ['invoicing', 'view', null, true],
      ['work_orders', 'edit', true, null],
      ['work_orders/status', 'edit', true, false],
    ]);
  });

  it('says nothing when the maps hold the same grants, and treats junk as empty', () => {
    expect(permMapChanges({ a: { view: true } }, { a: { view: true } })).toEqual([]);
    expect(permMapChanges(null, 'x')).toEqual([]);
    expect(permMapChanges(undefined, { a: { view: false } })).toHaveLength(1);
  });

  it('names paths as the Roles screen does, fields by their own key', () => {
    expect(permPathLabel('work_orders')).toBe('Work orders');
    expect(permPathLabel('work_orders/fields/finances/fields.34. Cost')).toMatch(/^Work orders › .* › 34\. Cost$/);
    expect(permChangeLine({ path: 'work_orders', label: 'Work orders', action: 'edit', from: true, to: null })).toBe(
      'Work orders · Edit: yes → inherits',
    );
  });
});

describe('the audit screen and CSV use it', () => {
  it('expands permissions / overrides instead of "N entries"', () => {
    expect(read('apps', 'web', 'src', 'lib', 'auditFormat.ts')).toMatch(/PERM_SNAPSHOT_KEYS\.includes\(key\)[\s\S]*permMapChanges/);
    expect(read('apps', 'api', 'src', 'services', 'auditLog.ts')).toMatch(/PERM_SNAPSHOT_KEYS\.includes\(k\)[\s\S]*permMapChanges/);
  });
});
