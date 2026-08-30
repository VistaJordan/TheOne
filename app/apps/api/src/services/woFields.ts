// The work-order FIELD CATALOGUE and the filter/sort SQL it compiles to.
//
// Until now the list endpoint knew three filters by name (status_group,
// status_id, search) and every column was hardcoded in the SELECT. Letting a
// user filter on "any field" and choose their own columns means the set of
// addressable fields is no longer something the code can enumerate at compile
// time: the custom ones live in `field_def` and an administrator can add more.
//
// So this module is the single place that answers "what is a field?" for the
// list. Every other module — the list query, the export, the saved views, the
// web's filter builder — asks HERE rather than inventing its own vocabulary.
//
// SAFETY. A field's SQL expression comes from this file's own tables and is
// never built from request text. A CUSTOM field is addressed as
// `t.fields->>$n` with the key BOUND AS A PARAMETER, so a field key containing
// a quote is data, not syntax. Filter values are always parameters.

import { query } from '../db.js';
import { ApiError } from '../errors.js';

export type FieldType = 'text' | 'number' | 'money' | 'date' | 'select' | 'boolean';

export interface FieldOption {
  value: string;
  label: string;
  color?: string;
}

export interface FieldDescriptor {
  key: string;
  label: string;
  type: FieldType;
  /** Grouping in the field picker: 'Work order', 'Status', 'Custom field', … */
  group: string;
  /** Present for `select` fields whose vocabulary is known up front. */
  options?: FieldOption[];
  /** Custom fields live in the JSONB bag, addressed by key at query time. */
  custom?: boolean;
  sortable: boolean;
  /** Right-align in the table, and format as a number. */
  numeric?: boolean;
  /** The raw field_def type for custom fields ('long_text', 'phone', 'formula',
      'attachment', …). The 6-value `type` says how to COMPARE a value; the
      subtype says how to EDIT one — textarea vs input, or not at all. */
  subtype?: string;
}

// ── Core (promoted column) fields ────────────────────────────────────────────
// `sql` is a raw fragment referencing the aliases in WO_FROM (t / s / hl).
// It is a compile-time constant in every case — see the SAFETY note above.

interface CoreField extends FieldDescriptor {
  sql: string;
  /** Distinct values of this column are offered as filter choices. */
  distinct?: boolean;
}

const PRIORITY_OPTIONS: FieldOption[] = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
];

const GROUP_OPTIONS: FieldOption[] = [
  { value: 'open', label: 'Open' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
  { value: 'closed', label: 'Closed' },
];

const CORE_FIELDS: CoreField[] = [
  { key: 'wo_number',      label: 'WO #',           type: 'text',   group: 'Work order', sql: 't.wo_number',      sortable: true },
  { key: 'ext_name',       label: 'Client WO #',    type: 'text',   group: 'Work order', sql: 't.ext_name',       sortable: true },
  { key: 'title',          label: 'Title',          type: 'text',   group: 'Work order', sql: 't.title',          sortable: true },
  { key: 'description',    label: 'Description',    type: 'text',   group: 'Work order', sql: 't.description',    sortable: false },
  { key: 'client',         label: 'Client',         type: 'select', group: 'Work order', sql: 't.client',         sortable: true, distinct: true },
  { key: 'city',           label: 'City',           type: 'select', group: 'Site',       sql: 't.city',           sortable: true, distinct: true },
  { key: 'state',          label: 'State',          type: 'select', group: 'Site',       sql: 't.state',          sortable: true, distinct: true },
  { key: 'trade',          label: 'Trade',          type: 'select', group: 'Work order', sql: 't.trade',          sortable: true, distinct: true },
  { key: 'billing_entity', label: 'Billing entity', type: 'select', group: 'Money',      sql: 't.billing_entity', sortable: true, distinct: true },
  { key: 'nte',            label: 'NTE',            type: 'money',  group: 'Money',      sql: 't.nte',            sortable: true, numeric: true },
  { key: 'priority',       label: 'Priority',       type: 'select', group: 'Work order', sql: 't.priority',       sortable: true, options: PRIORITY_OPTIONS },
  { key: 'date_received',  label: 'Date received',  type: 'date',   group: 'Dates',      sql: 't.date_received',  sortable: true },
  { key: 'age_days',       label: 'Age (days)',     type: 'number', group: 'Dates',      sql: '(now()::date - t.date_received)', sortable: true, numeric: true },
  { key: 'home_list',      label: 'Home list',      type: 'select', group: 'Routing',    sql: 'hl.name',          sortable: true, distinct: true },
  { key: 'status',         label: 'Status',         type: 'select', group: 'Status',     sql: 's.name',           sortable: true },
  { key: 'status_group',   label: 'Status group',   type: 'select', group: 'Status',     sql: 't.status_group::text', sortable: true, options: GROUP_OPTIONS },
  { key: 'created_at',     label: 'Created',        type: 'date',   group: 'Dates',      sql: 't.created_at',     sortable: true },
  { key: 'updated_at',     label: 'Last updated',   type: 'date',   group: 'Dates',      sql: 't.updated_at',     sortable: true },
];

const CORE_BY_KEY = new Map(CORE_FIELDS.map((f) => [f.key, f]));

/** The columns the table shows before anybody has chosen anything. */
export const DEFAULT_COLUMNS = [
  'wo_number',
  'client',
  'trade',
  'status',
  'nte',
  'home_list',
  'age_days',
];

// ── Custom fields ────────────────────────────────────────────────────────────
// `field_def.type` is the 13-value ClickUp-derived enum; the list only needs to
// know how to COMPARE a value, so the 13 collapse to five behaviours.

const CUSTOM_TYPE_MAP: Record<string, FieldType> = {
  checkbox: 'boolean',
  short_text: 'text',
  long_text: 'text',
  dropdown: 'select',
  date: 'date',
  // A person field (Assignee, AM, …) is a picker like a dropdown: its choices
  // are the people in the system, not free text (see `customDistinctOptions`).
  users: 'select',
  formula: 'text',
  currency: 'money',
  attachment: 'text',
  location: 'text',
  rating: 'number',
  url: 'text',
  number: 'number',
  phone: 'text',
};

interface FieldDefRow {
  key: string;
  label: string;
  type: string;
  type_config: { options?: unknown } | null;
}

let customCache: { at: number; fields: FieldDescriptor[] } | null = null;
const CUSTOM_TTL_MS = 30_000;

/** Called by the admin field-def writes: without this, a rename or a new field
    would take up to 30 s to reach the catalogue. */
export function invalidateFieldCache(): void {
  customCache = null;
}

/** Select-typed custom fields with NO declared vocabulary (the `users` ones):
    their choices are read from the data instead. Rebuilt with the cache. */
let distinctCustomKeys: string[] = [];

/** Custom fields, keyed as they appear inside `task.fields`. Cached briefly:
    the catalogue is read on every list render and changes only when an
    administrator adds a field. */
export async function listCustomFields(): Promise<FieldDescriptor[]> {
  const now = Date.now();
  if (customCache && now - customCache.at < CUSTOM_TTL_MS) return customCache.fields;

  const res = await query<FieldDefRow>(
    `SELECT key, label, type::text AS type, type_config
       FROM field_def
      ORDER BY position NULLS LAST, key ASC`,
  );

  // A key can be defined on more than one container; the list is workspace-wide
  // so the first definition of a key wins and the duplicate is dropped.
  const seen = new Set<string>();
  const fields: FieldDescriptor[] = [];
  distinctCustomKeys = [];
  for (const r of res.rows) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    const type = CUSTOM_TYPE_MAP[r.type] ?? 'text';
    const raw = r.type_config?.options;
    const options = Array.isArray(raw)
      ? raw.map(optionOf).filter((o): o is FieldOption => o !== null)
      : undefined;
    fields.push({
      key: `fields.${r.key}`,
      label: r.label || r.key,
      type,
      group: 'Custom field',
      options: type === 'select' ? options : undefined,
      custom: true,
      sortable: true,
      numeric: type === 'number' || type === 'money',
      subtype: r.type,
    });
    if (type === 'select' && !options) distinctCustomKeys.push(r.key);
  }

  customCache = { at: now, fields };
  return fields;
}

/** Dropdown options arrive as `"Yes"` or `{name|label|value, color}` depending
    on which ClickUp export produced them. */
function optionOf(o: unknown): FieldOption | null {
  if (typeof o === 'string') return { value: o, label: o };
  if (o && typeof o === 'object') {
    const rec = o as Record<string, unknown>;
    const v = rec.name ?? rec.label ?? rec.value;
    if (typeof v === 'string' && v.length > 0) {
      const color = typeof rec.color === 'string' ? rec.color : undefined;
      return { value: v, label: v, color };
    }
  }
  return null;
}

/** Distinct values actually present for the `distinct: true` core columns —
    what makes "Client is ___" a picker instead of a free-text guess. */
async function distinctOptions(): Promise<Record<string, FieldOption[]>> {
  const out: Record<string, FieldOption[]> = {};
  for (const f of CORE_FIELDS) {
    if (!f.distinct) continue;
    const res = await query<{ v: string }>(
      `SELECT DISTINCT ${f.sql} AS v
         FROM task t
         LEFT JOIN container hl ON hl.id = t.home_list_id
        WHERE t.deleted_at IS NULL AND ${f.sql} IS NOT NULL AND ${f.sql} <> ''
        ORDER BY v ASC
        LIMIT 300`,
    );
    out[f.key] = res.rows.map((r) => ({ value: r.v, label: r.v }));
  }
  return out;
}

/**
 * The choices for a person field: EVERY user in the system — the assignee
 * (the dispatcher / operations manager handling the work order) can be anyone
 * on the team, whether or not they hold a work order today — plus any name
 * already written on a work order that is not a user (an ex-colleague, an
 * import), so no existing value is unreachable. Users are matched by display
 * name because that is what the JSONB bag stores.
 */
async function customDistinctOptions(): Promise<Record<string, FieldOption[]>> {
  const out: Record<string, FieldOption[]> = {};
  if (distinctCustomKeys.length === 0) return out;
  const users = await query<{ v: string }>(
    `SELECT display_name AS v
       FROM principal
      WHERE kind = 'human' AND status <> 'disabled'
      ORDER BY display_name ASC`,
  );
  for (const key of distinctCustomKeys) {
    const onTasks = await query<{ v: string }>(
      `SELECT DISTINCT (t.fields->>$1) AS v
         FROM task t
        WHERE t.deleted_at IS NULL AND (t.fields->>$1) IS NOT NULL AND (t.fields->>$1) <> ''
        ORDER BY v ASC
        LIMIT 300`,
      [key],
    );
    const names = new Set(users.rows.map((r) => r.v));
    for (const r of onTasks.rows) names.add(r.v);
    out[`fields.${key}`] = [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((v) => ({ value: v, label: v }));
  }
  return out;
}

export interface FieldCatalogue {
  fields: FieldDescriptor[];
  default_columns: string[];
}

/** Everything the filter builder and column picker need, in one round trip. */
export async function getFieldCatalogue(): Promise<FieldCatalogue> {
  const [custom, distinct, statuses] = await Promise.all([
    listCustomFields(),
    distinctOptions(),
    query<{ name: string; color: string }>(`SELECT name, color FROM status ORDER BY position ASC`),
  ]);
  // After `listCustomFields`, which is what decides the keys to read.
  const customDistinct = await customDistinctOptions();

  const core: FieldDescriptor[] = CORE_FIELDS.map((f) => {
    const { sql: _sql, distinct: _distinct, ...rest } = f;
    const options =
      f.key === 'status'
        ? statuses.rows.map((s) => ({ value: s.name, label: s.name, color: s.color }))
        : (distinct[f.key] ?? f.options);
    return { ...rest, options };
  });

  const customWithOptions = custom.map((f) =>
    customDistinct[f.key] ? { ...f, options: customDistinct[f.key] } : f,
  );

  return { fields: [...core, ...customWithOptions], default_columns: [...DEFAULT_COLUMNS] };
}

// ── Resolution ───────────────────────────────────────────────────────────────

export interface ResolvedField {
  key: string;
  label: string;
  type: FieldType;
  custom: boolean;
  /** The JSONB key, for custom fields. */
  jsonKey?: string;
  /** Raw SQL for core fields (a constant from this module). */
  sql?: string;
}

/** Turn a field key from a request into something safe to put in SQL, or throw.
    Unknown keys are rejected rather than ignored: silently dropping a filter
    would show the user MORE rows than they asked for, which is the dangerous
    direction to fail in. */
export async function resolveField(key: string): Promise<ResolvedField> {
  const core = CORE_BY_KEY.get(key);
  if (core) {
    return { key, label: core.label, type: core.type, custom: false, sql: core.sql };
  }
  if (key.startsWith('fields.')) {
    const jsonKey = key.slice('fields.'.length);
    const custom = (await listCustomFields()).find((f) => f.key === key);
    if (custom) {
      return { key, label: custom.label, type: custom.type, custom: true, jsonKey };
    }
  }
  throw new ApiError('BAD_REQUEST', `Unknown field "${key}"`, { field: key });
}

// ── Filters ──────────────────────────────────────────────────────────────────

export const FILTER_OPS = [
  'is_set',
  'is_not_set',
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'in',
  'not_in',
  'is_true',
  'is_false',
] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

/** Which operators a field of each type accepts. The web renders exactly this
    list, and the server re-checks it — a saved view can outlive a field whose
    type an administrator later changed. */
export const OPS_BY_TYPE: Record<FieldType, FilterOp[]> = {
  text: ['contains', 'not_contains', 'eq', 'neq', 'starts_with', 'ends_with', 'in', 'not_in', 'is_set', 'is_not_set'],
  select: ['eq', 'neq', 'in', 'not_in', 'contains', 'is_set', 'is_not_set'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_set', 'is_not_set'],
  money: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_set', 'is_not_set'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_set', 'is_not_set'],
  boolean: ['is_true', 'is_false', 'is_set', 'is_not_set'],
};

export interface FilterRule {
  field: string;
  op: FilterOp;
  value?: unknown;
}

export interface FilterSet {
  match: 'all' | 'any';
  rules: FilterRule[];
}

export const EMPTY_FILTERS: FilterSet = { match: 'all', rules: [] };

/** Accumulates `$n` placeholders so every caller shares one parameter array. */
export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/**
 * The SQL expression for a field, TYPED for comparison.
 *
 * A custom field is text in the JSONB bag no matter what its declared type is,
 * so a numeric or date comparison has to cast — and casting whatever a ClickUp
 * export happened to put in that key will throw on the first malformed row.
 * Hence the guarded CASE: a value that does not look like a number/date
 * compares as NULL (i.e. "not set") instead of failing the whole query.
 */
function exprFor(f: ResolvedField, p: Params, forceText = false): string {
  if (!f.custom) return f.sql as string;
  const k = p.add(f.jsonKey);
  const raw = `(t.fields->>${k})`;
  if (forceText) return raw;
  switch (f.type) {
    case 'number':
    case 'money':
      return `CASE WHEN ${raw} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${raw}::numeric END`;
    case 'date':
      return `CASE WHEN ${raw} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN substring(${raw} from 1 for 10)::date END`;
    case 'boolean':
      return `CASE WHEN lower(${raw}) IN ('true','yes','1') THEN true
                   WHEN lower(${raw}) IN ('false','no','0') THEN false END`;
    default:
      return raw;
  }
}

/** A value coerced to the shape its field's SQL expression compares against. */
function coerce(f: ResolvedField, v: unknown): unknown {
  if (f.type === 'number' || f.type === 'money') {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new ApiError('BAD_REQUEST', `"${f.label}" needs a number`);
      return v;
    }
    // `Number("")` is 0, so stripping "abc" down to "" and trusting isFinite
    // would turn a typo into the filter `>= 0` — which quietly matches
    // everything instead of saying the value was not a number.
    const digits = String(v).replace(/[^0-9.-]/g, '');
    if (!/^-?\d*\.?\d+$/.test(digits)) {
      throw new ApiError('BAD_REQUEST', `"${f.label}" needs a number`);
    }
    return Number(digits);
  }
  if (f.type === 'date') {
    const s = String(v).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      throw new ApiError('BAD_REQUEST', `"${f.label}" needs a date (YYYY-MM-DD)`);
    }
    return s;
  }
  return String(v);
}

/** `date_received` is a DATE but `created_at` is a TIMESTAMPTZ; comparing the
    latter against 'YYYY-MM-DD' would silently mean "at midnight", so timestamp
    columns are truncated to their date for every date comparison. */
function dateExpr(f: ResolvedField, p: Params): string {
  const base = exprFor(f, p);
  if (!f.custom && (f.key === 'created_at' || f.key === 'updated_at')) return `(${base})::date`;
  return base;
}

function toList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return v == null ? [] : [v];
}

/** `%`, `_` and `\` are wildcards in ILIKE; a user typing them means them literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** Compile one rule into a boolean SQL fragment. */
function compileRule(f: ResolvedField, rule: FilterRule, p: Params): string {
  const allowed = OPS_BY_TYPE[f.type];
  if (!allowed.includes(rule.op)) {
    throw new ApiError('BAD_REQUEST', `"${f.label}" does not support the "${rule.op}" test`, {
      field: rule.field,
      op: rule.op,
      allowed,
    });
  }

  // Presence tests never look at `value`. For text-ish fields an empty string
  // counts as absent — an operator who filters "Trade is not set" means the
  // blank cells, and does not care whether the export wrote NULL or ''.
  if (rule.op === 'is_set' || rule.op === 'is_not_set') {
    const e = exprFor(f, p, f.custom);
    const blank =
      f.type === 'text' || f.type === 'select' ? `${e} IS NULL OR ${e} = ''` : `${e} IS NULL`;
    return rule.op === 'is_set' ? `NOT (${blank})` : `(${blank})`;
  }

  if (rule.op === 'is_true' || rule.op === 'is_false') {
    const e = exprFor(f, p);
    // A checkbox nobody has touched is unchecked: "is false" must match the
    // rows where the key was never written, or filtering "Not Fully Paid is
    // unchecked" would hide most of the list. IS NOT TRUE covers NULL.
    return rule.op === 'is_true' ? `${e} IS TRUE` : `${e} IS NOT TRUE`;
  }

  if (rule.op === 'between') {
    const pair = toList(rule.value);
    if (pair.length !== 2) {
      throw new ApiError('BAD_REQUEST', `"${f.label}" between needs two values`, {
        field: rule.field,
      });
    }
    const e = f.type === 'date' ? dateExpr(f, p) : exprFor(f, p);
    return `${e} BETWEEN ${p.add(coerce(f, pair[0]))} AND ${p.add(coerce(f, pair[1]))}`;
  }

  if (rule.op === 'in' || rule.op === 'not_in') {
    const vals = toList(rule.value).map((v) => coerce(f, v));
    // An empty set is a rule the user has not finished writing. `IN ()` is a
    // syntax error, so it matches nothing for `in` and everything for
    // `not_in` — the intuitive reading of an unfinished rule.
    if (vals.length === 0) return rule.op === 'in' ? 'FALSE' : 'TRUE';
    const e = exprFor(f, p, f.custom);
    const holes = vals.map((v) => p.add(v)).join(', ');
    return rule.op === 'in' ? `${e} IN (${holes})` : `(${e} IS NULL OR ${e} NOT IN (${holes}))`;
  }

  if (rule.value === undefined || rule.value === null || rule.value === '') {
    throw new ApiError('BAD_REQUEST', `"${f.label}" ${rule.op} needs a value`, {
      field: rule.field,
    });
  }

  // Substring tests are always textual, even on a number or date field —
  // "NTE contains 500" is a legitimate thing to type.
  if (
    rule.op === 'contains' ||
    rule.op === 'not_contains' ||
    rule.op === 'starts_with' ||
    rule.op === 'ends_with'
  ) {
    const e = `(${exprFor(f, p, true)})::text`;
    const s = escapeLike(String(rule.value));
    const pattern =
      rule.op === 'starts_with' ? `${s}%` : rule.op === 'ends_with' ? `%${s}` : `%${s}%`;
    const hole = p.add(pattern);
    return rule.op === 'not_contains'
      ? `(${e} IS NULL OR ${e} NOT ILIKE ${hole})`
      : `${e} ILIKE ${hole}`;
  }

  const e = f.type === 'date' ? dateExpr(f, p) : exprFor(f, p);
  const hole = p.add(coerce(f, rule.value));
  switch (rule.op) {
    case 'eq':
      return `${e} = ${hole}`;
    // `<>` drops NULL rows, which reads as "the filter hid rows that plainly
    // are not equal to the value". Not-equal therefore includes the blanks.
    case 'neq':
      return `(${e} IS NULL OR ${e} <> ${hole})`;
    case 'gt':
      return `${e} > ${hole}`;
    case 'gte':
      return `${e} >= ${hole}`;
    case 'lt':
      return `${e} < ${hole}`;
    case 'lte':
      return `${e} <= ${hole}`;
    default:
      throw new ApiError('BAD_REQUEST', `Unsupported operator "${rule.op}"`);
  }
}

/** Compile a whole filter set. Returns null when nothing constrains the query. */
export async function compileFilters(set: FilterSet, p: Params): Promise<string | null> {
  const rules = set.rules ?? [];
  if (rules.length === 0) return null;
  const parts: string[] = [];
  for (const rule of rules) {
    const f = await resolveField(rule.field);
    parts.push(`(${compileRule(f, rule, p)})`);
  }
  return `(${parts.join(set.match === 'any' ? ' OR ' : ' AND ')})`;
}

// ── Sorting & grouping ───────────────────────────────────────────────────────

export interface SortSpec {
  field: string;
  dir: 'asc' | 'desc';
}

export async function compileSort(sort: SortSpec | null, p: Params): Promise<string> {
  if (!sort) return 't.created_at DESC, t.wo_number ASC';
  const f = await resolveField(sort.field);
  const dir = sort.dir === 'asc' ? 'ASC' : 'DESC';
  // NULLS LAST in both directions: an empty cell is never the most interesting
  // row, so it belongs at the bottom whichever way the column is sorted.
  return `${exprFor(f, p)} ${dir} NULLS LAST, t.wo_number ASC`;
}

/** The expression a `group_by` buckets on — always text, since the group key
    travels to the browser as a string. */
export async function compileGroupExpr(key: string, p: Params): Promise<string> {
  const f = await resolveField(key);
  return `(${exprFor(f, p, true)})::text`;
}

/** The SELECT fragment for one requested column, when it is a custom field.
    Core columns are already in the base projection. */
export function customSelect(f: ResolvedField, alias: string, p: Params): string {
  return `(t.fields->>${p.add(f.jsonKey)}) AS ${alias}`;
}
