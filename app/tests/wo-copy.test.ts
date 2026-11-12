/* The header's Copy full / Copy vague (Elise, 2026-11-12): pure text, no database. */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { woCopyFull, woCopyVague, woVagueAddress } from '../packages/shared/src/woCopy';

const ROOT = resolve(__dirname, '..');

const wo = {
  wo_number: 'WO-41017',
  description: 'column text',
  city: null,
  fields: {
    '17. Address': '7898 Bradley Long Dr, Sherrills Ford, NC 28673, USA',
    Store: '1234',
    '35. WO Description': 'Walk-in cooler not holding temp.\nCheck compressor.',
  },
};

describe('woCopyFull', () => {
  it('lists WO #, address, store and scope', () => {
    expect(woCopyFull(wo)).toBe(
      'WO#: WO-41017\nAddress: 7898 Bradley Long Dr, Sherrills Ford, NC 28673, USA\nStore: 1234\nScope: Walk-in cooler not holding temp.\nCheck compressor.',
    );
  });
  it('leaves out a line that is empty and falls back to the description column', () => {
    expect(woCopyFull({ wo_number: 'A1', description: 'Fix door', fields: {} })).toBe('WO#: A1\nScope: Fix door');
  });
});

describe('woCopyVague', () => {
  it('gives street, city and ZIP (no state) and the scope', () => {
    expect(woCopyVague(wo)).toBe(
      'Address: 7898 Bradley Long Dr, Sherrills Ford 28673\nScope: Walk-in cooler not holding temp.\nCheck compressor.',
    );
  });
  it('prefers the part fields over the parsed address', () => {
    expect(
      woVagueAddress({ wo_number: 'x', fields: { 'Street Address': '1 Elm St', City: 'Dallas', 'Zip Code': '75201', '17. Address': 'junk' } }),
    ).toBe('1 Elm St, Dallas 75201');
  });
  it('has no WO #, store or state', () => {
    const t = woCopyVague(wo);
    expect(t).not.toContain('WO-41017');
    expect(t).not.toContain('1234');
    expect(t).not.toContain('NC');
  });
});

it('the header draws both buttons', () => {
  const src = readFileSync(join(ROOT, 'apps/web/src/components/wo/WoHeader.tsx'), 'utf8');
  expect(src).toContain('<WoCopyButtons wo={wo} />');
});
