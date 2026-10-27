// 2026-10-27 (Elise): the Client list follows the Comp, and editing a work
// order's Client or Comp re-fills AM / TL / ATL from the account team.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clientOptionsForComp, refillFromClientTeam } from '@theone/shared';

const opts = [
  { value: 'PH', label: 'PH', comps: ['AF', 'BKR', 'RF', 'TPM'] },
  { value: 'Vuori', label: 'Vuori', comps: ['SFM'] },
  { value: 'NoTeam', label: 'NoTeam' },
];

describe('clientOptionsForComp', () => {
  it('offers every client while no Comp is picked', () => {
    expect(clientOptionsForComp(opts, '').map((o) => o.value)).toEqual(['PH', 'Vuori', 'NoTeam']);
  });
  it('offers only the clients filed under the Comp, any case', () => {
    expect(clientOptionsForComp(opts, 'bkr').map((o) => o.value)).toEqual(['PH']);
    expect(clientOptionsForComp(opts, 'SFM').map((o) => o.value)).toEqual(['Vuori']);
  });
  it('keeps the value already chosen offered', () => {
    expect(clientOptionsForComp(opts, 'SFM', 'PH').map((o) => o.value)).toEqual(['PH', 'Vuori']);
  });
  it('never empties the list: a Comp nobody is filed under offers everyone', () => {
    expect(clientOptionsForComp(opts, 'EDS')).toHaveLength(3);
  });
});

const teams = [
  { client: 'PH', billing_entity: 'BKR', am: 'Ann Am', tl: 'Tom Tl', atl: null },
  { client: 'PH', billing_entity: 'AF', am: 'Bea Am', tl: 'Tom Tl', atl: 'Al Atl' },
  { client: 'Vuori', billing_entity: 'SFM', am: 'Cy Am', tl: 'Ted Tl', atl: 'Al Atl' },
];
const names = { am: ['Ann Am', 'Bea Am', 'Cy Am'], tl: ['Tom Tl', 'Ted Tl'], atl: ['Al Atl'] };

describe('refillFromClientTeam', () => {
  it('fills empty seats when the client is set', () => {
    const bag: Record<string, unknown> = { Client: 'Vuori', '21. Comp': 'SFM' };
    const ch = refillFromClientTeam({ client: null, comp: 'SFM' }, bag, new Set(['Client']), teams, names);
    expect(bag).toMatchObject({ AM: 'Cy Am', TL: 'Ted Tl', ATL: 'Al Atl' });
    expect(ch.map((c) => c.key)).toEqual(['AM', 'TL', 'ATL']);
  });
  it('replaces the old team, keeps a hand-picked name, clears a seat the new team leaves blank', () => {
    const bag: Record<string, unknown> = { Client: 'PH', '21. Comp': 'BKR', AM: 'Bea Am', TL: 'Someone Else', ATL: 'Al Atl' };
    refillFromClientTeam({ client: 'PH', comp: 'AF' }, bag, new Set(['21. Comp']), teams, names);
    expect(bag.AM).toBe('Ann Am');
    expect(bag.TL).toBe('Someone Else');
    expect('ATL' in bag).toBe(false);
  });
  it('leaves a seat the same save set', () => {
    const bag: Record<string, unknown> = { Client: 'Vuori', '21. Comp': 'SFM', AM: 'Typed' };
    refillFromClientTeam({ client: null, comp: 'SFM' }, bag, new Set(['Client', 'AM']), teams, names);
    expect(bag.AM).toBe('Typed');
  });
  it('fills an empty Comp from a client with one team', () => {
    const bag: Record<string, unknown> = { Client: 'Vuori' };
    const ch = refillFromClientTeam({ client: null, comp: null }, bag, new Set(['Client']), teams, names);
    expect(bag['21. Comp']).toBe('SFM');
    expect(ch[0]).toEqual({ key: '21. Comp', before: null, after: 'SFM' });
  });
  it('is wired into the single-field save, logged via client_team', () => {
    const src = readFileSync(new URL('../apps/api/src/services/woFieldValues.ts', import.meta.url), 'utf8');
    expect(src).toContain('refillTeamOnEdit');
    expect(src).toContain("teamLog, 'client_team'");
  });
});
