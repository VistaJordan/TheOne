/* City, State and Zip Code read off a work order's address (Elise,
 * 2026-10-22): packages/shared/src/addressParts.ts (pure) and
 * apps/api/src/services/addressFill.ts. Hermetic: the parser, the fill run
 * against a scripted query (no pool), and source-text pins on every writer
 * of the address. No database, no network. */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { addressPartValues, parseAddressParts } from '../packages/shared/src/addressParts';

vi.mock('../apps/api/src/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { addressWritten, fillFromAddress } from '../apps/api/src/services/addressFill';

const ROOT = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const p = (s: string) => parseAddressParts(s);

describe('parseAddressParts', () => {
  it('reads the team’s usual shape', () => {
    expect(p('7898 Bradley Long Dr, Sherrills Ford, NC 28673, USA')).toEqual({
      city: 'Sherrills Ford',
      state: 'NC',
      zip: '28673',
    });
  });
  it('without the country, with other spellings of it', () => {
    const want = { city: 'Dallas', state: 'TX', zip: '75201' };
    expect(p('123 Main St, Dallas, TX 75201')).toEqual(want);
    expect(p('123 Main St, Dallas, TX 75201, United States')).toEqual(want);
    expect(p('123 Main St, Dallas, TX 75201 US')).toEqual(want);
    expect(p('123 Main St, Dallas, TX 75201, U.S.A.')).toEqual(want);
  });
  it('a suite as its own part, ZIP+4, a spelled-out state', () => {
    expect(p('500 Elm Ave, Suite 4, Charlotte, North Carolina 28202-1234, USA')).toEqual({
      city: 'Charlotte',
      state: 'NC',
      zip: '28202-1234',
    });
  });
  it('two-word states and a city named like a state', () => {
    expect(p('1 Broadway, New York, New York 10004')).toEqual({ city: 'New York', state: 'NY', zip: '10004' });
    expect(p('9 Oak Rd, Charleston, West Virginia 25301')).toEqual({ city: 'Charleston', state: 'WV', zip: '25301' });
    expect(p('22 Pine St, Kansas City, MO 64105')).toEqual({ city: 'Kansas City', state: 'MO', zip: '64105' });
  });
  it('"City ST ZIP" with no comma before the state', () => {
    expect(p('123 Main St, Dallas TX 75201')).toEqual({ city: 'Dallas', state: 'TX', zip: '75201' });
  });
  it('a ZIP with no state still gives the city before it', () => {
    expect(p('7898 Bradley Long Dr, Sherrills Ford, 28673')).toEqual({ city: 'Sherrills Ford', state: null, zip: '28673' });
  });
  it('no commas at all: the state and ZIP only (the ZIP table names the city)', () => {
    expect(p('123 Main St Dallas TX 75201')).toEqual({ city: null, state: 'TX', zip: '75201' });
  });
  it('never takes the street for the city', () => {
    expect(p('123 Main St, TX 75201')).toEqual({ city: null, state: 'TX', zip: '75201' });
    expect(p('Suite 4, NC 28673')).toEqual({ city: null, state: 'NC', zip: '28673' });
  });
  it('reads nothing from a bare street or a non-address', () => {
    expect(p('123 Main St')).toEqual({ city: null, state: null, zip: null });
    expect(p('Behind the loading dock')).toEqual({ city: null, state: null, zip: null });
    expect(p('')).toEqual({ city: null, state: null, zip: null });
    expect(parseAddressParts(null)).toEqual({ city: null, state: null, zip: null });
  });
  it('a lower-case word at the end of a street is not a state', () => {
    expect(p('10 Walk in Way')).toEqual({ city: null, state: null, zip: null });
  });
  it('addressPartValues keys only the parts read', () => {
    expect(addressPartValues({ city: null, state: 'TX', zip: '75201' })).toEqual({ State: 'TX', 'Zip Code': '75201' });
  });
});

describe('fillFromAddress', () => {
  const tx = (rows: { city: string; state: string }[] = []) => ({ query: vi.fn().mockResolvedValue({ rows }) });

  it('overwrites the three fields from the address, and reports what changed', async () => {
    const bag: Record<string, unknown> = {
      '17. Address': '7898 Bradley Long Dr, Sherrills Ford, NC 28673, USA',
      City: 'Old Town',
      State: 'NC',
    };
    const q = tx();
    const changes = await fillFromAddress(bag, new Set(['17. Address']), q);
    expect(bag).toMatchObject({ City: 'Sherrills Ford', State: 'NC', 'Zip Code': '28673' });
    expect(changes).toEqual([
      { key: 'City', before: 'Old Town', after: 'Sherrills Ford' },
      { key: 'Zip Code', before: null, after: '28673' },
    ]);
    expect(q.query).not.toHaveBeenCalled(); // nothing to complete from the ZIP
  });
  it('leaves a part the same save set by hand', async () => {
    const bag: Record<string, unknown> = { '17. Address': '1 A St, Dallas, TX 75201', City: 'Highland Park' };
    await fillFromAddress(bag, new Set(['17. Address', 'City']), tx());
    expect(bag).toMatchObject({ City: 'Highland Park', State: 'TX', 'Zip Code': '75201' });
  });
  it('completes a missing city and state from the ZIP table', async () => {
    const bag: Record<string, unknown> = { '17. Address': '123 Main St Dallas TX 75201' };
    const q = tx([{ city: 'Dallas', state: 'TX' }]);
    await fillFromAddress(bag, new Set(), q);
    expect(q.query).toHaveBeenCalledWith(expect.stringContaining('FROM geo_zip'), ['75201']);
    expect(bag).toMatchObject({ City: 'Dallas', State: 'TX', 'Zip Code': '75201' });
  });
  it('ignores a ZIP row whose state contradicts the address', async () => {
    const bag: Record<string, unknown> = { '17. Address': '123 Main St TX 75201' };
    await fillFromAddress(bag, new Set(), tx([{ city: 'Somewhere', state: 'OK' }]));
    expect(bag.City).toBeUndefined();
    expect(bag.State).toBe('TX');
  });
  it('a bare street changes nothing', async () => {
    const bag: Record<string, unknown> = { '17. Address': '123 Main St', City: 'Dallas' };
    expect(await fillFromAddress(bag, new Set(), tx())).toEqual([]);
    expect(bag.City).toBe('Dallas');
  });
  it('addressWritten: only a non-blank address that changed', () => {
    expect(addressWritten(null, '1 A St, Dallas, TX 75201')).toBe(true);
    expect(addressWritten('1 A St', '1 A St')).toBe(false);
    expect(addressWritten('1 A St', '')).toBe(false);
    expect(addressWritten('1 A St', null)).toBe(false);
  });
});

describe('every writer of the address fills the parts', () => {
  it('the field editor and the automations (updateWorkOrderFields), logged via address, mirrors kept', () => {
    const src = read('apps', 'api', 'src', 'services', 'woFieldValues.ts');
    expect(src).toMatch(/fillFromAddress\(merged, new Set\(patch\.map/);
    expect(src).toMatch(/logTaskChanges\(tx, actorId, task\.id, addressLog, 'address'\)/);
    expect(src).toMatch(/MIRROR_BY_JSON_KEY\[f\.key\]/);
    expect(src).toMatch(/changes: \[\.\.\.log, \.\.\.addressLog[\],]/);
  });
  it('bulk edit and both halves of the CSV import', () => {
    const src = read('apps', 'api', 'src', 'services', 'woBulk.ts');
    expect(src.match(/fillFromAddress\(/g)?.length).toBe(3);
    expect(src.match(/addressLog, 'address'\)/g)?.length).toBe(2);
  });
  it('Add work order, intake drafts and planned maintenance', () => {
    expect(read('apps', 'api', 'src', 'services', 'woCreate.ts')).toMatch(/fillFromAddress\(bag, new Set\(Object\.keys\(bag\)\)\)/);
    expect(read('apps', 'api', 'src', 'services', 'intake.ts').match(/fillFromAddress\(/g)?.length).toBe(2);
    expect(read('apps', 'api', 'src', 'services', 'plannedMaintenance.ts')).toMatch(/fillFromAddress\(bag/);
  });
  it('the Add work order form fills them as the address is typed', () => {
    expect(read('apps', 'web', 'src', 'components', 'wo', 'list', 'CreateWorkOrderDialog.tsx')).toMatch(
      /key === ADDRESS_KEY \? addressPartValues\(parseAddressParts\(v\)\)/,
    );
  });
  it('going forward only: no migration back-fills old work orders', () => {
    const fill = read('apps', 'api', 'src', 'services', 'addressFill.ts');
    expect(fill).toMatch(/going forward only/);
  });
});
