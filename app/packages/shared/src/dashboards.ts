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

export const WIDGET_SOURCES = ['work_orders', 'invoices', 'payments', 'vendor_bills'] as const;
export type WidgetSource = (typeof WIDGET_SOURCES)[number];

export const WIDGET_SOURCE_LABELS: Record<WidgetSource, string> = {
  work_orders: 'Work orders',
  invoices: 'Client invoices',
  payments: 'Payment requests',
  vendor_bills: 'Vendor bills',
};

/** What a count of this source is called. */
export const WIDGET_SOURCE_NOUNS: Record<WidgetSource, string> = {
  work_orders: 'Work orders',
  invoices: 'Invoices',
  payments: 'Payment requests',
  vendor_bills: 'Vendor bills',
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
};

/** The statuses each source may be narrowed to. */
export const SOURCE_STATUSES: Record<Exclude<WidgetSource, 'work_orders'>, string[]> = {
  invoices: ['draft', 'sent', 'paid', 'void'],
  payments: ['requested', 'approved', 'sent_to_yoda', 'paid', 'rejected'],
  vendor_bills: ['received', 'approved', 'paid', 'disputed', 'void'],
};

/** Where a card over this source drills through to. */
export const SOURCE_DRILL_PATH: Record<WidgetSource, string> = {
  work_orders: '/',
  invoices: '/receivables/invoicing',
  payments: '/payments',
  vendor_bills: '/payments?lane=bills',
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
  const what = fieldLabel ?? config.value_field ?? 'value';
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
