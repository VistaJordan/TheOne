/* Payment history on the work order (Elise, 2026-11-02). The Payables part of
 * the Finances tab lists every step of every payment request — requested,
 * edited, approved, paid, rejected, method changed, delete asked / refused /
 * done — read off the audit rows `logPayment` already writes, so deleted
 * requests keep their history and no table was added. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const service = read('apps/api/src/services/payments.ts');
const routes = read('apps/api/src/routes/payments.ts');
const card = read('apps/web/src/components/wo/PayablesCard.tsx');

describe('payment history', () => {
  it('lists every action logPayment writes (drift guard)', () => {
    const logged = new Set<string>();
    for (const m of service.matchAll(/logPayment\([^)]*?'(payment_[a-z_]+)'/g)) logged.add(m[1]);
    for (const m of service.matchAll(/setStatus\([^)]*?'(payment_[a-z_]+)'/g)) logged.add(m[1]);
    const listed = service.match(/const HISTORY_ACTIONS[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(logged.size).toBeGreaterThanOrEqual(9);
    for (const action of logged) expect(listed, `${action} is logged but missing from HISTORY_ACTIONS`).toContain(`'${action}'`);
  });

  it('reads the payment audit rows of this work order only, deleted requests included', () => {
    const fn = service.slice(service.indexOf('export async function listPaymentHistory'));
    expect(fn).toContain(`a.field = 'payment_request.status'`);
    expect(fn).toContain('a.entity_id = $1::text');
    expect(fn).toContain('AND pr.task_id = $1');
    expect(fn).toContain('ACTOR_NAME_SQL');
    expect(fn.slice(0, fn.indexOf('ORDER BY'))).not.toContain('deleted_at IS NULL');
  });

  it('is behind payments view and the work-order scope', () => {
    const route = routes.slice(routes.indexOf(`'/work-orders/:id/payment-history'`));
    const body = route.slice(0, route.indexOf('});'));
    expect(body).toContain(`requirePerm(actingPrincipalFromRequest(req), 'payments', 'view'`);
    expect(body).toContain('taskIdOf(req)');
  });

  it('refreshes with every payment action (query key under wo-payments)', () => {
    expect(card).toContain(`queryKey: ['wo-payments', woNumber, 'history']`);
  });
});
