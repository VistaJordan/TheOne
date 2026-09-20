/**
 * The manual create form — "Add work order" (0041).
 *
 * The form is CONFIGURATION, not code: `field_def.create_mode` says, per
 * field, whether it appears and whether it may be left empty. An admin adds a
 * field in Admin › Custom fields, switches it to "on the form", and it is on
 * the form — no deploy.
 *
 *   off       not offered
 *   optional  offered, may be left empty
 *   required  offered, and Create refuses while it is empty
 *
 * WO # is the exception: it is `task.wo_number` (NOT NULL UNIQUE by schema),
 * not a field_def, so it is always shown and always required. It is also the
 * work order's identity, which is why a repeat is refused outright rather
 * than warned about — see `WO_NUMBER_TAKEN` below.
 *
 * Creation is deliberately lighter than assignment. Rule 11.1.1 still demands
 * its 13 fields (intakeGate.ts) before a work order can be assigned or
 * accepted, so a coordinator can raise one from a phone call with the number
 * alone and it simply cannot reach a dispatcher until the rest is in.
 */

/** The three settings a field can carry on the create form. */
export const WO_CREATE_MODES = ['off', 'optional', 'required'] as const;
export type WoCreateMode = (typeof WO_CREATE_MODES)[number];

export function isWoCreateMode(v: unknown): v is WoCreateMode {
  return typeof v === 'string' && (WO_CREATE_MODES as readonly string[]).includes(v);
}

/** How the Admin › Custom fields control names each setting. */
export const WO_CREATE_MODE_LABELS: Record<WoCreateMode, string> = {
  off: 'Not on the form',
  optional: 'On the form',
  required: 'Required',
};

/**
 * The form as it ships: identity, where, what, when, then money and people.
 * Kept in step with `migrations/0041_wo_create_form.sql` AND `seed.ts` — all
 * three carry the same list on purpose.
 */
export const WO_CREATE_DEFAULT_KEYS: readonly string[] = [
  'Client Portal Type',
  'Client',
  'Store',
  '17. Address',
  'City',
  'State',
  'Zip Code',
  'Trade',
  'Problem Type',
  '35. WO Description',
  'Date-Time Received',
  'Due Date',
  'SLA Due Date',
  '16. Client NTE 🔴',
  '22. FM',
  '21. Comp',
  'AM',
  'Assignee',
];

/**
 * The order the form draws its sections in. A field whose key is listed here
 * lands in that section; anything else an admin switches on lands in "More
 * details" at the foot, so a new field is never invisible.
 */
export interface WoCreateSection {
  id: string;
  title: string;
  /** Why this section exists, shown under its heading. */
  hint: string;
  keys: readonly string[];
}

export const WO_CREATE_SECTIONS: readonly WoCreateSection[] = [
  {
    id: 'identity',
    title: 'Identity',
    hint: 'The number the client knows this job by. One work order per number.',
    keys: ['Client Portal Type', 'Client'],
  },
  {
    id: 'where',
    title: 'Where',
    hint: 'The store, and the address a technician drives to.',
    keys: ['Store', '17. Address', 'City', 'State', 'Zip Code'],
  },
  {
    id: 'what',
    title: 'What is wrong',
    hint: 'The trade decides who can take it; the description is what the store told us.',
    keys: ['Trade', 'Problem Type', '35. WO Description'],
  },
  {
    id: 'when',
    title: 'When it is due',
    hint: 'The clocks. SLA drives the Pulse; the due date drives the daily list.',
    keys: ['Date-Time Received', 'Due Date', 'SLA Due Date'],
  },
  {
    id: 'money',
    title: 'Money and people',
    hint: 'The NTE the client authorised, and who carries the job.',
    keys: ['16. Client NTE 🔴', '22. FM', '21. Comp', 'AM', 'Assignee'],
  },
];

export const WO_CREATE_MORE_SECTION: WoCreateSection = {
  id: 'more',
  title: 'More details',
  hint: 'Fields your admin added to the form.',
  keys: [],
};

/** One row of the form, as the API hands it to the browser. */
export interface WoCreateField {
  key: string;
  label: string;
  /** field_def.type — the editor picks its control from this. */
  type: string;
  /** Dropdown vocabulary; empty for every other type. */
  options: string[];
  mode: Exclude<WoCreateMode, 'off'>;
  /** Which `WO_CREATE_SECTIONS` id it belongs under. */
  section: string;
}

export interface WoCreateForm {
  fields: WoCreateField[];
}

/** POST /api/work-orders. */
export interface WoCreateInput {
  wo_number: string;
  /** Keyed like `task.fields`; only keys that are on the form are accepted. */
  fields: Record<string, unknown>;
}

/** `details.code` on the 409 a repeated WO # returns. */
export const WO_NUMBER_TAKEN_CODE = 'WO_NUMBER_TAKEN';
/** `details.code` on the 409 an incomplete form returns. */
export const WO_CREATE_MISSING_CODE = 'WO_CREATE_MISSING';

/** How far back a near-match is worth mentioning. */
export const WO_NEAR_DUPLICATE_DAYS = 30;

/** One work order the check found — enough to draw a link to it. */
export interface WoDuplicateHit {
  wo_number: string;
  title: string;
  client: string | null;
  store: string | null;
  trade: string | null;
  status: string;
  /** Set when the row is in the trash: the number is still taken. */
  deleted: boolean;
  created_at: string;
}

/** GET /api/work-orders/check. */
export interface WoNumberCheck {
  wo_number: string;
  /** True = this number is already a work order. Create is refused. */
  taken: boolean;
  /** The work order holding the number, when one does. */
  existing: WoDuplicateHit | null;
  /** Open work orders on the same store and trade inside the window — shown
      as a warning, never a block: a store really can break twice. */
  near: WoDuplicateHit[];
}

/**
 * The identity of a work order, compared loosely enough that "wo 12345",
 * "WO-12345 " and "wo-12345" are one number. Stored as typed — only the
 * comparison is normalized (the API keeps a normalized copy to match on).
 */
export function normalizeWoNumber(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^WO/, '');
}

/**
 * The same two steps in SQL, so the browser's live check and the API's refusal
 * agree on what "already exists" means. Used against `task.wo_number`.
 */
export const WO_NUMBER_NORMALIZED_SQL =
  "regexp_replace(regexp_replace(upper(%s), '[^A-Z0-9]', '', 'g'), '^WO', '')";

/** Labels of the required fields still empty, in form order. */
export function woCreateMissing(
  form: WoCreateForm,
  values: Record<string, unknown>,
  woNumber: string,
): string[] {
  const missing: string[] = [];
  if (woNumber.trim().length === 0) missing.push('WO #');
  for (const f of form.fields) {
    if (f.mode !== 'required') continue;
    if (!woCreateValueFilled(values[f.key])) missing.push(f.label);
  }
  return missing;
}

/** Empty means empty: `false` is an answer, `''` and `[]` are not. */
export function woCreateValueFilled(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** "Received on, Trade and FM" — the sentence the 409 and the button use. */
export function describeMissing(missing: string[]): string {
  if (missing.length === 0) return '';
  if (missing.length === 1) return missing[0];
  return `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
}
