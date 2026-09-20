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

export const WIDGET_KINDS = ['number', 'bar', 'donut', 'table', 'line'] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const WIDGET_KIND_LABELS: Record<WidgetKind, string> = {
  number: 'A single number',
  bar: 'Bars',
  donut: 'A donut',
  table: 'A table',
  line: 'A line over time',
};

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
  if (config.metric === 'count') return 'Work orders';
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
