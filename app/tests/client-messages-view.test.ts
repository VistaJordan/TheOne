/**
 * Elise, 2026-11-15 (migration 0142): who reads the client conversation and
 * who writes to it. `work_orders/comments/client` view = read it at all;
 * posting needs view AND create. OM / OM Under Probation neither, Senior OM
 * view only, TL / ATL / Admin / OP Admin both.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_MESSAGE_COLUMN_KEYS,
  CLIENT_MESSAGE_PERM_KEY,
  mayMessageClient,
  mayViewClientMessages,
  permAllows,
  type PermissionSet,
} from '@theone/shared';

const root = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');
const mig = read('packages', 'db', 'migrations', '0142_client_messages_view.sql');

const allowFor = (role: PermissionSet['role']) => (key: string, action: 'view' | 'create') =>
  permAllows({ role, overrides: {} } as PermissionSet, key, action);

describe('the client path: view and create', () => {
  it('unset inherits Messages, then Work orders view', () => {
    const allow = allowFor({ work_orders: { view: true }, 'work_orders/comments': { create: true } });
    expect(mayViewClientMessages(allow)).toBe(true);
    expect(mayMessageClient(allow)).toBe(true);
  });
  it('view false hides it and stops posting even with create', () => {
    const allow = allowFor({
      work_orders: { view: true },
      'work_orders/comments': { create: true },
      [CLIENT_MESSAGE_PERM_KEY]: { view: false, create: true },
    });
    expect(mayViewClientMessages(allow)).toBe(false);
    expect(mayMessageClient(allow)).toBe(false);
  });
  it('Senior OM: view without create', () => {
    const allow = allowFor({ work_orders: { view: true }, [CLIENT_MESSAGE_PERM_KEY]: { view: true, create: false } });
    expect(mayViewClientMessages(allow)).toBe(true);
    expect(mayMessageClient(allow)).toBe(false);
  });
});

describe('0142 sets the five roles', () => {
  it('OM and OM Under Probation: neither', () => {
    expect(mig).toMatch(/"view": false, "create": false[\s\S]*?WHERE code IN \('om_probation', 'om'\)/);
  });
  it('Senior OM: view only', () => {
    expect(mig).toMatch(/"view": true, "create": false[\s\S]*?WHERE code = 'senior_om'/);
  });
  it('TL, ATL, Admin, OP Admin: both', () => {
    expect(mig).toMatch(/"view": true, "create": true[\s\S]*?WHERE code IN \('tl', 'atl', 'admin', 'oa'\)/);
  });
});

describe('nothing of the client conversation leaks around the tab', () => {
  const svc = read('apps', 'api', 'src', 'services', 'woMessages.ts');
  const routes = read('apps', 'api', 'src', 'routes', 'workOrders.ts');
  it('the thread drops client-visible messages without view', () => {
    expect(svc).toContain("mayViewClientMessages(allow) ? '' : ' AND NOT c.client_visible'");
  });
  it('the Overview feed too', () => {
    expect(read('apps', 'api', 'src', 'services', 'feed.ts')).toContain('($2::boolean OR NOT c.client_visible)');
    expect(routes).toContain('getFeed(taskId, mayViewClientMessages(allow))');
  });
  it('posting, Improve and editing to client-visible ask view first', () => {
    expect(routes.match(/CLIENT_MESSAGE_PERM_KEY, 'view', 'You cannot see the client messages'/g)?.length).toBe(3);
  });
  it('notices and mentions on a client message go only to readers', () => {
    expect(svc).toContain('(!clientVisible || mayViewClientMessages(allow))');
    expect(svc).toContain('mentionCandidates(taskId, messageWatcherNames(row.fields), clientVisible)');
  });
  it('the Last client message columns follow the view', () => {
    expect(CLIENT_MESSAGE_COLUMN_KEYS).toEqual(['last_client_message', 'last_client_message_at']);
    expect(read('apps', 'api', 'src', 'services', 'permissions.ts')).toContain('CLIENT_MESSAGE_COLUMN_KEYS');
  });
  it('the web hides the Client visible tab', () => {
    const panel = read('apps', 'web', 'src', 'components', 'wo', 'messages', 'MessagesPanel.tsx');
    expect(panel).toContain('{canSeeClient && (');
  });
});
