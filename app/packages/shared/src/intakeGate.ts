// Rules 11.1.1 / 11.1.2 — the "Ready to Assign" gate (intake).
//
// A work order cannot be assigned to a dispatcher until the intake fields
// are filled: WO#, Received on, Due date, SLA, Address, City, State, Zip
// code, Store, Trade, WO description, FM, Comp and Client NTE (11.1.1). A
// Client NTE of $0.00 counts as filled (11.1.2) — only an EMPTY NTE blocks.
//
// The check itself needs the database (apps/api/src/services/intakeGate.ts):
// it runs when a manager accepts a new work order from the Incoming queue
// (rule 7.1.3 — the acceptance IS the assignment) and when somebody fills
// the Assignee seat by hand on a work order that is still waiting there.
// This file is the vocabulary both sides share: which fields, what "filled"
// means, and the sentence the person reads. The Incoming page reads
// `intake_missing` off every acceptance row so the Accept verb is locked,
// with the list, before the click.

export interface IntakeField {
  /** The bag key (`task.fields`) — the same key the field editor writes. */
  key: string;
  /** How the missing list names it. */
  label: string;
}

/**
 * The intake fields, in the rule's order. WO# is `task.wo_number`, NOT NULL
 * by schema, so it is never missing and is not listed. Three keys also have
 * a promoted column the check accepts as filled (`intakeMissing` below):
 * Received on ↔ `task.date_received`, WO description ↔ `task.description`,
 * Client NTE ↔ `task.nte` — the Ecotrak ingest writes the columns, not the
 * bag keys.
 */
export const INTAKE_REQUIRED_FIELDS: readonly IntakeField[] = [
  { key: 'Date-Time Received', label: 'Received on' },
  { key: 'Due Date', label: 'Due date' },
  { key: 'SLA Due Date', label: 'SLA' },
  { key: '17. Address', label: 'Address' },
  { key: 'City', label: 'City' },
  { key: 'State', label: 'State' },
  { key: 'Zip Code', label: 'Zip code' },
  { key: 'Store', label: 'Store' },
  { key: 'Trade', label: 'Trade' },
  { key: '35. WO Description', label: 'WO description' },
  { key: '22. FM', label: 'FM' },
  { key: '21. Comp', label: 'Comp' },
  { key: '16. Client NTE 🔴', label: 'Client NTE' },
];

/** `details.code` on the 409 a refused assignment returns; `details.missing`
    carries the labels. */
export const INTAKE_GATE_ERROR_CODE = 'INTAKE_GATE';

/** What the check reads: the bag plus the three promoted columns. */
export interface IntakeRow {
  fields: Record<string, unknown> | null | undefined;
  date_received?: string | null;
  description?: string | null;
  nte?: number | string | null;
}

/**
 * "NOT NULL" for a hand-typed value: something other than whitespace. A
 * number counts however small — 11.1.2 lets a $0.00 NTE through — and a
 * structured value (a location object, a list) counts when any part of it
 * is non-blank.
 */
export function intakeValueFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.some(intakeValueFilled);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(intakeValueFilled);
  return String(value).trim() !== '';
}

/** The intake fields still empty on this row, in the rule's order. Empty
    array = ready to assign. */
export function intakeMissing(row: IntakeRow): IntakeField[] {
  const bag = row.fields ?? {};
  const column: Record<string, unknown> = {
    'Date-Time Received': row.date_received,
    '35. WO Description': row.description,
    '16. Client NTE 🔴': row.nte,
  };
  return INTAKE_REQUIRED_FIELDS.filter(
    (f) => !intakeValueFilled(bag[f.key]) && !intakeValueFilled(column[f.key]),
  );
}

/** The sentence a refused assignment reads (the 409, the locked Accept
    verb, the header chip). */
export function describeIntakeGate(missing: readonly Pick<IntakeField, 'label'>[]): string {
  const n = missing.length;
  if (n === 0) return 'Every intake field is filled — the work order can be assigned.';
  const list = missing.map((m) => m.label).join(', ');
  return `Fill ${n === 1 ? 'this field' : `these ${n} fields`} before the work order can be assigned (rule 11.1.1): ${list}.`;
}
