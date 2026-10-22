/* Import transcript › From a Quo call — the pure halves: which Quo lines a
 * person may read (by the email they sign in with), how a Quo call becomes
 * the option the dialog lists (answered or not, duration, already stored),
 * the order the dialog shows, and Quo's dialogue → transcript lines (shared
 * with the webhook, so a fetched transcript and a pushed one are the same
 * shape). The Quo calls themselves (lib/quoApi.ts) and the database half
 * (services/woCalls.ts lookupQuoCalls / importQuoCall) run against the live
 * site. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  QUO_CALL_LOOKUP_MAX,
  quoCallOption,
  quoDialogueToLines,
  quoLinesForEmail,
  sortQuoCallOptions,
} from '../packages/shared/src/calls';
import type { QuoApiCall, QuoApiPhoneNumber } from '../packages/shared/src/calls';

const LINES: QuoApiPhoneNumber[] = [
  { id: 'PN1', number: '+14095550100', name: 'Dispatch', users: [{ id: 'US1', email: 'Elise@byblosvista.com' }, { id: 'US2', email: 'matt@byblosvista.com' }] },
  { id: 'PN2', number: '+14095550101', name: 'Elise direct', users: [{ id: 'US1', email: 'elise@byblosvista.com' }] },
  { id: 'PN3', number: '+14095550102', name: 'VR', users: [{ id: 'US3', email: 'vr@byblosvista.com' }] },
  { id: 'PN4', number: '+14095550103', name: 'Nobody', users: [] },
];

describe('quoLinesForEmail — the lines a person may read calls from', () => {
  it('matches the member email case-insensitively, on every line they are on', () => {
    expect(quoLinesForEmail(LINES, 'elise@byblosvista.com').map((l) => l.id)).toEqual(['PN1', 'PN2']);
    expect(quoLinesForEmail(LINES, '  MATT@byblosvista.com ').map((l) => l.id)).toEqual(['PN1']);
  });
  it('is empty for nobody, an unknown email or a line with no members', () => {
    expect(quoLinesForEmail(LINES, null)).toEqual([]);
    expect(quoLinesForEmail(LINES, '')).toEqual([]);
    expect(quoLinesForEmail(LINES, 'stranger@example.com')).toEqual([]);
    expect(quoLinesForEmail(LINES, 'vr@byblosvista.com').map((l) => l.id)).toEqual(['PN3']);
  });
});

const LINE = { id: 'PN1', number: '+14095550100', name: 'Dispatch' };
const base: QuoApiCall = {
  id: 'AC1',
  phoneNumberId: 'PN1',
  userId: 'US1',
  direction: 'outgoing',
  status: 'completed',
  participants: ['+14095550100', '+14095550143'],
  createdAt: '2026-10-20T15:00:00Z',
  answeredAt: '2026-10-20T15:00:08Z',
  completedAt: '2026-10-20T15:04:40Z',
  duration: 272,
};

describe('quoCallOption — a Quo call as the dialog lists it', () => {
  it('carries the moment, the direction, the duration and the line', () => {
    const o = quoCallOption(base, LINE, null);
    expect(o).toMatchObject({
      quo_call_id: 'AC1',
      direction: 'outgoing',
      status: 'completed',
      created_at: '2026-10-20T15:00:00Z',
      answered: true,
      duration_seconds: 272,
      already_on: null,
    });
    expect(o.line).toEqual(LINE);
  });
  it('reads an unanswered call as not pickable, whatever Quo calls it', () => {
    expect(quoCallOption({ ...base, status: 'no-answer', answeredAt: null, completedAt: null, duration: 0 }, LINE, null).answered).toBe(false);
    expect(quoCallOption({ ...base, status: 'missed', answeredAt: null, duration: null }, LINE, null).answered).toBe(false);
    // Quo says completed but sent no answeredAt: still a conversation.
    expect(quoCallOption({ ...base, answeredAt: null }, LINE, null).answered).toBe(true);
  });
  it('derives the duration from the stamps when Quo sends none', () => {
    expect(quoCallOption({ ...base, duration: null }, LINE, null).duration_seconds).toBe(272);
    expect(quoCallOption({ ...base, duration: undefined, completedAt: null }, LINE, null).duration_seconds).toBeNull();
  });
  it('keeps the row that already holds the call', () => {
    const held = { call_id: 'c1', task_id: 't1', wo_number: 'WO-1', same_work_order: false };
    expect(quoCallOption(base, LINE, held).already_on).toEqual(held);
  });
});

describe('sortQuoCallOptions — newest first, capped', () => {
  it('orders by when the call was made and keeps the most recent', () => {
    const many = Array.from({ length: QUO_CALL_LOOKUP_MAX + 5 }, (_, i) =>
      quoCallOption({ ...base, id: `AC${i}`, createdAt: new Date(Date.UTC(2026, 9, 1 + (i % 28), i % 24)).toISOString() }, LINE, null),
    );
    const out = sortQuoCallOptions(many);
    expect(out).toHaveLength(QUO_CALL_LOOKUP_MAX);
    for (let i = 1; i < out.length; i++) {
      expect(new Date(out[i - 1].created_at).getTime()).toBeGreaterThanOrEqual(new Date(out[i].created_at).getTime());
    }
  });
});

describe('quoDialogueToLines — Quo dialogue → transcript lines', () => {
  const dialogue = [
    { content: 'The condenser fan motor is seized.', start: 12.34, identifier: '+14095550143' },
    { content: 'What did you find?', start: 5.06, identifier: '+14095550100' },
    { content: '   ', start: 20, identifier: '+14095550143' },
    { content: 'Can you quote the motor?', start: 30.99, identifier: null },
  ];
  it('names the contact by their number, everyone else as ours, in order, dropping empties', () => {
    expect(quoDialogueToLines(dialogue, '+14095550143', 'Gulf Coast', 'Matt')).toEqual([
      { speaker: 'Matt', line: 'What did you find?', start: 5.1 },
      { speaker: 'Gulf Coast', line: 'The condenser fan motor is seized.', start: 12.3 },
      { speaker: 'Matt', line: 'Can you quote the motor?', start: 31 },
    ]);
  });
  it('treats every segment as ours when no contact number is known', () => {
    expect(quoDialogueToLines(dialogue, null, 'Contact', 'Seamless FM').every((l) => l.speaker === 'Seamless FM')).toBe(true);
  });
  it('is what the webhook stores too', () => {
    const src = readFileSync(new URL('../apps/api/src/services/woCalls.ts', import.meta.url), 'utf8');
    expect(src.match(/quoDialogueToLines\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
