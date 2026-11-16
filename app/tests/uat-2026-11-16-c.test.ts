/**
 * UAT list of 2026-11-16, third batch (Elise; migration 0152): #44 the POP
 * request over Parts Required, #42 the status order, #5 Add work order with
 * no examples or remembered entries, #24 / #45 Projected Cost and Cost from
 * the payments only. Pure functions and source-text pins; no database.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COST_FIELD_KEY,
  FIELD_SECTIONS,
  POP_REQUEST_LINES,
  PROJECTED_COST_FIELD_KEY,
  SYSTEM_MONEY_KEYS,
  emptyPopRequest,
  formatPopRequest,
  parsePopRequest,
  partsRequiredFilled,
  popRequestEmpty,
} from '@theone/shared';

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('#44 · the POP request', () => {
  it('has the ten lines in the team’s order', () => {
    expect(POP_REQUEST_LINES.map((l) => l.label)).toEqual([
      'POP', 'Link', 'QTY', 'Estimated Total Cost', 'Specs if Applicable',
      'Delivery Address', "Store or Tech's name", 'Phone Number', 'Full Address', 'Screenshot reference',
    ]);
  });

  it('writes the numbered text and reads it back', () => {
    const r = emptyPopRequest();
    r.values.pop = 'Home Depot #4512';
    r.values.link = 'https://example.com/part?id=1';
    r.values.qty = '2';
    const text = formatPopRequest(r)!;
    expect(text.split('\n')[0]).toBe('1- POP: Home Depot #4512');
    expect(text.split('\n')[1]).toBe('2- Link: https://example.com/part?id=1');
    expect(text.split('\n')[9]).toBe('10- Screenshot reference:');
    expect(parsePopRequest(text)).toEqual(r);
    expect(partsRequiredFilled(text)).toBe(true);
  });

  it('an empty request stores nothing, so the parts gate still sees no list', () => {
    expect(formatPopRequest(emptyPopRequest())).toBeNull();
    expect(popRequestEmpty(parsePopRequest('1- POP:\n2- Link:'))).toBe(true);
  });

  it('keeps a list typed before the form as notes, never drops it', () => {
    const r = parsePopRequest('2x compressor relay\nThermostat');
    expect(r.notes).toBe('2x compressor relay\nThermostat');
    expect(formatPopRequest(r)).toContain('\n\n2x compressor relay\nThermostat');
  });

  it('the Parts card draws the form over Parts Required', () => {
    expect(src('apps/web/src/components/wo/PartsCard.tsx')).toContain('<PopRequestBlock wo={wo} />');
    expect(src('apps/web/src/components/wo/PopRequestBlock.tsx')).toContain('uploadAttachment(wo.id');
  });
});

describe('#42 · the status order', () => {
  it('migration and seed put the visit after its scheduling', () => {
    const mig = src('packages/db/migrations/0152_projected_cost_status_order.sql');
    for (const [name, pos] of [['Assessment Sched', 2], ['On Site (Assessment)', 3], ['Job Sched', 4], ['On Site (Job)', 5], ['PM Sched', 6]] as const) {
      expect(mig).toMatch(new RegExp(`\\('${name.replace(/[()]/g, '\\$&')}',\\s+${pos}\\)`));
    }
    expect(src('packages/db/src/seed.ts')).toContain("'Assessment Sched': 2, 'On Site (Assessment)': 3, 'Job Sched': 4, 'On Site (Job)': 5, 'PM Sched': 6");
  });
});

describe('#5 · Add work order shows no examples', () => {
  it('drops the example placeholders and the browser’s remembered entries', () => {
    const dlg = src('apps/web/src/components/wo/list/CreateWorkOrderDialog.tsx');
    expect(dlg).not.toContain("'77002'");
    expect(dlg).not.toContain('The number the client knows this job by');
    expect(dlg).not.toContain('Pick the trade first for suggestions');
    expect(dlg).not.toContain('e.g. 7-Eleven');
    expect(dlg).not.toContain('Type the WO # of the original work order');
    expect(dlg.match(/autoComplete="off"/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});

describe('#24 / #45 · Projected Cost; Cost from the payments only', () => {
  it('Cost is system-only, Projected Cost is a typed Finances field', () => {
    expect(SYSTEM_MONEY_KEYS).toContain(COST_FIELD_KEY);
    expect(SYSTEM_MONEY_KEYS).not.toContain(PROJECTED_COST_FIELD_KEY);
    const fin = FIELD_SECTIONS.find((s) => s.slug === 'finances')!;
    expect(fin.keys).toContain(`fields.${PROJECTED_COST_FIELD_KEY}`);
  });

  it('migration and seed carry the field', () => {
    expect(src('packages/db/migrations/0152_projected_cost_status_order.sql')).toContain("'Projected Cost', 'Projected Cost', 'currency'");
    expect(src('packages/db/src/seed.ts')).toContain("{ key: 'Projected Cost',           label: 'Projected Cost',       type: 'currency' }");
  });

  it('the Finances card shows it, and a payment action refreshes the rail’s Cost', () => {
    expect(src('apps/web/src/components/wo/MoneyCard.tsx')).toContain('fieldKey={`fields.${PROJECTED_COST_FIELD_KEY}`}');
    expect(src('apps/web/src/components/payments/PaymentActions.tsx')).toContain("queryKey: ['wo-record']");
  });

  it('Pay still adds the amount to Cost inside the payment', () => {
    const pay = src('apps/api/src/services/payments.ts');
    expect(pay).toContain('return rollCost(tx, row.task_id, actor.id, amount);');
  });
});
