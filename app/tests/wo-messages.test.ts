/* 0052 — messages on a work order: internal or to the client.
 *
 * The rules worth pinning: which client system a `Client Portal Type` value
 * names, that a message is locked the moment ANY system accepted it, that only
 * the author may edit and never a note the client wrote, and that "Message the
 * client" is its own permission that inherits from posting at all.
 */

import { describe, it, expect } from 'vitest';
import {
  CLIENT_MESSAGE_PERM_KEY,
  MESSAGE_PERM_KEY,
  clientMessageTarget,
  messageEditableBy,
  messageIsSent,
  permAllows,
  type MessageDelivery,
  type PermissionSet,
} from '@theone/shared';

const delivery = (status: MessageDelivery['status'], target: MessageDelivery['target'] = 'corrigo'): MessageDelivery => ({
  target,
  status,
  external_id: status === 'sent' ? 'N-1' : null,
  error: status === 'failed' ? 'refused' : null,
  attempts: status === 'pending' ? 0 : 1,
  sent_at: status === 'sent' ? '2026-09-22T10:00:00Z' : null,
  updated_at: '2026-09-22T10:00:00Z',
});

const me = { id: 'p-1', name: 'Elise', kind: 'human' as const };
const other = { id: 'p-2', name: 'Jordan', kind: 'human' as const };

describe('clientMessageTarget', () => {
  it('maps the three portal types, tolerant of case and spacing', () => {
    expect(clientMessageTarget('Ecotrak')).toBe('ecotrak');
    expect(clientMessageTarget('corrigo')).toBe('corrigo');
    expect(clientMessageTarget('ServiceChannel')).toBe('servicechannel');
    expect(clientMessageTarget('Service Channel')).toBe('servicechannel');
    expect(clientMessageTarget(' ECOTRAK ')).toBe('ecotrak');
  });

  it('is null for an empty or unknown value', () => {
    expect(clientMessageTarget(null)).toBeNull();
    expect(clientMessageTarget('')).toBeNull();
    expect(clientMessageTarget('Email')).toBeNull();
  });
});

describe('messageIsSent', () => {
  it('is false while every delivery is pending or failed', () => {
    expect(messageIsSent([])).toBe(false);
    expect(messageIsSent([delivery('pending')])).toBe(false);
    expect(messageIsSent([delivery('failed')])).toBe(false);
  });

  it('is true once any system accepted it', () => {
    expect(messageIsSent([delivery('failed', 'ecotrak'), delivery('sent', 'corrigo')])).toBe(true);
  });
});

describe('messageEditableBy', () => {
  const mine = { source: 'staff' as const, author: me, deliveries: [] as MessageDelivery[] };

  it('lets the author edit their own unsent message', () => {
    expect(messageEditableBy(mine, me.id, true)).toBe(true);
    expect(messageEditableBy({ ...mine, deliveries: [delivery('pending')] }, me.id, true)).toBe(true);
    expect(messageEditableBy({ ...mine, deliveries: [delivery('failed')] }, me.id, true)).toBe(true);
  });

  it('locks a message the moment it was sent', () => {
    expect(messageEditableBy({ ...mine, deliveries: [delivery('sent')] }, me.id, true)).toBe(false);
  });

  it('refuses anyone but the author, and anyone without the edit grant', () => {
    expect(messageEditableBy(mine, other.id, true)).toBe(false);
    expect(messageEditableBy(mine, me.id, false)).toBe(false);
  });

  it('never lets a note the client wrote be edited here', () => {
    expect(messageEditableBy({ source: 'client', author: null, deliveries: [] }, me.id, true)).toBe(false);
  });
});

describe('"Message the client" permission', () => {
  it('inherits from posting at all when unset', () => {
    const set: PermissionSet = { role: { [MESSAGE_PERM_KEY]: { create: true } }, overrides: {} };
    expect(permAllows(set, CLIENT_MESSAGE_PERM_KEY, 'create')).toBe(true);
  });

  it('can be withheld on its own while posting stays allowed (the probation tiers)', () => {
    const set: PermissionSet = {
      role: { [MESSAGE_PERM_KEY]: { create: true }, [CLIENT_MESSAGE_PERM_KEY]: { create: false } },
      overrides: {},
    };
    expect(permAllows(set, MESSAGE_PERM_KEY, 'create')).toBe(true);
    expect(permAllows(set, CLIENT_MESSAGE_PERM_KEY, 'create')).toBe(false);
  });

  it('a per-person override can hand it back', () => {
    const set: PermissionSet = {
      role: { [MESSAGE_PERM_KEY]: { create: true }, [CLIENT_MESSAGE_PERM_KEY]: { create: false } },
      overrides: { [CLIENT_MESSAGE_PERM_KEY]: { create: true } },
    };
    expect(permAllows(set, CLIENT_MESSAGE_PERM_KEY, 'create')).toBe(true);
  });
});
