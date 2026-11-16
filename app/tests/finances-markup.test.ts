/* Finances card (Elise, 2026-11-16): the NTE meter is gone and the Markup row
   reads (Total Invoiced − Cost) ÷ Cost. */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markupPct } from '../packages/shared/src/moneyRules';

const ROOT = resolve(__dirname, '..');

describe('markupPct', () => {
  it('is the profit over the cost', () => {
    expect(markupPct(1500, 1000)).toBe(50);
    expect(markupPct(800, 1000)).toBe(-20);
  });
  it('has no answer without both figures or with no cost', () => {
    expect(markupPct(null, 1000)).toBeNull();
    expect(markupPct(1500, null)).toBeNull();
    expect(markupPct(1500, 0)).toBeNull();
  });
});

it('the Finances card draws Markup and no NTE meter', () => {
  const src = readFileSync(join(ROOT, 'apps/web/src/components/wo/MoneyCard.tsx'), 'utf8');
  expect(src).toContain('<dt>Markup</dt>');
  expect(src).toContain('markupPct(m.invoiced, m.cost)');
  expect(src).not.toContain('className="ntemeter"');
});
