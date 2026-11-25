/* 0162 (Elise, 2026-11-25) — the AM approves every purchase-request band
 * below their own: a $600 purchase request is the AM's as well as TL / ATL's. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tierAllows, tierFor, type ApprovalTier } from '../packages/shared/src/approvalTiers';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const band = (id: string, min: number, max: number | null, roles: string[], position: number): ApprovalTier => ({
  id, kind: 'purchase_request', label: id, min_amount: min, max_amount: max, roles, position,
});
// The bands as 0162 leaves them.
const BANDS = [band('under', 0, 500, [], 0), band('mid', 500, 3000, ['tl', 'atl', 'am'], 1), band('top', 3000, null, ['am'], 2)];

describe('0162: the AM covers the purchase-request bands below theirs', () => {
  it('an AM approves $600 and $250,000; TL / ATL keep $500 to $3,000 only', () => {
    const mid = tierFor(BANDS, 'purchase_request', 600);
    expect(tierAllows(mid, 'am', false)).toBe(true);
    expect(tierAllows(mid, 'tl', false)).toBe(true);
    expect(tierAllows(mid, 'atl', false)).toBe(true);
    expect(tierAllows(mid, 'om', false)).toBe(false);
    const top = tierFor(BANDS, 'purchase_request', 250_000);
    expect(tierAllows(top, 'am', false)).toBe(true);
    expect(tierAllows(top, 'tl', false)).toBe(false);
  });

  it('the migration adds am only to named purchase bands under the AM band', () => {
    const sql = read('packages/db/migrations/0162_purchase_bands_am_covers_lower.sql').replace(/\s+/g, ' ');
    expect(sql).toContain("SET roles = array_append(roles, 'am')");
    expect(sql).toContain("WHERE kind = 'purchase_request'");
    // An empty band means "anyone with the permission": adding am would narrow it.
    expect(sql).toContain('AND cardinality(roles) > 0');
    expect(sql).toContain("AND NOT ('am' = ANY (roles))");
    // Payments, vendor bills and invoices are untouched.
    expect(sql).not.toMatch(/kind = '(payment|vendor_bill|invoice)'/);
  });
});
