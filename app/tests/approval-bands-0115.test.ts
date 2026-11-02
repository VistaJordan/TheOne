/* 0115 (Elise, 2026-11-02) — one set of approval bands for payment requests
 * and purchase requests: under $500 no approval, $500 to $3,000 TL / ATL,
 * $3,000 and over AM (a super admin always may). */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APPROVAL_TIER_KINDS, tierAllows, tierFor, type ApprovalTier } from '../packages/shared/src/approvalTiers';
import { purchaseRequestNeedsNoApproval } from '../packages/shared/src/purchasing';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const band = (id: string, min: number, max: number | null, roles: string[], position: number): ApprovalTier => ({
  id, kind: 'purchase_request', label: id, min_amount: min, max_amount: max, roles, position,
});
const BANDS = [band('under', 0, 500, [], 0), band('mid', 500, 3000, ['tl', 'atl'], 1), band('top', 3000, null, ['am'], 2)];
const line = (unit_cost: number | null, qty = 1) => ({ description: 'Filter', qty, unit_cost });

describe('purchase requests ride the approval tiers', () => {
  it('is a tier kind', () => {
    expect(APPROVAL_TIER_KINDS).toContain('purchase_request');
  });

  it('$500 to $3,000: TL and ATL, not AM; $3,000 and over: AM only', () => {
    const mid = tierFor(BANDS, 'purchase_request', 1200);
    expect(tierAllows(mid, 'tl', false)).toBe(true);
    expect(tierAllows(mid, 'atl', false)).toBe(true);
    expect(tierAllows(mid, 'am', false)).toBe(false);
    const top = tierFor(BANDS, 'purchase_request', 250_000);
    expect(tierAllows(top, 'am', false)).toBe(true);
    expect(tierAllows(top, 'tl', false)).toBe(false);
    expect(tierAllows(top, 'admin', false)).toBe(false);
    expect(tierAllows(top, 'om', true)).toBe(true);
    expect(tierFor(BANDS, 'purchase_request', 3000)?.id).toBe('top');
  });

  it('under $500, every item priced, needs no approval', () => {
    expect(purchaseRequestNeedsNoApproval([line(120, 2)])).toBe(true);
    expect(purchaseRequestNeedsNoApproval([line(499.99)])).toBe(true);
    expect(purchaseRequestNeedsNoApproval([line(250, 2)])).toBe(false);
    // An unpriced item could hide anything: it waits.
    expect(purchaseRequestNeedsNoApproval([line(10), line(null)])).toBe(false);
    expect(purchaseRequestNeedsNoApproval([])).toBe(false);
  });

  it('the service approves on submit under $500 and asks the band on approve', () => {
    const src = read('apps/api/src/services/purchasing.ts');
    const fn = src.slice(src.indexOf('export async function actOnRequest'));
    expect(fn).toContain('if (purchaseRequestNeedsNoApproval(cur.lines))');
    expect(fn).toContain("await assertTierAllows('purchase_request', cur.estimate, actor, 'Approving a purchase request')");
    expect(src).toContain("tierSummary(tiers, 'purchase_request', estimate, viewer)");
  });

  it('the Approve button locks with the band', () => {
    const src = read('apps/web/src/components/purchasing/PurchasingParts.tsx');
    expect(src).toContain('disabled={busy || ownRequest || tierLocked}');
  });

  it('the migration sets the same bands for payments and purchase requests', () => {
    const sql = read('packages/db/migrations/0115_approval_bands_purchasing.sql').replace(/\s+/g, ' ');
    for (const kind of ['payment', 'purchase_request']) {
      expect(sql).toContain(`('${kind}', '$500 to $3,000', 500, 3000, '{tl,atl}', 1)`);
      expect(sql).toContain(`('${kind}', '$3,000 and over', 3000, NULL, '{am}', 2)`);
    }
    expect(sql).toContain("CHECK (kind IN ('payment', 'vendor_bill', 'invoice', 'purchase_request'))");
  });
});
