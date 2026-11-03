/*
 * 0114 · Ecotrak → OBI: webhooks, comments into Messages, the address.
 *
 * The pure helpers, and source pins for the rule that matters most: nothing
 * may change what our clients see on Ecotrak. The only write outside the
 * OAuth token is registering our own webhooks, one POST to /api/webhook, from
 * one file, behind a super-admin button.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ECOTRAK_WEBHOOK_ACTIONS, ecotrakAddressLine, ecotrakIdsFromPayload, ecotrakNoteAuthor } from '../packages/shared/src/ecotrakInbound';

const API = resolve(__dirname, '..', 'apps', 'api', 'src');
const read = (...p: string[]) => readFileSync(join(API, ...p), 'utf8');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('ecotrakNoteAuthor', () => {
  it('names the person, then the company', () => {
    expect(ecotrakNoteAuthor({ user_fist_name: 'Jane', user_last_name: 'Doe', customer_name: "Dave's Burgers" })).toBe("Jane Doe · Dave's Burgers");
  });
  it('takes either alone, and drops the API placeholder', () => {
    expect(ecotrakNoteAuthor({ customer_name: 'Henry the Handyman' })).toBe('Henry the Handyman');
    expect(ecotrakNoteAuthor({ user_first_name: 'Sam' })).toBe('Sam');
    expect(ecotrakNoteAuthor({ user_fist_name: 'ExternalApi', user_last_name: 'ExternalApi', customer_name: 'Acme' })).toBe('Acme');
    expect(ecotrakNoteAuthor({})).toBeNull();
  });
});

describe('ecotrakIdsFromPayload', () => {
  it('finds a work order id under the names Ecotrak uses', () => {
    expect(ecotrakIdsFromPayload({ workOrderId: 1234, history: [] })).toEqual(['1234']);
    expect(ecotrakIdsFromPayload({ note: { id: 'abc', work_order_id: 1234 } })).toEqual(['1234']);
    expect(ecotrakIdsFromPayload({ data: { workOrder: { id: 99 } } })).toEqual(['99']);
  });
  it('takes the top-level id only when the payload is a work order', () => {
    expect(ecotrakIdsFromPayload({ id: 3652206, status: 'COMPLETED' })).toEqual(['3652206']);
    expect(ecotrakIdsFromPayload({ id: 5 })).toEqual([]);
  });
  it('ignores what is not a plain number, and anything odd', () => {
    expect(ecotrakIdsFromPayload({ workOrderId: '67d33f029e4ff2efa14dc6df' })).toEqual([]);
    expect(ecotrakIdsFromPayload(null)).toEqual([]);
    expect(ecotrakIdsFromPayload('text')).toEqual([]);
  });
});

describe('ecotrakAddressLine', () => {
  it('writes the team’s shape', () => {
    expect(
      ecotrakAddressLine({ address1: '281 S. Beverly Dr', address2: '', city: 'Beverly Hills', zip: '90212' }, 'CA'),
    ).toBe('281 S. Beverly Dr, Beverly Hills, CA 90212');
    expect(ecotrakAddressLine({ address1: '1 Main', address2: 'Suite 2', city: 'X', zip: null }, 'IL')).toBe('1 Main, Suite 2, X, IL');
  });
  it('is null without a street', () => {
    expect(ecotrakAddressLine({ address1: ' ', city: 'X' }, 'IL')).toBeNull();
    expect(ecotrakAddressLine(null, null)).toBeNull();
  });
});

describe('nothing writes to Ecotrak but the webhook registration', () => {
  const client = read('modules', 'integrations', 'ecotrak', 'client.ts');
  const hooks = read('services', 'ecotrakWebhooks.ts');

  it('the client still sends one POST — the token — and no other method', () => {
    expect(client.match(/method:\s*'POST'/g)?.length ?? 0).toBe(1);
    expect(client).not.toMatch(/method:\s*'(PUT|PATCH|DELETE)'/i);
  });

  it('the registration sends exactly one POST, to /api/webhook, and never edits or removes one', () => {
    expect(hooks.match(/method:\s*'[A-Z]+'/g)).toEqual(["method: 'POST'"]);
    expect(hooks.match(/\bfetch\(/g)?.length).toBe(1);
    expect(hooks).toContain('fetch(`${client.baseUrl}/api/webhook`');
    expect(hooks).not.toMatch(/'(PUT|PATCH|DELETE)'/);
  });

  it('only the registration uses the bearer token outside the client', () => {
    const users = tsFiles(API).filter((f) => !f.endsWith('client.ts') && /\.bearer\(\)/.test(readFileSync(f, 'utf8')));
    expect(users.map((f) => f.replace(/\\/g, '/').split('/src/')[1])).toEqual(['services/ecotrakWebhooks.ts']);
  });

  it('it is a super admin’s act, not while viewing as someone, and logged', () => {
    expect(hooks).toContain("if (!actor.isSuperAdmin) throw new ApiError('FORBIDDEN'");
    expect(hooks).toContain("action: 'ecotrak_webhooks_registered'");
    const route = read('routes', 'adminIntegrations.ts');
    expect(route).toContain('if (req.auth.isImpersonating) throw');
    expect(route).toContain('registerEcotrakWebhooksNow(req.auth.user)');
  });

  it('registers only the two work-order events, and skips one already on Ecotrak', () => {
    expect([...ECOTRAK_WEBHOOK_ACTIONS]).toEqual(['WEBHOOK_WORKORDER_ACTIVITY', 'WEBHOOK_WORKORDER_COMMENT']);
    expect(hooks).toContain("result: 'already_on_ecotrak'");
  });

  it('no client-message adapter is registered, so our replies never leave for Ecotrak', () => {
    const calls = tsFiles(API).filter((f) => /registerClientMessageAdapter\(/.test(readFileSync(f, 'utf8')));
    expect(calls.map((f) => f.replace(/\\/g, '/').split('/src/')[1])).toEqual(['modules/integrations/clientMessages.ts']);
  });
});

describe('the receiver', () => {
  it('is public by exact path and checks the hashed key before anything', () => {
    expect(read('plugins', 'authGuard.ts')).toContain("'/api/webhooks/ecotrak',");
    const routes = read('routes', 'webhooks.ts');
    const at = routes.indexOf('const ecotrakDelivery');
    const body = routes.slice(at, routes.indexOf('};', at));
    expect(body.indexOf('ecotrakWebhookKeyOk')).toBeLessThan(body.indexOf('handleEcotrakDelivery(req.body)'));
  });

  it('reads the work order back instead of trusting the delivery', () => {
    const hooks = read('services', 'ecotrakWebhooks.ts');
    expect(hooks).toContain('refreshEcotrakWorkOrders(ids)');
    const ingest = read('modules', 'integrations', 'ecotrak', 'ingest.ts');
    expect(ingest).toContain('await client.fetchWorkOrder(id)');
  });

  it('comments land through receiveClientMessage, keyed by Ecotrak’s note id', () => {
    const notes = read('services', 'ecotrakNotes.ts');
    expect(notes).toContain("target: 'ecotrak'");
    expect(notes).toContain('external_id: String(n.id)');
  });
});
