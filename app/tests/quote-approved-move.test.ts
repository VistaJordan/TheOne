// 2026-11-04 (Elise): a submitted quote is locked for everyone; a quote over
// the NTE is not sent until the NTE is raised; moving the work order to
// Approved records the client's approval on the sent quote (OA may too).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  approvedMovePlan,
  mayMoveToApprovedDirectly,
  QUOTE_NOT_SENT_CODE,
  QUOTE_OPTION_REQUIRED_CODE,
} from '../packages/shared/src/quoteSubmit';
import { quoteOverNte, quoteOverNteSentence, quoteTotalForNte } from '../packages/shared/src/moneyGuards';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const fn = (text: string, head: string) => {
  const at = text.indexOf(head);
  const next = text.indexOf('\nexport ', at + head.length);
  return text.slice(at, next === -1 ? undefined : next);
};

const sec = (id: string, kind: string, round: number, label: string, name: string | null = null) => ({ id, kind, round, label, name });

describe('the plan for a move into Approved', () => {
  it('no quote, or one the client already decided: the status just moves', () => {
    expect(approvedMovePlan(null)).toEqual({ kind: 'move' });
    expect(approvedMovePlan({ status: 'client_approved', current_round: 1, sections: [] })).toEqual({ kind: 'move' });
    expect(approvedMovePlan({ status: 'client_declined', current_round: 1, sections: [] })).toEqual({ kind: 'move' });
  });
  it('a quote not yet sent refuses the move', () => {
    for (const status of ['draft', 'pending_correction', 'pending_approval', 'approved']) {
      expect(approvedMovePlan({ status, current_round: 1, sections: [] })).toEqual({ kind: 'not_sent', status });
    }
  });
  it('a sent quote records one of the current round options', () => {
    const plan = approvedMovePlan({
      status: 'sent',
      current_round: 2,
      sections: [sec('i', 'incurred', 1, 'Incurred'), sec('old', 'option', 1, 'Option A'), sec('a', 'option', 2, 'Option A', 'Repair'), sec('b', 'option', 2, 'Option B')],
    });
    expect(plan).toEqual({ kind: 'record', options: [{ id: 'a', label: 'Option A · Repair' }, { id: 'b', label: 'Option B' }] });
  });
  it('OA moves straight to Approved; the dispatchers do not', () => {
    expect(mayMoveToApprovedDirectly('oa')).toBe(true);
    for (const r of ['om', 'om_probation', 'senior_om', null]) expect(mayMoveToApprovedDirectly(r)).toBe(false);
    expect(QUOTE_NOT_SENT_CODE).toBe('QUOTE_NOT_SENT');
    expect(QUOTE_OPTION_REQUIRED_CODE).toBe('QUOTE_OPTION_REQUIRED');
  });
});

describe('over the NTE', () => {
  it('compares the dearest option with the NTE', () => {
    const totals = { grand_total: 280, option_totals: [{ grand_total: 280 }, { grand_total: 5080 }] };
    expect(quoteTotalForNte(totals)).toBe(5080);
    expect(quoteOverNte(quoteTotalForNte(totals), 500)).toBe(true);
    expect(quoteTotalForNte({ grand_total: 300, option_totals: [] })).toBe(300);
    expect(quoteOverNteSentence(5080, 500)).toContain('request an NTE increase');
  });
  it('the builder locks Send to client and offers Request NTE increase', () => {
    const b = src('apps/web/src/pages/QuoteBuilderPage.tsx');
    expect(b).toContain("lockedButton('Send to client', quoteOverNteSentence(nteTotal, nte), 'lockTipSend')");
    expect(b).toContain('<NteIncreaseButton');
    expect(src('apps/web/src/components/quote/NteIncreaseButton.tsx')).toContain('requestNteIncrease(woNumber');
  });
});

describe('the status route', () => {
  const route = src('apps/api/src/routes/workOrders.ts');
  const body = route.slice(route.indexOf("app.patch('/work-orders/:id/status'"));
  const patch = body.slice(0, body.indexOf('app.post('));
  it('lets OA move to Approved without the direct grant', () => {
    expect(patch).toContain('statusApprovalNeedsNote(name) && mayMoveToApprovedDirectly(p.role)');
  });
  it('asks the quote before the move and records the approval after it', () => {
    const plan = patch.indexOf('await planApprovedMove(');
    const move = patch.indexOf('await changeStatus(');
    const record = patch.indexOf('await recordApproval()');
    expect(plan).toBeGreaterThan(-1);
    expect(plan).toBeLessThan(move);
    expect(move).toBeLessThan(record);
  });
  it('planApprovedMove refuses before anything is written and records through clientApproveQuote', () => {
    const quotes = src('apps/api/src/services/quotes.ts');
    const f = fn(quotes, 'export async function planApprovedMove(');
    expect(f).toContain('QUOTE_NOT_SENT_CODE');
    expect(f).toContain('STATUS_APPROVAL_NOTE_CODE');
    expect(f).toContain('QUOTE_OPTION_REQUIRED_CODE');
    expect(f).toContain('assertCanClientDecide(actor, snap)');
    expect(f).toContain('assertNoOpenNteOverride(');
    expect(f).toContain('clientApproveQuote(taskId, { section_id: sectionId, note }, actor)');
  });
  it('the status menu opens the dialog for Approved', () => {
    const menu = src('apps/web/src/components/StatusChangeMenu.tsx');
    expect(menu).toContain('<ApprovedMoveDialog');
    expect(menu).toContain('patchStatus(woId, s.id, s.approval)');
  });
});
