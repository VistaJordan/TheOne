/* 0047 — approval tiers (rule 6.2.3), vocabulary half. The database half
 * (services/approvalTiers.ts) stores the bands and raises the 403; these pin
 * which band an amount falls in and who may decide inside it — the two
 * things that, wrong, let a $4,000 payment out on an account manager's say.
 */

import { describe, it, expect } from 'vitest';
import {
  describeTierBand,
  tierAllows,
  tierFor,
  type ApprovalTier,
} from '../packages/shared/src/approvalTiers';

const TIERS: ApprovalTier[] = [
  { id: 'a', kind: 'payment', label: 'Under $500', min_amount: 0, max_amount: 500, roles: [], position: 0 },
  { id: 'b', kind: 'payment', label: '$500 to $3,000', min_amount: 500, max_amount: 3000, roles: ['tl', 'atl', 'am', 'admin'], position: 1 },
  { id: 'c', kind: 'payment', label: 'Over $3,000', min_amount: 3000, max_amount: null, roles: ['tl', 'admin'], position: 2 },
  { id: 'i', kind: 'invoice', label: '$10,000 and above', min_amount: 10000, max_amount: null, roles: ['ar', 'tl', 'admin'], position: 0 },
];

describe('which band an amount falls in', () => {
  it('is min-inclusive and max-exclusive', () => {
    expect(tierFor(TIERS, 'payment', 0)?.id).toBe('a');
    expect(tierFor(TIERS, 'payment', 499.99)?.id).toBe('a');
    expect(tierFor(TIERS, 'payment', 500)?.id).toBe('b');
    expect(tierFor(TIERS, 'payment', 2999.99)?.id).toBe('b');
    expect(tierFor(TIERS, 'payment', 3000)?.id).toBe('c');
    expect(tierFor(TIERS, 'payment', 1_000_000)?.id).toBe('c');
  });

  it('keeps kinds apart, and answers null where no band is set', () => {
    expect(tierFor(TIERS, 'invoice', 12_000)?.id).toBe('i');
    expect(tierFor(TIERS, 'invoice', 500)).toBeNull();
    expect(tierFor(TIERS, 'vendor_bill', 500)).toBeNull();
  });

  it('reads the bands in position order, not array order', () => {
    const shuffled = [TIERS[2], TIERS[0], TIERS[1]];
    expect(tierFor(shuffled, 'payment', 700)?.id).toBe('b');
  });
});

describe('who may decide inside a band', () => {
  const mid = TIERS[1];
  const top = TIERS[2];

  it('lets the named roles through and nobody else', () => {
    expect(tierAllows(mid, 'am', false)).toBe(true);
    expect(tierAllows(mid, 'om', false)).toBe(false);
    expect(tierAllows(top, 'am', false)).toBe(false);
    expect(tierAllows(top, 'tl', false)).toBe(true);
  });

  it('restricts nobody when the band names no roles, or no band applies', () => {
    expect(tierAllows(TIERS[0], 'om', false)).toBe(true);
    expect(tierAllows(null, null, false)).toBe(true);
  });

  it('never stops a super admin', () => {
    expect(tierAllows(top, 'om', true)).toBe(true);
    expect(tierAllows(top, null, true)).toBe(true);
  });

  it('treats a missing role as outside every restricted band', () => {
    expect(tierAllows(mid, null, false)).toBe(false);
    expect(tierAllows(mid, undefined, false)).toBe(false);
  });
});

describe('how a band reads', () => {
  it('words the three shapes of band', () => {
    expect(describeTierBand(0, 500)).toBe('Under $500');
    expect(describeTierBand(500, 3000)).toBe('$500 to $3,000');
    expect(describeTierBand(3000, null)).toBe('Over $3,000');
    expect(describeTierBand(0, null)).toBe('Any amount');
  });
});
