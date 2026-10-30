/* Elise, 2026-10-27 — two asks.
 *
 * 1. The AM, TL and ATL pickers list only the people whose role is that seat's
 *    (Add work order, the work order's fields / bulk edit / filters, the
 *    client's Account team, the client record's Account manager).
 * 2. The check-in method follows the client + Comp, the "CICO methods" sheet
 *    (migration 0100), before the FM table.
 *
 * The rules are pure; the wiring is pinned to the source.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_TEAM_SEAT_ROLE,
  cicoSourceLabel,
  clientTeamValues,
  pickClientTeam,
  seatNames,
  seatRoleForField,
} from '../packages/shared/src/index';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const people = [
  { name: 'Peter Adams', role: 'am' },
  { name: 'Mary Jones', role: 'tl' },
  { name: 'Mary Smith', role: 'om' },
  { name: 'Sammy Lee', role: 'atl' },
  { name: 'Josh Ramirez', role: 'tl' },
];

describe('each seat lists only its role', () => {
  it('maps the bag keys to the role codes', () => {
    expect(seatRoleForField('AM')).toBe('am');
    expect(seatRoleForField('TL')).toBe('tl');
    expect(seatRoleForField('ATL')).toBe('atl');
    expect(seatRoleForField('Assignee')).toBeNull();
    expect(CLIENT_TEAM_SEAT_ROLE).toEqual({ am: 'am', tl: 'tl', atl: 'atl' });
  });

  it('seatNames keeps the people holding the role', () => {
    expect(seatNames(people, 'am')).toEqual(['Peter Adams']);
    expect(seatNames(people, 'tl')).toEqual(['Mary Jones', 'Josh Ramirez']);
    expect(seatNames(people, 'atl')).toEqual(['Sammy Lee']);
  });

  it('a team name resolves among the seat’s role only', () => {
    const bySeat = { am: seatNames(people, 'am'), tl: seatNames(people, 'tl'), atl: seatNames(people, 'atl') };
    // "Mary" is two people overall, one TL: the TL seat means Mary Jones.
    const { values, unmatched } = clientTeamValues({ am: 'Peter', tl: 'Mary', atl: 'Josh' }, bySeat);
    expect(values).toEqual({ AM: 'Peter Adams', TL: 'Mary Jones', ATL: 'Josh' });
    // Josh is a TL, not an ATL: written as typed, never guessed into his account.
    expect(unmatched).toEqual({ ATL: 'Josh' });
  });

  it('the old one-list form still works', () => {
    expect(clientTeamValues({ am: 'Peter', tl: null, atl: null }, ['Peter Adams']).values).toEqual({ AM: 'Peter Adams' });
  });

  it('the pickers are wired to the seat', () => {
    expect(read('apps/api/src/services/woFields.ts')).toContain('const seatRole = seatRoleForField(key) ?? ROLE_LIMITED_PERSON_FIELDS[key] ?? null;');
    expect(read('apps/web/src/components/wo/list/CreateWorkOrderDialog.tsx')).toContain("p.kind === 'human' && p.role === role");
    expect(read('apps/api/src/services/clientTeams.ts')).toContain('people_by_seat: bySeat(people)');
    expect(read('apps/web/src/components/portfolio/ClientTeamCard.tsx')).toContain('data?.people_by_seat?.[k]');
    expect(read('apps/api/src/services/portfolioExtras.ts')).toContain('p.role === CLIENT_TEAM_SEAT_ROLE.am');
  });
});

describe('the check-in method per client and Comp', () => {
  const rows = [
    { client: 'PH', billing_entity: 'BKR', method: 'Portal' },
    { client: 'PH', billing_entity: 'AF', method: 'Portal' },
    { client: 'Qdoba', billing_entity: 'SFM', method: 'IVR' },
  ];

  it('matches client + Comp, and a single-row client without a Comp', () => {
    expect(pickClientTeam(rows, 'ph', 'af')?.billing_entity).toBe('AF');
    expect(pickClientTeam(rows, 'PH', 'TPM')).toBeNull();
    expect(pickClientTeam(rows, 'PH', null)).toBeNull();
    expect(pickClientTeam(rows, ' Qdoba ', '')?.method).toBe('IVR');
  });

  it('names where the default came from', () => {
    expect(cicoSourceLabel({ kind: 'client', client: 'PH ', billing_entity: 'BKR' })).toBe('PH · BKR');
    expect(cicoSourceLabel({ kind: 'fm', fm: 'Powerhouse' })).toBe('FM Powerhouse');
    expect(cicoSourceLabel(null)).toBeNull();
  });

  it('0100 creates the table and loads the sheet', () => {
    const sql = read('packages/db/migrations/0100_client_cico_method.sql');
    expect(sql).toContain('CREATE TABLE client_cico_method (');
    expect(sql).toContain('ON client_cico_method (client_id, upper(btrim(billing_entity)))');
    expect((sql.match(/^ {2}\('(SFM|BKR|AF|TPM|RF)', /gm) ?? []).length).toBe(79);
    expect(sql).toContain("('BKR', 'PH', 'Metryx', 'dispatchph@bkrnational.com', 'Portal', 'Picture + manager name')");
    expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT;|CONCURRENTLY/);
  });

  it('a new visit reads the client row before the FM table', () => {
    const visits = read('apps/api/src/services/visits.ts');
    const client = visits.indexOf('await cicoForClient(client,');
    const fm = visits.indexOf('entry = await methodForFm(fm);');
    expect(client).toBeGreaterThan(0);
    expect(fm).toBeGreaterThan(client);
    expect(visits).toContain('default_method_from: from,');
  });
});
