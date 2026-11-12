/* ClickUp: our Client fills ClickUp's "22. FM" in ClickUp's spelling; our FM
 * and ClickUp's own "Client" field are left alone (Elise, 2026-11-10). */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClickUpFieldDef } from '../packages/shared/src/integrations';
import { findOption, findOptionFor, toCuFieldValue } from '../apps/api/src/lib/clickupValues';

const fm: ClickUpFieldDef = {
  id: 'f-fm',
  name: '22. FM',
  type: 'drop_down',
  options: [
    { id: 'pw', name: 'Powerhouse' },
    { id: 'sh', name: 'SunHoldings' },
    { id: 'ck', name: 'CHEESECAKE FACTORY  ' },
    { id: 'se', name: '7-Eleven' },
    { id: 'ws', name: "Wendy's" },
    { id: 'fs', name: 'FrontStreet' },
    { id: 'le', name: 'Learning' },
    { id: 'rs', name: 'RSM365' },
  ],
};
const sales: ClickUpFieldDef = { id: 'f-so', name: 'Sales Owner', type: 'drop_down', options: [{ id: 'ro', name: 'Ro' }, { id: 'te', name: 'Teresa' }] };
const none = new Map<string, number>();

describe('Client → 22. FM', () => {
  it('sends a client to the FM option of the same name, spacing and case aside', () => {
    expect(toCuFieldValue(fm, 'Sun Holdings', none)).toEqual({ kind: 'set', value: 'sh' });
    expect(toCuFieldValue(fm, 'Cheesecake Factory', none)).toEqual({ kind: 'set', value: 'ck' });
    expect(toCuFieldValue(fm, '7-Eleven', none)).toEqual({ kind: 'set', value: 'se' });
  });
  it('translates the clients ClickUp spells differently', () => {
    expect(toCuFieldValue(fm, 'PH', none)).toEqual({ kind: 'set', value: 'pw' });
    expect(toCuFieldValue(fm, '7-11', none)).toEqual({ kind: 'set', value: 'se' });
    expect(toCuFieldValue(fm, "Wendy's Corp", none)).toEqual({ kind: 'set', value: 'ws' });
    expect(toCuFieldValue(fm, 'FSFS', none)).toEqual({ kind: 'set', value: 'fs' });
    expect(toCuFieldValue(fm, 'SFS', none)).toEqual({ kind: 'set', value: 'fs' });
    expect(toCuFieldValue(fm, 'Learning Experience', none)).toEqual({ kind: 'set', value: 'le' });
    expect(toCuFieldValue(fm, 'RSM LEO', none)).toEqual({ kind: 'set', value: 'rs' });
  });
  it('reports a client with no FM option instead of guessing', () => {
    expect(toCuFieldValue(fm, 'ALDI', none).kind).toBe('error');
  });
  it('applies an alias only on its own field', () => {
    expect(findOptionFor('Trade', fm.options!, 'PH')).toBeUndefined();
    expect(findOption(fm.options!, 'PH')).toBeUndefined();
  });
  it('sends Rocio as ClickUp’s "Ro"', () => {
    expect(toCuFieldValue(sales, 'Rocio', none)).toEqual({ kind: 'set', value: 'ro' });
    expect(toCuFieldValue(sales, 'Kevin', none).kind).toBe('error');
  });
  it('maps Client to 22. FM and sends neither our FM nor anything to ClickUp’s Client', () => {
    const src = readFileSync(resolve(__dirname, '../apps/api/src/services/clickup.ts'), 'utf8');
    expect(src).toMatch(/CUSTOM_AUTO[^=]*=\s*\{\s*'fields\.Client':\s*'22\. FM'\s*\}/);
    expect(src).toMatch(/NOT_SENT_AUTO\s*=\s*new Set\(\['fields\.22\. FM'\]\)/);
  });
});
