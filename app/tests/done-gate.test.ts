/* Rules 11.3.1 – 11.3.3 — the "Job is Done" gate, vocabulary half. The
 * database half (services/statusGates.ts, doneGateMissingFor) reads the
 * visit log, the Cost bag key and the quote; these pin what each check
 * means and what the person reads when the move is refused. */

import { describe, it, expect } from 'vitest';
import {
  DONE_GATE_CHECKS,
  DONE_STATUS_NAME,
  FINAL_COST_KEY,
  costFilled,
  describeStatusGate,
  doneGateMissing,
  statusGateFor,
  statusGateTag,
} from '../packages/shared/src/statusGates';
import { completionProofMissing } from '../packages/shared/src/attachments';

describe('statusGateFor — Done / Incurred opens the Done gate', () => {
  it('matches the status by name, case-insensitively', () => {
    expect(statusGateFor(DONE_STATUS_NAME)).toBe('done');
    expect(statusGateFor('done / incurred')).toBe('done');
    expect(statusGateFor('  Done / Incurred ')).toBe('done');
  });

  it('leaves the neighbouring statuses alone', () => {
    expect(statusGateFor('Ready to Invoice')).toBeNull();
    expect(statusGateFor('Invoiced')).toBeNull();
    expect(statusGateFor('Done')).toBeNull();
  });
});

describe('costFilled — "NOT NULL" for the final vendor cost (11.3.2)', () => {
  it('rejects nothing, blanks and words', () => {
    expect(costFilled(null)).toBe(false);
    expect(costFilled(undefined)).toBe(false);
    expect(costFilled('')).toBe(false);
    expect(costFilled('   ')).toBe(false);
    expect(costFilled('TBD')).toBe(false);
    expect(costFilled(true)).toBe(false);
    expect(costFilled(NaN)).toBe(false);
  });

  it('accepts numbers and money-shaped text, zero included', () => {
    expect(costFilled(0)).toBe(true);
    expect(costFilled(1610)).toBe(true);
    expect(costFilled('0')).toBe(true);
    expect(costFilled('$1,610.00')).toBe(true);
    expect(costFilled(' 250 ')).toBe(true);
  });

  it('names the Cost field', () => {
    expect(FINAL_COST_KEY).toBe('34. Cost');
  });
});

describe('doneGateMissing — which of the three checks fail', () => {
  it('is empty when everything is in place', () => {
    expect(doneGateMissing({ visitComplete: true, costValue: '$400', quoteFilled: true })).toEqual([]);
  });

  it('lists what is absent, in the rule order visit → cost → quote', () => {
    expect(doneGateMissing({ visitComplete: false, costValue: null, quoteFilled: false })).toEqual([
      'visit',
      'cost',
      'quote',
    ]);
    expect(doneGateMissing({ visitComplete: true, costValue: '', quoteFilled: true })).toEqual(['cost']);
    expect(doneGateMissing({ visitComplete: false, costValue: 12, quoteFilled: true })).toEqual(['visit']);
    expect(doneGateMissing({ visitComplete: true, costValue: 12, quoteFilled: false })).toEqual(['quote']);
    expect(DONE_GATE_CHECKS).toEqual(['visit', 'cost', 'quote', 'after_photo']);
  });
});

describe('rule 11.3.4 — proof before Done (0061)', () => {
  const ok = { visitComplete: true, costValue: 12, quoteFilled: true };

  it('says nothing when the caller does not know the files', () => {
    expect(doneGateMissing(ok)).toEqual([]);
    expect(doneGateMissing({ ...ok, proof: null })).toEqual([]);
  });

  it('standard completion needs an approved after photo', () => {
    expect(doneGateMissing({ ...ok, proof: { bfi: false, approvedKinds: [] } })).toEqual(['after_photo']);
    expect(doneGateMissing({ ...ok, proof: { bfi: null, approvedKinds: ['before', 'signoff'] } })).toEqual([
      'after_photo',
    ]);
    expect(doneGateMissing({ ...ok, proof: { bfi: false, approvedKinds: ['after'] } })).toEqual([]);
  });

  it('a BFI job needs a before photo AND a sign-off instead', () => {
    expect(completionProofMissing(true, ['after'])).toBe('bfi_proof');
    expect(completionProofMissing('true', ['before'])).toBe('bfi_proof');
    expect(completionProofMissing(true, ['signoff'])).toBe('bfi_proof');
    expect(completionProofMissing(true, ['before', 'signoff'])).toBeNull();
    expect(doneGateMissing({ ...ok, proof: { bfi: true, approvedKinds: ['before', 'signoff'] } })).toEqual([]);
  });

  it('comes last in the list and has its own words', () => {
    expect(
      doneGateMissing({ visitComplete: false, costValue: null, quoteFilled: false, proof: { bfi: false, approvedKinds: [] } }),
    ).toEqual(['visit', 'cost', 'quote', 'after_photo']);
    expect(describeStatusGate('done', DONE_STATUS_NAME, ['after_photo'])).toContain('approved after photo');
    expect(describeStatusGate('done', DONE_STATUS_NAME, ['bfi_proof'])).toContain('sign-off');
    expect(statusGateTag('done', ['after_photo'])).toBe('Needs after photo');
    expect(statusGateTag('done', ['bfi_proof'])).toBe('Needs sign-off');
  });
});

describe('the sentence and the tag name only what is missing', () => {
  it('lists every check when nothing narrower is known', () => {
    const s = describeStatusGate('done', DONE_STATUS_NAME);
    expect(s).toContain('Done / Incurred needs');
    expect(s).toContain('checked in and checked out');
    expect(s).toContain(FINAL_COST_KEY);
    expect(s).toContain('quote');
  });

  it('narrows to the missing checks', () => {
    const s = describeStatusGate('done', DONE_STATUS_NAME, ['cost']);
    expect(s).toContain(FINAL_COST_KEY);
    expect(s).not.toContain('checked in');
    expect(s).not.toContain('quote');
    expect(describeStatusGate('done', DONE_STATUS_NAME, ['visit', 'quote'])).toContain(' and ');
  });

  it('keeps the tags short', () => {
    expect(statusGateTag('done')).toBe('Not ready');
    expect(statusGateTag('done', ['visit'])).toBe('Needs check-out');
    expect(statusGateTag('done', ['cost'])).toBe('Needs cost');
    expect(statusGateTag('done', ['quote'])).toBe('Needs quote');
    expect(statusGateTag('done', ['visit', 'cost'])).toBe('Not ready');
    // The older gates are untouched.
    expect(statusGateTag('quote')).toBe('Needs quote');
    expect(statusGateTag('parts')).toBe('Needs parts');
  });
});
