/* UAT list of 2026-11-16, fifth batch (Elise):
 *   #33 maker ≠ checker on payments (pinned in payment-approval.test.ts),
 *   #31 one Approvals table per type with the NTE and the money paid so far,
 *   #25 specs in the quote summary / printed quote, saved on leaving a box,
 *   #9  fold each quote section,
 *   #7  add a new technician from the payment search,
 *   Late Quote ticked automatically once the Quote Due Date passes.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lateQuoteDescription, shouldMarkLateQuote } from '../packages/shared/src/lateQuote';
import { prefillFromSearch } from '../apps/web/src/components/payments/VendorPicker';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('Late Quote ticks itself', () => {
  const now = new Date('2026-11-16T18:00:00Z');
  const base = { quoteDueAt: '2026-11-16T15:00:00Z', quoteStatus: null, quoteOwed: true, ticked: false, touchedBefore: false };
  it('ticks once the due date has passed with no quote, or a draft', () => {
    expect(shouldMarkLateQuote(base, now)).toBe(true);
    expect(shouldMarkLateQuote({ ...base, quoteStatus: 'draft' }, now)).toBe(true);
  });
  it('leaves a submitted quote, a future due date, a work order past quoting alone', () => {
    for (const s of ['pending_correction', 'pending_approval', 'approved', 'sent']) {
      expect(shouldMarkLateQuote({ ...base, quoteStatus: s }, now)).toBe(false);
    }
    expect(shouldMarkLateQuote({ ...base, quoteDueAt: '2026-11-17T15:00:00Z' }, now)).toBe(false);
    expect(shouldMarkLateQuote({ ...base, quoteDueAt: null }, now)).toBe(false);
    expect(shouldMarkLateQuote({ ...base, quoteOwed: false }, now)).toBe(false);
  });
  it('never re-ticks one a manager took off (the field was written before)', () => {
    expect(shouldMarkLateQuote({ ...base, touchedBefore: true }, now)).toBe(false);
    expect(shouldMarkLateQuote({ ...base, ticked: true }, now)).toBe(false);
  });
  it('the description names the due date in Central time', () => {
    expect(lateQuoteDescription('2026-11-16T15:00:00Z')).toContain('Nov 16, 2026');
    expect(lateQuoteDescription('2026-11-16T15:00:00Z')).toContain('CT');
  });
  it('the sweep skips a field written before and runs on the hourly cron', () => {
    const svc = read('apps/api/src/services/lateQuote.ts');
    expect(svc).toContain("a.field = 'fields.' || $2");
    expect(svc).toContain("(q.id IS NULL OR q.status = 'draft')");
    expect(svc).toContain('updateWorkOrderFields(r.id, values, actorId, undefined, { system: true })');
    expect(read('apps/api/src/routes/webhooks.ts')).toContain('await sweepLateQuotes()');
  });
});

describe('#31 Approvals: a table per type, NTE and paid so far', () => {
  it('every row source carries wo_paid', () => {
    for (const f of ['apps/api/src/services/approvals.ts', 'apps/api/src/services/payments.ts']) {
      expect(read(f)).toContain('AS wo_paid,');
    }
    // The quote base SQL takes no WHERE (T5), so quotes read it batched.
    expect(read('apps/api/src/services/quotes.ts')).toContain('wo_paid: paidByTask.get(r.task_id) ?? 0,');
  });
  it('each type has its own default columns; payments and quotes show NTE and Paid so far', () => {
    const page = read('apps/web/src/pages/ApprovalsPage.tsx');
    expect(page).toContain("payments: ['requester', 'client', 'payee', 'amount', 'method', 'reason', 'nte', 'paid', 'cost', 'raised', 'status']");
    expect(page).toContain("quotes: ['requester', 'client', 'amount', 'nte', 'paid', 'cost', 'due', 'raised', 'status']");
    expect(page).toContain("{ key: 'paid', label: 'Paid so far' }");
    expect(page).toContain('return SECTION_ORDER.map((s) => {');
  });
});

describe('#25 specs in the summary and on the printed quote', () => {
  it('the summary and the print page carry the specs; leaving a box saves', () => {
    expect(read('apps/api/src/services/quotes.ts')).toContain('pushSpecs(out, section.specs);');
    expect(read('apps/web/src/pages/QuotePrintPage.tsx')).toContain('<b>Specs:</b> {section.specs}');
    expect(read('apps/web/src/pages/QuoteBuilderPage.tsx')).toContain('onBlurCapture={saveOnLeave}');
  });
});

describe('#9 fold a quote section', () => {
  it('the Incurred card and each option carry the fold button', () => {
    expect(read('apps/web/src/pages/QuoteBuilderPage.tsx')).toContain('<SectionFoldButton foldKey={incurred.key} label="Incurred"');
    expect(read('apps/web/src/components/quote/OptionCard.tsx')).toContain('<SectionFoldButton foldKey={section.key} label={label}');
    expect(read('apps/web/src/styles/quote.css')).toContain('[data-fold][data-folded="true"]');
  });
});

describe('#7 a new technician from the payment search', () => {
  it('carries a typed phone into Phone and a typed name into the name', () => {
    expect(prefillFromSearch('(409) 555-0143')).toEqual({ name: '', phone: '(409) 555-0143' });
    expect(prefillFromSearch('409.555.0143')).toEqual({ name: '', phone: '409.555.0143' });
    expect(prefillFromSearch('Gulf Coast')).toEqual({ name: 'Gulf Coast', phone: '' });
    expect(prefillFromSearch('Unit 4095550')).toEqual({ name: 'Unit 4095550', phone: '' });
  });
});
