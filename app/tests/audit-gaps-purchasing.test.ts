/* Rule 1.2.1 ("every button"), audit gaps closed 2026-10-20.
 *
 * PUT /rates (upsertLaborRate) wrote no audit row at all, and purchasing
 * logged only through `logWo`, which returns early when a document has no
 * work order — so a purchase request, an RFQ or a purchase order raised on
 * its own left no trace. Every writer now reaches `logAdminEvent` on the
 * document itself (entity labor_rate | purchase_request | rfq |
 * purchase_order), with or without a work order.
 *
 * Source-text assertions in the house pattern (tests/purchasing-tx.test.ts):
 * no database is opened and no API module is imported.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const purchasing = src('apps/api/src/services/purchasing.ts');
const rates = src('apps/api/src/services/rates.ts');
const quotesRoute = src('apps/api/src/routes/quotes.ts');

/** One top-level function: from its header to the first `}` at column 0. */
function fn(text: string, header: string): string {
  const start = text.indexOf(header);
  if (start < 0) throw new Error(`${header} is not in the file`);
  const end = text.indexOf('\n}', start);
  return text.slice(start, end + 2);
}

describe('labor rates (rates.ts)', () => {
  const body = fn(rates, 'export async function upsertLaborRate(');

  it('reads the row on the key first, logs created / updated, and only when something changed', () => {
    expect(body).toContain('actorId: string');
    expect(body.indexOf('const prior')).toBeLessThan(body.indexOf('INSERT INTO labor_rate'));
    expect(body).toContain('logAdminEvent(');
    expect(body).toContain("entity: 'labor_rate'");
    expect(body).toContain("'labor_rate_updated'");
    expect(body).toContain("'labor_rate_created'");
    expect(body).toContain('snapshotsDiffer(before, after)');
  });

  it('names a rate by its key with blanks as "All", and the route passes the actor', () => {
    expect(fn(rates, 'function rateName(')).toContain("'All'");
    expect(quotesRoute).toContain('upsertLaborRate(input, actor.id)');
  });
});

describe('purchasing documents log on themselves (purchasing.ts)', () => {
  it('logDoc writes an admin row whatever the work order, and skips a no-op save', () => {
    const body = fn(purchasing, 'async function logDoc(');
    expect(body).toContain('logAdminEvent(');
    expect(body).toContain('snapshotsDiffer(before, after)');
    expect(body).not.toContain('taskId');
  });

  it.each([
    ['saveRequest', "'purchase_request'", ['purchase_request_updated', 'purchase_request_created']],
    ['actOnRequest', "'purchase_request'", ['submitted', 'approved', 'rejected', 'cancelled', 'returned_to_draft']],
    ['saveRfq', "'rfq'", ['rfq_updated', 'rfq_created']],
    ['actOnRfq', "'rfq'", ['sent', 'closed', 'reopened', 'cancelled']],
    ['saveVendorQuote', "'rfq'", ['rfq_quote_updated', 'rfq_quote_recorded']],
    ['deleteVendorQuote', "'rfq'", ['rfq_quote_deleted']],
    ['awardQuote', "'rfq'", ['rfq_awarded', 'purchase_order_created', 'purchase_request_ordered']],
    ['saveOrder', "'purchase_order'", ['purchase_order_created', 'purchase_order_updated', 'purchase_request_ordered']],
    ['approvePoOverLimit', "'purchase_order'", ['purchase_order_limit_approved']],
    ['actOnOrder', "'purchase_order'", ['issued', 'closed', 'cancelled', 'reopened', 'purchase_request_order_cancelled']],
    ['receiveOrder', "'purchase_order'", ['purchase_order_received']],
  ])('%s reaches logDoc on its document', (name, entity, actions) => {
    const body = fn(purchasing, `export async function ${name}(`);
    expect(body).toMatch(/logDoc\(|logRequestSideMove\(/);
    expect(body).toContain(entity);
    for (const a of actions) expect(body).toContain(a);
  });

  it('edits log whole before / after snapshots', () => {
    expect(fn(purchasing, 'export async function saveRequest(')).toContain('requestSnapshot(before)');
    expect(fn(purchasing, 'export async function saveRfq(')).toContain('rfqSnapshot(before)');
    expect(fn(purchasing, 'export async function saveOrder(')).toContain('orderSnapshot(before), orderSnapshot(after)');
  });

  it('each document snapshot is named by its number and summarises its lines', () => {
    for (const [header, number] of [
      ['function requestSnapshot(', 'r.pr_number'],
      ['function rfqSnapshot(', 'r.rfq_number'],
      ['function orderSnapshot(', 'o.po_number'],
    ]) {
      const body = fn(purchasing, header);
      expect(body).toContain(`name: ${number}`);
      expect(body).toContain('lines:');
      expect(body).toContain('items: lineItems(');
    }
  });

  it('logDoc never runs inside a transaction', () => {
    // No withTransaction( block of a writer holds a logDoc( call: the
    // document's row is written on the pool once the write committed.
    const names = ['saveRequest', 'saveRfq', 'saveVendorQuote', 'deleteVendorQuote', 'awardQuote', 'saveOrder', 'actOnOrder', 'receiveOrder'];
    for (const name of names) {
      const body = fn(purchasing, `export async function ${name}(`);
      expect(body, name).toMatch(/logDoc\(|logRequestSideMove\(/);
      let at = body.indexOf('withTransaction(');
      expect(at, name).toBeGreaterThanOrEqual(0);
      while (at >= 0) {
        const lineStart = body.lastIndexOf('\n', at) + 1;
        const indent = body.slice(lineStart, at).match(/^\s*/)![0];
        const end = body.indexOf(`\n${indent}});`, at);
        expect(end, name).toBeGreaterThan(at);
        expect(body.slice(at, end), name).not.toMatch(/logDoc\(|logRequestSideMove\(/);
        at = body.indexOf('withTransaction(', end);
      }
    }
  });
});
