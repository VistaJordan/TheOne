/* Section 14 — the OP Admin intake, vocabulary half. The database half
 * (services/intake.ts) creates the work order; these pin what "ready to
 * submit" means and what the person reads when it is not. */

import { describe, it, expect } from 'vitest';
import {
  INTAKE_FORM_FIELDS,
  INTAKE_PERM_KEY,
  describeIntakeSubmit,
  intakeDraftMissing,
  intakeDraftReady,
} from '../packages/shared/src/intakeDrafts';
import { INTAKE_REQUIRED_FIELDS } from '../packages/shared/src/intakeGate';

const FULL: Record<string, unknown> = {
  'Date-Time Received': '2026-09-11T14:00:00Z',
  'Due Date': '2026-09-14T22:00:00Z',
  'SLA Due Date': '2026-09-13T22:00:00Z',
  '17. Address': '1200 Main St',
  City: 'Houston',
  State: 'TX',
  'Zip Code': '77002',
  Store: '#4471',
  Trade: 'HVAC',
  '35. WO Description': 'Walk-in cooler not holding temperature',
  '22. FM': 'Seamless',
  '21. Comp': 'SFM',
  '16. Client NTE 🔴': 0,
};

describe('the form', () => {
  it('lists the thirteen 11.1.1 fields as required, then the optional ones', () => {
    const required = INTAKE_FORM_FIELDS.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(INTAKE_REQUIRED_FIELDS.map((f) => f.key));
    expect(INTAKE_FORM_FIELDS.some((f) => !f.required && f.key === 'Client')).toBe(true);
  });

  it('is gated on its own permission path', () => {
    expect(INTAKE_PERM_KEY).toBe('intake');
  });
});

describe('intakeDraftMissing — WO# first, then the intake fields', () => {
  it('is empty when everything is typed (a $0.00 NTE counts, rule 11.1.2)', () => {
    expect(intakeDraftMissing({ wo_number: 'WOT0452814', fields: FULL })).toEqual([]);
  });

  it('names WO# and each empty field, in the rule order', () => {
    expect(intakeDraftMissing({ wo_number: '  ', fields: { ...FULL, City: '', Trade: null } })).toEqual([
      'WO#',
      'City',
      'Trade',
    ]);
    expect(intakeDraftMissing({ wo_number: null, fields: {} })).toHaveLength(1 + INTAKE_REQUIRED_FIELDS.length);
  });
});

describe('intakeDraftReady — every field AND an assignee (14.3.2)', () => {
  it('needs the assignee on top of the fields', () => {
    expect(intakeDraftReady({ wo_number: 'WOT1', fields: FULL, assignee: null })).toBe(false);
    expect(intakeDraftReady({ wo_number: 'WOT1', fields: FULL, assignee: '  ' })).toBe(false);
    expect(intakeDraftReady({ wo_number: 'WOT1', fields: FULL, assignee: 'Adam Keller' })).toBe(true);
    expect(intakeDraftReady({ wo_number: null, fields: FULL, assignee: 'Adam Keller' })).toBe(false);
  });
});

describe('the sentence', () => {
  it('names the fields, the assignee, or both', () => {
    expect(describeIntakeSubmit(['City'], false)).toContain('this field: City');
    expect(describeIntakeSubmit(['City', 'Trade'], false)).toContain('these 2 fields: City, Trade');
    expect(describeIntakeSubmit([], true)).toContain('pick an assignee');
    expect(describeIntakeSubmit(['WO#'], true)).toContain(' and pick an assignee');
    expect(describeIntakeSubmit([], false)).toContain('can be submitted');
  });
});
