/* The header's Emergency and Escalation buttons are everyone's; only a TL,
 * ATL or AM (Admin, super admins) clears an escalation (Elise, 2026-11-03,
 * migration 0120). */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { flagTicked, mayClearEmergency, mayClearEscalation, mayReopenWorkOrder, onlyHeaderFlags } from '@theone/shared';

describe('Reopen button (Elise, 2026-11-17)', () => {
  it('OP Admin, TL, ATL, AM, Admin and super admins only', () => {
    for (const r of ['oa', 'tl', 'atl', 'am', 'admin']) expect(mayReopenWorkOrder(r, false)).toBe(true);
    for (const r of ['om', 'senior_om', 'om_probation', 'ar', 'ap', 'vr_officer', 'qc', null]) expect(mayReopenWorkOrder(r, false)).toBe(false);
    expect(mayReopenWorkOrder('om', true)).toBe(true);
  });
});

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('header flags', () => {
  it('a save of only the two flags is a header-flag save', () => {
    expect(onlyHeaderFlags(['fields.Emergency'])).toBe(true);
    expect(onlyHeaderFlags(['fields.Escalated', 'fields.Emergency'])).toBe(true);
    expect(onlyHeaderFlags(['fields.Escalated', 'fields.Assignee'])).toBe(false);
    expect(onlyHeaderFlags([])).toBe(false);
  });

  it('only TL, ATL, AM, Admin, OP Admin and super admins clear an escalation', () => {
    for (const r of ['tl', 'atl', 'am', 'admin', 'oa']) expect(mayClearEscalation(r, false)).toBe(true);
    for (const r of ['om', 'senior_om', 'om_probation', 'vr_officer', null]) {
      expect(mayClearEscalation(r, false)).toBe(false);
    }
    expect(mayClearEscalation('om', true)).toBe(true);
  });

  it('OP Admin clears an emergency too (2026-11-16)', () => {
    expect(mayClearEmergency('oa', false)).toBe(true);
  });

  it('reads a ticked checkbox in every spelling', () => {
    expect(flagTicked(true)).toBe(true);
    expect(flagTicked('true')).toBe(true);
    expect(flagTicked('Yes')).toBe(true);
    expect(flagTicked(false)).toBe(false);
    expect(flagTicked(null)).toBe(false);
    expect(flagTicked('')).toBe(false);
  });

  it('the field editor and bulk edit ask before an escalation is cleared', () => {
    const editor = read('apps/api/src/services/woFieldValues.ts');
    expect(editor).toContain('flagTicked(esc.before) && !flagTicked(esc.after) && !auto && !opts.system');
    expect(editor).toContain('assertMayClearEscalation(actorId, tx)');
    expect(read('apps/api/src/services/woBulk.ts')).toContain('if (esc && !flagTicked(esc.value)) await assertMayClearEscalation(actorId);');
  });

  it('the field-save route lets a flag-only save through on view', () => {
    const route = read('apps/api/src/routes/workOrders.ts');
    expect(route).toContain(`if (onlyHeaderFlags(catalogueKeys)) requirePerm(p, 'work_orders', 'view'`);
  });

  it('0120 grants both fields to every role but service', () => {
    const sql = read('packages/db/migrations/0120_header_flags_everyone.sql');
    expect(sql).toContain(`WHERE code <> 'service'`);
    expect(sql).toContain('fields.Emergency');
    expect(sql).toContain('fields.Escalated');
  });
});
