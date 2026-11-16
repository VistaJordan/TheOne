// The Notifications page (Elise, 2026-11-04): one inbox for everything that
// happened to a person — the `app_notice` rows (0059, "For you") and, for
// whoever holds the Pulse, the Pulse's escalation pings (`notification`,
// 0004). The bell in the top bar is gone; this page is where they are read.
//
// Pure vocabulary: which TYPE a notice is, which GROUP the type sits in, and
// the day bands the list is drawn in. The API sends the raw `kind`; the page
// and the API's filters agree on what a type is through these tables.

/** A Pulse ping's kind on the inbox: `pulse.<rule_key>`. */
export const PULSE_NOTICE_PREFIX = 'pulse.';

export type NoticeSource = 'notice' | 'pulse';

export type NoticeGroupId = 'work_orders' | 'approvals' | 'vendors' | 'pulse' | 'other';

export const NOTICE_GROUPS: { id: NoticeGroupId; label: string }[] = [
  { id: 'work_orders', label: 'Work orders' },
  { id: 'approvals', label: 'Approvals & requests' },
  { id: 'vendors', label: 'Vendors' },
  { id: 'pulse', label: 'Pulse escalations' },
  { id: 'other', label: 'Other' },
];

/** Every kind `notify()` raises today, with the name the page prints. A kind
    that is not listed still shows, under Other, with its code tidied up. */
export const NOTICE_TYPES: Record<string, { label: string; group: NoticeGroupId }> = {
  wo_assigned: { label: 'Assigned to you', group: 'work_orders' },
  assignment: { label: 'Assignment Manager', group: 'work_orders' },
  wo_mention: { label: 'Mentions', group: 'work_orders' },
  wo_message: { label: 'Messages on your work orders', group: 'work_orders' },
  dispatch: { label: 'Dispatch offers', group: 'work_orders' },
  vendor_portal: { label: 'Vendor portal notes', group: 'work_orders' },
  request_decided: { label: 'Request decisions', group: 'approvals' },
  nte_increase: { label: 'NTE increase requests', group: 'approvals' },
  nte_increase_decided: { label: 'NTE increase decisions', group: 'approvals' },
  work_permit: { label: 'Work permits', group: 'approvals' },
  purchasing: { label: 'Purchasing', group: 'approvals' },
  credit_note: { label: 'Credit notes', group: 'approvals' },
  asset_request: { label: 'Asset requests', group: 'approvals' },
  asset_request_decided: { label: 'Asset request decisions', group: 'approvals' },
  vendor_review: { label: 'Vendor reviews', group: 'vendors' },
  vendor_task: { label: 'Vendor tasks', group: 'vendors' },
  vendor_task_decided: { label: 'Vendor task decisions', group: 'vendors' },
  vendor_assigned: { label: 'Vendors handed to you', group: 'vendors' },
  vendor_blacklisted: { label: 'Blacklisted vendors', group: 'vendors' },
  vendor_expiry: { label: 'Insurance dates', group: 'vendors' },
  vendor_onboarding: { label: 'Vendor onboarding', group: 'vendors' },
  quote_due: { label: 'Quotes due', group: 'work_orders' },
};

/** A decided approval task (status change, snooze, money hold), told to the
    requester and the work order's assigned dispatcher(s) (Elise, 2026-11-14). */
export const REQUEST_DECIDED_NOTICE_KIND = 'request_decided';

/** "Status change approved on WO-123 by Jordan". */
export function requestDecidedNoticeTitle(
  typeLabel: string,
  decision: 'approved' | 'rejected',
  woNumber: string,
  byName: string | null,
): string {
  const by = byName && byName.trim() !== '' ? ` by ${byName.trim()}` : '';
  return `${typeLabel} ${decision} on ${woNumber}${by}`;
}

/** The Pulse rules, in the wording the Pulse page prints for them. */
export const PULSE_RULE_LABELS: Record<string, string> = {
  emergency_ack: 'Emergency not acknowledged',
  quote_owed: 'Quote owed to the client',
  schedule_owed: 'ETA owed after approval',
  approval_followup: 'Client approval needs chasing',
  quote_review_owed: 'Quote waiting on review',
  payment_processing: 'Payment request unprocessed',
  sla_blown: 'SLA date blown',
};

function tidy(code: string): string {
  const s = code.replace(/[_.]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Notification';
}

export function noticeType(kind: string): { kind: string; label: string; group: NoticeGroupId } {
  if (kind.startsWith(PULSE_NOTICE_PREFIX)) {
    const rule = kind.slice(PULSE_NOTICE_PREFIX.length);
    return { kind, label: PULSE_RULE_LABELS[rule] ?? tidy(rule), group: 'pulse' };
  }
  const t = NOTICE_TYPES[kind];
  return t ? { kind, ...t } : { kind, label: tidy(kind), group: 'other' };
}

/** The kinds of a group among the ones a person actually has. */
export function kindsInGroup(group: NoticeGroupId, kinds: string[]): string[] {
  return kinds.filter((k) => noticeType(k).group === group);
}

export type NoticeReadFilter = 'all' | 'unread' | 'read';

export interface NoticeInboxItem {
  /** `notice` ids and `pulse` ids come from two tables; the pair is the key. */
  source: NoticeSource;
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  actor: { id: string; name: string; kind: 'human' | 'service' } | null;
  /** Pulse pings only. */
  wo_number: string | null;
  tier: number | null;
  read: boolean;
  created_at: string;
}

export interface NoticeTypeCount {
  kind: string;
  total: number;
  unread: number;
}

export interface NoticeInboxResponse {
  items: NoticeInboxItem[];
  /** How many match the filter (read state, types, search), all pages. */
  matching: number;
  /** Every unread notification the person has, whatever the filter. */
  unread: number;
  total: number;
  /** One row per type the person has, whatever the filter. */
  types: NoticeTypeCount[];
  /** Pass back as `before` for the next page; null = the last page. */
  next_before: string | null;
  /** Whether the Pulse's pings are part of this inbox (the Pulse grant). */
  includes_pulse: boolean;
  /** After hours is on: every work order's notices, not only the person's jobs. */
  all_work_orders: boolean;
}

export const NOTICE_PAGE_SIZE = 50;

export type NoticeDayBand = 'Today' | 'Yesterday' | 'Earlier this week' | 'Earlier';

/** The day band a notice is drawn under, on the viewer's own calendar. */
export function noticeDayBand(iso: string, now: Date): NoticeDayBand {
  const at = new Date(iso);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = at.getTime();
  if (t >= start) return 'Today';
  if (t >= start - 86_400_000) return 'Yesterday';
  if (t >= start - 6 * 86_400_000) return 'Earlier this week';
  return 'Earlier';
}

/** The cursor: the last row's time and key, so rows sharing a second are
    neither skipped nor repeated. */
export function noticeCursor(item: Pick<NoticeInboxItem, 'created_at' | 'source' | 'id'>): string {
  return `${item.created_at}|${item.source}:${item.id}`;
}

export function parseNoticeCursor(raw: string | null | undefined): { at: string; key: string } | null {
  if (!raw) return null;
  const i = raw.indexOf('|');
  if (i <= 0) return null;
  const at = raw.slice(0, i);
  const key = raw.slice(i + 1);
  if (Number.isNaN(Date.parse(at)) || !/^(notice|pulse):[0-9a-f-]{36}$/i.test(key)) return null;
  return { at, key };
}

// ── Only the people on the job (Elise, 2026-11-16) ──────────────────────────
//
// Notifications and approvals about a work order show only to the people
// assigned to it: whoever sits in one of these seats of the work order. The
// rest stays reachable through **After hours**, a switch on the Notifications
// and Approvals pages that shows every work order the person may open — each
// press is logged (`after_hours_opened` / `after_hours_closed`).

/** The work-order seats that make a person "on the job". */
export const ASSIGNED_SEAT_KEYS = ['Assignee', 'Support Trainee', 'TL', 'ATL', 'AM', 'Completion Assignee'] as const;

/** Kinds shown whoever holds the work order: someone asked for this person by
    name (a mention), or it answers their own request. */
export const NOTICE_KINDS_ALWAYS_SHOWN: readonly string[] = ['wo_mention', 'request_decided'];

/** True when `name` sits in one of the assigned seats of this bag (each seat
    is a comma-joined list of display names). The pure twin of the SQL in
    `assignedToSql` (api `services/woScope.ts`). */
export function isAssignedTo(bag: Record<string, unknown> | null | undefined, name: string | null | undefined): boolean {
  const me = (name ?? '').trim().toLowerCase();
  if (!me || !bag) return false;
  for (const key of ASSIGNED_SEAT_KEYS) {
    const v = bag[key];
    if (typeof v !== 'string') continue;
    if (v.split(',').some((n) => n.trim().toLowerCase() === me)) return true;
  }
  const assignee = typeof bag.Assignee === 'string' ? bag.Assignee.trim() : '';
  const legacy = typeof bag['Assignee Name TXT'] === 'string' ? (bag['Assignee Name TXT'] as string).trim().toLowerCase() : '';
  return assignee === '' && legacy !== '' && legacy === me;
}

/** The two pages that have the After hours switch. */
export type AfterHoursPage = 'notifications' | 'approvals';
export const AFTER_HOURS_PAGES: readonly AfterHoursPage[] = ['notifications', 'approvals'];

/** How long a press lasts before the page goes back to "my jobs". */
export const AFTER_HOURS_HOURS = 12;

export interface AfterHoursState {
  notifications: boolean;
  approvals: boolean;
}

// ── Quotes due (Elise, 2026-11-16) ──────────────────────────────────────────
//
// A work order that sits in Waiting for Quote owes its quote 48 working hours
// after it got there (weekends and holidays skipped, like the quote clock).
// From the morning of that day the people on the job get a reminder, and
// again every day after while the quote is still not submitted.

export const QUOTE_DUE_NOTICE_KIND = 'quote_due';
export const QUOTE_DUE_STATUS_NAME = 'Waiting for Quote';
export const QUOTE_DUE_AFTER_HOURS = 48;

export type QuoteDueState = 'not_yet' | 'due_today' | 'overdue';

/** Where a quote stands on `today` ('YYYY-MM-DD', Chicago) given its due day. */
export function quoteDueState(dueDay: string, today: string): QuoteDueState {
  if (today < dueDay) return 'not_yet';
  return today === dueDay ? 'due_today' : 'overdue';
}

/** "Quote due today on WO-123" / "Quote overdue on WO-123 (was due Nov 14)". */
export function quoteDueNoticeTitle(woNumber: string, state: Exclude<QuoteDueState, 'not_yet'>, dueDay: string): string {
  if (state === 'due_today') return `Quote due today on ${woNumber}`;
  const [y, m, d] = dueDay.split('-').map(Number);
  const label = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `Quote overdue on ${woNumber} (was due ${label})`;
}
