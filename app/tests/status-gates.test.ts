/* Rules 11.2.1 / 11.2.2 — the Quoting & Parts gate, vocabulary half. The
 * database half (services/statusGates.ts) answers the same questions in SQL;
 * these pin what "gated status" and "filled" mean so the two halves cannot
 * drift apart silently. */

import { describe, it, expect } from 'vitest';
import {
  PARTS_GATED_STATUS_NAMES,
  PARTS_REQUIRED_KEY,
  QUOTE_READY_STATUS_NAME,
  describeStatusGate,
  partsRequiredFilled,
  quoteSectionsHaveData,
  statusGateFor,
  statusGateTag,
} from '../packages/shared/src/statusGates';

describe('statusGateFor — which status opens which gate', () => {
  it('gates Quote Ready on the quote (11.2.1)', () => {
    expect(statusGateFor(QUOTE_READY_STATUS_NAME)).toBe('quote');
    expect(statusGateFor('quote ready')).toBe('quote');
    expect(statusGateFor('  Quote Ready ')).toBe('quote');
  });

  it('gates both parts statuses on the parts list (11.2.2)', () => {
    expect(PARTS_GATED_STATUS_NAMES).toEqual(['Waiting for Parts', 'Please Order Parts']);
    for (const name of PARTS_GATED_STATUS_NAMES) expect(statusGateFor(name)).toBe('parts');
    expect(statusGateFor('PLEASE ORDER PARTS')).toBe('parts');
  });

  it('leaves every other status alone — Waiting for Quote needs no validation', () => {
    expect(statusGateFor('Waiting for Quote')).toBeNull();
    expect(statusGateFor('Waiting for Approval')).toBeNull();
    expect(statusGateFor('Parts Arrived')).toBeNull();
    expect(statusGateFor('')).toBeNull();
    expect(statusGateFor(null)).toBeNull();
    expect(statusGateFor(undefined)).toBeNull();
  });
});

describe('partsRequiredFilled — "NOT NULL" for a hand-typed list', () => {
  it('rejects nothing, blanks and whitespace', () => {
    expect(partsRequiredFilled(null)).toBe(false);
    expect(partsRequiredFilled(undefined)).toBe(false);
    expect(partsRequiredFilled('')).toBe(false);
    expect(partsRequiredFilled('   \n\t')).toBe(false);
    expect(partsRequiredFilled([])).toBe(false);
    expect(partsRequiredFilled(['', ' '])).toBe(false);
  });

  it('accepts any text and any array with a non-blank entry', () => {
    expect(partsRequiredFilled('Condenser fan motor')).toBe(true);
    expect(partsRequiredFilled('1x motor\n1x start kit')).toBe(true);
    expect(partsRequiredFilled(['', 'capacitor'])).toBe(true);
    expect(partsRequiredFilled(0)).toBe(true);
  });
});

describe('quoteSectionsHaveData — what "the quote section contains data" means', () => {
  it('is false for no quote and for the empty draft createQuote leaves behind', () => {
    expect(quoteSectionsHaveData(null)).toBe(false);
    expect(quoteSectionsHaveData(undefined)).toBe(false);
    expect(quoteSectionsHaveData([])).toBe(false);
    expect(quoteSectionsHaveData([{ lines: [], scope_lines: [] }])).toBe(false);
    expect(quoteSectionsHaveData([{ lines: [], scope_lines: ['', '  '] }])).toBe(false);
  });

  it('is true with a line item or a scope line in any section', () => {
    expect(quoteSectionsHaveData([{ lines: [], scope_lines: [] }, { lines: [{}], scope_lines: [] }])).toBe(true);
    expect(quoteSectionsHaveData([{ lines: [], scope_lines: ['Replace the seized motor'] }])).toBe(true);
    expect(quoteSectionsHaveData([{ lines: [{}] }])).toBe(true);
  });
});

describe('the sentence and the tag', () => {
  it('names the status and, for parts, the field to fill', () => {
    expect(describeStatusGate('quote', 'Quote Ready')).toContain('Quote Ready');
    expect(describeStatusGate('quote', 'Quote Ready')).toContain('Quote tab');
    expect(describeStatusGate('parts', 'Waiting for Parts')).toContain(PARTS_REQUIRED_KEY);
    expect(describeStatusGate('parts', 'Please Order Parts')).toContain('Please Order Parts');
  });

  it('keeps the tags short', () => {
    expect(statusGateTag('quote')).toBe('Needs quote');
    expect(statusGateTag('parts')).toBe('Needs parts');
  });
});
