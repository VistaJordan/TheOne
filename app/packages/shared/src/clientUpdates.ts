/**
 * Client Updates (0055) — the page that replaces the per-client tracking
 * spreadsheet (e.g. "SUN Holdings Tracking": WO # · Dispatcher · WO Mgr ·
 * Trade · Asset · Store · Location · Rec On · Comp On · Status · NTE · Client
 * Notes). A TRACKER is a saved question over the work orders — a client, a
 * filter, the columns to show, the charts to draw — plus how it is shared:
 * which columns the client may see, a read-only public link, and an email
 * from contact@seamlessfm.com, sent by hand or on a schedule.
 *
 * Every value comes from the work order at the moment it is read; a tracker
 * stores no copy of any row. Everything that decides something — how two
 * filter sets combine, when a schedule next fires, how a value reads to a
 * client, which rows a column-hidden share may carry — is a pure function
 * here so the API, the browser, the email and the tests agree.
 */

import type { WoFilterRule, WoFilterSet, WoSort } from './index';

export const CLIENT_UPDATES_PERM_KEY = 'client_updates';
/** Sending email, turning the public link on or off, and scheduling. */
export const CLIENT_UPDATES_SHARE_PERM_KEY = 'client_updates/share';

/** The address every client update is sent from (MAIL_FROM overrides). */
export const CLIENT_UPDATES_DEFAULT_FROM = 'contact@seamlessfm.com';

// ── Computed columns ─────────────────────────────────────────────────────────
// Catalogue keys the work-order field list gains for this page. They are
// derived at read time (services/woFields.ts holds the SQL), filterable and
// sortable like any other column, and projected only when asked for.

export const COMPUTED_WO_COLUMNS = [
  'location',
  'completed_on',
  'last_client_message',
  'last_client_message_at',
  'last_sent_to_client',
  'age_band',
] as const;
export type ComputedWoColumn = (typeof COMPUTED_WO_COLUMNS)[number];

export function isComputedWoColumn(key: string): key is ComputedWoColumn {
  return (COMPUTED_WO_COLUMNS as readonly string[]).includes(key);
}

/** How old an open work order is, in bands a chart can read left to right. */
export const AGE_BANDS = ['0–7 days', '8–14 days', '15–30 days', '31–60 days', 'Over 60 days'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export function ageBandOf(days: number | null | undefined): AgeBand | null {
  if (days === null || days === undefined || !Number.isFinite(days)) return null;
  if (days <= 7) return AGE_BANDS[0];
  if (days <= 14) return AGE_BANDS[1];
  if (days <= 30) return AGE_BANDS[2];
  if (days <= 60) return AGE_BANDS[3];
  return AGE_BANDS[4];
}

// ── The tracker ──────────────────────────────────────────────────────────────

export interface ClientUpdateColumn {
  /** Work-order catalogue key: 'ext_name', 'status', 'fields.Store', 'completed_on', … */
  key: string;
  /** The header the client reads ('WO MGR', 'Comp On'); null = the field's own label. */
  label: string | null;
  /** false = our team sees it on the page; the email, the CSV and the link never carry it. */
  shared: boolean;
}

export const CLIENT_UPDATE_CHART_KINDS = ['bar', 'donut'] as const;
export type ClientUpdateChartKind = (typeof CLIENT_UPDATE_CHART_KINDS)[number];

export interface ClientUpdateChart {
  /** The field the chart counts work orders by. */
  field: string;
  kind: ClientUpdateChartKind;
  /** Shown on the public link and in the email when charts are shared. */
  shared: boolean;
}

export const SCHEDULE_FREQUENCIES = ['daily', 'weekdays', 'weekly', 'monthly'] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export const SCHEDULE_FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  daily: 'Every day',
  weekdays: 'Every weekday (Mon–Fri)',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export interface ClientUpdateSchedule {
  enabled: boolean;
  frequency: ScheduleFrequency;
  /** 0 = Sunday … 6 = Saturday; used by 'weekly'. */
  weekdays: number[];
  /** 1–28 (so every month has it); used by 'monthly'. */
  day_of_month: number;
  /** 'HH:MM', 24-hour, in America/Chicago. */
  time: string;
}

export interface ClientUpdateRecipient {
  email: string;
  name: string | null;
}

export interface ClientUpdateEmailSettings {
  /** null = "<Tracker name> — work order update · <date>". */
  subject: string | null;
  /** A short paragraph above the table ("Hi team, here is where …"). */
  intro: string | null;
  to: ClientUpdateRecipient[];
  cc: ClientUpdateRecipient[];
  /** Attach the shared columns as a CSV the client can open in Excel. */
  attach_csv: boolean;
  /** Put an "Open the live tracker" button in the email (needs the link on). */
  include_link: boolean;
}

export interface ClientUpdateShareSettings {
  /** The public read-only link is live. */
  enabled: boolean;
  /** Present to people who may share; the link is `/share/client-updates/<token>`. */
  token: string | null;
  /** The link stops working after this instant; null = until turned off. */
  expires_at: string | null;
  /** Draw the shared charts on the link and in the email. */
  charts: boolean;
  /** Show the headline tiles (open, waiting on you, completed, …). */
  summary: boolean;
}

export interface ClientUpdate {
  id: string;
  name: string;
  /** task.client this tracker is about; null = no client rule (the filter decides). */
  client: string | null;
  description: string | null;
  filters: WoFilterSet;
  columns: ClientUpdateColumn[];
  sort: WoSort | null;
  /** Section the list by this field ('status' reads like the sheet); null = one list. */
  group_by: string | null;
  charts: ClientUpdateChart[];
  /** The text field our team types the client's note into, editable in the row. */
  note_field: string | null;
  share: ClientUpdateShareSettings;
  email: ClientUpdateEmailSettings;
  schedule: ClientUpdateSchedule | null;
  next_run_at: string | null;
  last_sent_at: string | null;
  created_by: { id: string; display_name: string } | null;
  created_at: string;
  updated_at: string;
}

export interface ClientUpdateInput {
  name: string;
  client?: string | null;
  description?: string | null;
  filters?: WoFilterSet;
  columns?: ClientUpdateColumn[];
  sort?: WoSort | null;
  group_by?: string | null;
  charts?: ClientUpdateChart[];
  note_field?: string | null;
  share?: Partial<Omit<ClientUpdateShareSettings, 'token'>>;
  email?: Partial<ClientUpdateEmailSettings>;
  schedule?: ClientUpdateSchedule | null;
}

export interface ClientUpdatesResponse {
  items: ClientUpdate[];
  /** Whether an email provider is configured, and who mail comes from. */
  mail: MailStatus;
}

export interface MailStatus {
  configured: boolean;
  provider: 'graph' | 'resend' | null;
  from: string;
}

export const DELIVERY_TRIGGERS = ['manual', 'scheduled', 'test'] as const;
export type DeliveryTrigger = (typeof DELIVERY_TRIGGERS)[number];

export interface ClientUpdateDelivery {
  id: string;
  trigger: DeliveryTrigger;
  to: string[];
  cc: string[];
  subject: string;
  status: 'sent' | 'failed';
  error: string | null;
  row_count: number;
  columns: string[];
  sent_by: { id: string; display_name: string } | null;
  created_at: string;
}

// ── Headline tiles ───────────────────────────────────────────────────────────
// Each tile is a count (or a sum) over the tracker's rows, and the rules that
// narrow the list to exactly those rows — so a click on a tile shows what it
// counted. Statuses by NAME: 'Waiting for Advice' / 'Waiting for Approval' are
// the sheet's "Awaiting Advice" / "Awaiting Approval".

export const CLOSED_GROUPS = ['done', 'closed'];
export const WAITING_ON_CLIENT_STATUSES = ['Waiting for Advice', 'Waiting for Approval'];

export interface SummaryTileDef {
  key: 'open' | 'waiting_on_client' | 'completed_30d' | 'aged_over_30' | 'open_nte';
  label: string;
  hint: string;
  rules: WoFilterRule[];
  /** Sum NTE instead of counting. */
  money?: boolean;
}

export const SUMMARY_TILES: SummaryTileDef[] = [
  {
    key: 'open',
    label: 'Open',
    hint: 'Not completed or closed',
    rules: [{ field: 'status_group', op: 'not_in', value: CLOSED_GROUPS }],
  },
  {
    key: 'waiting_on_client',
    label: 'Waiting on the client',
    hint: 'Waiting for advice or approval',
    rules: [{ field: 'status', op: 'in', value: WAITING_ON_CLIENT_STATUSES }],
  },
  {
    key: 'aged_over_30',
    label: 'Open over 30 days',
    hint: 'Received more than 30 days ago',
    rules: [
      { field: 'status_group', op: 'not_in', value: CLOSED_GROUPS },
      { field: 'age_days', op: 'gt', value: 30 },
    ],
  },
  {
    key: 'completed_30d',
    label: 'Completed, last 30 days',
    hint: 'Completed or closed in the last 30 days',
    rules: [{ field: 'completed_on', op: 'gte', value: 'today-30' }],
  },
  {
    key: 'open_nte',
    label: 'NTE on open work',
    hint: 'Sum of the NTE on open work orders',
    rules: [{ field: 'status_group', op: 'not_in', value: CLOSED_GROUPS }],
    money: true,
  },
];

export interface ClientUpdateSummary {
  total: number;
  tiles: Record<SummaryTileDef['key'], number>;
}

export interface ChartBucket {
  /** null = not set. */
  value: string | null;
  n: number;
}

export interface ClientUpdateChartResult {
  field: string;
  label: string;
  kind: ClientUpdateChartKind;
  total: number;
  buckets: ChartBucket[];
  other: number;
}

export interface ClientUpdateInsights {
  summary: ClientUpdateSummary;
  charts: ClientUpdateChartResult[];
}

/** What the public link and the email both render — shared columns only. */
export interface ClientUpdatePublicView {
  name: string;
  client: string | null;
  intro: string | null;
  generated_at: string;
  columns: { key: string; label: string; type: string }[];
  rows: { cells: (string | number | null)[]; facets: Record<string, string | null> }[];
  truncated: boolean;
  summary: ClientUpdateSummary | null;
  charts: ClientUpdateChartResult[];
  group_by: string | null;
}

// ── Defaults: the SUN Holdings sheet, column for column ─────────────────────

export const DEFAULT_NOTE_FIELD = 'fields.20. Last Update';

export const DEFAULT_CLIENT_UPDATE_COLUMNS: ClientUpdateColumn[] = [
  { key: 'ext_name', label: 'WO #', shared: true },
  { key: 'fields.Assignee', label: 'Dispatcher', shared: true },
  { key: 'fields.✅ Client AFM', label: 'WO Mgr', shared: true },
  { key: 'trade', label: 'Trade', shared: true },
  { key: 'title', label: 'Asset', shared: true },
  { key: 'fields.Store', label: 'Store', shared: true },
  { key: 'location', label: 'Location', shared: true },
  { key: 'date_received', label: 'Rec On', shared: true },
  { key: 'completed_on', label: 'Comp On', shared: true },
  { key: 'status', label: 'Status', shared: true },
  { key: 'nte', label: 'NTE', shared: true },
  { key: DEFAULT_NOTE_FIELD, label: 'Client Notes', shared: true },
  // Ours only until someone ticks them: the internal number, the age, cost.
  { key: 'wo_number', label: 'Our WO #', shared: false },
  { key: 'age_days', label: 'Age', shared: false },
  { key: 'fields.34. Cost', label: 'Cost', shared: false },
  { key: 'last_sent_to_client', label: 'Last sent', shared: false },
];

export const DEFAULT_CLIENT_UPDATE_CHARTS: ClientUpdateChart[] = [
  { field: 'status', kind: 'bar', shared: true },
  { field: 'trade', kind: 'donut', shared: true },
  { field: 'fields.Store', kind: 'bar', shared: true },
  { field: 'age_band', kind: 'bar', shared: true },
  { field: 'fields.Assignee', kind: 'bar', shared: false },
  { field: 'location', kind: 'bar', shared: false },
];

export const DEFAULT_SCHEDULE: ClientUpdateSchedule = {
  enabled: false,
  frequency: 'weekly',
  weekdays: [1],
  day_of_month: 1,
  time: '08:00',
};

export const MAX_TRACKER_COLUMNS = 40;
export const MAX_TRACKER_CHARTS = 8;
export const MAX_RECIPIENTS = 50;
/** Rows a share (email, CSV, link) carries; more says "narrow the tracker". */
export const SHARE_ROW_CAP = 2000;

export function sharedColumns(columns: ClientUpdateColumn[]): ClientUpdateColumn[] {
  return columns.filter((c) => c.shared);
}

// ── Filters ──────────────────────────────────────────────────────────────────

/** A tracker's client as a filter rule on task.client. */
export function clientRule(client: string | null | undefined): WoFilterRule[] {
  const c = (client ?? '').trim();
  return c ? [{ field: 'client', op: 'eq', value: c }] : [];
}

/**
 * `base AND every one of extra`, as ONE filter set the compiler understands.
 *
 * The compiler reads a set with joins as OR-separated groups of ANDs (AND
 * binds tighter), and a set without joins as all-AND or all-OR by `match`.
 * ANDing extra rules onto a set that ORs anything therefore means appending
 * them to EVERY OR group — (a OR b) AND x is (a AND x) OR (b AND x) — which
 * is how a chart click narrows a tracker whose own filter is "any of".
 */
export function andFilters(base: WoFilterSet | null | undefined, extra: WoFilterRule[]): WoFilterSet {
  const baseRules = (base?.rules ?? []).map((r) => ({ ...r }));
  const extraRules = extra.map(({ join: _j, ...r }) => ({ ...r }));
  if (baseRules.length === 0) return { match: 'all', rules: extraRules };
  if (extraRules.length === 0) return { match: base?.match ?? 'all', rules: baseRules };

  // Break the base into its OR groups, rule objects without their joins.
  const groups: WoFilterRule[][] = [];
  const hasJoins = baseRules.some((r) => r.join);
  if (hasJoins) {
    baseRules.forEach(({ join, ...r }, i) => {
      if (i === 0 || join === 'or') groups.push([r]);
      else groups[groups.length - 1].push(r);
    });
  } else if (base?.match === 'any') {
    for (const { join: _j, ...r } of baseRules) groups.push([r]);
  } else {
    groups.push(baseRules.map(({ join: _j, ...r }) => r));
  }

  if (groups.length === 1) return { match: 'all', rules: [...groups[0], ...extraRules] };

  const rules: WoFilterRule[] = [];
  groups.forEach((g, gi) => {
    [...g, ...extraRules].forEach((r, ri) => {
      rules.push({ ...r, join: ri === 0 ? (gi === 0 ? undefined : 'or') : 'and' });
    });
  });
  // The first rule carries no join; strip the undefined so the JSON is clean.
  return { match: 'all', rules: rules.map((r) => (r.join === undefined ? (({ join: _j, ...x }) => x)(r) : r)) };
}

/** The rule a chart segment (or "not set") narrows the list with. */
export function bucketRule(field: string, value: string | null): WoFilterRule {
  return value === null || value === ''
    ? { field, op: 'is_not_set' }
    : { field, op: 'eq', value };
}

/** The whole question a tracker asks: its client, its filter, then any drill. */
export function trackerFilters(
  t: Pick<ClientUpdate, 'client' | 'filters'>,
  drill: WoFilterRule[] = [],
): WoFilterSet {
  return andFilters(t.filters, [...clientRule(t.client), ...drill]);
}

// ── Values as a client reads them ────────────────────────────────────────────

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

function usDate(y: string, m: string, d: string): string {
  return `${m}/${d}/${y}`;
}

/**
 * A cell as the client sees it — in the email, the CSV and the link. US
 * dates (the sheet's), dollars with cents, Yes/No, and '' for nothing so an
 * empty cell stays empty in Excel.
 */
export function formatClientValue(value: unknown, type: string, key = ''): string {
  if (value === null || value === undefined || value === '') return '';
  if (key === 'age_days') {
    const n = Number(value);
    return Number.isFinite(n) ? `${n} day${n === 1 ? '' : 's'}` : String(value);
  }
  switch (type) {
    case 'money': {
      const n = Number(String(value).replace(/[$,\s]/g, ''));
      return Number.isFinite(n) ? MONEY.format(n) : String(value);
    }
    case 'date':
    case 'datetime': {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
      return m ? usDate(m[1], m[2], m[3]) : String(value);
    }
    case 'boolean': {
      const s = String(value).toLowerCase();
      return s === 'true' || s === 'yes' || s === '1' ? 'Yes' : s === 'false' || s === 'no' || s === '0' ? 'No' : String(value);
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value);
    }
    default:
      return String(value).trim();
  }
}

// ── Schedules ────────────────────────────────────────────────────────────────

export const SCHEDULE_TIME_ZONE = 'America/Chicago';

export function isValidScheduleTime(t: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
}

/** Wall-clock parts of an instant in a time zone. */
function zonedParts(at: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(at)) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    dow: WEEKDAY_LABELS.indexOf(parts.weekday as (typeof WEEKDAY_LABELS)[number]),
  };
}

/** The instant a wall-clock time in `tz` happens (DST-correct to the minute). */
export function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // The zone's offset at the guess, then once more at the corrected instant —
  // the second pass settles the hour either side of a DST change.
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(t), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    t = t + (guess - asUtc);
  }
  return new Date(t);
}

function scheduleMatchesDay(s: ClientUpdateSchedule, dow: number, dayOfMonth: number): boolean {
  switch (s.frequency) {
    case 'daily':
      return true;
    case 'weekdays':
      return dow >= 1 && dow <= 5;
    case 'weekly':
      return (s.weekdays.length ? s.weekdays : [1]).includes(dow);
    case 'monthly':
      return dayOfMonth === Math.min(28, Math.max(1, s.day_of_month || 1));
  }
}

/**
 * The first time the schedule fires strictly after `after`, or null when it
 * is off. Days are walked in the business time zone, so "8:00 every Monday"
 * is 8:00 in Chicago on both sides of daylight saving.
 */
export function nextRunAt(s: ClientUpdateSchedule | null | undefined, after: Date, tz = SCHEDULE_TIME_ZONE): Date | null {
  if (!s || !s.enabled || !isValidScheduleTime(s.time)) return null;
  const [hh, mm] = s.time.split(':').map(Number);
  const start = zonedParts(after, tz);
  // Walk calendar days from the zone's "today"; 40 days covers every monthly case.
  const cursor = new Date(Date.UTC(start.y, start.m - 1, start.d));
  for (let i = 0; i < 40; i++) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    const dow = cursor.getUTCDay();
    if (scheduleMatchesDay(s, dow, d)) {
      const at = zonedTimeToUtc(y, m, d, hh, mm, tz);
      if (at.getTime() > after.getTime()) return at;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

export function describeSchedule(s: ClientUpdateSchedule | null | undefined): string {
  if (!s || !s.enabled) return 'Not scheduled';
  const at = formatTime12(s.time);
  switch (s.frequency) {
    case 'daily':
      return `Every day at ${at}`;
    case 'weekdays':
      return `Weekdays at ${at}`;
    case 'weekly': {
      const days = (s.weekdays.length ? s.weekdays : [1]).slice().sort().map((d) => WEEKDAY_LABELS[d]);
      return `Every ${days.join(', ')} at ${at}`;
    }
    case 'monthly':
      return `Monthly on day ${s.day_of_month} at ${at}`;
  }
}

export function formatTime12(t: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return t;
  const h = Number(m[1]);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix} CT`;
}

// ── Recipients and links ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/;

export function isEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

/**
 * Pasted addresses — "Ann <ann@x.com>, bob@y.com; carol@z.com" — as
 * recipients, de-duplicated case-insensitively, plus whatever did not parse.
 */
export function parseRecipients(text: string): { recipients: ClientUpdateRecipient[]; invalid: string[] } {
  const recipients: ClientUpdateRecipient[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,;\n]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const angled = /^(.*?)<([^>]+)>$/.exec(part);
    const email = (angled ? angled[2] : part).trim().replace(/^mailto:/i, '');
    const name = angled ? angled[1].trim().replace(/^"|"$/g, '') || null : null;
    if (!isEmail(email)) {
      invalid.push(part);
      continue;
    }
    const k = email.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    recipients.push({ email, name });
  }
  return { recipients, invalid };
}

export function formatRecipient(r: ClientUpdateRecipient): string {
  return r.name ? `${r.name} <${r.email}>` : r.email;
}

/** Share tokens are 32 url-safe characters; anything else is not looked up. */
export function isShareTokenShape(t: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(t);
}

export function shareLinkLive(share: Pick<ClientUpdateShareSettings, 'enabled' | 'token' | 'expires_at'>, now: Date): boolean {
  if (!share.enabled || !share.token) return false;
  if (share.expires_at && new Date(share.expires_at).getTime() <= now.getTime()) return false;
  return true;
}

export function sharePath(token: string): string {
  return `/share/client-updates/${token}`;
}

export function defaultSubject(name: string, when: Date): string {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(when);
  return `${name} — work order update · ${day}`;
}
