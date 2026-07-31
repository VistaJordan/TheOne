// Hardened money validation (S4).
//
// Money enters the API twice — the quote's qty/rate/sales_tax/total_cost and the
// payment request's amount — and both paths are validated the SAME way, here.
//
// TWO layers, because JSON destroys evidence:
//
//  1. assertRawMoney() reads the RAW request body text. `{"amount": 5e3}` is
//     legal JSON that JSON.parse turns into the number 5000, so by the time a
//     schema sees it the exponent is gone and indistinguishable from a typed
//     5000. Money that reached us in exponent notation is a client bug (or a
//     probe) and never a real dollar figure a human typed, so it is rejected on
//     the raw text, before parsing. Same for "+500", "1_000" and "  12 ".
//  2. zMoney() re-validates the PARSED value, so a caller that bypasses the raw
//     scan (or a future non-JSON content type) still cannot store a negative,
//     a NaN or fractions of a cent.
//
// The pattern is deliberately FULL-STRING and boring: digits, optional . and
// one or two decimals. No currency symbols, no thousands separators, no signs.
// Formatting is the client's job; the wire carries plain numbers.

import { z } from 'zod';
import { badRequest } from './errors.js';

// The raw body text, stashed by index.ts's JSON content-type parser. Declared
// here — beside its only consumer — so every module that reads it also imports
// the augmentation.
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** A plain, unsigned, ≤2-decimal amount. Anchored — partial matches are rejected. */
export const MONEY_RE = /^\d{1,10}(?:\.\d{1,2})?$/;

/**
 * Money-bearing keys and their floor. `min: 0.01` means "a real payment" —
 * a $0 payment request is not a request. Quote inputs floor at 0 because the
 * builder legitimately holds a half-filled line (the comp's Option A line 5 has
 * no rate yet and is simply excluded from the subtotal).
 */
const MONEY_KEYS: Record<string, { min: number; nullable: boolean }> = {
  amount: { min: 0.01, nullable: false },
  qty: { min: 0, nullable: false },
  rate: { min: 0, nullable: false },
  sales_tax: { min: 0, nullable: false },
  total_cost: { min: 0, nullable: true },
};

// The lookbehind skips an ESCAPED quote, so the literal text `\"amount\": 9` in
// somebody's note is prose, not a money field.
const RAW_MONEY_RE = new RegExp(
  `(?<!\\\\)"(${Object.keys(MONEY_KEYS).join('|')})"\\s*:\\s*([^,}\\]]+)`,
  'g',
);

function reject(field: string, token: string, min: number): never {
  throw badRequest(
    `"${field}" must be a plain amount of at least ${min.toFixed(2)} — digits with at most two decimals, no sign, comma or exponent`,
    { field, received: token.slice(0, 40), pattern: MONEY_RE.source, min },
  );
}

/**
 * Validate every money token in the raw JSON body text. Runs before the Zod
 * schema so exponent notation is caught while it is still visible. A body that
 * carries no money key is a no-op.
 */
export function assertRawMoney(raw: string | undefined): void {
  if (!raw) return;
  RAW_MONEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RAW_MONEY_RE.exec(raw)) !== null) {
    const field = m[1];
    const rule = MONEY_KEYS[field];
    const token = m[2].trim();
    if (rule.nullable && token === 'null') continue;
    // Strings are accepted ("1234.56") — the value inside must still be plain money.
    const bare = token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1).trim() : token;
    if (!MONEY_RE.test(bare)) reject(field, token, rule.min);
    if (Number(bare) < rule.min) reject(field, token, rule.min);
  }
}

/**
 * A parsed money value: accepts a JSON number or a numeric string, always yields
 * a number. `min` is the floor (0.01 for a payment, 0 for a quote input).
 */
export function zMoney(label: string, min: number) {
  return z
    .union([z.number(), z.string()])
    .superRefine((v, ctx) => {
      const text = (typeof v === 'number' ? String(v) : v).trim();
      if (!MONEY_RE.test(text)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be a plain amount — digits with at most two decimals, no sign, comma or exponent`,
        });
        return;
      }
      if (Number(text) < min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be at least ${min.toFixed(2)}`,
        });
      }
    })
    .transform((v) => Number((typeof v === 'number' ? String(v) : v).trim()));
}
