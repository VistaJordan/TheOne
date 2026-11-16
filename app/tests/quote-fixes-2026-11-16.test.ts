// Quotes, 2026-11-16 (Elise): send above the NTE without the NTE override
// holding it, the client's approval settles the NTE (and any open increase
// request), the Trip charged once (Incurred only), labor hours in the client
// text, and quote templates (0145).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mayManageQuoteTemplate,
  quoteTemplateHasContent,
  quoteTemplateSummary,
  summaryLineLabel,
  type QuoteDraftBody,
} from '../packages/shared/src/index';
import { buildAutoSummary } from '../apps/api/src/services/quotes';
import { migrationFileProblems } from '../packages/db/src/migrateLedger';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
/** The body of one function in a source file (from its signature to the next top-level declaration). */
function fn(src: string, sig: string): string {
  const i = src.indexOf(sig);
  expect(i).toBeGreaterThan(-1);
  const rest = src.slice(i + sig.length);
  const end = rest.search(/\n(export |async function |function |const |\/\*\*)/);
  return sig + (end === -1 ? rest : rest.slice(0, end));
}

describe('the NTE override holds payments, never the quote', () => {
  const quotes = read('apps/api/src/services/quotes.ts');
  it('approve, send, the client approval and the Approved move ask no NTE override', () => {
    for (const sig of [
      'export async function approveQuote(',
      'export async function sendQuote(',
      'export async function clientApproveQuote(',
      'export async function planApprovedMove(',
    ]) {
      expect(fn(quotes, sig)).not.toContain('assertNoOpenNteOverride(');
    }
    expect(quotes).not.toContain('assertNoOpenNteOverride');
  });
  it('payments still ask it', () => {
    expect(read('apps/api/src/services/payments.ts')).toContain('await assertNoOpenNteOverride(row.task_id, move)');
  });
  it('the builder, the Quotes list and the Approvals quotes lane draw no NTE hold on a quote', () => {
    const builder = read('apps/web/src/pages/QuoteBuilderPage.tsx');
    expect(builder).not.toContain('nte_override_open');
    expect(builder).not.toContain('NTE_HOLD');
    const decision = read('apps/web/src/components/quote/QuoteDecision.tsx');
    expect(decision).not.toContain('nteHold');
    const inbox = read('apps/web/src/pages/ApprovalsPage.tsx');
    const quoteRow = fn(inbox, 'function quoteRow(');
    expect(quoteRow).toContain('held: false');
    expect(inbox).not.toContain("!canApproveQuotes ? 'Requires quote approval rights' : NTE_HOLD");
  });
  it('the client approval sets the NTE, then settles the open NTE increase requests', () => {
    const set = fn(quotes, 'async function setNteFromApproval(');
    expect(set.indexOf('updateWorkOrderFields(')).toBeLessThan(set.indexOf('settleNteRequestsFromApproval('));
    const rec = read('apps/api/src/services/woRecord.ts');
    const settle = fn(rec, 'export async function settleNteRequestsFromApproval(');
    expect(settle).toContain("WHERE task_id = $1 AND status = 'open'");
    expect(settle).toContain("CASE WHEN requested_nte <= $2 THEN 'approved' ELSE 'withdrawn' END");
    expect(settle).toContain("kind: 'nte_increase_decided'");
    expect(settle).toContain('catch (err)');
  });
});

describe('the Trip is charged once, on Incurred', () => {
  it('createQuote puts the Trip line on the incurred section only', () => {
    const quotes = read('apps/api/src/services/quotes.ts');
    expect(quotes).toContain("sections.rows.filter((r) => r.kind === 'incurred')");
  });
  it('a new option opens with no lines', async () => {
    const { blankOption } = await import('../apps/web/src/lib/quoteDraft');
    expect(blankOption(1).lines).toEqual([]);
    expect(blankOption(2).round).toBe(2);
  });
});

describe('labor hours in the client text', () => {
  it('a Labor line of more than one hour says how many', () => {
    expect(summaryLineLabel({ line_type: 'labor', description: 'Labor tech 1', qty: 3 })).toBe('3 labor hours tech 1');
    expect(summaryLineLabel({ line_type: 'labor', description: 'Labor tech 2', qty: 2.5 })).toBe('2.5 labor hours tech 2');
    expect(summaryLineLabel({ line_type: 'labor', description: 'Labor', qty: 4 })).toBe('4 labor hours');
    expect(summaryLineLabel({ line_type: 'labor', description: 'Helper', qty: 3 })).toBe('3 labor hours — Helper');
  });
  it('one hour, and every other line type, print as typed', () => {
    expect(summaryLineLabel({ line_type: 'labor', description: 'Labor tech 1', qty: 1 })).toBe('Labor tech 1');
    expect(summaryLineLabel({ line_type: 'part', description: 'Fan motor', qty: 3 })).toBe('Fan motor');
    expect(summaryLineLabel({ line_type: 'service', description: 'Trip', qty: 2 })).toBe('Trip');
  });
  it('the summary prints the hours', () => {
    const ctx = { client: null, store: null, city: null, state: null, ext_name: null, trade: null, title: null, note_to_customer: null };
    const totals = { total_rule: 'yoda', incurred_subtotal: 0, option_totals: [], priced_section_id: null, sales_tax_pct: 0, sales_tax: 0, grand_total: 0, nte: null };
    const text = buildAutoSummary(
      ctx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [
        {
          id: 'o', kind: 'option', label: 'Option A', name: null, scope_lines: [], approved_at: null, locked: false,
          include_in_summary: true, narrative_reported: null,
          lines: [{ description: 'Labor tech 1', line_type: 'labor', qty: 3, day: 1, amount: 285 }],
        },
      ] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      totals as any,
    );
    expect(text).toContain('3 labor hours tech 1');
  });
});

describe('quote templates (0145)', () => {
  const body = (lines: number, scope: string[] = []): QuoteDraftBody => ({
    sections: [
      {
        kind: 'option', name: null, narrative_reported: null, scope_lines: scope, include_in_summary: true,
        lines: Array.from({ length: lines }, () => ({
          line_type: 'labor' as const, description: 'Labor tech 1', qty: 1, rate: 95, day_value: 'Day 1', ot: false, uom: null, tax_pct: 0, markup_pct: 0,
        })),
      },
    ],
    specs: null,
    note_to_customer: null,
  });

  it('an empty quote is not a template; a line or a scope line is', () => {
    expect(quoteTemplateHasContent(body(0, ['', '  ']))).toBe(false);
    expect(quoteTemplateHasContent(body(1))).toBe(true);
    expect(quoteTemplateHasContent(body(0, ['Replace the compressor']))).toBe(true);
    expect(quoteTemplateSummary(body(2))).toBe('1 option · 2 lines');
  });

  it('who may manage one: the owner; a quote approver for a shared one; a super admin', () => {
    const viewer = { id: 'me', canShare: false, isSuperAdmin: false };
    expect(mayManageQuoteTemplate({ created_by: 'me', shared: false }, viewer)).toBe(true);
    expect(mayManageQuoteTemplate({ created_by: 'other', shared: true }, viewer)).toBe(false);
    expect(mayManageQuoteTemplate({ created_by: 'other', shared: true }, { ...viewer, canShare: true })).toBe(true);
    expect(mayManageQuoteTemplate({ created_by: 'other', shared: false }, { ...viewer, canShare: true })).toBe(false);
    expect(mayManageQuoteTemplate({ created_by: 'other', shared: false }, { ...viewer, isSuperAdmin: true })).toBe(true);
  });

  it('the list is the viewer’s own and the shared ones; sharing needs quotes approve', () => {
    const svc = read('apps/api/src/services/quoteTemplates.ts');
    expect(svc).toContain('WHERE t.shared OR t.created_by = $1');
    expect(svc).toContain("permAllows(a.perms, 'quotes', 'approve', a.isSuperAdmin)");
    expect(svc).toContain("permAllows(a.perms, 'quotes', 'edit', a.isSuperAdmin)");
    for (const action of ['quote_template_created', 'quote_template_updated', 'quote_template_deleted']) {
      expect(svc).toContain(`action: '${action}'`);
      expect(read('apps/web/src/lib/auditFormat.ts')).toContain(`${action}:`);
    }
  });

  it('the migration is applyable and keeps no FK to principal (survives a re-seed)', () => {
    const sql = read('packages/db/migrations/0145_quote_template.sql');
    expect(migrationFileProblems(sql)).toEqual([]);
    expect(sql).toContain('CREATE TABLE quote_template');
    expect(sql).not.toMatch(/REFERENCES\s+principal/i);
    expect(read('packages/db/src/seed.ts')).not.toContain('quote_template');
  });

  it('Use replaces only what is being typed; Save keeps only that too', async () => {
    const { applyTemplate, blankOption, templateContentFrom } = await import('../apps/web/src/lib/quoteDraft');
    const locked = { ...blankOption(1), name: 'Approved earlier', locked: true };
    const draft = {
      sections: [
        { ...blankOption(2), kind: 'incurred' as const, name: 'Work already performed', locked: true },
        locked,
        { ...blankOption(2), name: 'Typed' },
      ],
      current_round: 2,
      sales_tax_pct: '8.25',
      total_rule: 'incurred_plus_option' as const,
      bill_to: 'Bill',
      is_cost_tbd: false,
      summary_pinned: 'pinned',
      document_type: 'quote' as const,
      ship_to: '',
    };
    const next = applyTemplate(draft, { ...body(2), specs: 'template specs' });
    expect(next.sections[0]).toBe(draft.sections[0]); // locked incurred stays
    expect(next.sections[1]).toBe(locked); // the earlier round stays
    expect(next.sections).toHaveLength(3);
    expect(next.sections[2].lines).toHaveLength(2);
    expect(next.sections[2].round).toBe(2);
    expect(next.summary_pinned).toBeNull();
    expect(next.sales_tax_pct).toBe('8.25');
    // Save keeps the open section only, never the locked history.
    const saved = templateContentFrom(draft);
    expect(saved.sections).toHaveLength(1);
    expect(saved.sections[0].name).toBe('Typed');
    // 0146 · an older template's quote-wide specs land on the Incurred section it brings.
    const open = { ...draft, sections: [{ ...draft.sections[0], locked: false }, draft.sections[2]] };
    const withInc = { ...body(2), specs: 'template specs', sections: [{ ...body(2).sections[0], kind: 'incurred' as const }] };
    expect(applyTemplate(open, withInc).sections[0].specs).toBe('template specs');
  });

  it('the builder offers Templates while the quote can be edited', () => {
    const page = read('apps/web/src/pages/QuoteBuilderPage.tsx');
    expect(page).toMatch(/\{editable && draft && \(\s*<QuoteTemplatesButton/);
    expect(page).toContain('update(applyTemplate(draft, body))');
  });
});
