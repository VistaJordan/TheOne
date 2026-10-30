// ── UAT round 1, Wave D (migration 0086): data quality ──────────────────────
//
// The pure half of Wave D's validation — the API refuses with it (400,
// `details.code = VALIDATION`, `details.field`) and the web can say the same
// sentence before the click. Nothing here opens a database. Decisions: #11,
// #22, M2, L3 in docs/specs/uat-round-1.md.
//
// What is checked is the value being WRITTEN, never a value already stored:
// a CSV row loaded before these rules keeps what it has until somebody edits
// that field.

import { VALIDATION_CODE } from './moneyGuards';
import { US_STATE_CODES } from './vendors';
import { permAllows, type PermissionSet } from './permissions';
import type { WoFilterRule, WoFilterSet } from './index';

// ── #11 · one client list ────────────────────────────────────────────────────

/** The bag key (and the promoted `task.client` column) the client lives in. */
export const CLIENT_FIELD_KEY = 'Client';

/** `details.code` when a client name is not a client record on file. */
export const CLIENT_NOT_ON_FILE_CODE = 'CLIENT_NOT_ON_FILE';

/** `details.code` when a CSV import names clients that are not on file. */
export const IMPORT_UNKNOWN_CLIENT_CODE = 'IMPORT_UNKNOWN_CLIENT';

/** The join key every client match uses (0062): case and outer spaces. */
export function clientKey(name: string | null | undefined): string {
  return String(name ?? '').trim().toLowerCase();
}

/** The record's spelling for a typed name, or null when no ACTIVE record
    matches. `records` is every client record's name and whether it is
    active. */
export function matchClientRecord(
  typed: string | null | undefined,
  records: readonly { name: string; is_active: boolean }[],
): string | null {
  const k = clientKey(typed);
  if (!k) return null;
  const hit = records.find((r) => r.is_active && clientKey(r.name) === k);
  return hit ? hit.name : null;
}

export function clientNotOnFileMessage(name: string): string {
  return `"${name}" is not a client on file — pick a client from the list (Clients holds the list; ask an admin to add a new one)`;
}

// ── #22 / M22 · the assignee is a dispatcher ─────────────────────────────────

/** `details.code` when an assignee is not an active dispatcher (D3). */
export const ASSIGNEE_NOT_DISPATCHER_CODE = 'ASSIGNEE_NOT_DISPATCHER';

export function assigneeNotDispatcherMessage(names: readonly string[]): string {
  const list = names.map((n) => `"${n}"`).join(', ');
  return names.length === 1
    ? `${list} is not an active dispatcher — a work order is assigned to an OM Under Probation, OM or Senior OM`
    : `${list} are not active dispatchers — a work order is assigned to an OM Under Probation, OM or Senior OM`;
}

// ── Completion Assignee is AR (Elise, 2026-10-30) ───────────────────────────

/** The work-order field naming who closes the job out with the client. */
export const COMPLETION_ASSIGNEE_KEY = 'Completion Assignee';

/** The roles a Completion Assignee holds: Accounts Receivable only. */
export const COMPLETION_ASSIGNEE_ROLE_CODES = ['ar'] as const;

/** `details.code` when a Completion Assignee is not an active AR user. */
export const COMPLETION_ASSIGNEE_NOT_AR_CODE = 'COMPLETION_ASSIGNEE_NOT_AR';

export function completionAssigneeNotArMessage(names: readonly string[]): string {
  const list = names.map((n) => `"${n}"`).join(', ');
  return names.length === 1
    ? `${list} is not an active AR user — the Completion Assignee must hold the AR role`
    : `${list} are not active AR users — the Completion Assignee must hold the AR role`;
}

/** Person fields whose picker lists one role only (besides the AM / TL / ATL
    seats, `seatRoleForField`): bag key → role code. */
export const ROLE_LIMITED_PERSON_FIELDS: Readonly<Record<string, string>> = {
  [COMPLETION_ASSIGNEE_KEY]: 'ar',
};

/** `details.code` when an assignee names a disabled account — asked of every
    writer of the seat, the automations, the PM raise and the CSV import too. */
export const ASSIGNEE_DISABLED_CODE = 'ASSIGNEE_DISABLED';

export function assigneeDisabledMessage(names: readonly string[]): string {
  const list = names.map((n) => `"${n}"`).join(', ');
  return names.length === 1
    ? `${list} is a disabled account — a work order cannot be assigned to them`
    : `${list} are disabled accounts — a work order cannot be assigned to them`;
}

/** The bell notice a person gets when a work order is assigned to them
    (2026-10-30, services/assignmentNotices.ts). */
export const WO_ASSIGNED_NOTICE_KIND = 'wo_assigned';

/** "Josh assigned you WO-1234" — or, when a rule or the system did it,
    "WO-1234 was assigned to you". */
export function assignedNoticeTitle(woNumber: string, byName: string | null): string {
  return byName && byName.trim() !== '' ? `${byName.trim()} assigned you ${woNumber}` : `${woNumber} was assigned to you`;
}

/** Names in a comma-joined `users` value, trimmed, blanks dropped. */
export function assigneeNames(v: unknown): string[] {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The names in `after` that were not in `before` (case-insensitive) — only
    a name being ADDED to the seat is checked, so keeping an old assignee who
    has since changed role is not refused. */
export function addedAssignees(before: unknown, after: unknown): string[] {
  const had = new Set(assigneeNames(before).map((n) => n.toLowerCase()));
  return assigneeNames(after).filter((n) => !had.has(n.toLowerCase()));
}

// ── M2 · field values ────────────────────────────────────────────────────────

/** WO # on create: letters, digits and dashes, 3 to 40 characters. */
export const WO_NUMBER_RE = /^[A-Za-z0-9-]{3,40}$/;

export function woNumberProblem(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (s === '') return 'A work order needs its WO #';
  if (!WO_NUMBER_RE.test(s)) return 'A WO # is 3 to 40 letters, digits or dashes (no spaces or other punctuation)';
  return null;
}

/** A State value is one of `US_STATE_CODES` (the 50 states and DC, the
    vendors' list), stored upper-case. */
export const STATE_FIELD_KEY = 'State';

/** The two-letter code, upper-cased, or null when it is not one. */
export function normalizeUsState(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toUpperCase();
  return (US_STATE_CODES as readonly string[]).includes(s) ? s : null;
}

/** No date on a work order is before this year (a typo like 0202 or 1926). */
export const DATE_FLOOR_YEAR = 2000;

export function dateFloorProblem(label: string, iso: string): string | null {
  const y = Number(String(iso).slice(0, 4));
  if (!Number.isFinite(y) || y < DATE_FLOOR_YEAR) return `"${label}" cannot be before ${DATE_FLOOR_YEAR}`;
  return null;
}

/** Received on ≤ Due date (bag keys). */
export const RECEIVED_ON_KEY = 'Date-Time Received';
export const DUE_DATE_KEY = 'Due Date';

/** The sentence when the due date is before the day the work order came in;
    null when either is missing or the order is right. Compared as ISO text
    (both are 'YYYY-MM-DD[THH:MM]'), on the minutes both carry. */
export function dateOrderProblem(received: unknown, due: unknown): string | null {
  const a = typeof received === 'string' ? received.trim() : '';
  const b = typeof due === 'string' ? due.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}/.test(a) || !/^\d{4}-\d{2}-\d{2}/.test(b)) return null;
  const len = a.length >= 16 && b.length >= 16 ? 16 : 10;
  if (a.slice(0, len) > b.slice(0, len)) return 'The due date cannot be before the date the work order was received';
  return null;
}

/** A dropdown value matched to its option (case and outer spaces ignored),
    returning the option's own spelling; null when it is not an option. */
export function matchOption(options: readonly string[], raw: unknown): string | null {
  const k = String(raw ?? '').trim().toLowerCase();
  if (!k) return null;
  return options.find((o) => o.trim().toLowerCase() === k) ?? null;
}

// ── M10 · Raise now raises the upcoming occurrence once ──────────────────────

export const PM_ALREADY_RAISED_CODE = 'PM_ALREADY_RAISED';

export function pmAlreadyRaisedMessage(dueOn: string, woNumber: string | null): string {
  return `The next occurrence (${dueOn}) is already raised${woNumber ? ` as ${woNumber}` : ''} — Raise now makes the upcoming work order once; the one after it goes out when it comes due`;
}

// ── M11 / T9 · "No visit logged" counts work that is owed a visit now ────────

/** The statuses a work order can sit in and still be owed a visit is every
    open / active / pending one EXCEPT the billing status filed under active
    (Invoiced Not Paid). Since UAT follow-up T9 the Sched statuses are no
    longer dropped wholesale: whether the visit is for later is the work
    order's own Scheduled Date (`noVisitLoggedFilter`). */
export const NO_VISIT_EXCLUDED_STATUSES: readonly string[] = ['Invoiced Not Paid'];

/** The groups that are live work (not done, closed or cancelled). */
export const NO_VISIT_STATUS_GROUPS: readonly string[] = ['open', 'active', 'pending'];

/** The catalogue keys the card reads: the latest visit's type (0021 mirror —
    unset = no visit logged yet) and the hand-typed Scheduled Date (0030). */
export const NO_VISIT_VISIT_TYPE_FIELD = 'fields.Visit Type';
export const NO_VISIT_SCHEDULED_FIELD = 'fields.Scheduled Date';

/**
 * T9 · the rows behind "No visit logged": live work with no visit, whose
 * Scheduled Date is empty or on / before today — a visit booked for a later
 * day is not a visit missing. The filter language has no grouping brackets,
 * only AND binding tighter than OR, so "A and (empty or ≤ today)" is written
 * distributed: (A and empty) OR (A and ≤ today). `today` is resolved in SQL
 * on the database's clock (compileRule, 0049), so the count and the list it
 * opens agree on the day.
 */
export function noVisitLoggedFilter(): WoFilterSet {
  const live = (): WoFilterRule[] => [
    { field: NO_VISIT_VISIT_TYPE_FIELD, op: 'is_not_set' },
    { field: 'status_group', op: 'in', value: [...NO_VISIT_STATUS_GROUPS] },
    { field: 'status', op: 'not_in', value: [...NO_VISIT_EXCLUDED_STATUSES] },
  ];
  const [first, ...rest] = live();
  return {
    match: 'all',
    rules: [
      first,
      ...rest.map((r) => ({ ...r, join: 'and' as const })),
      { field: NO_VISIT_SCHEDULED_FIELD, op: 'is_not_set', join: 'and' },
      { ...live()[0], join: 'or' },
      ...live().slice(1).map((r) => ({ ...r, join: 'and' as const })),
      { field: NO_VISIT_SCHEDULED_FIELD, op: 'lte', value: 'today', join: 'and' },
    ],
  };
}

// ── M15 · what an integration's chip says ────────────────────────────────────

export type IntegrationStateTone = 'ok' | 'warn' | 'off' | 'muted';

/** The connection state, not just the switch: "On · set up" only when the
    server holds what the connector needs; "On · not set up" when the switch
    is on but nothing would work; "Off" when it is switched off. */
export function integrationState(it: {
  enabled: boolean;
  configured: boolean;
  built?: boolean;
  locked_off?: string | null;
}): { label: string; tone: IntegrationStateTone } {
  if (it.locked_off) return { label: 'Off · cannot be turned on yet', tone: 'muted' };
  if (!it.enabled) return { label: 'Off', tone: 'off' };
  if (it.built === false) return { label: 'On · connector not built yet', tone: 'muted' };
  if (it.configured) return { label: 'On · set up', tone: 'ok' };
  return { label: 'On · not set up', tone: 'warn' };
}

// ── M16 · who may sign in, said the way the code does it ─────────────────────

/** The Settings "Access" row, from the real sign-in policy (config.signIn):
    an address on an allowed domain enrols itself in the auto-enrol role; any
    other address needs an invitation (its row in Admin › Users). */
export function enrolmentSentence(domains: readonly string[], roleLabel: string): string {
  if (domains.length === 0) return 'Invitation only — every account is created in Admin › Users first';
  const list = domains.map((d) => `@${d}`).join(', ');
  return `${list} accounts enrol themselves as ${roleLabel} on first sign-in; anyone else by invitation (Admin › Users)`;
}

// ── M17 · who may restore from Trash ─────────────────────────────────────────

/** Restoring undoes a delete: the work-order delete right, or Admin › Trash
    edit. Viewing the Trash stays `admin/trash` view. */
export function mayRestoreFromTrash(perms: PermissionSet, isSuperAdmin: boolean): boolean {
  return permAllows(perms, 'work_orders', 'delete', isSuperAdmin) || permAllows(perms, 'admin/trash', 'edit', isSuperAdmin);
}

export const TRASH_RESTORE_REFUSED = 'Restoring a work order needs the right to delete work orders (or Admin › Trash edit)';

// ── #9 · the quote total, every term on screen ───────────────────────────────

export interface QuoteTermsInput {
  rule: 'incurred_plus_option' | 'options_only';
  incurred: number;
  /** The current round's options, in order. */
  options: { id: string; label: string; total: number; included: boolean }[];
  /** The option the Grand Total prices (Yoda), or null. */
  priced_id: string | null;
  sales_tax: number;
  sales_tax_pct: number;
  line_tax: number;
  grand_total: number;
}

export interface QuoteTerm {
  label: string;
  amount: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** The terms the Grand Total is made of, in the order they add up — what the
    on-screen summary draws so the visible numbers sum to the total (D7: the
    Yoda formula is unchanged; this only says it out loud). Yoda: incurred +
    the priced option + sales tax (pct% of the two) + line tax. RULE B: each
    included option + line tax. `sum` is the terms added up, to the cent. */
export function quoteTotalTerms(t: QuoteTermsInput): { terms: QuoteTerm[]; sum: number; adds_up: boolean } {
  const terms: QuoteTerm[] = [];
  if (t.rule === 'options_only') {
    for (const o of t.options) if (o.included) terms.push({ label: `${o.label} lines`, amount: o.total });
  } else {
    terms.push({ label: 'Incurred work', amount: t.incurred });
    const priced = t.options.find((o) => o.id === t.priced_id) ?? null;
    if (priced) terms.push({ label: `${priced.label} lines`, amount: priced.total });
    if (t.sales_tax !== 0 || t.sales_tax_pct !== 0) terms.push({ label: `Sales tax ${t.sales_tax_pct}%`, amount: t.sales_tax });
  }
  if (t.line_tax !== 0) terms.push({ label: 'Line tax', amount: t.line_tax });
  const sum = cents(terms.reduce((a, x) => a + x.amount, 0));
  return { terms, sum, adds_up: Math.abs(sum - cents(t.grand_total)) < 0.015 };
}

/** The server Quote's totals (snake case) as the terms' input. */
export function quoteTermsFromTotals(t: {
  total_rule: 'incurred_plus_option' | 'options_only';
  incurred_subtotal: number;
  option_totals: { section_id: string; label: string; total: number; include_in_summary: boolean }[];
  priced_section_id: string | null;
  sales_tax: number;
  sales_tax_pct: number;
  line_tax: number;
  grand_total: number;
}): QuoteTermsInput {
  return {
    rule: t.total_rule,
    incurred: t.incurred_subtotal,
    options: t.option_totals.map((o) => ({ id: o.section_id, label: o.label, total: o.total, included: o.include_in_summary })),
    priced_id: t.priced_section_id,
    sales_tax: t.sales_tax,
    sales_tax_pct: t.sales_tax_pct,
    line_tax: t.line_tax ?? 0,
    grand_total: t.grand_total,
  };
}

// ── L1 · "Tech reported that Tech found…" ────────────────────────────────────

/** A narrative that already says who reported it ("Tech found…", "The
    technician reported…", "Tech reported that…"). */
const REPORTED_LEAD = /^\s*(the\s+)?(tech|technician|techs|technicians|vendor)\s+(reported|found|said|noted|advised|observed|states?|confirmed|discovered|checked|saw)\b/i;

/** The incurred narrative as the client summary prints it: "Tech reported
    that …" in front, unless the text already opens that way (then it is
    printed as typed, first letter up). */
export function reportedSentence(narrative: string): string {
  const s = narrative.trim();
  if (s === '') return '';
  if (REPORTED_LEAD.test(s)) return s.charAt(0).toUpperCase() + s.slice(1);
  return `Tech reported that ${s}`;
}

// ── L2 · audit times in Eastern time ─────────────────────────────────────────

export const AUDIT_TIME_ZONE = 'America/New_York';

function etParts(iso: string): Record<string, string> | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: AUDIT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const out: Record<string, string> = {};
  for (const p of parts) out[p.type] = p.value;
  if (out.hour === '24') out.hour = '00';
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Admin › Audit's time cell: "Oct 15 · 14:05 ET", whatever the browser's zone. */
export function auditTimeET(iso: string | null | undefined): string {
  const p = iso ? etParts(iso) : null;
  if (!p) return '—';
  return `${MONTHS[Number(p.month) - 1]} ${Number(p.day)} · ${p.hour}:${p.minute} ET`;
}

/** The audit CSV's time column: "2026-10-15 14:05:09 ET". */
export function auditTimestampET(iso: string): string {
  const p = etParts(iso);
  if (!p) return iso;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ET`;
}

// ── L4 · who to ask, from the database ───────────────────────────────────────

/** The locked admin page's sentence, naming the super admins on file now
    (GET /principals/super-admins) instead of a list typed into the code. */
export function superAdminAskSentence(names: readonly string[]): string {
  if (names.length === 0) return 'Ask a super admin if you need access.';
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `Ask a super admin — ${list} — if you need access.`;
}

// ── L3 · history fields are the system's ─────────────────────────────────────

/** Bag keys that are a log the system keeps: read-only for everyone, super
    admins included (Previous Assignees is appended by assigneeHistory.ts on
    every change of the seat). */
export const HISTORY_FIELD_KEYS: readonly string[] = ['Previous Assignees'];

export function historyFieldMessage(label: string): string {
  return `"${label}" is a history the system keeps — it is not edited by hand`;
}

/** The 400 details every refusal above carries. */
export function validationDetails(field: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: VALIDATION_CODE, field, ...extra };
}
