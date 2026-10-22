// Two things a manager records on a work order (Elise, 2026-10-22):
//
//  · A PROFITABILITY EXCEPTION on the Finances section — the margin on this
//    job is accepted as it is, and why (the manager's notes). Two custom
//    fields in the Finances section: a checkbox and a long text.
//
//  · PENALTIES, a section of their own on All fields: what went wrong on the
//    job (Bad quote — the field that already existed under AR —, Penalty,
//    Late quote, Missed ETA, Recall) and the manager's description.
//
// They are ordinary custom fields (field_def rows, migration 0094 and the
// seed in step), so Admin › Custom fields, the list columns, filters,
// automations, the PDF layouts and the permission tree all know them with
// no code of their own. The dispatcher tiers, the VR Officer and the OP
// Admin are view-only on all of them (0094): they are a manager's call.
//
// Keys here are the JSON keys inside task.fields; the catalogue key is
// `fields.<key>`.

export const PROFITABILITY_EXCEPTION_KEY = 'Profitability Exception';
export const PROFITABILITY_NOTES_KEY = 'Profitability Exception Notes';

export const PENALTIES_SECTION_SLUG = 'penalties';
export const PENALTIES_SECTION_TITLE = 'Penalties';

export interface ManagerFlagField {
  key: string;
  label: string;
  type: 'checkbox' | 'long_text';
}

/** The Finances section's two rows. */
export const PROFITABILITY_FIELDS: readonly ManagerFlagField[] = [
  { key: PROFITABILITY_EXCEPTION_KEY, label: 'Profitability Exception', type: 'checkbox' },
  { key: PROFITABILITY_NOTES_KEY, label: 'Manager Notes', type: 'long_text' },
];

/** The Penalties section, in the order it is drawn. `12. Bad quote` is the
    old AR field moved here, so it is not inserted again. */
export const PENALTY_FIELDS: readonly ManagerFlagField[] = [
  { key: '12. Bad quote', label: 'Bad Quote', type: 'checkbox' },
  { key: 'Penalty', label: 'Penalty', type: 'checkbox' },
  { key: 'Late Quote', label: 'Late Quote', type: 'checkbox' },
  { key: 'Missed ETA', label: 'Missed ETA', type: 'checkbox' },
  { key: 'Recall', label: 'Recall', type: 'checkbox' },
  { key: 'Penalty Description', label: 'Manager Description', type: 'long_text' },
];

/** The rows 0094 and the seed both insert (everything above that is new). */
export const MANAGER_FLAG_NEW_FIELDS: readonly ManagerFlagField[] = [
  ...PROFITABILITY_FIELDS,
  ...PENALTY_FIELDS.filter((f) => f.key !== '12. Bad quote'),
];

/** The catalogue keys of the Penalties section. */
export const PENALTIES_SECTION_KEYS: readonly string[] = PENALTY_FIELDS.map((f) => `fields.${f.key}`);

/** The roles 0094 makes view-only on the section and the two Finances rows. */
export const MANAGER_FLAG_LOCKED_ROLES = ['om_probation', 'om', 'senior_om', 'vr_officer', 'oa'] as const;
