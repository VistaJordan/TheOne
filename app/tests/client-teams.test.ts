// 0096 · the account team per client and Comp: picking the team, matching a
// sheet name to an account, and the migration / seed / form staying in step.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  WO_CREATE_DEFAULT_KEYS,
  WO_CREATE_SECTIONS,
  clientTeamValues,
  pickClientTeam,
  resolvePersonName,
} from '../packages/shared/src/index';

const people = ['Josh Ramirez', 'Fady Haddad', 'Peter Khoury', 'Mary Jones', 'Mary-Ann Lee', 'Charles Doe', 'Charlie Day'];
const teams = [
  { client: 'PH', billing_entity: 'BKR', tl: 'Mary', atl: 'Mary', sales: 'House', am: 'Peter' },
  { client: 'PH', billing_entity: 'AF', tl: 'Mary', atl: 'Mary', sales: 'House', am: 'Peter' },
  { client: '7-11', billing_entity: 'SFM', tl: 'Josh', atl: 'Fady', sales: 'Rocio', am: 'Peter' },
];

describe('pickClientTeam', () => {
  it('picks the team for the Comp, any case and spacing', () => {
    expect(pickClientTeam(teams, ' ph ', 'af')?.billing_entity).toBe('AF');
  });
  it('waits for the Comp when the client has several teams', () => {
    expect(pickClientTeam(teams, 'PH', '')).toBeNull();
  });
  it('uses the only team when no Comp is picked', () => {
    expect(pickClientTeam(teams, '7-11', null)?.billing_entity).toBe('SFM');
  });
  it('finds nothing under a Comp the client has no team for', () => {
    expect(pickClientTeam(teams, '7-11', 'TPM')).toBeNull();
    expect(pickClientTeam(teams, '', 'SFM')).toBeNull();
  });
});

describe('resolvePersonName', () => {
  it('takes an exact display name in any case', () => {
    expect(resolvePersonName('josh ramirez', people)).toBe('Josh Ramirez');
  });
  it('takes a first name only one person has', () => {
    expect(resolvePersonName('Josh', people)).toBe('Josh Ramirez');
    expect(resolvePersonName('Mary', people)).toBe('Mary Jones');
  });
  it('refuses a name more than one person answers to', () => {
    expect(resolvePersonName('Char', people)).toBeNull();
  });
  it('never resolves House or a blank', () => {
    expect(resolvePersonName('House', people)).toBeNull();
    expect(resolvePersonName('  ', people)).toBeNull();
  });
});

describe('clientTeamValues', () => {
  it('fills AM, TL and ATL and reports what it could not match', () => {
    const r = clientTeamValues({ tl: 'Josh', atl: 'Lucas', am: 'Peter' }, people);
    expect(r.values).toEqual({ AM: 'Peter Khoury', TL: 'Josh Ramirez' });
    expect(r.unmatched).toEqual({ ATL: 'Lucas' });
  });
  it('fills nothing without a team', () => {
    expect(clientTeamValues(null, people)).toEqual({ values: {}, unmatched: {} });
  });
});

describe('the create form', () => {
  it('keeps Comp, Client, Client Portal and FM together, and AM / TL / ATL / Dispatcher under People', () => {
    const keys = (id: string) => WO_CREATE_SECTIONS.find((s) => s.id === id)?.keys;
    expect(keys('identity')).toEqual(['21. Comp', 'Client', 'Client Portal Type', '22. FM']);
    expect(keys('people')).toEqual(['AM', 'TL', 'ATL', 'Assignee']);
    expect(keys('money')).toEqual(['16. Client NTE 🔴']);
  });
  it('offers TL and ATL by default, in step with the migration and the seed', () => {
    expect(WO_CREATE_DEFAULT_KEYS).toContain('TL');
    expect(WO_CREATE_DEFAULT_KEYS).toContain('ATL');
    const mig = readFileSync('packages/db/migrations/0096_client_teams.sql', 'utf8');
    expect(mig).toMatch(/\('ATL', 'Assistant Team Lead', 'users'/);
    expect(mig).toMatch(/create_mode = 'optional' WHERE key IN \('TL', 'ATL'\)/);
    const seed = readFileSync('packages/db/src/seed.ts', 'utf8');
    expect(seed).toMatch(/key: 'ATL',\s+label: 'Assistant Team Lead',\s+type: 'users'/);
  });
});
