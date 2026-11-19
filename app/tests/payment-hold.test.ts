/* Hold on a payment request (0159, Elise 2026-11-19). The people who may
 * approve or reject a waiting payment request may also put it on hold — the
 * same gate as Reject — and a held request stays `requested`, so it stays in
 * the Approvals › Payments lane to be decided later. Source pins: no database. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(__dirname, '..');
const src = (p: string) => readFileSync(join(APP, p), 'utf8').replace(/\r\n/g, '\n');
const between = (text: string, a: string, b: string) => {
  const i = text.indexOf(a);
  expect(i, a).toBeGreaterThanOrEqual(0);
  const j = text.indexOf(b, i + a.length);
  return text.slice(i, j === -1 ? undefined : j);
};

describe('the payment hold', () => {
  const svc = src('apps/api/src/services/payments.ts');

  it('adds the three columns', () => {
    const mig = src('packages/db/migrations/0159_payment_request_hold.sql');
    for (const col of ['held_by', 'held_at', 'hold_note']) expect(mig).toContain(col);
  });

  it('asks Hold and Release what Reject asks', () => {
    const hold = between(svc, 'async function setHold(', '\n}\n');
    expect(hold).toContain("assertCanApprove(actor, on ? 'hold' : 'release')");
    expect(hold).toContain('await assertMayDecide(row, actor,');
    const reject = between(svc, 'export async function rejectPaymentRequest(', '\n}\n');
    expect(reject).toContain("await assertMayDecide(row, actor, 'Declining a payment', 'declines')");
  });

  it('keeps the request waiting, and only a waiting one is held', () => {
    const hold = between(svc, 'async function setHold(', '\n}\n');
    expect(hold).toContain("if (row.status !== 'requested')");
    expect(hold).toContain("WHERE id = $1 AND status = 'requested' AND held_at IS NULL");
    expect(hold).not.toMatch(/SET status/);
  });

  it('any decision clears the hold', () => {
    expect(between(svc, 'async function setStatus(', '\n}\n')).toContain(
      'SET status = $1, held_by = NULL, held_at = NULL, hold_note = NULL',
    );
  });

  it('is logged on the payment history', () => {
    const list = between(svc, 'const HISTORY_ACTIONS', '];');
    expect(list).toContain("'payment_held'");
    expect(list).toContain("'payment_released'");
  });

  it('has its routes', () => {
    const routes = src('apps/api/src/routes/payments.ts');
    expect(routes).toContain("app.post('/payment-requests/:pid/hold'");
    expect(routes).toContain("app.post('/payment-requests/:pid/release'");
  });
});

describe('the Approvals page', () => {
  const page = src('apps/web/src/pages/ApprovalsPage.tsx');

  it('offers Hold / Release on a payment, gated like Reject', () => {
    const decisions = between(page, 'function Decisions(', '\n}\n');
    const payment = between(decisions, "    case 'payment':", "    case 'purchase':");
    expect(payment.match(/d\.item\.hold \? 'Release' : 'Hold'/g)?.length).toBe(2);
  });

  it('reads a held payment as On hold, still open', () => {
    const row = between(page, 'function paymentRow(', '\n}\n');
    expect(row).toContain("const open = item.status === 'requested';");
    expect(row).toContain("label: 'On hold'");
  });
});
