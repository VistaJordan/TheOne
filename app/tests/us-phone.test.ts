/* A new vendor's phone on Request payment must be a real US number (Elise,
   2026-11-03): the pure check, the shape it is stored in, the keystroke mask,
   and the API refusing one before a vendor record is created. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatUsPhone, usPhoneInputValue, usPhoneProblem } from '@theone/shared';

describe('usPhoneProblem', () => {
  it('takes ten digits in any usual shape, with or without the 1', () => {
    for (const ok of ['(409) 555-0143', '409-555-0143', '409.555.0143', '4095550143', '+1 409 555 0143', '1-409-555-0143']) {
      expect(usPhoneProblem(ok)).toBeNull();
    }
  });
  it('refuses text, short, long and impossible numbers', () => {
    expect(usPhoneProblem('')).toMatch(/Enter the phone/);
    expect(usPhoneProblem('call me')).toMatch(/digits only/);
    expect(usPhoneProblem('409-555-01x3')).toMatch(/digits only/);
    expect(usPhoneProblem('555-0143')).toMatch(/10-digit/);
    expect(usPhoneProblem('40955501431')).toMatch(/10-digit/);
    expect(usPhoneProblem('(109) 555-0143')).toMatch(/area code/);
    expect(usPhoneProblem('(411) 555-0143')).toMatch(/area code/);
    expect(usPhoneProblem('(409) 155-0143')).toMatch(/not a valid/);
    expect(usPhoneProblem('(409) 911-0143')).toMatch(/not a valid/);
  });
});

describe('formatUsPhone', () => {
  it('stores one shape, and nothing for a bad number', () => {
    expect(formatUsPhone('+1 409 555 0143')).toBe('(409) 555-0143');
    expect(formatUsPhone('hello')).toBeNull();
  });
});

describe('usPhoneInputValue', () => {
  it('keeps digits only, ten at most, shaped as typed', () => {
    expect(usPhoneInputValue('abc')).toBe('');
    expect(usPhoneInputValue('40')).toBe('(40');
    expect(usPhoneInputValue('40955')).toBe('(409) 55');
    expect(usPhoneInputValue('409555014399')).toBe('(409) 555-0143');
    expect(usPhoneInputValue('14095550143')).toBe('(409) 555-0143');
    expect(usPhoneInputValue('(409) 555-01x')).toBe('(409) 555-01');
  });
});

describe('the API asks it before creating a vendor', () => {
  const src = readFileSync(resolve(__dirname, '../apps/api/src/services/payments.ts'), 'utf8');
  it('refuses with VALIDATION on payee_phone and stores the formatted number', () => {
    expect(src).toMatch(/if \(!vendorId && payeePhone\) \{\s+const problem = usPhoneProblem\(payeePhone\);/);
    expect(src).toContain("field: 'payee_phone'");
    expect(src).toContain('[payeeName, newPayeePhone, actor.id]');
  });
});
