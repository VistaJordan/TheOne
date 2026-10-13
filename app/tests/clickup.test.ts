/* 0078 — ClickUp sync. The pure halves: the List id read from what an
 * administrator pastes, the name matching our field keys rely on, and every
 * value shape a ClickUp call is sent. The runner itself talks to ClickUp and
 * the database and is exercised against a real List. */

import { describe, it, expect } from 'vitest';
import { clickUpFits, type ClickUpFieldDef } from '../packages/shared/src/integrations';
import { parseListId } from '../apps/api/src/lib/clickupApi';
import { bareName, matchName, splitNames, toCuStatus, toCuDate, toCuFieldValue, toCuPriority, userIds } from '../apps/api/src/lib/clickupValues';

const people = new Map([
  ['jordan brown', 11],
  ['elise abdel massih', 22],
]);

const dd: ClickUpFieldDef = {
  id: 'f-trade',
  name: 'Trade',
  type: 'drop_down',
  options: [
    { id: 'o-1', name: 'Plumbing' },
    { id: 'o-2', name: 'HVAC' },
  ],
};

describe('the List id', () => {
  it('reads a bare id and the shapes of a ClickUp link', () => {
    expect(parseListId('901105678901')).toBe('901105678901');
    expect(parseListId('https://app.clickup.com/9011234567/v/li/901105678901')).toBe('901105678901');
    expect(parseListId('https://app.clickup.com/9011234567/v/l/6-901105678901-1')).toBe('901105678901');
    expect(parseListId('not a list')).toBeNull();
  });
});

describe('matching by name', () => {
  it('forgives case, punctuation and the emoji markers', () => {
    expect(matchName('16. Client NTE 🔴')).toBe(matchName('16 client nte'));
    expect(matchName('WO #')).toBe('wo number');
    expect(bareName('32. Tech Name')).toBe(bareName('Tech Name'));
    expect(bareName('33. Tech Phone #')).toBe('tech phone number');
  });
  it('offers only the ClickUp field types a value fits', () => {
    expect(clickUpFits('money', 'currency')).toBe(true);
    expect(clickUpFits('money', 'drop_down')).toBe(false);
    expect(clickUpFits('date', 'text')).toBe(true);
    expect(clickUpFits('text', 'formula')).toBe(false);
  });
});

describe('statuses', () => {
  // The Vista space's list statuses, as ClickUp spells them.
  const vista = ['Open', '!! approved', 'assessment scheduled', 'assessment ongoing', 'done/incurred', '<< invoiced not paid >>', '!! canceled/postponed'];
  it("finds our status under the List's spelling", () => {
    expect(toCuStatus('Approved', vista)).toBe('!! approved');
    expect(toCuStatus('Assessment Sched', vista)).toBe('assessment scheduled');
    expect(toCuStatus('On Site (Assessment)', vista)).toBe('assessment ongoing');
    expect(toCuStatus('Done / Incurred', vista)).toBe('done/incurred');
    expect(toCuStatus('Cancelled / Postponed', vista)).toBe('!! canceled/postponed');
    expect(toCuStatus('Open', vista)).toBe('Open');
  });
  it('says when the List has nothing that fits', () => {
    expect(toCuStatus('Invoiced', vista)).toBeNull();
    expect(toCuStatus('Invoiced', [])).toBe('invoiced');
  });
});

describe('values in ClickUp shapes', () => {
  it('turns a dropdown label into the option id, and says when ClickUp lacks it', () => {
    expect(toCuFieldValue(dd, 'hvac', people)).toEqual({ kind: 'set', value: 'o-2' });
    const miss = toCuFieldValue(dd, 'Roofing', people);
    expect(miss.kind).toBe('error');
  });
  it("finds an option behind ClickUp's numbering, never ours", () => {
    const cico: ClickUpFieldDef = { id: 'c', name: 'Check-in/out status', type: 'drop_down', options: [{ id: 'a', name: '1. Checked-in' }, { id: 'b', name: '3. Checked-out - RTN' }] };
    expect(toCuFieldValue(cico, 'Checked-in', people)).toEqual({ kind: 'set', value: 'a' });
    expect(toCuFieldValue(cico, 'Checked-out - RTN', people)).toEqual({ kind: 'set', value: 'b' });
    const client: ClickUpFieldDef = { id: 'k', name: 'Client', type: 'drop_down', options: [{ id: 'e', name: 'Eleven' }] };
    expect(toCuFieldValue(client, '7-Eleven', people).kind).toBe('error');
  });
  it('clears an empty value instead of sending it', () => {
    expect(toCuFieldValue(dd, '', people)).toEqual({ kind: 'clear' });
    expect(toCuFieldValue({ id: 'c', name: 'Cost', type: 'currency' }, null, people)).toEqual({ kind: 'clear' });
  });
  it('sends money as a number', () => {
    expect(toCuFieldValue({ id: 'c', name: 'Cost', type: 'currency' }, '$1,250.50', people)).toEqual({ kind: 'set', value: 1250.5 });
  });
  it('reads our stamps as Chicago wall time', () => {
    // 2026-10-13 09:30 in Chicago is 14:30 UTC (CDT, UTC-5).
    expect(toCuDate('2026-10-13T09:30')).toEqual({ ms: Date.UTC(2026, 9, 13, 14, 30), time: true });
    // A bare date is Chicago midnight, without a time of day.
    expect(toCuDate('2026-12-01')).toEqual({ ms: Date.UTC(2026, 11, 1, 6, 0), time: false });
    expect(toCuDate('2026-10-13T14:30:00.000Z')?.ms).toBe(Date.UTC(2026, 9, 13, 14, 30));
    expect(toCuDate('soon')).toBeNull();
  });
  it('maps people by name to their ClickUp ids and names who is missing', () => {
    expect(splitNames('Jordan Brown, Elise Abdel Massih')).toEqual(['Jordan Brown', 'Elise Abdel Massih']);
    expect(userIds('Jordan Brown, Nobody Here', people)).toEqual({ ids: [11], missing: ['Nobody Here'] });
  });
  it('gives priority as ClickUp numbers it', () => {
    expect(toCuPriority('Urgent')).toBe(1);
    expect(toCuPriority('low')).toBe(4);
    expect(toCuPriority(null)).toBeNull();
  });
  it('writes a checkbox as a boolean', () => {
    expect(toCuFieldValue({ id: 'e', name: 'Emergency', type: 'checkbox' }, 'true', people)).toEqual({ kind: 'set', value: true });
  });
});
