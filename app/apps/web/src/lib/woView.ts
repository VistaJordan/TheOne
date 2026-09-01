// The work-order list's VIEW STATE — the arrangement the table is currently in.
//
// A view is four things: which columns, which filters, what it is grouped by,
// and how it is sorted. They travel together because they are saved together
// (a `SavedView` row) and because changing any one of them re-runs the same
// query. Keeping them in one object is what lets "is this dirty?" be a single
// comparison instead of four.
//
// This module owns the vocabulary the UI renders — operator labels, which
// operators need a value, how a cell is formatted — so the filter builder, the
// column picker and the table never disagree about what a field means.

import type {
  SavedView,
  WoFieldDescriptor,
  WoFieldType,
  WoFilterOp,
  WoFilterRule,
  WoFilterSet,
  WoSort,
} from '../api/client';
import type { StatusGroup, WorkOrderListItem } from '@theone/shared';

export interface ViewState {
  columns: string[];
  filters: WoFilterSet;
  group_by: string | null;
  sort: WoSort | null;
}

export const EMPTY_FILTERS: WoFilterSet = { match: 'all', rules: [] };

/** The arrangement before anybody has chosen one — the S1 table plus the S5
    Clock column (worst open obligation), so an existing user's list looks as
    it did with the watchdog's column in its place. */
export const DEFAULT_VIEW: ViewState = {
  columns: ['wo_number', 'client', 'trade', 'status', 'clock', 'nte', 'home_list', 'age_days'],
  filters: EMPTY_FILTERS,
  group_by: null,
  sort: null,
};

export function viewOf(v: SavedView): ViewState {
  return {
    columns: v.columns.length > 0 ? v.columns : DEFAULT_VIEW.columns,
    filters: v.filters ?? EMPTY_FILTERS,
    group_by: v.group_by,
    sort: v.sort,
  };
}

// ── The status tabs (All / Open / Active / Done / Closed) ────────────────────
// The tabs are not a separate control layered on top of the view: they are a
// shortcut for one filter rule on `status_group` — `eq done` for one group,
// `in [done, closed]` for several. That is what makes "save this view while
// on Done" mean what people expect, and what lets the Filter menu show the
// same constraint the tabs do. The tabs are toggles that ADD to whatever the
// rule already says; they never swap one group for another.

export type StatusTab = 'all' | StatusGroup;

/** Default order — callers with the live status_group_def list pass their own
    (admins can add groups beyond these four). */
const STATUS_GROUPS: readonly StatusGroup[] = ['open', 'active', 'done', 'closed'];

function isStatusGroupRule(r: WoFilterRule): boolean {
  return r.field === 'status_group';
}

/**
 * The set of groups the current rules amount to. Empty means no restriction
 * (the All tab). `null` means the rules say something the tabs cannot show
 * (e.g. "is not closed", or two separate status-group rules) — the constraint
 * is then visible in the Filter menu instead, and no tab lights up.
 */
export function statusGroupsOf(filters: WoFilterSet): ReadonlySet<StatusGroup> | null {
  const rules = filters.rules.filter(isStatusGroupRule);
  if (rules.length === 0) return new Set();
  if (rules.length > 1) return null;
  const [r] = rules;
  const raw = r.op === 'eq' ? [r.value] : r.op === 'in' && Array.isArray(r.value) ? r.value : null;
  if (!raw || !raw.every((v): v is string => typeof v === 'string')) return null;
  return new Set(raw);
}

/** The rules with the status-group constraint set to exactly `groups` (none
    = All). Other rules are untouched; the status rule goes first so the
    Filter menu lists it where the tabs are. `order` is the tab order (the
    live group list); codes it does not know sort after it, so equality is
    stable either way. */
export function withStatusGroups(
  filters: WoFilterSet,
  groups: Iterable<StatusGroup>,
  order: readonly StatusGroup[] = STATUS_GROUPS,
): WoFilterSet {
  const others = filters.rules.filter((r) => !isStatusGroupRule(r));
  const wanted = new Set(groups);
  const list = [
    ...order.filter((g) => wanted.has(g)), // canonical order, so equality is stable
    ...[...wanted].filter((g) => !order.includes(g)).sort(),
  ];
  if (list.length === 0) return { match: filters.match, rules: others };
  const rule: WoFilterRule =
    list.length === 1
      ? { field: 'status_group', op: 'eq' as WoFilterOp, value: list[0] }
      : { field: 'status_group', op: 'in' as WoFilterOp, value: list };
  return { match: filters.match, rules: [rule, ...others] };
}

/** Structural equality, used for the "unsaved changes" dot on a view tab.
    Order matters for `columns` (it is the column order) and for `rules` (the
    user reads them top to bottom), so a stable stringify is the honest test. */
export function sameView(a: ViewState, b: ViewState): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(v: ViewState) {
  return {
    columns: v.columns,
    match: v.filters.match,
    rules: v.filters.rules.map((r) => ({ field: r.field, op: r.op, value: r.value ?? null })),
    group_by: v.group_by ?? null,
    sort: v.sort ? { field: v.sort.field, dir: v.sort.dir } : null,
  };
}

// ── Operators ────────────────────────────────────────────────────────────────

/** How each test reads in a sentence: "Trade  is not set", "NTE  is more than
    500". The labels are phrased to complete the field name to their left. */
export const OP_LABEL: Record<WoFilterOp, string> = {
  is_set: 'is set',
  is_not_set: 'is not set',
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  between: 'is between',
  in: 'is any of',
  not_in: 'is none of',
  is_true: 'is checked',
  is_false: 'is unchecked',
};

/** Date fields read better with time words than with arithmetic ones. */
const DATE_OP_LABEL: Partial<Record<WoFilterOp, string>> = {
  eq: 'is on',
  neq: 'is not on',
  gt: 'is after',
  gte: 'is on or after',
  lt: 'is before',
  lte: 'is on or before',
};

export function opLabel(op: WoFilterOp, type: WoFieldType): string {
  if ((type === 'date' || type === 'datetime') && DATE_OP_LABEL[op]) {
    return DATE_OP_LABEL[op] as string;
  }
  return OP_LABEL[op];
}

/** Operators that take no value at all — the rule is complete as soon as it is
    chosen, so the editor hides its value input. */
export const VALUELESS_OPS: WoFilterOp[] = ['is_set', 'is_not_set', 'is_true', 'is_false'];

/** Operators taking a LIST of values rather than one. */
export const MULTI_OPS: WoFilterOp[] = ['in', 'not_in'];

export function isValueless(op: WoFilterOp): boolean {
  return VALUELESS_OPS.includes(op);
}

export function isMulti(op: WoFilterOp): boolean {
  return MULTI_OPS.includes(op);
}

/** A rule the server would reject — the user has picked a field and an operator
    but not yet typed the value. Such rules are held in the UI and left OUT of
    the request, so the table keeps showing results while a rule is half-written. */
export function isComplete(rule: WoFilterRule): boolean {
  if (isValueless(rule.op)) return true;
  if (rule.op === 'between') {
    const v = Array.isArray(rule.value) ? rule.value : [];
    return v.length === 2 && v.every((x) => String(x ?? '').trim() !== '');
  }
  if (isMulti(rule.op)) {
    return Array.isArray(rule.value) && rule.value.length > 0;
  }
  return rule.value !== undefined && rule.value !== null && String(rule.value).trim() !== '';
}

/** The filter set as the SERVER should see it: half-written rules dropped. */
export function sendableFilters(filters: WoFilterSet): WoFilterSet | undefined {
  const rules = filters.rules.filter(isComplete);
  if (rules.length === 0) return undefined;
  return { match: filters.match, rules };
}

/** The operator a freshly-added rule starts on — the one people mean most often
    for that kind of field. */
export function defaultOp(type: WoFieldType, allowed: WoFilterOp[]): WoFilterOp {
  const preferred: Record<WoFieldType, WoFilterOp> = {
    text: 'contains',
    select: 'eq',
    number: 'eq',
    money: 'gte',
    date: 'gte',
    datetime: 'gte',
    boolean: 'is_true',
  };
  const want = preferred[type];
  return allowed.includes(want) ? want : allowed[0];
}

// ── Cell values ──────────────────────────────────────────────────────────────

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

/** The RAW value behind a column, before formatting — also what grouping and
    the CSV clipboard read. */
export function rawCell(item: WorkOrderListItem, key: string): unknown {
  if (key.startsWith('fields.')) return item.custom?.[key] ?? null;
  switch (key) {
    case 'status':
      return item.status.name;
    case 'status_group':
      return item.status.group;
    default:
      return (item as unknown as Record<string, unknown>)[key] ?? null;
  }
}

/** A cell as text. `status` is rendered as a pill by the table rather than
    through here, so it is only reached by the export and the group headers. */
export function formatCell(value: unknown, field: WoFieldDescriptor | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const type = field?.type;
  if (type === 'money') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? MONEY.format(n) : String(value);
  }
  if (field?.key === 'age_days') return `${value}d`;
  if (type === 'date') {
    const s = String(value).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : String(value);
  }
  if (type === 'datetime') {
    // '2026-07-21T14:30' → '2026-07-21 14:30'; a bare date stays a bare date.
    const s = String(value).replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
    const day = s.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : String(value);
  }
  if (type === 'boolean') {
    if (value === true || value === 'true' || value === 'yes' || value === '1') return 'Yes';
    if (value === false || value === 'false' || value === 'no' || value === '0') return 'No';
  }
  return String(value);
}

/** The label a group header shows for a bucket key. */
export function groupLabel(key: string | null, field: WoFieldDescriptor | undefined): string {
  if (key === null) return `No ${(field?.label ?? 'value').toLowerCase()}`;
  return formatCell(key, field);
}

// ── Filters in the URL ───────────────────────────────────────────────────────
// A link can open the list pre-narrowed: `/?filter=<json WoFilterSet>`. That is
// how the dashboard's Needs Attention cards land on exactly the rows they
// counted. The param is applied as WORKING filters (no saved view, pin
// ignored) and then stripped from the address bar.

/** The list URL that opens on `filters`. */
export function filterUrl(filters: WoFilterSet): string {
  return `/?filter=${encodeURIComponent(JSON.stringify(filters))}`;
}

/** The `filter` param parsed back, or null — anything malformed is ignored
    rather than crashing the list on a hand-edited address. */
export function parseFilterParam(raw: string | null): WoFilterSet | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WoFilterSet;
    if (parsed?.match !== 'all' && parsed?.match !== 'any') return null;
    if (!Array.isArray(parsed.rules)) return null;
    const rules = parsed.rules.filter(
      (r) => r && typeof r.field === 'string' && typeof r.op === 'string',
    );
    if (rules.length === 0) return null;
    return { match: parsed.match, rules };
  } catch {
    return null;
  }
}

// ── The working view, per browser ────────────────────────────────────────────
// Which SAVED view you had open, and any edits you had not saved, are a
// property of the tab you are working in — not of the account. They belong in
// localStorage; the saved view itself lives in the database.

const STORAGE_KEY = 'theone.wo.view.v1';

export interface StoredView {
  viewId: string | null;
  state: ViewState;
}

export function loadStoredView(): StoredView | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredView;
    if (!parsed?.state?.columns?.length) return null;
    return {
      viewId: parsed.viewId ?? null,
      state: {
        columns: parsed.state.columns,
        filters: parsed.state.filters ?? EMPTY_FILTERS,
        group_by: parsed.state.group_by ?? null,
        sort: parsed.state.sort ?? null,
      },
    };
  } catch {
    // A private window, cleared site data, or a shape from an older build.
    return null;
  }
}

export function saveStoredView(v: StoredView): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* storage disabled — the view simply does not survive the reload */
  }
}
