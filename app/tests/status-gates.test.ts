/* Rules 11.2.1 / 11.2.2 — the Quoting & Parts gate, vocabulary half. The
 * database half (services/statusGates.ts) answers the same questions in SQL;
 * these pin what "gated status" and "filled" mean so the two halves cannot
 * drift apart silently. 11.2.1 was widened on 2026-10-22 (Elise): Quote
 * Ready also needs the quote submitted and one approved picture. */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  PARTS_GATED_STATUS_NAMES,
  PARTS_REQUIRED_KEY,
  QUOTE_GATE_CHECKS,
  QUOTE_READY_STATUS_NAME,
  describeStatusGate,
  partsRequiredFilled,
  quoteGateMissing,
  quoteSectionsHaveData,
  quoteSubmitted,
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

describe('quoteSubmitted — the quote has left draft (11.2.1, 2026-10-22)', () => {
  it('is false for no quote and for a draft', () => {
    expect(quoteSubmitted(null)).toBe(false);
    expect(quoteSubmitted(undefined)).toBe(false);
    expect(quoteSubmitted('')).toBe(false);
    expect(quoteSubmitted('draft')).toBe(false);
    expect(quoteSubmitted(' Draft ')).toBe(false);
  });

  it('is true from Submit for correction on — every later status counts', () => {
    for (const s of ['pending_correction', 'pending_approval', 'approved', 'sent', 'client_approved', 'client_declined']) {
      expect(quoteSubmitted(s), s).toBe(true);
    }
  });
});

describe('quoteGateMissing — what Quote Ready finds missing', () => {
  it('lists the three checks in the rule\'s order', () => {
    expect(QUOTE_GATE_CHECKS).toEqual(['quote', 'quote_submitted', 'photo']);
  });

  it('passes a submitted quote with data and one approved picture', () => {
    expect(quoteGateMissing({ quoteFilled: true, quoteSubmitted: true, approvedPhotos: 1 })).toEqual([]);
    expect(quoteGateMissing({ quoteFilled: true, quoteSubmitted: true, approvedPhotos: 7 })).toEqual([]);
  });

  it('asks for the quote first and the submission only once there is one', () => {
    expect(quoteGateMissing({ quoteFilled: false, quoteSubmitted: false, approvedPhotos: 1 })).toEqual(['quote']);
    expect(quoteGateMissing({ quoteFilled: true, quoteSubmitted: false, approvedPhotos: 1 })).toEqual(['quote_submitted']);
  });

  it('asks for a picture whatever the quote says — zero or a bad count is none', () => {
    expect(quoteGateMissing({ quoteFilled: true, quoteSubmitted: true, approvedPhotos: 0 })).toEqual(['photo']);
    expect(quoteGateMissing({ quoteFilled: true, quoteSubmitted: true, approvedPhotos: Number.NaN })).toEqual(['photo']);
    expect(quoteGateMissing({ quoteFilled: false, quoteSubmitted: false, approvedPhotos: 0 })).toEqual(['quote', 'photo']);
    expect(quoteGateMissing({ quoteFilled: true, quoteSubmitted: false, approvedPhotos: 0 })).toEqual(['quote_submitted', 'photo']);
  });

  it('names each missing check in the sentence and the tag', () => {
    expect(describeStatusGate('quote', 'Quote Ready', ['quote_submitted'])).toContain('submitted');
    expect(describeStatusGate('quote', 'Quote Ready', ['photo'])).toContain('approved picture');
    expect(describeStatusGate('quote', 'Quote Ready', ['photo'])).toContain('Drive tab');
    expect(describeStatusGate('quote', 'Quote Ready', ['quote_submitted', 'photo'])).toContain(' and ');
    // Unknown = every check, so nobody is told less than the gate asks.
    const all = describeStatusGate('quote', 'Quote Ready');
    expect(all).toContain('line or scope item');
    expect(all).toContain('submitted');
    expect(all).toContain('approved picture');
    expect(statusGateTag('quote', ['quote'])).toBe('Needs quote');
    expect(statusGateTag('quote', ['quote_submitted'])).toBe('Needs quote submitted');
    expect(statusGateTag('quote', ['photo'])).toBe('Needs photo');
    expect(statusGateTag('quote', ['quote_submitted', 'photo'])).toBe('Not ready');
  });

  it('is what the API and the bulk editor ask, and a picture is an approved image in storage', () => {
    const api = readFileSync(new URL('../apps/api/src/services/statusGates.ts', import.meta.url), 'utf8');
    expect(api).toContain("a.review_status = 'approved'");
    expect(api).toContain('a.storage_key IS NOT NULL');
    expect(api).toContain("a.content_type LIKE 'image/%'");
    expect(api).toContain('quoteSubmitted(r.quote_status)');
    // The single move goes through quoteGateMissingFor, not the data-only test.
    expect(api).toMatch(/if \(gate === 'quote'\) \{\s*const missing = \(await quoteGateMissingFor\(q, \[taskId\]\)\)/);
    const bulk = readFileSync(new URL('../apps/api/src/services/woBulk.ts', import.meta.url), 'utf8');
    expect(bulk).toContain('quoteGateMissingFor({ query }, gated.map((x) => x.r.id))');
    expect(bulk).not.toContain('quoteFilledTaskIds');
    // The menu tags the pick from the same vocabulary.
    const menu = readFileSync(new URL('../apps/web/src/components/StatusChangeMenu.tsx', import.meta.url), 'utf8');
    expect(menu).toContain('quoteGateMissing({');
    expect(menu).toContain('quoteSubmitted(h.quoteStatus)');
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
