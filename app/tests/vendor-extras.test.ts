// 0066 — the pure rules of the vendor extras: what the invoicing rules say
// about a bill, when a credit note may be raised, who a dispatch run offers
// the job to next, where an induction stands.
import { describe, expect, it } from 'vitest';
import {
  BILL_RULE_DEFAULTS,
  PORTAL_TOKEN_RE,
  billWarnings,
  cleanBillRules,
  cleanDispatchSettings,
  creditNeedsApproval,
  creditNoteProblem,
  inductionState,
  nextCandidate,
  slaRate,
  type BillFacts,
} from '@theone/shared';

const clean: BillFacts = {
  bill_number: 'INV-7',
  received_on: '2026-10-05',
  same_number: 0,
  vendor_total_on_wo: 400,
  wo_cost: 500,
  has_vendor: true,
  vendor_on_wo: true,
  completed_on: '2026-10-01',
};
const rulesOf = (f: Partial<BillFacts>, rules = BILL_RULE_DEFAULTS) => billWarnings({ ...clean, ...f }, rules).map((w) => w.rule);

describe('what the invoicing rules say about a bill', () => {
  it('says nothing about a bill that is in order', () => {
    expect(rulesOf({})).toEqual([]);
  });

  it('warns on a missing or repeated invoice number', () => {
    expect(rulesOf({ bill_number: '  ' })).toEqual(['bill_number_required']);
    expect(rulesOf({ same_number: 1 })).toEqual(['duplicate_number']);
  });

  it('warns when the vendor’s bills pass the work order’s Cost, not when they meet it', () => {
    expect(rulesOf({ vendor_total_on_wo: 500 })).toEqual([]);
    expect(rulesOf({ vendor_total_on_wo: 500.01 })).toEqual(['over_cost']);
    expect(rulesOf({ vendor_total_on_wo: 9000, wo_cost: null })).toEqual([]);
  });

  it('warns about a vendor who is not on the work order, but not about a typed name', () => {
    expect(rulesOf({ vendor_on_wo: false })).toEqual(['vendor_not_on_wo']);
    expect(rulesOf({ has_vendor: false, vendor_on_wo: false })).toEqual([]);
  });

  it('warns when billed before completion, and when billed late', () => {
    expect(rulesOf({ completed_on: null })).toEqual(['before_completion']);
    expect(rulesOf({ received_on: '2026-09-30' })).toEqual(['before_completion']);
    expect(rulesOf({ received_on: '2026-10-31' })).toEqual([]);
    expect(rulesOf({ received_on: '2026-11-01' })).toEqual(['late_days']);
  });

  it('a rule switched off says nothing', () => {
    const off = { ...BILL_RULE_DEFAULTS, bill_number_required: false, late_days: 0 };
    expect(rulesOf({ bill_number: null, received_on: '2027-01-01' }, off)).toEqual([]);
  });

  it('reads stored settings defensively', () => {
    expect(cleanBillRules(null)).toEqual(BILL_RULE_DEFAULTS);
    expect(cleanBillRules({ over_cost: false, late_days: -4, credit_approval_over: '100' })).toMatchObject({ over_cost: false, late_days: 30, credit_approval_over: 100 });
  });
});

describe('credit notes', () => {
  it('needs an amount, a reason, and room left on the bill', () => {
    expect(creditNoteProblem(100, 'Trip charge billed twice', 900, 0, 'received')).toBeNull();
    expect(creditNoteProblem(0, 'x', 900, 0, 'received')).toMatch(/more than zero/);
    expect(creditNoteProblem(100, '  ', 900, 0, 'received')).toMatch(/what the credit is for/);
    expect(creditNoteProblem(100, 'x', 900, 850, 'received')).toMatch(/\$50\.00/);
    expect(creditNoteProblem(900, 'x', 900, 0, 'paid')).toBeNull();
    expect(creditNoteProblem(100, 'x', 900, 0, 'void')).toMatch(/void/);
  });

  it('waits for an approver only above the limit', () => {
    expect(creditNeedsApproval(250, BILL_RULE_DEFAULTS)).toBe(false);
    expect(creditNeedsApproval(250.01, BILL_RULE_DEFAULTS)).toBe(true);
    expect(creditNeedsApproval(1, { ...BILL_RULE_DEFAULTS, credit_approval_over: 0 })).toBe(true);
  });
});

describe('the dispatch run', () => {
  const c = (name: string, rank: number, over: Partial<{ blacklisted: boolean; offered: boolean }> = {}) => ({ vendor_id: name, name, rank, rule: '', blacklisted: false, offered: false, ...over });
  it('offers the best-ranked vendor that was not asked yet and is not blacklisted', () => {
    expect(nextCandidate([c('B', 2), c('A', 1)])?.name).toBe('A');
    expect(nextCandidate([c('A', 1, { offered: true }), c('B', 2, { blacklisted: true }), c('C', 3)])?.name).toBe('C');
    expect(nextCandidate([c('A', 1, { offered: true })])).toBeNull();
    expect(nextCandidate([])).toBeNull();
  });

  it('is off unless somebody switched it on', () => {
    expect(cleanDispatchSettings(null)).toEqual({ enabled: false, auto_start: false, hours: 4 });
    expect(cleanDispatchSettings({ enabled: 'yes', hours: 0 })).toEqual({ enabled: false, auto_start: false, hours: 4 });
    expect(cleanDispatchSettings({ enabled: true, auto_start: true, hours: 500 })).toEqual({ enabled: true, auto_start: true, hours: 168 });
  });
});

describe('inductions, SLA, the portal token', () => {
  it('an induction is pending until done, current until its last day, expired after', () => {
    expect(inductionState(null, null, '2026-10-02')).toBe('pending');
    expect(inductionState('2026-01-01', null, '2030-01-01')).toBe('current');
    expect(inductionState('2026-01-01', '2026-10-02', '2026-10-02')).toBe('current');
    expect(inductionState('2026-01-01', '2026-10-02', '2026-10-03')).toBe('expired');
  });

  it('the SLA rate is over the jobs that had an SLA date', () => {
    expect(slaRate(0, 0)).toBeNull();
    expect(slaRate(9, 1)).toBe(90);
    expect(slaRate(1, 2)).toBe(33);
  });

  it('a portal token is exactly 32 url-safe characters', () => {
    expect(PORTAL_TOKEN_RE.test('a'.repeat(32))).toBe(true);
    expect(PORTAL_TOKEN_RE.test('a'.repeat(31))).toBe(false);
    expect(PORTAL_TOKEN_RE.test(`${'a'.repeat(31)}/`)).toBe(false);
  });
});
