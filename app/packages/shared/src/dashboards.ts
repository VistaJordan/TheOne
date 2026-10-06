/**
 * Dashboards (0042) — folders of dashboards, each stating which roles may
 * open it, each holding widgets over the work-order set.
 *
 * Two rules worth keeping straight:
 *
 *   sharing ≠ scope.  `shared_roles` / `shared_all` decide who may OPEN a
 *   dashboard. What it counts is still scoped per viewer (0026/0032), so two
 *   dispatchers open the same "Dispatch Center" and each sees their own book.
 *   Sharing a dashboard can never leak a work order.
 *
 *   a widget is a question, not a picture.  `kind` only says how to draw the
 *   answer; `config` says what to ask. The same config drawn as a bar or a
 *   donut is the same numbers, so changing the drawing never changes the
 *   meaning — and every widget can drill through to the list that produced it.
 */

import type { WoFilterSet } from './index';

// ── Widgets ──────────────────────────────────────────────────────────────────

export const WIDGET_KINDS = [
  'number',
  'bar',
  'donut',
  'table',
  'line',
  'gauge',
  'live',
  'narrative',
  'image',
  'link',
] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const WIDGET_KIND_LABELS: Record<WidgetKind, string> = {
  number: 'A single number',
  bar: 'Bars',
  donut: 'A donut',
  table: 'A table',
  line: 'A line over time',
  gauge: 'A gauge against a target',
  live: 'A live number (re-reads itself)',
  narrative: 'A block of text',
  image: 'A picture',
  link: 'A button to a page',
};

/** 0049 · the kinds that ASK something of the records. The other three are
    furniture — text, a picture, a button — and never run a query. */
export const QUERY_WIDGET_KINDS: readonly WidgetKind[] = ['number', 'bar', 'donut', 'table', 'line', 'gauge', 'live'];
export function widgetAsksQuestion(kind: WidgetKind): boolean {
  return QUERY_WIDGET_KINDS.includes(kind);
}
/** The kinds whose answer is one figure rather than buckets. */
export function widgetIsFigure(kind: WidgetKind): boolean {
  return kind === 'number' || kind === 'gauge' || kind === 'live';
}

/** How often a live card re-reads, when the card does not say. */
export const LIVE_DEFAULT_SECONDS = 30;
export const LIVE_MIN_SECONDS = 5;

// ── Sources (0049) ───────────────────────────────────────────────────────────
//
// A card used to ask its question of the work-order set only. Invoices
// (0045), payment requests and vendor bills (0047) are records now, so a card
// may ask them instead. Each source lists the fields a card can total, cut
// by, or run along; anything else is refused on the way in so a card cannot
// name a column that is not there.

export const WIDGET_SOURCES = ['work_orders', 'invoices', 'payments', 'vendor_bills', 'vendors', 'sites', 'assets'] as const;
export type WidgetSource = (typeof WIDGET_SOURCES)[number];

export const WIDGET_SOURCE_LABELS: Record<WidgetSource, string> = {
  work_orders: 'Work orders',
  invoices: 'Client invoices',
  payments: 'Payment requests',
  vendor_bills: 'Vendor bills',
  vendors: 'Vendors and technicians',
  sites: 'Sites',
  assets: 'Assets',
};

/** What a count of this source is called. */
export const WIDGET_SOURCE_NOUNS: Record<WidgetSource, string> = {
  work_orders: 'Work orders',
  invoices: 'Invoices',
  payments: 'Payment requests',
  vendor_bills: 'Vendor bills',
  vendors: 'Vendors',
  sites: 'Sites',
  assets: 'Assets',
};

export interface SourceField {
  key: string;
  label: string;
  type: 'number' | 'text' | 'date';
}

/** The vocabulary of each non-work-order source. Work orders use the field
    catalogue (any core column or custom field), so they are not listed. */
export const SOURCE_FIELDS: Record<Exclude<WidgetSource, 'work_orders'>, SourceField[]> = {
  invoices: [
    { key: 'total', label: 'Total', type: 'number' },
    { key: 'subtotal', label: 'Subtotal', type: 'number' },
    { key: 'tax', label: 'Tax', type: 'number' },
    { key: 'status', label: 'Status', type: 'text' },
    { key: 'client', label: 'Client', type: 'text' },
    { key: 'billing_entity', label: 'Billing entity', type: 'text' },
    { key: 'created_at', label: 'Raised on', type: 'date' },
    { key: 'issued_at', label: 'Sent on', type: 'date' },
    { key: 'due_at', label: 'Due on', type: 'date' },
    { key: 'paid_at', label: 'Paid on', type: 'date' },
  ],
  payments: [
    { key: 'amount', label: 'Amount', type: 'number' },
    { key: 'status', label: 'Status', type: 'text' },
    { key: 'method', label: 'Method', type: 'text' },
    { key: 'payee', label: 'Payee', type: 'text' },
    { key: 'client', label: 'Client', type: 'text' },
    // 0057 · everything a payment can be cut by: who asked, for which
    // company, trade, state and FM, for what, and the vendor behind the payee.
    { key: 'requested_by', label: 'Dispatcher (requested by)', type: 'text' },
    { key: 'billing_entity', label: 'Company (billing entity)', type: 'text' },
    { key: 'fm', label: 'FM', type: 'text' },
    { key: 'trade', label: 'Trade', type: 'text' },
    { key: 'state', label: 'State', type: 'text' },
    { key: 'purpose', label: 'Purpose', type: 'text' },
    { key: 'wo_number', label: 'Work order', type: 'text' },
    { key: 'vendor_owner', label: 'Vendor owner', type: 'text' },
    { key: 'vendor_trade', label: 'Vendor trade', type: 'text' },
    { key: 'vendor_state', label: 'Vendor state', type: 'text' },
    { key: 'created_at', label: 'Requested on', type: 'date' },
    { key: 'approved_at', label: 'Approved on', type: 'date' },
    { key: 'paid_at', label: 'Paid on', type: 'date' },
  ],
  vendor_bills: [
    { key: 'total', label: 'Total', type: 'number' },
    { key: 'status', label: 'Status', type: 'text' },
    { key: 'vendor_name', label: 'Vendor', type: 'text' },
    { key: 'client', label: 'Client', type: 'text' },
    { key: 'received_on', label: 'Received on', type: 'date' },
    { key: 'due_on', label: 'Due on', type: 'date' },
    { key: 'paid_at', label: 'Paid on', type: 'date' },
  ],
  // 0059 · the Vendors section's own records (0057): what the VR team has
  // recruited and the technicians dispatchers work with. Not joined to a
  // work order — a card over it follows the viewer's VENDOR scope instead.
  vendors: [
    { key: 'status', label: 'Status', type: 'text' },
    { key: 'kind', label: 'Kind (VR vendor / technician)', type: 'text' },
    { key: 'primary_trade', label: 'Primary trade', type: 'text' },
    { key: 'state', label: 'State', type: 'text' },
    { key: 'city', label: 'City', type: 'text' },
    { key: 'owner', label: 'Owner', type: 'text' },
    { key: 'added_by', label: 'Added by', type: 'text' },
    { key: 'brand_source', label: 'Brand source', type: 'text' },
    { key: 'priority', label: 'Priority', type: 'text' },
    { key: 'paperwork', label: 'Paperwork', type: 'text' },
    { key: 'coverage', label: 'Coverage (nationwide / statewide / local)', type: 'text' },
    { key: 'w9_received', label: 'W-9 received', type: 'text' },
    { key: 'msa_signed', label: 'MSA signed', type: 'text' },
    { key: 'coi_received', label: 'COI received', type: 'text' },
    { key: 'coi_approved', label: 'COI approved', type: 'text' },
    { key: 'blacklisted', label: 'Blacklisted', type: 'text' },
    { key: 'on_file_flags', label: 'Flag (duplicate / missing information)', type: 'text' },
    { key: 'work_orders_count', label: 'Jobs', type: 'number' },
    { key: 'regular_hourly_rate', label: 'Regular hourly rate', type: 'number' },
    { key: 'after_hours_rate', label: 'After-hours rate', type: 'number' },
    { key: 'trip_charge', label: 'Trip charge', type: 'number' },
    { key: 'diagnostic_fee', label: 'Diagnostic fee', type: 'number' },
    { key: 'created_at', label: 'Added on', type: 'date' },
    { key: 'updated_at', label: 'Last changed on', type: 'date' },
  ],
  // 0062 · the portfolio (0060). Neither hangs on one work order; a card
  // over them follows the viewer's site list, when they have one.
  sites: [
    { key: 'client', label: 'Client', type: 'text' },
    { key: 'state', label: 'State', type: 'text' },
    { key: 'city', label: 'City', type: 'text' },
    { key: 'site_type', label: 'Site type', type: 'text' },
    { key: 'ownership', label: 'Ownership', type: 'text' },
    { key: 'managed_by', label: 'Managed by', type: 'text' },
    { key: 'billing_entity', label: 'Billing entity', type: 'text' },
    { key: 'source', label: 'Where the record came from', type: 'text' },
    { key: 'active', label: 'Active or closed', type: 'text' },
    { key: 'on_map', label: 'On the map', type: 'text' },
    { key: 'asset_count', label: 'Assets', type: 'number' },
    { key: 'open_work_orders', label: 'Open work orders', type: 'number' },
    { key: 'work_orders', label: 'Work orders', type: 'number' },
    { key: 'created_at', label: 'Added on', type: 'date' },
  ],
  assets: [
    { key: 'status', label: 'Status', type: 'text' },
    { key: 'category', label: 'Category', type: 'text' },
    { key: 'asset_type', label: 'Type', type: 'text' },
    { key: 'manufacturer', label: 'Manufacturer', type: 'text' },
    { key: 'condition', label: 'Condition', type: 'text' },
    { key: 'warranty', label: 'Warranty', type: 'text' },
    { key: 'client', label: 'Client', type: 'text' },
    { key: 'site', label: 'Site', type: 'text' },
    { key: 'state', label: 'State', type: 'text' },
    { key: 'source', label: 'Where the record came from', type: 'text' },
    { key: 'age_years', label: 'Age (years)', type: 'number' },
    { key: 'open_work_orders', label: 'Open work orders', type: 'number' },
    { key: 'work_orders', label: 'Work orders', type: 'number' },
    { key: 'install_date', label: 'Installed on', type: 'date' },
    { key: 'warranty_expires_on', label: 'Warranty ends on', type: 'date' },
    { key: 'created_at', label: 'Added on', type: 'date' },
  ],
};

/** The statuses each source may be narrowed to. */
export const SOURCE_STATUSES: Record<Exclude<WidgetSource, 'work_orders'>, string[]> = {
  invoices: ['draft', 'sent', 'paid', 'void'],
  payments: ['requested', 'approved', 'sent_to_yoda', 'paid', 'rejected'],
  vendor_bills: ['received', 'approved', 'paid', 'disputed', 'void'],
  // The six statuses 0057 ships. One added in Admin › Vendors & map still
  // shows as a slice of any "by status" card; it just cannot be ticked here.
  vendors: ['NEW', 'INTERESTED', 'READY', 'ACTIVE', 'DISQUALIFIED', 'INACTIVE'],
  // A site has no status of its own (active / closed is a field to cut by).
  sites: [],
  assets: ['in_service', 'out_of_service', 'retired'],
};

/** Where a card over this source drills through to. */
export const SOURCE_DRILL_PATH: Record<WidgetSource, string> = {
  work_orders: '/',
  invoices: '/receivables/invoicing',
  payments: '/payments',
  vendor_bills: '/payments?lane=bills',
  vendors: '/vendors',
  sites: '/sites',
  assets: '/assets',
};

// ── Page filters (0049) ──────────────────────────────────────────────────────
//
// Facilio's boards carry a filter bar (vendor, site) that narrows every card
// at once. Ours narrows on the fields a dispatcher actually reaches for; the
// values come from the field catalogue's option lists, or are typed. They
// AND into every card on the board, like the period does.

export interface PageFilterField {
  key: string;
  label: string;
}

export const PAGE_FILTER_FIELDS: readonly PageFilterField[] = [
  { key: 'client', label: 'Client' },
  { key: 'billing_entity', label: 'Billing entity' },
  { key: 'trade', label: 'Trade' },
  { key: 'fields.Store', label: 'Store' },
  { key: 'fields.Assignee', label: 'Dispatcher' },
];

export interface PageFilter {
  field: string;
  value: string;
}

/** The board's filter bar as filter rules, ANDed into every card. */
export function pageFiltersToSet(filters: PageFilter[]): WoFilterSet | null {
  const rules = filters
    .filter((f) => f.field && f.value.trim() !== '')
    .map((f) => ({ field: f.field, op: 'eq' as const, value: f.value.trim() }));
  return rules.length === 0 ? null : { match: 'all', rules };
}

/** How a line buckets time. A line is the only card that does not group by a
    category — it groups by WHEN, and draws in date order rather than by size,
    because a trend read biggest-first is not a trend. */
export const TIME_BUCKETS = ['day', 'week', 'month'] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];

export const TIME_BUCKET_LABELS: Record<TimeBucket, string> = {
  day: 'By day',
  week: 'By week',
  month: 'By month',
};

/** Most lines want more points than a bar chart wants bars. */
export const LINE_DEFAULT_LIMIT = 24;

/** How the rows are reduced to a number. */
export const WIDGET_METRICS = ['count', 'sum', 'avg'] as const;
export type WidgetMetric = (typeof WIDGET_METRICS)[number];

export const WIDGET_METRIC_LABELS: Record<WidgetMetric, string> = {
  count: 'How many work orders',
  sum: 'Total of',
  avg: 'Average of',
};

export const WIDGET_WIDTHS = ['quarter', 'half', 'full'] as const;
export type WidgetWidth = (typeof WIDGET_WIDTHS)[number];

/** How many buckets a chart draws before the rest collapse into "other". */
export const WIDGET_DEFAULT_LIMIT = 8;
export const WIDGET_MAX_LIMIT = 50;

export interface WidgetConfig {
  metric: WidgetMetric;
  /** The numeric field summed or averaged. Required unless metric = 'count'. */
  value_field?: string;
  /** The field the rows are cut by. Required for bar / donut / table. */
  group_field?: string;
  /** A line's date field — what "over time" means for this card. Required
      for kind = 'line', and it replaces group_field rather than joining it:
      a card answers one question, cut one way. */
  time_field?: string;
  bucket?: TimeBucket;
  /** Which work orders are in scope for this widget at all. */
  filters?: WoFilterSet;
  limit?: number;
  /** 0049 · which records the question is asked of. Absent = work orders. */
  source?: WidgetSource;
  /** 0049 · for a non-work-order source: only these statuses. */
  source_status?: string[];
  /** 0049 · for invoices / vendor bills: only rows past their due date and unpaid. */
  source_overdue?: boolean;
  /** 0049 · gauge: the figure the total is read against. */
  target?: number;
  /** 0049 · live: seconds between re-reads. */
  refresh_seconds?: number;
  /** 0049 · narrative: the text. Plain text with blank lines as paragraphs. */
  text?: string;
  /** 0049 · image: what to show; link: where the button goes. */
  url?: string;
  /** 0049 · link: what the button says. */
  button_label?: string;
  /** 0068 · where the card sits inside its dashboard: the tab it is on and
      the group it is drawn under. Both are plain names; a dashboard whose
      cards name no tab has no tab strip and reads exactly as before. */
  tab?: string;
  section?: string;
}

/** The name the cards with no tab are filed under, once a dashboard has tabs. */
export const DASH_DEFAULT_TAB = 'Overview';

/** A dashboard's tabs, in the order its cards first name them. Empty = the
    dashboard has no tabs (one page, as before). Cards with no tab are on
    "Overview", which comes first when it is needed. */
export function dashboardTabs(widgets: { config: { tab?: string } }[]): string[] {
  const named: string[] = [];
  let loose = false;
  for (const w of widgets) {
    const t = (w.config.tab ?? '').trim();
    if (t === '') loose = true;
    else if (!named.some((n) => n.toLowerCase() === t.toLowerCase())) named.push(t);
  }
  if (named.length === 0) return [];
  const hasOverview = named.some((n) => n.toLowerCase() === DASH_DEFAULT_TAB.toLowerCase());
  return loose && !hasOverview ? [DASH_DEFAULT_TAB, ...named] : named;
}

/** The cards of one tab, cut into groups in the order the groups first
    appear. Cards with no group come first, under no heading. */
export function widgetsByGroup<T extends { config: { tab?: string; section?: string } }>(widgets: T[], tab: string | null): { section: string | null; widgets: T[] }[] {
  const on = tab === null ? widgets : widgets.filter((w) => ((w.config.tab ?? '').trim() || DASH_DEFAULT_TAB).toLowerCase() === tab.toLowerCase());
  const out: { section: string | null; widgets: T[] }[] = [];
  for (const w of on) {
    const s = (w.config.section ?? '').trim() || null;
    const slot = out.find((g) => (g.section ?? '').toLowerCase() === (s ?? '').toLowerCase());
    if (slot) slot.widgets.push(w);
    else if (s === null) out.unshift({ section: null, widgets: [w] });
    else out.push({ section: s, widgets: [w] });
  }
  return out;
}

export interface DashboardWidget {
  id: string;
  dashboard_id: string;
  kind: WidgetKind;
  label: string;
  config: WidgetConfig;
  width: WidgetWidth;
  position: number;
}

// ── Dashboards ───────────────────────────────────────────────────────────────

export interface DashboardFolder {
  id: string;
  name: string;
  position: number;
}

export interface Dashboard {
  id: string;
  folder_id: string | null;
  folder_name: string | null;
  name: string;
  description: string | null;
  /** Set on the ones we ship; null for anything a person built. */
  system_key: string | null;
  owner: { id: string; display_name: string } | null;
  shared_roles: string[];
  shared_all: boolean;
  position: number;
  /** True when the viewer may edit it (owner, or a super admin). */
  can_edit: boolean;
  widgets: DashboardWidget[];
}

export interface DashboardsResponse {
  folders: DashboardFolder[];
  items: Dashboard[];
}

/** One bucket of a widget's answer. `value` is null for the blank bucket. */
export interface WidgetBucket {
  value: string | null;
  /** The reduced number — a count, a total or an average. */
  n: number;
}

export interface WidgetResult {
  widget_id: string;
  /** A single number for 'number'; one per bucket otherwise. */
  total: number;
  buckets: WidgetBucket[];
  /** Rows in buckets past `limit`, already reduced. */
  other: number;
  /** Set when the widget cannot be answered — a field that no longer exists,
      say. The card says so instead of the page failing. */
  error?: string;
}

/** How a widget's numbers are worded, for the drill-through link's title. */
export function widgetSubtitle(config: WidgetConfig, fieldLabel?: string): string {
  if (config.metric === 'count') return WIDGET_SOURCE_NOUNS[config.source ?? 'work_orders'];
  // A card over another source names its field by the source's own label.
  const src = config.source && config.source !== 'work_orders' ? SOURCE_FIELDS[config.source] : undefined;
  const own = src?.find((f) => f.key === config.value_field)?.label.toLowerCase();
  const what = fieldLabel ?? own ?? config.value_field ?? 'value';
  return config.metric === 'sum' ? `Total ${what}` : `Average ${what}`;
}

// ── The dashboards we ship ───────────────────────────────────────────────────
//
// Upserted by ensureSystemDashboards() on the first read, keyed by
// system_key, so a seeded laptop and production get them the same way and
// neither the migration nor seed.ts carries a copy. An admin may rename,
// reshare or re-widget them afterwards: the upsert only INSERTS what is
// missing, it never overwrites what someone has changed.
//
// Every widget below is answerable with the data that exists today. Vendor,
// site and invoice cards are deliberately absent until those modules land —
// a dashboard with blanks on it reads as broken.

export interface PrebuiltWidget {
  kind: WidgetKind;
  label: string;
  width: WidgetWidth;
  config: WidgetConfig;
}

export interface PrebuiltDashboard {
  key: string;
  name: string;
  description: string;
  folder: string;
  /** Empty + shared_all true = everyone who can see dashboards at all. */
  shared_all: boolean;
  shared_roles: string[];
  widgets: PrebuiltWidget[];
}

const OPEN_WORK: WoFilterSet = {
  match: 'all',
  rules: [{ field: 'status_group', op: 'in', value: ['open', 'active'] }],
};

export const PREBUILT_DASHBOARDS: readonly PrebuiltDashboard[] = [
  {
    key: 'dispatch-center',
    name: 'Dispatch Center',
    description: 'What is on the floor right now, and what is about to go wrong.',
    folder: 'Operations',
    shared_all: true,
    shared_roles: [],
    widgets: [
      {
        kind: 'number',
        label: 'Open work orders',
        width: 'quarter',
        config: { metric: 'count', filters: OPEN_WORK },
      },
      {
        kind: 'number',
        label: 'Emergencies',
        width: 'quarter',
        config: {
          metric: 'count',
          filters: {
            match: 'all',
            rules: [
              // The flag is a checkbox field (0034), so the operator is the
              // boolean one — `eq true` is not in a checkbox's vocabulary.
              { field: 'fields.Emergency', op: 'is_true' },
              { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' },
            ],
          },
        },
      },
      {
        kind: 'number',
        label: 'Escalated',
        width: 'quarter',
        config: {
          metric: 'count',
          filters: {
            match: 'all',
            rules: [
              { field: 'fields.Escalated', op: 'is_true' },
              { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' },
            ],
          },
        },
      },
      {
        kind: 'number',
        label: 'Nobody assigned',
        width: 'quarter',
        config: {
          metric: 'count',
          filters: {
            match: 'all',
            rules: [
              { field: 'fields.Assignee', op: 'is_not_set' },
              { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' },
            ],
          },
        },
      },
      {
        kind: 'bar',
        label: 'Open work by trade',
        width: 'half',
        config: { metric: 'count', group_field: 'trade', filters: OPEN_WORK, limit: 10 },
      },
      {
        kind: 'donut',
        label: 'Where the work sits',
        width: 'half',
        config: { metric: 'count', group_field: 'status', filters: OPEN_WORK, limit: 8 },
      },
      {
        kind: 'bar',
        label: 'Open work by client',
        width: 'half',
        config: { metric: 'count', group_field: 'client', filters: OPEN_WORK, limit: 10 },
      },
      {
        kind: 'table',
        label: 'Open work by dispatcher',
        width: 'half',
        config: { metric: 'count', group_field: 'fields.Assignee', filters: OPEN_WORK, limit: 12 },
      },
      {
        // 0044 · the one card that answers "and is it getting worse". Every
        // work order, not just the open ones: a trend of what is still open
        // says more about today than about the months it runs across.
        kind: 'line',
        label: 'Work orders received',
        width: 'full',
        config: { metric: 'count', time_field: 'date_received', bucket: 'month', limit: 18 },
      },
    ],
  },
  {
    key: 'bottlenecks',
    name: 'Approvals & bottlenecks',
    description: 'What is waiting on a person, and how long it has been waiting.',
    folder: 'Operations',
    shared_all: true,
    shared_roles: [],
    widgets: [
      {
        kind: 'number',
        label: 'Nobody assigned',
        width: 'quarter',
        config: {
          metric: 'count',
          filters: {
            match: 'all',
            rules: [
              { field: 'fields.Assignee', op: 'is_not_set' },
              { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' },
            ],
          },
        },
      },
      {
        kind: 'number',
        label: 'Quote clock running',
        width: 'quarter',
        config: {
          metric: 'count',
          filters: {
            match: 'all',
            rules: [
              // The quote clock only carries a date while one is owed (0030),
              // so "is set" IS the queue.
              { field: 'fields.Quote Due Date', op: 'is_set' },
              { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' },
            ],
          },
        },
      },
      {
        kind: 'bar',
        label: 'Open work by phase',
        width: 'half',
        config: { metric: 'count', group_field: 'status_group', filters: OPEN_WORK },
      },
      {
        kind: 'table',
        label: 'Open work by account manager',
        width: 'half',
        config: { metric: 'count', group_field: 'fields.AM', filters: OPEN_WORK, limit: 12 },
      },
      {
        kind: 'bar',
        label: 'Open work by problem type',
        width: 'half',
        config: { metric: 'count', group_field: 'fields.Problem Type', filters: OPEN_WORK, limit: 10 },
      },
    ],
  },
  {
    key: 'money',
    name: 'Money',
    description: 'What the work is worth, what it cost, and what is still owed.',
    folder: 'Finance',
    shared_all: false,
    shared_roles: ['admin', 'am', 'tl'],
    widgets: [
      {
        kind: 'number',
        label: 'Client NTE on open work',
        width: 'quarter',
        config: { metric: 'sum', value_field: 'nte', filters: OPEN_WORK },
      },
      {
        kind: 'number',
        label: 'Cost on open work',
        width: 'quarter',
        config: { metric: 'sum', value_field: 'fields.34. Cost', filters: OPEN_WORK },
      },
      {
        kind: 'number',
        label: 'Average NTE',
        width: 'quarter',
        config: { metric: 'avg', value_field: 'nte', filters: OPEN_WORK },
      },
      {
        kind: 'number',
        label: 'Total invoiced',
        width: 'quarter',
        config: { metric: 'sum', value_field: 'fields.Total Invoiced' },
      },
      {
        kind: 'bar',
        label: 'Cost by trade',
        width: 'half',
        config: { metric: 'sum', value_field: 'fields.34. Cost', group_field: 'trade', limit: 10 },
      },
      {
        kind: 'bar',
        label: 'Cost by billing entity',
        width: 'half',
        config: { metric: 'sum', value_field: 'fields.34. Cost', group_field: 'billing_entity', limit: 10 },
      },
      {
        kind: 'table',
        label: 'Profit by client',
        width: 'full',
        config: { metric: 'sum', value_field: 'fields.Profit', group_field: 'client', limit: 15 },
      },
    ],
  },
  {
    // 0049 · built from the money records that exist now: invoices (0045),
    // payment requests, vendor bills (0047). Every card names its source.
    key: 'accounting',
    name: 'Accounting',
    description: 'Cash in and cash out: what is billed, what is owed to us, what we owe.',
    folder: 'Finance',
    shared_all: false,
    shared_roles: ['admin', 'ar', 'ap', 'tl', 'am'],
    widgets: [
      {
        kind: 'number',
        label: 'Outstanding (sent, unpaid)',
        width: 'quarter',
        config: { metric: 'sum', value_field: 'total', source: 'invoices', source_status: ['sent'] },
      },
      {
        kind: 'number',
        label: 'Overdue',
        width: 'quarter',
        config: {
          metric: 'sum',
          value_field: 'total',
          source: 'invoices',
          source_status: ['sent'],
          source_overdue: true,
        },
      },
      {
        kind: 'number',
        label: 'Payments awaiting approval',
        width: 'quarter',
        config: { metric: 'sum', value_field: 'amount', source: 'payments', source_status: ['requested'] },
      },
      {
        kind: 'number',
        label: 'Vendor bills on file, unpaid',
        width: 'quarter',
        config: {
          metric: 'sum',
          value_field: 'total',
          source: 'vendor_bills',
          source_status: ['received', 'approved', 'disputed'],
        },
      },
      {
        kind: 'donut',
        label: 'Invoices by status',
        width: 'half',
        config: { metric: 'sum', value_field: 'total', group_field: 'status', source: 'invoices' },
      },
      {
        kind: 'bar',
        label: 'Billed by client',
        width: 'half',
        config: {
          metric: 'sum',
          value_field: 'total',
          group_field: 'client',
          source: 'invoices',
          source_status: ['sent', 'paid'],
          limit: 10,
        },
      },
      {
        kind: 'line',
        label: 'Invoiced per month',
        width: 'half',
        config: {
          metric: 'sum',
          value_field: 'total',
          source: 'invoices',
          source_status: ['sent', 'paid'],
          time_field: 'issued_at',
          bucket: 'month',
          limit: 12,
        },
      },
      {
        kind: 'bar',
        label: 'Paid to vendors, by vendor',
        width: 'half',
        config: {
          metric: 'sum',
          value_field: 'total',
          group_field: 'vendor_name',
          source: 'vendor_bills',
          source_status: ['paid'],
          limit: 10,
        },
      },
      {
        kind: 'narrative',
        label: 'How to read this board',
        width: 'full',
        config: {
          metric: 'count',
          text:
            'Outstanding is every invoice that has been sent and not yet paid; Overdue is the part of it past its due date. Payments awaiting approval is money technicians have asked for and a manager has not yet decided on. Each card opens the queue behind it.',
        },
      },
    ],
  },
  {
    // 0057 · the Payments dashboard: every technician / vendor payment
    // request raised in The One, cut the ways the old payments dashboard cut
    // the Teams chat — by vendor, company, client, dispatcher — plus trade,
    // state, method and status. It starts empty and fills as payments are
    // requested here; every card can be edited and more can be added.
    key: 'payments',
    name: 'Payments',
    description: 'Technician and vendor payments: what was asked for, approved and paid, and to whom.',
    folder: 'Finance',
    shared_all: false,
    shared_roles: ['admin', 'ap', 'tl', 'am'],
    widgets: [
      {
        kind: 'number',
        label: 'Paid',
        width: 'quarter',
        config: { metric: 'sum', value_field: 'amount', source: 'payments', source_status: ['paid'] },
      },
      {
        kind: 'number',
        label: 'Approved, not yet paid',
        width: 'quarter',
        config: { metric: 'sum', value_field: 'amount', source: 'payments', source_status: ['approved', 'sent_to_yoda'] },
      },
      {
        kind: 'number',
        label: 'Awaiting approval',
        width: 'quarter',
        config: { metric: 'sum', value_field: 'amount', source: 'payments', source_status: ['requested'] },
      },
      {
        kind: 'number',
        label: 'Average payment',
        width: 'quarter',
        config: { metric: 'avg', value_field: 'amount', source: 'payments', source_status: ['approved', 'sent_to_yoda', 'paid'] },
      },
      {
        kind: 'line',
        label: 'Requested per month',
        width: 'half',
        config: { metric: 'sum', value_field: 'amount', source: 'payments', time_field: 'created_at', bucket: 'month', limit: 12 },
      },
      {
        kind: 'donut',
        label: 'Requests by status',
        width: 'half',
        config: { metric: 'count', group_field: 'status', source: 'payments' },
      },
      {
        kind: 'bar',
        label: 'Top vendors by amount',
        width: 'half',
        config: { metric: 'sum', value_field: 'amount', group_field: 'payee', source: 'payments', source_status: ['approved', 'sent_to_yoda', 'paid'], limit: 10 },
      },
      {
        kind: 'bar',
        label: 'Top vendors by number of payments',
        width: 'half',
        config: { metric: 'count', group_field: 'payee', source: 'payments', source_status: ['approved', 'sent_to_yoda', 'paid'], limit: 10 },
      },
      {
        kind: 'bar',
        label: 'By dispatcher',
        width: 'half',
        config: { metric: 'sum', value_field: 'amount', group_field: 'requested_by', source: 'payments', limit: 12 },
      },
      {
        kind: 'bar',
        label: 'By client',
        width: 'half',
        config: { metric: 'sum', value_field: 'amount', group_field: 'client', source: 'payments', limit: 12 },
      },
      {
        kind: 'donut',
        label: 'By company',
        width: 'half',
        config: { metric: 'sum', value_field: 'amount', group_field: 'billing_entity', source: 'payments' },
      },
      {
        kind: 'donut',
        label: 'By method',
        width: 'half',
        config: { metric: 'sum', value_field: 'amount', group_field: 'method', source: 'payments' },
      },
      {
        kind: 'donut',
        label: 'By trade',
        width: 'half',
        config: { metric: 'sum', value_field: 'amount', group_field: 'trade', source: 'payments' },
      },
      {
        kind: 'bar',
        label: 'By state',
        width: 'half',
        config: { metric: 'sum', value_field: 'amount', group_field: 'state', source: 'payments', limit: 15 },
      },
      {
        kind: 'table',
        label: 'Average paid per vendor',
        width: 'half',
        config: { metric: 'avg', value_field: 'amount', group_field: 'payee', source: 'payments', source_status: ['approved', 'sent_to_yoda', 'paid'], limit: 15 },
      },
      {
        kind: 'narrative',
        label: 'How to read this board',
        width: 'full',
        config: {
          metric: 'count',
          text:
            'Every payment request raised on a work order in The One. Paid is money that has gone out; Approved, not yet paid is decided and waiting on the payment run; Awaiting approval is what a manager still has to decide. Add a card to cut payments any other way — by FM, purpose, vendor owner, vendor state — from the card editor.',
        },
      },
    ],
  },
  {
    // 0062 · the portfolio: sites and the assets standing in them (0060).
    key: 'portfolio',
    name: 'Sites & assets',
    description: 'The portfolio: how many sites and where, and the equipment in them — its condition and its warranties.',
    folder: 'Operations',
    shared_all: false,
    shared_roles: ['admin', 'tl', 'atl', 'am', 'senior_om', 'ops_coord'],
    widgets: [
      { kind: 'number', label: 'Sites', width: 'quarter', config: { metric: 'count', source: 'sites' } },
      { kind: 'number', label: 'Assets', width: 'quarter', config: { metric: 'count', source: 'assets' } },
      { kind: 'number', label: 'Assets out of service', width: 'quarter', config: { metric: 'count', source: 'assets', source_status: ['out_of_service'] } },
      { kind: 'number', label: 'Open work orders at sites', width: 'quarter', config: { metric: 'sum', value_field: 'open_work_orders', source: 'sites' } },
      { kind: 'bar', label: 'Sites by client', width: 'half', config: { metric: 'count', group_field: 'client', source: 'sites', limit: 15 } },
      { kind: 'bar', label: 'Sites by state', width: 'half', config: { metric: 'count', group_field: 'state', source: 'sites', limit: 20 } },
      { kind: 'donut', label: 'Sites by type', width: 'half', config: { metric: 'count', group_field: 'site_type', source: 'sites' } },
      { kind: 'table', label: 'Open work orders by client', width: 'half', config: { metric: 'sum', value_field: 'open_work_orders', group_field: 'client', source: 'sites', limit: 15 } },
      { kind: 'donut', label: 'Asset condition', width: 'half', config: { metric: 'count', group_field: 'condition', source: 'assets' } },
      { kind: 'donut', label: 'Warranty', width: 'half', config: { metric: 'count', group_field: 'warranty', source: 'assets' } },
      { kind: 'bar', label: 'Assets by category', width: 'half', config: { metric: 'count', group_field: 'category', source: 'assets', limit: 15 } },
      { kind: 'bar', label: 'Assets by client', width: 'half', config: { metric: 'count', group_field: 'client', source: 'assets', limit: 15 } },
      { kind: 'table', label: 'Work orders by asset category', width: 'half', config: { metric: 'sum', value_field: 'work_orders', group_field: 'category', source: 'assets', limit: 15 } },
      { kind: 'table', label: 'Average age by category (years)', width: 'half', config: { metric: 'avg', value_field: 'age_years', group_field: 'category', source: 'assets', limit: 15 } },
      { kind: 'line', label: 'Warranties ending, by month', width: 'full', config: { metric: 'count', source: 'assets', time_field: 'warranty_expires_on', bucket: 'month', limit: 18 } },
    ],
  },
  {
    // 0059 · the vendor network, over the Vendors section's own records.
    key: 'vendors',
    name: 'Vendors',
    description: 'The vendor network: how many, where, which trades, who owns them and where the paperwork stands.',
    folder: 'Operations',
    shared_all: false,
    shared_roles: ['admin', 'vr_officer', 'tl', 'atl', 'am'],
    widgets: [
      { kind: 'number', label: 'Vendors and technicians', width: 'quarter', config: { metric: 'count', source: 'vendors' } },
      { kind: 'number', label: 'Active', width: 'quarter', config: { metric: 'count', source: 'vendors', source_status: ['ACTIVE'] } },
      { kind: 'number', label: 'In the pipeline', width: 'quarter', config: { metric: 'count', source: 'vendors', source_status: ['NEW', 'INTERESTED', 'READY'] } },
      { kind: 'number', label: 'Average hourly rate', width: 'quarter', config: { metric: 'avg', value_field: 'regular_hourly_rate', source: 'vendors' } },
      { kind: 'donut', label: 'By status', width: 'half', config: { metric: 'count', group_field: 'status', source: 'vendors' } },
      { kind: 'donut', label: 'Paperwork', width: 'half', config: { metric: 'count', group_field: 'paperwork', source: 'vendors' } },
      { kind: 'bar', label: 'By trade', width: 'half', config: { metric: 'count', group_field: 'primary_trade', source: 'vendors', limit: 15 } },
      { kind: 'bar', label: 'By state', width: 'half', config: { metric: 'count', group_field: 'state', source: 'vendors', limit: 20 } },
      { kind: 'line', label: 'Added per month', width: 'full', config: { metric: 'count', source: 'vendors', time_field: 'created_at', bucket: 'month', limit: 12 } },
      { kind: 'bar', label: 'By owner', width: 'half', config: { metric: 'count', group_field: 'owner', source: 'vendors', limit: 12 } },
      { kind: 'bar', label: 'Added by', width: 'half', config: { metric: 'count', group_field: 'added_by', source: 'vendors', limit: 12 } },
      { kind: 'donut', label: 'Coverage', width: 'half', config: { metric: 'count', group_field: 'coverage', source: 'vendors' } },
      { kind: 'donut', label: 'VR vendors and technicians', width: 'half', config: { metric: 'count', group_field: 'kind', source: 'vendors' } },
      { kind: 'table', label: 'Jobs by trade', width: 'half', config: { metric: 'sum', value_field: 'work_orders_count', group_field: 'primary_trade', source: 'vendors', limit: 15 } },
      { kind: 'table', label: 'Average hourly rate by trade', width: 'half', config: { metric: 'avg', value_field: 'regular_hourly_rate', group_field: 'primary_trade', source: 'vendors', limit: 15 } },
    ],
  },
  {
    // 0049 · service levels, on the SLA Due Date the intake gate stamps
    // (0037). "today" is resolved by the API on the day the card is read.
    key: 'service-levels',
    name: 'Service levels',
    description: 'Which work orders are past, at, or near their SLA.',
    folder: 'Operations',
    shared_all: true,
    shared_roles: [],
    widgets: [
      {
        kind: 'number',
        label: 'Past SLA',
        width: 'quarter',
        config: {
          metric: 'count',
          filters: {
            match: 'all',
            rules: [
              { field: 'fields.SLA Due Date', op: 'lt', value: 'today' },
              { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' },
            ],
          },
        },
      },
      {
        kind: 'number',
        label: 'SLA due today',
        width: 'quarter',
        config: {
          metric: 'count',
          filters: {
            match: 'all',
            rules: [
              { field: 'fields.SLA Due Date', op: 'gte', value: 'today' },
              { field: 'fields.SLA Due Date', op: 'lt', value: 'today+1', join: 'and' },
              { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' },
            ],
          },
        },
      },
      {
        kind: 'number',
        label: 'SLA due within 7 days',
        width: 'quarter',
        config: {
          metric: 'count',
          filters: {
            match: 'all',
            rules: [
              { field: 'fields.SLA Due Date', op: 'gte', value: 'today' },
              { field: 'fields.SLA Due Date', op: 'lt', value: 'today+7', join: 'and' },
              { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' },
            ],
          },
        },
      },
      {
        kind: 'gauge',
        label: 'Open work inside SLA',
        width: 'quarter',
        config: {
          metric: 'count',
          // Read against the open total: the gauge's target is filled in by
          // the board from the "Open work orders" figure when none is set.
          filters: {
            match: 'all',
            rules: [
              { field: 'fields.SLA Due Date', op: 'gte', value: 'today' },
              { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' },
            ],
          },
        },
      },
      {
        kind: 'bar',
        label: 'Past SLA by client',
        width: 'half',
        config: {
          metric: 'count',
          group_field: 'client',
          filters: {
            match: 'all',
            rules: [
              { field: 'fields.SLA Due Date', op: 'lt', value: 'today' },
              { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' },
            ],
          },
          limit: 10,
        },
      },
      {
        kind: 'table',
        label: 'Past SLA by dispatcher',
        width: 'half',
        config: {
          metric: 'count',
          group_field: 'fields.Assignee',
          filters: {
            match: 'all',
            rules: [
              { field: 'fields.SLA Due Date', op: 'lt', value: 'today' },
              { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' },
            ],
          },
          limit: 12,
        },
      },
      {
        kind: 'line',
        label: 'SLA deadlines by week',
        width: 'full',
        config: { metric: 'count', time_field: 'fields.SLA Due Date', bucket: 'week', filters: OPEN_WORK, limit: 16 },
      },
    ],
  },
  // ── 0068 · five more boards, each laid out in tabs and groups ─────────────
  {
    key: 'maintenance-supervisor',
    name: 'Maintenance Supervisor',
    description: 'The day of a supervisor: what is open, what is late, who carries it and where it keeps breaking.',
    folder: 'Operations',
    shared_all: false,
    shared_roles: ['admin', 'tl', 'atl', 'am', 'senior_om', 'ops_coord'],
    widgets: [
      { kind: 'number', label: 'Open work orders', width: 'quarter', config: { metric: 'count', filters: OPEN_WORK, tab: 'Today', section: 'Right now' } },
      { kind: 'number', label: 'Emergencies', width: 'quarter', config: { metric: 'count', tab: 'Today', section: 'Right now', filters: { match: 'all', rules: [{ field: 'fields.Emergency', op: 'is_true' }, { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' }] } } },
      { kind: 'number', label: 'Escalated', width: 'quarter', config: { metric: 'count', tab: 'Today', section: 'Right now', filters: { match: 'all', rules: [{ field: 'fields.Escalated', op: 'is_true' }, { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' }] } } },
      { kind: 'number', label: 'Past SLA', width: 'quarter', config: { metric: 'count', tab: 'Today', section: 'Right now', filters: { match: 'all', rules: [{ field: 'fields.SLA Due Date', op: 'lt', value: 'today' }, { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' }] } } },
      { kind: 'bar', label: 'Open work by status', width: 'half', config: { metric: 'count', group_field: 'status', filters: OPEN_WORK, limit: 15, tab: 'Today', section: 'Where it stands' } },
      { kind: 'bar', label: 'Open work by trade', width: 'half', config: { metric: 'count', group_field: 'trade', filters: OPEN_WORK, limit: 12, tab: 'Today', section: 'Where it stands' } },
      { kind: 'bar', label: 'Open work by dispatcher', width: 'half', config: { metric: 'count', group_field: 'fields.Assignee', filters: OPEN_WORK, limit: 20, tab: 'Team', section: 'Workload' } },
      { kind: 'table', label: 'NTE carried by dispatcher', width: 'half', config: { metric: 'sum', value_field: 'nte', group_field: 'fields.Assignee', filters: OPEN_WORK, limit: 20, tab: 'Team', section: 'Workload' } },
      { kind: 'bar', label: 'Past SLA by dispatcher', width: 'half', config: { metric: 'count', group_field: 'fields.Assignee', limit: 20, tab: 'Team', section: 'Falling behind', filters: { match: 'all', rules: [{ field: 'fields.SLA Due Date', op: 'lt', value: 'today' }, { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' }] } } },
      { kind: 'bar', label: 'Emergencies by dispatcher', width: 'half', config: { metric: 'count', group_field: 'fields.Assignee', limit: 20, tab: 'Team', section: 'Falling behind', filters: { match: 'all', rules: [{ field: 'fields.Emergency', op: 'is_true' }, { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' }] } } },
      { kind: 'line', label: 'Work orders received, by week', width: 'full', config: { metric: 'count', time_field: 'date_received', bucket: 'week', limit: 16, tab: 'Trends' } },
      { kind: 'bar', label: 'By problem type', width: 'half', config: { metric: 'count', group_field: 'fields.Problem Type', limit: 12, tab: 'Trends' } },
      { kind: 'bar', label: 'By client', width: 'half', config: { metric: 'count', group_field: 'client', limit: 12, tab: 'Trends' } },
      { kind: 'bar', label: 'Assets by condition', width: 'half', config: { metric: 'count', group_field: 'condition', source: 'assets', tab: 'Equipment' } },
      { kind: 'table', label: 'Work orders by asset category', width: 'half', config: { metric: 'sum', value_field: 'work_orders', group_field: 'category', source: 'assets', limit: 15, tab: 'Equipment' } },
    ],
  },
  {
    key: 'vendor-performance',
    name: 'Vendor Performance',
    description: 'The vendor network at work: who is ready, what they bill, and where bills are stuck. Per-vendor SLA and recalls are on Vendors › Performance.',
    folder: 'Operations',
    shared_all: false,
    shared_roles: ['admin', 'vr_officer', 'tl', 'atl', 'am'],
    widgets: [
      { kind: 'number', label: 'Active vendors', width: 'quarter', config: { metric: 'count', source: 'vendors', source_status: ['ACTIVE'], tab: 'Network' } },
      { kind: 'number', label: 'In the pipeline', width: 'quarter', config: { metric: 'count', source: 'vendors', source_status: ['NEW', 'INTERESTED', 'READY'], tab: 'Network' } },
      { kind: 'number', label: 'Jobs done', width: 'quarter', config: { metric: 'sum', value_field: 'work_orders_count', source: 'vendors', tab: 'Network' } },
      { kind: 'number', label: 'Average hourly rate', width: 'quarter', config: { metric: 'avg', value_field: 'regular_hourly_rate', source: 'vendors', tab: 'Network' } },
      { kind: 'table', label: 'Jobs by trade', width: 'half', config: { metric: 'sum', value_field: 'work_orders_count', group_field: 'primary_trade', source: 'vendors', limit: 15, tab: 'Network', section: 'Who does the work' } },
      { kind: 'bar', label: 'Vendors by state', width: 'half', config: { metric: 'count', group_field: 'state', source: 'vendors', limit: 20, tab: 'Network', section: 'Who does the work' } },
      { kind: 'donut', label: 'Paperwork', width: 'half', config: { metric: 'count', group_field: 'paperwork', source: 'vendors', tab: 'Compliance' } },
      { kind: 'donut', label: 'COI approved', width: 'half', config: { metric: 'count', group_field: 'coi_approved', source: 'vendors', tab: 'Compliance' } },
      { kind: 'donut', label: 'Blacklisted', width: 'half', config: { metric: 'count', group_field: 'blacklisted', source: 'vendors', tab: 'Compliance' } },
      { kind: 'bar', label: 'Compliance by owner', width: 'half', config: { metric: 'count', group_field: 'owner', source: 'vendors', limit: 12, tab: 'Compliance' } },
      { kind: 'number', label: 'Bills waiting', width: 'quarter', config: { metric: 'sum', value_field: 'total', source: 'vendor_bills', source_status: ['received'], tab: 'Billing' } },
      { kind: 'number', label: 'Bills disputed', width: 'quarter', config: { metric: 'count', source: 'vendor_bills', source_status: ['disputed'], tab: 'Billing' } },
      { kind: 'number', label: 'Bills past due', width: 'quarter', config: { metric: 'sum', value_field: 'total', source: 'vendor_bills', source_overdue: true, tab: 'Billing' } },
      { kind: 'number', label: 'Paid', width: 'quarter', config: { metric: 'sum', value_field: 'total', source: 'vendor_bills', source_status: ['paid'], tab: 'Billing' } },
      { kind: 'table', label: 'Billed by vendor', width: 'half', config: { metric: 'sum', value_field: 'total', group_field: 'vendor_name', source: 'vendor_bills', limit: 15, tab: 'Billing' } },
      { kind: 'line', label: 'Bills received, by month', width: 'half', config: { metric: 'sum', value_field: 'total', source: 'vendor_bills', time_field: 'received_on', bucket: 'month', limit: 12, tab: 'Billing' } },
    ],
  },
  {
    key: 'technician',
    name: 'Technician',
    description: 'The technicians on the jobs: who is out, how much they carry, and what they are paid.',
    folder: 'Operations',
    shared_all: false,
    shared_roles: ['admin', 'tl', 'atl', 'am', 'senior_om', 'ops_coord', 'vr_officer'],
    widgets: [
      { kind: 'bar', label: 'Open work orders by technician', width: 'half', config: { metric: 'count', group_field: 'fields.Tech Name', filters: OPEN_WORK, limit: 20, tab: 'Jobs' } },
      { kind: 'bar', label: 'All work orders by technician', width: 'half', config: { metric: 'count', group_field: 'fields.Tech Name', limit: 20, tab: 'Jobs' } },
      { kind: 'bar', label: 'Check-in status of open work', width: 'half', config: { metric: 'count', group_field: 'fields.18. Check-in/out Status', filters: OPEN_WORK, tab: 'Jobs' } },
      { kind: 'donut', label: 'Visit type of open work', width: 'half', config: { metric: 'count', group_field: 'fields.Visit Type', filters: OPEN_WORK, tab: 'Jobs' } },
      { kind: 'number', label: 'Technicians on file', width: 'quarter', config: { metric: 'count', source: 'vendors', tab: 'Roster' } },
      { kind: 'donut', label: 'Vendors and technicians', width: 'half', config: { metric: 'count', group_field: 'kind', source: 'vendors', tab: 'Roster' } },
      { kind: 'bar', label: 'By trade', width: 'half', config: { metric: 'count', group_field: 'primary_trade', source: 'vendors', limit: 15, tab: 'Roster' } },
      { kind: 'bar', label: 'By state', width: 'half', config: { metric: 'count', group_field: 'state', source: 'vendors', limit: 20, tab: 'Roster' } },
      { kind: 'table', label: 'Paid, by payee', width: 'half', config: { metric: 'sum', value_field: 'amount', group_field: 'payee', source: 'payments', source_status: ['paid'], limit: 20, tab: 'Pay' } },
      { kind: 'table', label: 'Waiting to be paid, by payee', width: 'half', config: { metric: 'sum', value_field: 'amount', group_field: 'payee', source: 'payments', source_status: ['requested', 'approved', 'sent_to_yoda'], limit: 20, tab: 'Pay' } },
      { kind: 'bar', label: 'Payments by method', width: 'half', config: { metric: 'sum', value_field: 'amount', group_field: 'method', source: 'payments', tab: 'Pay' } },
    ],
  },
  {
    key: 'store-manager',
    name: 'Store Manager',
    description: 'One store’s view: pick a client and a store in the filter bar above to narrow every card to it.',
    folder: 'Clients',
    shared_all: false,
    shared_roles: ['admin', 'tl', 'atl', 'am', 'senior_om', 'ops_coord'],
    widgets: [
      { kind: 'narrative', label: 'How to read this', width: 'full', config: { metric: 'count', text: 'Use the filter bar above to pick a client and a store: every card on this dashboard then counts that store only. Without a pick it shows every store.' } },
      { kind: 'number', label: 'Open work orders', width: 'quarter', config: { metric: 'count', filters: OPEN_WORK, section: 'Open now' } },
      { kind: 'number', label: 'Emergencies', width: 'quarter', config: { metric: 'count', section: 'Open now', filters: { match: 'all', rules: [{ field: 'fields.Emergency', op: 'is_true' }, { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' }] } } },
      { kind: 'number', label: 'Past SLA', width: 'quarter', config: { metric: 'count', section: 'Open now', filters: { match: 'all', rules: [{ field: 'fields.SLA Due Date', op: 'lt', value: 'today' }, { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' }] } } },
      { kind: 'number', label: 'NTE on open work', width: 'quarter', config: { metric: 'sum', value_field: 'nte', filters: OPEN_WORK, section: 'Open now' } },
      { kind: 'bar', label: 'Open work by status', width: 'half', config: { metric: 'count', group_field: 'status', filters: OPEN_WORK, limit: 15, section: 'Open now' } },
      { kind: 'bar', label: 'Open work by store', width: 'half', config: { metric: 'count', group_field: 'fields.Store', filters: OPEN_WORK, limit: 20, section: 'Open now' } },
      { kind: 'bar', label: 'Work orders by trade', width: 'half', config: { metric: 'count', group_field: 'trade', limit: 12, section: 'History' } },
      { kind: 'bar', label: 'Work orders by problem type', width: 'half', config: { metric: 'count', group_field: 'fields.Problem Type', limit: 12, section: 'History' } },
      { kind: 'line', label: 'Work orders received, by month', width: 'full', config: { metric: 'count', time_field: 'date_received', bucket: 'month', limit: 18, section: 'History' } },
    ],
  },
  {
    key: 'unified-ops',
    name: 'Unified Ops',
    description: 'Everything on one board: the work, the money in, the money out, the vendors and the portfolio — one tab each.',
    folder: 'Operations',
    shared_all: false,
    shared_roles: ['admin', 'tl', 'atl', 'am'],
    widgets: [
      { kind: 'number', label: 'Open work orders', width: 'quarter', config: { metric: 'count', filters: OPEN_WORK, tab: 'Work' } },
      { kind: 'number', label: 'Emergencies', width: 'quarter', config: { metric: 'count', tab: 'Work', filters: { match: 'all', rules: [{ field: 'fields.Emergency', op: 'is_true' }, { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' }] } } },
      { kind: 'number', label: 'Past SLA', width: 'quarter', config: { metric: 'count', tab: 'Work', filters: { match: 'all', rules: [{ field: 'fields.SLA Due Date', op: 'lt', value: 'today' }, { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' }] } } },
      { kind: 'number', label: 'NTE on open work', width: 'quarter', config: { metric: 'sum', value_field: 'nte', filters: OPEN_WORK, tab: 'Work' } },
      { kind: 'bar', label: 'Open work by status', width: 'half', config: { metric: 'count', group_field: 'status', filters: OPEN_WORK, limit: 15, tab: 'Work' } },
      { kind: 'bar', label: 'Open work by client', width: 'half', config: { metric: 'count', group_field: 'client', filters: OPEN_WORK, limit: 12, tab: 'Work' } },
      { kind: 'line', label: 'Work orders received, by week', width: 'full', config: { metric: 'count', time_field: 'date_received', bucket: 'week', limit: 16, tab: 'Work' } },
      { kind: 'number', label: 'Invoiced, not paid', width: 'quarter', config: { metric: 'sum', value_field: 'total', source: 'invoices', source_status: ['sent'], tab: 'Money in' } },
      { kind: 'number', label: 'Invoices past due', width: 'quarter', config: { metric: 'sum', value_field: 'total', source: 'invoices', source_overdue: true, tab: 'Money in' } },
      { kind: 'number', label: 'Collected', width: 'quarter', config: { metric: 'sum', value_field: 'total', source: 'invoices', source_status: ['paid'], tab: 'Money in' } },
      { kind: 'number', label: 'Drafts to send', width: 'quarter', config: { metric: 'count', source: 'invoices', source_status: ['draft'], tab: 'Money in' } },
      { kind: 'bar', label: 'Invoiced by client', width: 'half', config: { metric: 'sum', value_field: 'total', group_field: 'client', source: 'invoices', limit: 12, tab: 'Money in' } },
      { kind: 'line', label: 'Invoiced, by month', width: 'half', config: { metric: 'sum', value_field: 'total', source: 'invoices', time_field: 'created_at', bucket: 'month', limit: 12, tab: 'Money in' } },
      { kind: 'number', label: 'Payments awaiting approval', width: 'quarter', config: { metric: 'sum', value_field: 'amount', source: 'payments', source_status: ['requested'], tab: 'Money out' } },
      { kind: 'number', label: 'Approved, not yet paid', width: 'quarter', config: { metric: 'sum', value_field: 'amount', source: 'payments', source_status: ['approved', 'sent_to_yoda'], tab: 'Money out' } },
      { kind: 'number', label: 'Vendor bills waiting', width: 'quarter', config: { metric: 'sum', value_field: 'total', source: 'vendor_bills', source_status: ['received'], tab: 'Money out' } },
      { kind: 'number', label: 'Vendor bills past due', width: 'quarter', config: { metric: 'sum', value_field: 'total', source: 'vendor_bills', source_overdue: true, tab: 'Money out' } },
      { kind: 'bar', label: 'Paid out by client', width: 'half', config: { metric: 'sum', value_field: 'amount', group_field: 'client', source: 'payments', source_status: ['paid'], limit: 12, tab: 'Money out' } },
      { kind: 'line', label: 'Paid out, by month', width: 'half', config: { metric: 'sum', value_field: 'amount', source: 'payments', source_status: ['paid'], time_field: 'paid_at', bucket: 'month', limit: 12, tab: 'Money out' } },
      { kind: 'number', label: 'Active vendors', width: 'quarter', config: { metric: 'count', source: 'vendors', source_status: ['ACTIVE'], tab: 'Vendors' } },
      { kind: 'donut', label: 'Vendors by status', width: 'half', config: { metric: 'count', group_field: 'status', source: 'vendors', tab: 'Vendors' } },
      { kind: 'bar', label: 'Vendors by trade', width: 'half', config: { metric: 'count', group_field: 'primary_trade', source: 'vendors', limit: 15, tab: 'Vendors' } },
      { kind: 'number', label: 'Sites', width: 'quarter', config: { metric: 'count', source: 'sites', tab: 'Portfolio' } },
      { kind: 'number', label: 'Assets', width: 'quarter', config: { metric: 'count', source: 'assets', tab: 'Portfolio' } },
      { kind: 'bar', label: 'Sites by client', width: 'half', config: { metric: 'count', group_field: 'client', source: 'sites', limit: 15, tab: 'Portfolio' } },
      { kind: 'donut', label: 'Asset condition', width: 'half', config: { metric: 'count', group_field: 'condition', source: 'assets', tab: 'Portfolio' } },
    ],
  },
  {
    // 0072 · the sales team's one page: how much work came in for their
    // clients. Nothing on it is special — every card is a plain work-order
    // count, and what it counts is the viewer's own scope (0032), which for
    // a salesperson is the clients assigned to them in Admin › Users
    // (principal_client). A manager opening the same board sees it over
    // their own book. Period = date received, like every board.
    key: 'sales',
    name: 'Sales',
    description: 'Work orders received for your clients: how many, when, where, and where they stand.',
    folder: 'Sales',
    shared_all: false,
    shared_roles: ['sales', 'admin', 'am', 'tl'],
    widgets: [
      { kind: 'number', label: 'Work orders received', width: 'quarter', config: { metric: 'count' } },
      { kind: 'number', label: 'Open right now', width: 'quarter', config: { metric: 'count', filters: OPEN_WORK } },
      {
        kind: 'number',
        label: 'Emergencies',
        width: 'quarter',
        config: { metric: 'count', filters: { match: 'all', rules: [{ field: 'fields.Emergency', op: 'is_true' }, { field: 'status_group', op: 'in', value: ['open', 'active'], join: 'and' }] } },
      },
      {
        kind: 'number',
        label: 'Completed',
        width: 'quarter',
        config: { metric: 'count', filters: { match: 'all', rules: [{ field: 'status_group', op: 'in', value: ['done', 'closed'] }] } },
      },
      { kind: 'bar', label: 'Received by client', width: 'half', config: { metric: 'count', group_field: 'client', limit: 15 } },
      { kind: 'line', label: 'Received per month', width: 'half', config: { metric: 'count', time_field: 'date_received', bucket: 'month', limit: 18 } },
      { kind: 'donut', label: 'Where the work stands', width: 'half', config: { metric: 'count', group_field: 'status', limit: 8 } },
      { kind: 'bar', label: 'Received by trade', width: 'half', config: { metric: 'count', group_field: 'trade', limit: 10 } },
      { kind: 'table', label: 'Received by city', width: 'full', config: { metric: 'count', group_field: 'city', limit: 15 } },
    ],
  },
];

/** The permission path the dashboard section is gated on (0015). */
export const DASHBOARD_PERM_KEY = 'dashboard';

// ── The period a whole dashboard is read over ────────────────────────────────
//
// One control at the top of the board, applied to every card on it, rather
// than a date setting hidden inside each one: a dashboard whose cards each
// cover a different stretch of time cannot be read as a whole.
//
// It filters on when the work order was RECEIVED — the one date every work
// order has, whatever became of it afterwards. "All time" is the default, so
// a board means what it meant before anybody touched the control.

export const PERIOD_PRESETS = ['all', 'month', 'quarter', 'year', 'last_30'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  all: 'All time',
  month: 'By month',
  quarter: 'By quarter',
  year: 'By year',
  last_30: 'Last 30 days',
};

/** The field the period filters on. */
export const PERIOD_FIELD = 'date_received';

export interface DashboardPeriod {
  preset: PeriodPreset;
  /** 0 = the current one, -1 = the one before it. Only month/quarter/year
      step; 'all' and 'last_30' ignore it. */
  offset: number;
}

export const DEFAULT_PERIOD: DashboardPeriod = { preset: 'all', offset: 0 };

/** Only the stepping presets get ‹ › arrows. */
export function periodSteps(preset: PeriodPreset): boolean {
  return preset === 'month' || preset === 'quarter' || preset === 'year';
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The period as dates and as a sentence. Computed in UTC so the browser and
 * the API agree on which month it is regardless of where the reader sits;
 * a day either side matters less than the two disagreeing.
 */
export function resolvePeriod(
  period: DashboardPeriod,
  now: Date = new Date(),
): { from: string | null; to: string | null; label: string } {
  const { preset, offset } = period;
  if (preset === 'all') return { from: null, to: null, label: 'All time' };

  if (preset === 'last_30') {
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - 29);
    return { from: ymd(from), to: ymd(to), label: 'Last 30 days' };
  }

  if (preset === 'month') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    const label = start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return { from: ymd(start), to: ymd(end), label };
  }

  if (preset === 'quarter') {
    const q = Math.floor(now.getUTCMonth() / 3) + offset;
    const start = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 0));
    return {
      from: ymd(start),
      to: ymd(end),
      label: `Q${Math.floor(start.getUTCMonth() / 3) + 1} ${start.getUTCFullYear()}`,
    };
  }

  const start = new Date(Date.UTC(now.getUTCFullYear() + offset, 0, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), 11, 31));
  return { from: ymd(start), to: ymd(end), label: String(start.getUTCFullYear()) };
}

/** A bucket key ('2026-09-01') as the axis should read it. */
export function formatBucket(iso: string, bucket: TimeBucket | undefined): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  if (bucket === 'month') {
    return d.toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
