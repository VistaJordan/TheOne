/* Rules 11.1.1 / 11.1.2 — the "Ready to Assign" gate, vocabulary half. The
 * database half (services/intakeGate.ts) reads the row and throws the 409;
 * these pin which fields the gate asks for, what "filled" means (a $0.00
 * NTE passes, 11.1.2) and the sentence, so the API, the Incoming page and
 * the header chip cannot drift apart. */

import { describe, it, expect } from 'vitest';
import {
  INTAKE_GATE_ERROR_CODE,
  INTAKE_REQUIRED_FIELDS,
  describeIntakeGate,
  intakeMissing,
  intakeValueFilled,
} from '../packages/shared/src/intakeGate';

/** A bag with every intake field typed. */
const FULL: Record<string, unknown> = {
  'Date-Time Received': '2026-09-10 09:15',
  'Due Date': '2026-09-14',
  'SLA Due Date': '2026-09-13 17:00',
  '17. Address': '1200 Main St',
  City: 'Houston',
  State: 'TX',
  'Zip Code': '77002',
  Store: '#4411',
  Trade: 'HVAC',
  '35. WO Description': 'Walk-in freezer not holding temp',
  '22. FM': 'Seamless',
  '21. Comp': 'SFM',
  '16. Client NTE 🔴': 750,
};

describe('INTAKE_REQUIRED_FIELDS — rule 11.1.1, in order', () => {
  it('lists the thirteen typed fields (WO# is the row key, never empty)', () => {
    expect(INTAKE_REQUIRED_FIELDS.map((f) => f.label)).toEqual([
      'Received on',
      'Due date',
      'SLA',
      'Address',
      'City',
      'State',
      'Zip code',
      'Store',
      'Trade',
      'WO description',
      'FM',
      'Comp',
      'Client NTE',
    ]);
  });

  it('names the bag keys the field editor writes', () => {
    expect(INTAKE_REQUIRED_FIELDS.map((f) => f.key)).toEqual(Object.keys(FULL));
  });

  it('has a stable error code for the 409', () => {
    expect(INTAKE_GATE_ERROR_CODE).toBe('INTAKE_GATE');
  });
});

describe('intakeValueFilled — what NOT NULL means', () => {
  it('rejects null, undefined and blank strings', () => {
    expect(intakeValueFilled(null)).toBe(false);
    expect(intakeValueFilled(undefined)).toBe(false);
    expect(intakeValueFilled('')).toBe(false);
    expect(intakeValueFilled('   ')).toBe(false);
  });

  it('accepts text, dates and numbers — zero included (11.1.2)', () => {
    expect(intakeValueFilled('TX')).toBe(true);
    expect(intakeValueFilled('2026-09-14')).toBe(true);
    expect(intakeValueFilled(0)).toBe(true);
    expect(intakeValueFilled('0')).toBe(true);
    expect(intakeValueFilled('$0.00')).toBe(true);
    expect(intakeValueFilled(NaN)).toBe(false);
  });

  it('looks inside a structured value (a location, a list)', () => {
    expect(intakeValueFilled({ address: '1200 Main St', lat: null })).toBe(true);
    expect(intakeValueFilled({ address: '', lat: null })).toBe(false);
    expect(intakeValueFilled(['', 'Compressor'])).toBe(true);
    expect(intakeValueFilled([])).toBe(false);
  });
});

describe('intakeMissing — the fields still empty on a row', () => {
  it('is empty when every field is typed', () => {
    expect(intakeMissing({ fields: FULL })).toEqual([]);
  });

  it('lists the empty ones in the rule order', () => {
    const { 'Due Date': _due, State: _state, '21. Comp': _comp, ...rest } = FULL;
    expect(intakeMissing({ fields: rest }).map((f) => f.label)).toEqual(['Due date', 'State', 'Comp']);
  });

  it('accepts the promoted column when the bag key is empty (the Ecotrak ingest writes columns)', () => {
    const { 'Date-Time Received': _r, '35. WO Description': _d, '16. Client NTE 🔴': _n, ...rest } = FULL;
    expect(intakeMissing({ fields: rest }).map((f) => f.label)).toEqual(['Received on', 'WO description', 'Client NTE']);
    expect(
      intakeMissing({
        fields: rest,
        date_received: '2026-09-10',
        description: 'Walk-in freezer',
        nte: '0.00',
      }),
    ).toEqual([]);
  });

  it('lets a $0.00 NTE through but not an empty one (11.1.2)', () => {
    expect(intakeMissing({ fields: { ...FULL, '16. Client NTE 🔴': 0 } })).toEqual([]);
    expect(intakeMissing({ fields: { ...FULL, '16. Client NTE 🔴': null } }).map((f) => f.label)).toEqual([
      'Client NTE',
    ]);
    expect(intakeMissing({ fields: { ...FULL, '16. Client NTE 🔴': null }, nte: 0 })).toEqual([]);
  });

  it('treats a missing bag as all empty', () => {
    expect(intakeMissing({ fields: null })).toHaveLength(INTAKE_REQUIRED_FIELDS.length);
  });
});

describe('describeIntakeGate — the sentence', () => {
  it('names the count and the fields', () => {
    expect(describeIntakeGate([{ label: 'Due date' }, { label: 'SLA' }])).toBe(
      'Fill these 2 fields before the work order can be assigned (rule 11.1.1): Due date, SLA.',
    );
    expect(describeIntakeGate([{ label: 'Comp' }])).toBe(
      'Fill this field before the work order can be assigned (rule 11.1.1): Comp.',
    );
  });

  it('says so when nothing is missing', () => {
    expect(describeIntakeGate([])).toMatch(/can be assigned/);
  });
});
