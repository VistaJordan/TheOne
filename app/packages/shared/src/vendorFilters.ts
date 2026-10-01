// 0059 · The Vendors list beyond its dropdowns: advanced filters (rules joined
// by AND or OR), the columns a person may show, and the board.
//
// A filter travels as JSON in the `filter` query parameter, so a saved list,
// the CSV export, "select all that match" and the board all mean the same
// rows. The vocabulary below is the whole of it: the API compiles a rule only
// for a field and an operator listed here (services/vendors.ts), so a rule
// can never name a column that is not there.

import { US_STATE_CODES } from './vendors.js';

export type VendorFilterFieldType = 'text' | 'choice' | 'number' | 'bool' | 'date' | 'list';

export interface VendorFilterField {
  key: string;
  label: string;
  type: VendorFilterFieldType;
  /** For a choice: fixed options. `status`, `brand_source`, `owner` and the
      trades take theirs from /vendors/meta instead (`dynamic`). */
  options?: { value: string; label: string }[];
  dynamic?: 'status' | 'brand_source' | 'owner' | 'trade';
}

const TRI = [
  { value: 'YES', label: 'Yes' },
  { value: 'NO', label: 'No' },
  { value: 'PENDING', label: 'Pending' },
];

export const VENDOR_FILTER_FIELDS: readonly VendorFilterField[] = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'kind', label: 'Kind', type: 'choice', options: [{ value: 'vendor', label: 'VR vendor' }, { value: 'tech', label: 'Technician' }] },
  { key: 'status', label: 'Status', type: 'choice', dynamic: 'status' },
  { key: 'primary_trade', label: 'Primary trade', type: 'choice', dynamic: 'trade' },
  { key: 'secondary_trades', label: 'Secondary trades', type: 'list', dynamic: 'trade' },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'state', label: 'State', type: 'choice', options: US_STATE_CODES.map((s) => ({ value: s, label: s })) },
  { key: 'zip', label: 'ZIP', type: 'text' },
  { key: 'coverage_states', label: 'Other states covered', type: 'list', options: US_STATE_CODES.map((s) => ({ value: s, label: s })) },
  { key: 'nationwide', label: 'Covers nationwide', type: 'bool' },
  { key: 'statewide', label: 'Covers the whole state', type: 'bool' },
  { key: 'owner', label: 'Owner', type: 'choice', dynamic: 'owner' },
  { key: 'brand_source', label: 'Brand source', type: 'choice', dynamic: 'brand_source' },
  { key: 'priority', label: 'Priority', type: 'choice', options: [{ value: 'HIGH', label: 'High' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'LOW', label: 'Low' }] },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'legal_name', label: 'Legal business name', type: 'text' },
  { key: 'primary_contact_name', label: 'Contact name', type: 'text' },
  {
    key: 'compliance_status',
    label: 'Paperwork',
    type: 'choice',
    options: [
      { value: 'MISSING_DOCS', label: 'Missing documents' },
      { value: 'IN_REVIEW', label: 'In review' },
      { value: 'APPROVED', label: 'Approved' },
      { value: 'EXPIRED', label: 'Expired' },
      { value: 'REJECTED', label: 'Rejected' },
    ],
  },
  { key: 'w9_received', label: 'W-9 received', type: 'choice', options: TRI },
  { key: 'msa_signed', label: 'MSA signed', type: 'choice', options: TRI },
  { key: 'coi_received', label: 'COI received', type: 'choice', options: TRI },
  { key: 'coi_approved', label: 'COI approved', type: 'choice', options: TRI },
  { key: 'emergency_same_day', label: 'Emergency same day', type: 'bool' },
  { key: 'after_hours', label: 'After hours', type: 'bool' },
  { key: 'weekends', label: 'Weekends', type: 'bool' },
  { key: 'holiday_emergency', label: 'Holiday emergency', type: 'bool' },
  { key: 'is_subcontractor', label: 'Subcontractor', type: 'bool' },
  { key: 'blacklisted', label: 'Blacklisted', type: 'bool' },
  { key: 'flagged_duplicate', label: 'Possible duplicate', type: 'bool' },
  { key: 'flagged_missing', label: 'Missing information', type: 'bool' },
  { key: 'on_map', label: 'On the map', type: 'bool' },
  { key: 'regular_hourly_rate', label: 'Regular hourly rate', type: 'number' },
  { key: 'after_hours_rate', label: 'After-hours rate', type: 'number' },
  { key: 'weekend_emergency_rate', label: 'Weekend / emergency rate', type: 'number' },
  { key: 'trip_charge', label: 'Trip charge', type: 'number' },
  { key: 'diagnostic_fee', label: 'Diagnostic fee', type: 'number' },
  { key: 'minimum_charge', label: 'Minimum charge', type: 'number' },
  { key: 'work_orders_count', label: 'Jobs', type: 'number' },
  { key: 'created_at', label: 'Added on', type: 'date' },
  { key: 'updated_at', label: 'Last changed on', type: 'date' },
];

export type VendorFilterOp =
  | 'is' | 'is_not' | 'contains' | 'not_contains' | 'starts_with'
  | 'eq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'before' | 'after' | 'on'
  | 'yes' | 'no'
  | 'has' | 'has_not'
  | 'empty' | 'not_empty';

export const VENDOR_FILTER_OP_LABELS: Record<VendorFilterOp, string> = {
  is: 'is',
  is_not: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  eq: '=',
  gt: 'more than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  before: 'before',
  after: 'after',
  on: 'on',
  yes: 'is yes',
  no: 'is no',
  has: 'includes',
  has_not: 'does not include',
  empty: 'is empty',
  not_empty: 'is not empty',
};

/** The operators each kind of field takes, most used first. */
export const VENDOR_FILTER_OPS: Record<VendorFilterFieldType, readonly VendorFilterOp[]> = {
  text: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'empty', 'not_empty'],
  choice: ['is', 'is_not', 'empty', 'not_empty'],
  number: ['eq', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'],
  bool: ['yes', 'no'],
  date: ['after', 'before', 'on', 'empty', 'not_empty'],
  list: ['has', 'has_not', 'empty', 'not_empty'],
};

/** Operators that take no value. */
export const VENDOR_FILTER_VALUELESS: readonly VendorFilterOp[] = ['yes', 'no', 'empty', 'not_empty'];

export interface VendorFilterRule {
  field: string;
  op: VendorFilterOp;
  value?: string;
}

export interface VendorFilter {
  /** and = every rule must hold; or = any one is enough. */
  join: 'and' | 'or';
  rules: VendorFilterRule[];
}

export const VENDOR_FILTER_MAX_RULES = 20;

/** The rules that are complete and name a known field and operator, in order.
 *  Anything else is dropped — a half-typed rule filters nothing. */
export function cleanVendorFilter(input: unknown): VendorFilter | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as { join?: unknown; rules?: unknown };
  if (!Array.isArray(raw.rules)) return null;
  const rules: VendorFilterRule[] = [];
  for (const r of raw.rules as unknown[]) {
    if (rules.length >= VENDOR_FILTER_MAX_RULES) break;
    if (!r || typeof r !== 'object') continue;
    const { field, op, value } = r as { field?: unknown; op?: unknown; value?: unknown };
    const def = VENDOR_FILTER_FIELDS.find((f) => f.key === field);
    if (!def || typeof op !== 'string' || !(VENDOR_FILTER_OPS[def.type] as readonly string[]).includes(op)) continue;
    const o = op as VendorFilterOp;
    if (VENDOR_FILTER_VALUELESS.includes(o)) {
      rules.push({ field: def.key, op: o });
      continue;
    }
    const v = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
    if (v === '' || v.length > 200) continue;
    if (def.type === 'number' && !Number.isFinite(Number(v))) continue;
    if (def.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    rules.push({ field: def.key, op: o, value: v });
  }
  if (rules.length === 0) return null;
  return { join: raw.join === 'or' ? 'or' : 'and', rules };
}

/** The `filter` query parameter ↔ a filter. A string that is not JSON, or
 *  holds no usable rule, is no filter at all. */
export function parseVendorFilter(raw: string | null | undefined): VendorFilter | null {
  if (!raw) return null;
  try {
    return cleanVendorFilter(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializeVendorFilter(f: VendorFilter | null): string | null {
  const clean = cleanVendorFilter(f);
  return clean ? JSON.stringify(clean) : null;
}

// ── Columns ──────────────────────────────────────────────────────────────────

export interface VendorColumnDef {
  key: string;
  label: string;
  /** The `sort` value the list takes, when the column can be sorted. */
  sort?: string;
  /** Shown until the person says otherwise. */
  default?: boolean;
}

/** Every column the list can show, in the order they are drawn. Name is
 *  always first and cannot be hidden, so it is not listed. */
export const VENDOR_COLUMNS: readonly VendorColumnDef[] = [
  { key: 'status', label: 'Status', sort: 'status', default: true },
  { key: 'trade', label: 'Trade', sort: 'trade', default: true },
  { key: 'city', label: 'City', sort: 'city', default: true },
  { key: 'state', label: 'State', sort: 'state', default: true },
  { key: 'zip', label: 'ZIP', sort: 'zip' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'phone', label: 'Phone', default: true },
  { key: 'email', label: 'Email', sort: 'email' },
  { key: 'contact', label: 'Contact', sort: 'contact' },
  { key: 'owner', label: 'Owner', sort: 'owner', default: true },
  { key: 'brand_source', label: 'Brand source', sort: 'brand' },
  { key: 'priority', label: 'Priority', sort: 'priority' },
  { key: 'compliance', label: 'Paperwork', sort: 'compliance', default: true },
  { key: 'w9', label: 'W-9' },
  { key: 'msa', label: 'MSA' },
  { key: 'coi', label: 'COI' },
  { key: 'rate', label: 'Hourly rate', sort: 'rate' },
  { key: 'trip_charge', label: 'Trip charge', sort: 'trip' },
  { key: 'jobs', label: 'Jobs', sort: 'jobs', default: true },
  { key: 'last_contact', label: 'Last contact', sort: 'last_contact' },
  { key: 'added', label: 'Added', sort: 'added', default: true },
  { key: 'updated', label: 'Last changed', sort: 'updated' },
];

export const VENDOR_DEFAULT_COLUMNS: readonly string[] = VENDOR_COLUMNS.filter((c) => c.default).map((c) => c.key);

/** A stored choice → the columns to draw, in catalogue order. An empty or
 *  unreadable choice is the default set. */
export function resolveVendorColumns(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [...VENDOR_DEFAULT_COLUMNS];
  const want = new Set(stored.filter((k): k is string => typeof k === 'string'));
  const out = VENDOR_COLUMNS.filter((c) => want.has(c.key)).map((c) => c.key);
  return out.length > 0 ? out : [...VENDOR_DEFAULT_COLUMNS];
}

/** The per-account pref key (routes/prefs.ts). */
export const VENDOR_COLUMNS_PREF = 'vendors.columns';

// ── The board ────────────────────────────────────────────────────────────────

/** Cards drawn per status column; the column's count is always the true one. */
export const VENDOR_BOARD_COLUMN_LIMIT = 40;

// ── Notifications (0059) ─────────────────────────────────────────────────────

/** One line in the bell. `link` is an in-app path. */
export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  actor: { id: string; name: string; kind: 'human' | 'service' } | null;
  read: boolean;
  created_at: string;
}

export interface AppNotificationsResponse {
  items: AppNotification[];
  unread: number;
}

// ── The board (0059) ─────────────────────────────────────────────────────────

export interface VendorBoardColumn {
  status: string;
  /** Every record in this status that the filters match. */
  total: number;
  /** The most recently changed of them, up to VENDOR_BOARD_COLUMN_LIMIT. */
  items: import("./vendors.js").VendorRow[];
}

export interface VendorBoardResponse {
  columns: VendorBoardColumn[];
}
