/* 0053 — billing proposals (BRD §6.4), the pure half. The database half
 * (services/billingProposals.ts) decides WHEN to propose; these pin WHAT a
 * contract's rates and the hours on site turn into, and that a vendor's
 * terms never price a client invoice or the other way round.
 */

import { describe, it, expect } from 'vitest';
import { contractBillingLines, proposalTotals, withAmounts } from '../packages/shared/src/billing';
import { contractScore, pickContract, type Contract } from '../packages/shared/src/contracts';

const contract = (over: Partial<Contract>): Contract => ({
  id: over.id ?? 'c',
  name: over.name ?? 'Card',
  party: 'client',
  vendor_name: null,
  auto_invoice: false,
  client: null,
  billing_entity: null,
  kind: 'tm',
  account_code: null,
  starts_on: '2026-01-01',
  ends_on: null,
  active: true,
  sites_covered: [],
  trades_covered: [],
  notes: null,
  created_by: null,
  created_at: '',
  updated_at: '',
  rates: [],
  in_force: true,
  ...over,
});

const TODAY = '2026-09-22';

describe('what a contract proposes to bill', () => {
  it('bills the hours at the standard rate and a trip charge per visit', () => {
    const lines = contractBillingLines({ standard: 85, trip_charge: 40 }, 3.5, 2, 'Wendy T&M');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: 'labor', quantity: 3.5, unit_price: 85, amount: 297.5 });
    expect(lines[1]).toMatchObject({ kind: 'trip', quantity: 2, unit_price: 40, amount: 80 });
    expect(lines[0].description).toContain('Wendy T&M');
  });

  it('proposes nothing for no hours and no visits', () => {
    expect(contractBillingLines({ standard: 85, trip_charge: 40 }, 0, 0, 'Card')).toEqual([]);
  });

  it('skips the labor line when the card states no hourly rate', () => {
    const lines = contractBillingLines({ standard: null, trip_charge: 40 }, 2, 1, 'Card');
    expect(lines.map((l) => l.kind)).toEqual(['trip']);
  });

  it('rounds like the invoice does — 1.5 × 99.99 is 149.99, not 149.98', () => {
    const [line] = withAmounts([{ kind: 'labor', description: 'x', quantity: 1.5, unit_price: 99.99, amount: 0 }]);
    expect(line.amount).toBe(149.99);
    expect(proposalTotals([line], 10)).toEqual({ subtotal: 149.99, total: 159.99 });
  });
});

describe('client cards and vendor terms never compete', () => {
  const clientCard = contract({ id: 'client', client: "Wendy's" });
  const vendorCard = contract({ id: 'vendor', party: 'vendor', vendor_name: 'Acme HVAC' });
  const anyVendor = contract({ id: 'any-vendor', party: 'vendor', vendor_name: null });
  const subject = { client: "Wendy's", billing_entity: null, trade: 'HVAC', site: null };

  it('a client invoice is priced by the client card only', () => {
    expect(pickContract([clientCard, vendorCard, anyVendor], subject, TODAY)?.id).toBe('client');
  });

  it('a vendor bill is priced by the card naming the vendor, then the house vendor card', () => {
    const vendorSubject = { ...subject, party: 'vendor' as const, vendor: 'acme hvac' };
    expect(pickContract([clientCard, vendorCard, anyVendor], vendorSubject, TODAY)?.id).toBe('vendor');
    const other = { ...subject, party: 'vendor' as const, vendor: 'Someone Else' };
    expect(pickContract([clientCard, vendorCard, anyVendor], other, TODAY)?.id).toBe('any-vendor');
  });

  it('a vendor card is out of the running for a client invoice', () => {
    expect(contractScore(vendorCard, subject, TODAY)).toBe(-1);
    expect(contractScore(anyVendor, subject, TODAY)).toBe(-1);
  });
});
