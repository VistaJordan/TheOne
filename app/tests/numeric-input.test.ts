// Money and number fields take figures only (Elise, 2026-11-13, Client NTE).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { numericInputValue, parseTypedNumber } from '../packages/shared/src/numericInput';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('numericInputValue (what the box keeps)', () => {
  it('drops letters, e, +, spaces and commas', () => {
    expect(numericInputValue('abc500', { money: true })).toBe('500');
    expect(numericInputValue('5e3', { money: true })).toBe('53');
    expect(numericInputValue('$1,250.75', { money: true })).toBe('1250.75');
  });
  it('keeps one point and two decimals for money', () => {
    expect(numericInputValue('12.3.4', { money: true })).toBe('12.34');
    expect(numericInputValue('99.999', { money: true })).toBe('99.99');
    expect(numericInputValue('1.', { money: true })).toBe('1.');
  });
  it('a minus only where allowed', () => {
    expect(numericInputValue('-5', { money: true })).toBe('5');
    expect(numericInputValue('-5', { allowNegative: true })).toBe('-5');
  });
});

describe('parseTypedNumber (what the API accepts)', () => {
  it('refuses letters instead of stripping them', () => {
    expect(parseTypedNumber('abc500')).toBeNull();
    expect(parseTypedNumber('5e3')).toBeNull();
    expect(parseTypedNumber('500 dollars')).toBeNull();
    expect(parseTypedNumber('')).toBeNull();
  });
  it('accepts plain figures, a $ and thousands commas', () => {
    expect(parseTypedNumber('500')).toBe(500);
    expect(parseTypedNumber(724.19)).toBe(724.19);
    expect(parseTypedNumber('$1,250.75')).toBe(1250.75);
    expect(parseTypedNumber('.5')).toBe(0.5);
    expect(parseTypedNumber('-3')).toBe(-3);
  });
});

describe('every typed field box filters figures', () => {
  for (const f of [
    'apps/web/src/components/wo/fieldEdit.tsx',
    'apps/web/src/components/wo/list/CreateWorkOrderDialog.tsx',
    'apps/web/src/pages/IntakePage.tsx',
    'apps/web/src/components/wo/list/BulkBar.tsx',
  ]) {
    it(f, () => expect(read(f)).toContain('numericInputValue(e.target.value'));
  }
  it('the API refuses rather than strips', () => {
    const src = read('apps/api/src/services/woFieldValues.ts');
    expect(src).toContain('parseTypedNumber(raw)');
    expect(src).not.toContain(`replace(/[^0-9.-]/g, '')`);
  });
});
