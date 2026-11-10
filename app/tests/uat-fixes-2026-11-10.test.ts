/* Elise, 2026-11-10 — the UAT fixes: the Multi-day toggle, pasting a block into
 * "Required is to…", only labor under the days in the summary, the client
 * message confirm and Enter to send, the check-in method read off the client
 * row, one check-in at a time, the dispatchers' intake field lock (0129) and
 * taking a submitted quote back to edit. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_FM_LOCKED_ROLES,
  CREATE_FILLABLE_FIELD_KEYS,
  DISPATCHER_INTAKE_LOCKED_FIELD_KEYS,
  fieldPermKey,
  fillableOnCreate,
  ORIGINAL_WO_KEY,
  RECALL_KEY,
  WO_CREATE_DEFAULT_KEYS,
  applyRecallRule,
  pasteScopeLines,
  recallTicked,
  splitPastedScope,
} from '../packages/shared/src/index';
import { buildAutoSummary } from '../apps/api/src/services/quotes';
import { migrationFileProblems } from '../packages/db/src/migrateLedger';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('pasting a block into "Required is to…"', () => {
  it('splits on line breaks and drops numbers, bullets and blank lines', () => {
    expect(splitPastedScope('1. Inspect the unit\r\n2) Replace the fan\n\n- Test\n• Clean up')).toEqual([
      'Inspect the unit',
      'Replace the fan',
      'Test',
      'Clean up',
    ]);
  });
  it('a single line is not a block — the browser pastes it', () => {
    expect(splitPastedScope('just one line')).toBeNull();
    expect(splitPastedScope('one\n\n')).toBeNull();
  });
  it('fills the blank lines that follow, then inserts, so the closing line stays last', () => {
    const lines = ['Full inspection', '', '', '', 'Clean the working area'];
    const out = pasteScopeLines(lines, 1, ['A', 'B', 'C', 'D', 'E']);
    expect(out.lines).toEqual(['Full inspection', 'A', 'B', 'C', 'D', 'E', 'Clean the working area']);
    expect(out.last).toBe(5);
  });
  it('keeps the text around the caret', () => {
    const out = pasteScopeLines(['Fix '], 0, ['the door', 'the lock'], 'Fix ', '!');
    expect(out.lines).toEqual(['Fix the door', 'the lock!']);
  });
});

describe('the summary: only labor sits under the days, incurred never does', () => {
  const ctx = { client: null, store: null, city: null, state: null, ext_name: null, trade: null, title: null, note_to_customer: null };
  const totals = { total_rule: 'yoda', incurred_subtotal: 0, option_totals: [], priced_section_id: null, sales_tax_pct: 0, sales_tax: 0, grand_total: 0, nte: null };
  const line = (description: string, line_type: string, day: number) => ({ description, line_type, day, amount: 10 });
  const section = (kind: string, lines: unknown[]) => ({
    id: kind, kind, label: kind, lines, scope_lines: [], approved_at: null, locked: false,
    include_in_summary: true, narrative_reported: null, name: null,
  });
  const text = buildAutoSummary(
    ctx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [
      section('incurred', [line('Diagnosis', 'labor', 2)]),
      section('option', [line('Trip', 'service', 1), line('Labor tech 1', 'labor', 1), line('Fan motor', 'part', 1), line('Labor tech 1', 'labor', 2)]),
    ] as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    totals as any,
  );
  it('groups the option’s labor Day 1, Day 2, then the trip and parts ungrouped', () => {
    const proposed = text.slice(text.indexOf('PROPOSED'));
    expect(proposed.indexOf('Day 1')).toBeLessThan(proposed.indexOf('Day 2'));
    expect(proposed.indexOf('Day 2')).toBeLessThan(proposed.indexOf('Trip'));
    expect(proposed.indexOf('Day 2')).toBeLessThan(proposed.indexOf('Fan motor'));
    expect(proposed).toMatch(/\n {2}Trip/);
  });
  it('prints no Day heading under INCURRED', () => {
    const incurred = text.slice(text.indexOf('INCURRED'), text.indexOf('PROPOSED'));
    expect(incurred).not.toContain('Day ');
  });
});

describe('Messages: Enter sends, the client message is confirmed', () => {
  const src = read('apps/web/src/components/wo/messages/MessageComposer.tsx');
  it('Enter without Shift sends; Shift+Enter is a new line', () => {
    expect(src).toContain("e.key !== 'Enter' || e.shiftKey");
    expect(src).toContain('onKeyDown={onKeyDown}');
  });
  it('a client-visible message asks first', () => {
    expect(src).toContain('Are you sure you want to send this message to the client?');
    expect(src).toContain('if (clientVisible) setConfirmOpen(true);');
  });
});

describe('visits: the method is the client’s, one check-in at a time', () => {
  const svc = read('apps/api/src/services/visits.ts');
  const create = svc.slice(svc.indexOf('export async function createVisit'), svc.indexOf('export async function updateVisit'));
  const update = svc.slice(svc.indexOf('export async function updateVisit'), svc.indexOf('export async function deleteVisit'));
  it('a new visit takes the method from methodForTask, never from the caller', () => {
    expect(create).toContain('await methodForTask(taskId)');
    expect(create).not.toContain('c.method');
  });
  it('an edit that changes the method is refused', () => {
    expect(update).toContain('VISIT_METHOD_LOCKED_CODE');
  });
  it('checking in while another visit is checked in is refused, under the task lock', () => {
    expect(create).toContain("if (status === 'checked_in') await assertNoOpenVisit(tx, taskId, null)");
    expect(update).toContain('await assertNoOpenVisit(tx, cur.task_id, visitId)');
    expect(svc).toContain("status = 'checked_in'");
  });
  it('the CICO card draws the method read-only', () => {
    const card = read('apps/web/src/components/wo/CicoCard.tsx');
    expect(card).toContain('function MethodReadOnly');
    expect(card).not.toContain('setMethod(');
  });
});

describe('0129 · the dispatchers’ intake field lock', () => {
  const sql = read('packages/db/migrations/0129_dispatcher_intake_field_lock.sql');
  it('names every locked path and only the three dispatcher tiers', () => {
    for (const k of DISPATCHER_INTAKE_LOCKED_FIELD_KEYS) expect(sql, k).toContain(`'${fieldPermKey(k)}'`);
    for (const r of CLIENT_FM_LOCKED_ROLES) expect(sql).toContain(`'${r}'`);
    for (const other of ['vr_officer', 'oa', 'tl', 'atl', 'am', 'admin']) expect(sql).not.toMatch(new RegExp(`'${other}'`));
    expect(sql).toContain('{"edit": false}');
  });
  it('Add work order still takes them', () => {
    for (const k of DISPATCHER_INTAKE_LOCKED_FIELD_KEYS) {
      expect(CREATE_FILLABLE_FIELD_KEYS as readonly string[]).toContain(k);
      expect(fillableOnCreate(k)).toBe(true);
    }
  });
  it('is a migration the ledger accepts', () => {
    expect(migrationFileProblems(sql)).toEqual([]);
  });
});

describe('the submitter takes a quote back to edit', () => {
  const svc = read('apps/api/src/services/quotes.ts');
  const fn = svc.slice(svc.indexOf('export async function retractQuote'), svc.indexOf('export async function cancelSubmission'));
  it('only from pending correction or approval, only by the submitter', () => {
    expect(svc).toContain("const QUOTE_RETRACTABLE_FROM: QuoteStatus[] = ['pending_correction', 'pending_approval'];");
    expect(fn).toContain('q.submitted_by !== actor.id && !actor.isSuperAdmin');
    expect(fn).toContain("'draft'");
  });
  it('has its route and its button', () => {
    expect(read('apps/api/src/routes/quotes.ts')).toContain("lifecycle('retract', retractQuote)");
    expect(read('apps/web/src/pages/QuoteBuilderPage.tsx')).toContain('Take back to edit');
  });
});

describe('0130 · "Is this WO a recall?" and the Original WO', () => {
  const form = {
    fields: [
      { key: 'Is Recall', label: 'Is this WO a recall?', type: 'checkbox', options: [], mode: 'optional' as const, section: 'what' },
      { key: 'Original WO', label: 'Original WO', type: 'short_text', options: [], mode: 'optional' as const, section: 'what' },
    ],
  };
  it('Original WO is off the form until the box is ticked, then required', () => {
    expect(applyRecallRule(form, false).fields.map((f) => f.key)).toEqual(['Is Recall']);
    const on = applyRecallRule(form, true).fields.find((f) => f.key === ORIGINAL_WO_KEY);
    expect(on?.mode).toBe('required');
    expect(recallTicked('true')).toBe(true);
    expect(recallTicked(true)).toBe(true);
    expect(recallTicked('')).toBe(false);
  });
  it('the migration, the seed and the default form carry both fields', () => {
    const sql = read('packages/db/migrations/0130_recall_original_wo.sql');
    expect(sql).toContain("('Is Recall',");
    expect(sql).toContain("('Original WO',");
    expect(migrationFileProblems(sql)).toEqual([]);
    const seed = read('packages/db/src/seed.ts');
    expect(seed).toContain("key: 'Is Recall'");
    expect(seed).toContain("key: 'Original WO'");
    expect(WO_CREATE_DEFAULT_KEYS).toContain(RECALL_KEY);
    expect(WO_CREATE_DEFAULT_KEYS).toContain(ORIGINAL_WO_KEY);
  });
  it('the API lays the rule over the form and checks the original exists', () => {
    const svc = read('apps/api/src/services/woCreate.ts');
    expect(svc).toContain('recallTicked(input.fields?.[RECALL_KEY])');
    expect(svc).toContain('await resolveOriginalWo(originalWo)');
    expect(svc).toContain('AND t.deleted_at IS NULL');
  });
});
