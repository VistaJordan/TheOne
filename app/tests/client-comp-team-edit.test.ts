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
  it('Sales Owner follows the team when the options are given (2026-10-28)', () => {
    const sales = ['Rocio', 'Kevin', 'House'];
    const t = [
      { client: 'PH', billing_entity: 'AF', am: 'Bea Am', tl: 'Tom Tl', atl: null, sales: 'rocio' },
      { client: 'Vuori', billing_entity: 'SFM', am: 'Cy Am', tl: 'Ted Tl', atl: null, sales: 'Kevin' },
    ];
    const bag: Record<string, unknown> = { Client: 'Vuori', '21. Comp': 'SFM', 'Sales Owner': 'Rocio' };
    refillFromClientTeam({ client: 'PH', comp: 'AF' }, bag, new Set(['Client']), t, names, sales);
    expect(bag['Sales Owner']).toBe('Kevin');
    // a hand-picked salesperson stays
    const kept: Record<string, unknown> = { Client: 'Vuori', '21. Comp': 'SFM', 'Sales Owner': 'House' };
    refillFromClientTeam({ client: 'PH', comp: 'AF' }, kept, new Set(['Client']), t, names, sales);
    expect(kept['Sales Owner']).toBe('House');
    // without the options, Sales Owner is not touched
    const off: Record<string, unknown> = { Client: 'Vuori', '21. Comp': 'SFM' };
    refillFromClientTeam({ client: null, comp: 'SFM' }, off, new Set(['Client']), t, names);
    expect('Sales Owner' in off).toBe(false);
  });
  it('an FM change sets the Client when it names a client record (2026-10-28)', () => {
    const src = readFileSync(new URL('../apps/api/src/services/woFieldValues.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/fields\.22\. FM[\s\S]{0,300}clientForFm/);
    expect(src).toMatch(/fmSetClient \|\| log\.some/);
    const svc = readFileSync(new URL('../apps/api/src/services/clientTeams.ts', import.meta.url), 'utf8');
    expect(svc).toContain("return refillFromClientTeam(before, bag, explicit, teams, bySeat(people), sales)");
  });
  it('is wired into the single-field save, logged via client_team', () => {
    const src = readFileSync(new URL('../apps/api/src/services/woFieldValues.ts', import.meta.url), 'utf8');
    expect(src).toContain('refillTeamOnEdit');
    expect(src).toContain("teamLog, 'client_team'");
  });
});

describe('the Client picker follows the Comp everywhere (2026-10-30)', () => {
  it('Add work order and the draft form both narrow it', () => {
    for (const f of ['../apps/web/src/components/wo/list/CreateWorkOrderDialog.tsx', '../apps/web/src/pages/IntakePage.tsx']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).toMatch(/clientOptionsForComp\(all, (values\[COMP_KEY\]|v\['21\. Comp'\]), val\)/);
    }
  });
});
