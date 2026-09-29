/* 0054 — calls placed from a work order through Quo, and the AI quote draft.
 * The pure halves: Quo's webhook signature, the phone number a call is matched
 * on, a transcript pasted by hand, and the conversion of the model's answer
 * into the quote builder's PUT body (every limit the PUT enforces). The
 * database half (services/woCalls.ts, services/aiQuote.ts) and the Claude call
 * are exercised against the live site. */

import { describe, it, expect } from 'vitest';
import {
  displayCallStatus,
  normalizePhone,
  parsePastedTranscript,
  quoteDraftHasContent,
} from '../packages/shared/src/calls';
import { signQuoLegacy, signQuoStandard, verifyQuoSignature } from '../apps/api/src/lib/quoSignature';
import { buildUserMessage, modelOutput, toDraftBody } from '../apps/api/src/lib/aiQuotePrompt';
import type { WoCall } from '../packages/shared/src/calls';

const KEY = Buffer.from('a-signing-key-from-quo-settings').toString('base64');
const BODY = JSON.stringify({ id: 'EV1', type: 'call.completed', data: { object: { id: 'AC1' } } });

describe('verifyQuoSignature — legacy openphone-signature header', () => {
  it('accepts what Quo signs', () => {
    const headers = { 'openphone-signature': signQuoLegacy(KEY, '1639710054089', BODY) };
    expect(verifyQuoSignature(headers, BODY, KEY)).toBe('ok');
  });
  it('accepts a body that was signed compact but arrived pretty-printed', () => {
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    const headers = { 'openphone-signature': signQuoLegacy(KEY, '1', BODY) };
    expect(verifyQuoSignature(headers, pretty, KEY)).toBe('ok');
  });
  it('refuses a tampered body, a wrong key and a malformed header', () => {
    const headers = { 'openphone-signature': signQuoLegacy(KEY, '1', BODY) };
    expect(verifyQuoSignature(headers, BODY.replace('AC1', 'AC2'), KEY)).toBe('mismatch');
    expect(verifyQuoSignature(headers, BODY, Buffer.from('other').toString('base64'))).toBe('mismatch');
    expect(verifyQuoSignature({ 'openphone-signature': 'nonsense' }, BODY, KEY)).toBe('mismatch');
  });
  it('is unconfigured without a key, and wants a header once one is set', () => {
    expect(verifyQuoSignature({}, BODY, null)).toBe('unconfigured');
    expect(verifyQuoSignature({}, BODY, KEY)).toBe('missing');
  });
});

describe('verifyQuoSignature — Standard Webhooks headers', () => {
  const now = 1_790_000_000_000;
  const ts = String(now / 1000);
  it('accepts a current signature, with or without the whsec_ prefix', () => {
    const headers = {
      'webhook-id': 'msg_1',
      'webhook-timestamp': ts,
      'webhook-signature': `v1,bogus ${signQuoStandard(KEY, 'msg_1', ts, BODY)}`,
    };
    expect(verifyQuoSignature(headers, BODY, KEY, now)).toBe('ok');
    expect(verifyQuoSignature(headers, BODY, `whsec_${KEY}`, now)).toBe('ok');
  });
  it('refuses a replay older than five minutes', () => {
    const headers = {
      'webhook-id': 'msg_1',
      'webhook-timestamp': ts,
      'webhook-signature': signQuoStandard(KEY, 'msg_1', ts, BODY),
    };
    expect(verifyQuoSignature(headers, BODY, KEY, now + 6 * 60_000)).toBe('stale');
  });
  it('refuses a signature made for another message id', () => {
    const headers = {
      'webhook-id': 'msg_2',
      'webhook-timestamp': ts,
      'webhook-signature': signQuoStandard(KEY, 'msg_1', ts, BODY),
    };
    expect(verifyQuoSignature(headers, BODY, KEY, now)).toBe('mismatch');
  });
});

describe('normalizePhone — the number a Quo call is matched on', () => {
  it('turns US numbers of any spelling into E.164', () => {
    expect(normalizePhone('(409) 555-0143')).toBe('+14095550143');
    expect(normalizePhone('409.555.0143')).toBe('+14095550143');
    expect(normalizePhone('1 409 555 0143')).toBe('+14095550143');
    expect(normalizePhone('+1 (409) 555-0143')).toBe('+14095550143');
  });
  it('keeps a foreign country code', () => {
    expect(normalizePhone('+961 3 123 456')).toBe('+9613123456');
  });
  it('refuses what cannot be dialled', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('ext 12')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('displayCallStatus — a call Quo never reported on expires', () => {
  const placed = new Date('2026-09-29T10:00:00Z');
  it('stays dialing for three hours, then reads expired', () => {
    expect(displayCallStatus('dialing', placed, new Date('2026-09-29T12:59:00Z'))).toBe('dialing');
    expect(displayCallStatus('dialing', placed, new Date('2026-09-29T13:01:00Z'))).toBe('expired');
  });
  it('never expires a call Quo did report on', () => {
    expect(displayCallStatus('transcribed', placed, new Date('2027-01-01T00:00:00Z'))).toBe('transcribed');
  });
});

describe('parsePastedTranscript — a transcript typed or pasted by hand', () => {
  it('splits "Name: text" lines into speakers and drops timestamps', () => {
    const lines = parsePastedTranscript('[00:01] Matt: Hi, how does it look?\n00:05 Gulf Coast: Fan motor is seized.\n\n');
    expect(lines).toEqual([
      { speaker: 'Matt', line: 'Hi, how does it look?', start: null },
      { speaker: 'Gulf Coast', line: 'Fan motor is seized.', start: null },
    ]);
  });
  it('joins a wrapped line onto the previous speaker', () => {
    const lines = parsePastedTranscript('Tech: Motor, start kit\nand a full coil clean.');
    expect(lines).toEqual([{ speaker: 'Tech', line: 'Motor, start kit and a full coil clean.', start: null }]);
  });
  it('does not mistake a sentence with a colon for a speaker', () => {
    const lines = parsePastedTranscript('Tech: Parts are in.\nNote that it is ready. Price: 450');
    expect(lines).toHaveLength(1);
  });
  it('labels text with no speaker at all', () => {
    expect(parsePastedTranscript('just some notes')[0].speaker).toBe('Speaker');
  });
});

const MODEL_ANSWER = {
  incurred: {
    narrative_reported: 'the freezer was stuck in defrost.',
    scope_lines: ['Diagnosed the freezer', '  '],
    lines: [
      { line_type: 'service', description: 'Trip charge', qty: 1, rate: 95.499, uom: 'trip', ot: false, markup_pct: 0 },
      { line_type: 'labor', description: '   ', qty: 1, rate: 10, uom: null, ot: false, markup_pct: 0 },
    ],
  },
  options: [
    {
      name: 'Condenser fan motor + start kit replacement',
      narrative_reported: 'The condenser fan motor is seized.',
      scope_lines: ['Replace the condenser fan motor'],
      lines: [
        { line_type: 'part', description: 'Parts and labor per technician quote', qty: 1, rate: 1450, uom: 'bushel', ot: false, markup_pct: 35 },
        { line_type: 'labor', description: 'Coil clean', qty: -2, rate: 1e12, uom: 'hr', ot: true, markup_pct: 5000 },
      ],
    },
  ],
  specs: '  ',
  note_to_customer: 'Parts in 2 days.',
  assumptions: ['Used the contract markup'],
  missing_info: [],
};

describe('toDraftBody — the model answer becomes the builder PUT body', () => {
  const body = toDraftBody(modelOutput.parse(MODEL_ANSWER));
  it('puts the incurred section first, then the options, all included', () => {
    expect(body.sections.map((s) => s.kind)).toEqual(['incurred', 'option']);
    expect(body.sections[0].name).toBe('Work already performed');
    expect(body.sections[1].name).toBe('Condenser fan motor + start kit replacement');
    expect(body.sections.every((s) => s.include_in_summary)).toBe(true);
  });
  it('drops blank scope lines and lines without a description', () => {
    expect(body.sections[0].scope_lines).toEqual(['Diagnosed the freezer']);
    expect(body.sections[0].lines).toHaveLength(1);
  });
  it('rounds money to cents, floors negatives at 0 and caps markup', () => {
    expect(body.sections[0].lines[0].rate).toBe(95.5);
    const coil = body.sections[1].lines[1];
    expect(coil.qty).toBe(0);
    expect(coil.markup_pct).toBe(1000);
    expect(coil.ot).toBe(true);
  });
  it('keeps only units the builder knows', () => {
    expect(body.sections[0].lines[0].uom).toBe('trip');
    expect(body.sections[1].lines[0].uom).toBeNull();
  });
  it('turns blank free text into null', () => {
    expect(body.specs).toBeNull();
    expect(body.note_to_customer).toBe('Parts in 2 days.');
  });
  it('has content by the rule 11.2.1 definition', () => {
    expect(quoteDraftHasContent(body)).toBe(true);
    expect(quoteDraftHasContent({ sections: [{ ...body.sections[0], lines: [], scope_lines: [' '] }], specs: null, note_to_customer: null })).toBe(false);
  });
  it('produces money the builder save accepts (plain, two decimals)', () => {
    const money = body.sections.flatMap((s) => s.lines.flatMap((l) => [l.qty, l.rate]));
    for (const n of money) expect(String(n)).toMatch(/^\d+(\.\d{1,2})?$/);
  });
});

describe('buildUserMessage — what Claude is told', () => {
  const call: WoCall = {
    id: 'c1',
    task_id: 't1',
    placed_by: { id: 'p1', name: 'Matt Hammond', kind: 'human' },
    contact_name: 'Gulf Coast',
    contact_role: 'tech',
    phone: '+14095550143',
    purpose: 'quote',
    status: 'transcribed',
    quo_call_id: 'AC1',
    direction: 'outgoing',
    answered_at: null,
    completed_at: null,
    duration_seconds: 120,
    transcript: [
      { speaker: 'Matt Hammond', line: 'What did you find?', start: 0 },
      { speaker: 'Gulf Coast', line: 'Fan motor seized, $1,450 my side.', start: 2 },
    ],
    transcript_source: 'quo',
    summary: { summary: ['Motor seized'], next_steps: ['Order motor'] },
    created_at: '2026-09-29T10:00:00.000Z',
    draft: null,
  };
  const ctx = {
    wo_number: 'WO-39403', title: 'Freezer down', description: null, client: 'MOD Pizza', trade: 'Refrigeration',
    billing_entity: 'SFM', nte: '1500.00', city: 'Beaumont', state: 'TX', priority: null, store: '1234',
    address: null, fm: 'CBRE', wo_description: 'Walk-in freezer not holding temp',
  };
  it('carries the work order, the rates and the whole transcript', () => {
    const msg = buildUserMessage(ctx, {
      contract: { name: 'MOD T&M 2026' },
      rates: { standard: 95, overtime: 142.5, trip_charge: 85, markup_pct: 30, ot_multiplier: 1.5 },
    }, call);
    expect(msg).toContain('Work order: WO-39403');
    expect(msg).toContain('Client NTE (not-to-exceed), USD: 1500.00');
    expect(msg).toContain('Markup on vendor cost, %: 30');
    expect(msg).toContain('Gulf Coast: Fan motor seized, $1,450 my side.');
    expect(msg).toContain('Next step: Order motor');
    expect(msg).toContain('Address: Beaumont, TX');
  });
  it('says plainly when no contract applies', () => {
    expect(buildUserMessage(ctx, null, call)).toContain('No client contract covers this work order');
  });
});
