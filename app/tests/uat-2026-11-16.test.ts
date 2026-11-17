/**
 * Elise's list of 2026-11-16 (migrations 0146, 0147, 0148): OP Admin raises
 * and clears both header flags; Submit for correction moves the work order to
 * Quote Ready (a manager's reject already sends it to Waiting for Quote);
 * specs and the note to the customer belong to each quote section; only TL /
 * ATL change TL and ATL; OM Under Probation is view-only on People; the
 * Emergency status is gone; no Tag action; a visit's phone is a US number;
 * no "Use this device's location".
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CREATE_FILLABLE_FIELD_KEYS,
  PHASE_BY_STATUS_NAME,
  QUOTE_EVENT_STATUS_NAME,
  TEAM_LEAD_FIELD_KEYS,
  foldQuoteLevelNotes,
  mayClearEmergency,
  mayClearEscalation,
  quoteEventStatusName,
} from '@theone/shared';
import { buildAutoSummary } from '../apps/api/src/services/quotes';

const root = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

describe('OP Admin and the header flags', () => {
  it('clears an escalation and an emergency', () => {
    expect(mayClearEscalation('oa', false)).toBe(true);
    expect(mayClearEmergency('oa', false)).toBe(true);
  });
});

describe('the status follows Submit for correction', () => {
  it('moves to Quote Ready from the statuses before it, never backwards', () => {
    expect(QUOTE_EVENT_STATUS_NAME.submitted_for_correction).toBe('Quote Ready');
    expect(quoteEventStatusName('submitted_for_correction', 'Waiting for Quote')).toBe('Quote Ready');
    expect(quoteEventStatusName('submitted_for_correction', 'On Site (Assessment)')).toBe('Quote Ready');
    expect(quoteEventStatusName('submitted_for_correction', 'Quote Ready')).toBeNull();
    expect(quoteEventStatusName('submitted_for_correction', 'Job Sched')).toBeNull();
  });
  it('a manager’s reject goes back to Waiting for Quote from Quote Ready', () => {
    expect(quoteEventStatusName('manager_rejected', 'Quote Ready')).toBe('Waiting for Quote');
  });
  it('submitQuote follows the event only for a correction submit', () => {
    const src = read('apps/api/src/services/quotes.ts');
    expect(src).toContain("withStatusMove(taskId, quote, 'submitted_for_correction', actor)");
  });
});

describe('specs and the note to the customer per section (0146)', () => {
  it('folds quote-wide values onto the Incurred section when it has none', () => {
    const out = foldQuoteLevelNotes(
      [{ kind: 'incurred' as const }, { kind: 'option' as const, note_to_customer: 'opt' }],
      'S',
      'N',
    );
    expect(out[0]).toMatchObject({ specs: 'S', note_to_customer: 'N' });
    expect(out[1]).toMatchObject({ note_to_customer: 'opt' });
    const kept = foldQuoteLevelNotes([{ kind: 'incurred' as const, specs: 'own', note_to_customer: 'own' }], 'S', 'N');
    expect(kept[0]).toMatchObject({ specs: 'own', note_to_customer: 'own' });
  });

  it('the summary prints each section’s specs and note under it (specs since UAT #25)', () => {
    const ctx = { client: null, store: null, city: null, state: null, ext_name: null, trade: null, title: null, note_to_customer: null };
    const totals = { total_rule: 'yoda', incurred_subtotal: 0, option_totals: [], priced_section_id: null, sales_tax_pct: 0, sales_tax: 0, grand_total: 0, nte: null };
    const section = (kind: string, note: string) => ({
      id: kind, kind, label: kind, lines: [], scope_lines: [], approved_at: null, locked: false,
      include_in_summary: true, narrative_reported: null, name: null, specs: kind + ' spec', note_to_customer: note,
    });
    const text = buildAutoSummary(
      ctx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [section('incurred', 'Incurred note'), section('option', 'Option note')] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      totals as any,
    );
    expect(text.indexOf('incurred spec')).toBeGreaterThan(text.indexOf('INCURRED'));
    expect(text.indexOf('incurred spec')).toBeLessThan(text.indexOf('Incurred note'));
    expect(text.indexOf('option spec')).toBeGreaterThan(text.indexOf('PROPOSED'));
    expect(text).toContain('Specs:');
    expect(text.indexOf('Incurred note')).toBeGreaterThan(text.indexOf('INCURRED'));
    expect(text.indexOf('Incurred note')).toBeLessThan(text.indexOf('PROPOSED'));
    expect(text.indexOf('Option note')).toBeGreaterThan(text.indexOf('PROPOSED'));
    expect(text.indexOf('Option note')).toBeLessThan(text.indexOf('GRAND TOTAL'));
  });

  it('the migration adds the columns and the save writes them', () => {
    const sql = read('packages/db/migrations/0146_quote_section_notes.sql');
    expect(sql).toContain('ALTER TABLE quote_section ADD COLUMN IF NOT EXISTS specs text');
    expect(sql).toContain('ALTER TABLE quote_section ADD COLUMN IF NOT EXISTS note_to_customer text');
    expect(read('apps/api/src/services/quotes.ts')).toContain('blankToNull(section.note_to_customer)');
    expect(read('apps/api/src/routes/quotes.ts')).toMatch(/sectionSchema = z\.object\(\{[\s\S]*note_to_customer/);
  });
});

describe('who changes the people (0147)', () => {
  const sql = read('packages/db/migrations/0147_team_lead_people_locks.sql');
  it('TL and ATL are edit false for everyone but TL and ATL', () => {
    for (const k of TEAM_LEAD_FIELD_KEYS) expect(sql).toContain(`work_orders/fields/people/${k}`);
    expect(sql).toContain("WHERE r.code NOT IN ('tl', 'atl', 'service')");
  });
  it('OM Under Probation is view-only on People', () => {
    expect(sql).toContain("pg_temp.tl_grant('om_probation', 'work_orders/fields/people', '{\"edit\": false}')");
  });
  it('the team seats still fill on Add work order', () => {
    for (const k of ['fields.AM', 'fields.TL', 'fields.ATL']) expect(CREATE_FILLABLE_FIELD_KEYS as readonly string[]).toContain(k);
  });
});

describe('the Emergency status is gone (0148)', () => {
  it('no phase, quote event or seed names it', () => {
    expect(PHASE_BY_STATUS_NAME.Emergency).toBeUndefined();
    const seed = read('packages/db/src/seed.ts');
    expect(seed).toContain("if (s.name.trim().toLowerCase() === 'emergency') continue;");
    expect(read('packages/shared/src/workflow.ts')).not.toMatch(/sent: \[[^\]]*'Emergency'/);
  });
  it('moves its work orders to Open with an audit row, then deletes it', () => {
    const sql = read('packages/db/migrations/0148_remove_emergency_status.sql');
    expect(sql).toContain("'status_changed'");
    expect(sql).toContain('DELETE FROM status s');
  });
});

describe('the work-order screens', () => {
  it('has no Tag action and no device-location button', () => {
    const parts = read('apps/web/src/components/wo/record/RecordParts.tsx');
    expect(parts).not.toContain('Tag this work order');
    expect(parts).not.toContain("pick('tag')");
    expect(parts).not.toContain('navigator.geolocation');
  });
  it('a visit’s phone is checked as a US number', () => {
    expect(read('apps/api/src/services/visits.ts')).toContain("out.tech_phone = techPhone(input.tech_phone)");
    expect(read('apps/web/src/components/wo/CicoCard.tsx')).toContain('usPhoneInputValue(e.target.value)');
  });
});
