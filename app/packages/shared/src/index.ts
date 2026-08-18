// @theone/shared — the single source of truth for cross-boundary types.
// Authored by Agent A; consumed READ-ONLY by @theone/api and @theone/web.
// Web imports these as `import type { ... }` (erased at build time) and never
// imports the DB runtime.

// ── Status groups ────────────────────────────────────────────────────────────
export type StatusGroup = 'open' | 'active' | 'done' | 'closed';

/**
 * Maps a ClickUp status `type` to our `status_group`.
 * ClickUp: open | custom | done | closed  →  our: open | active | done | closed
 * Canonical name per SPRINT1-SPEC §2 layout comment. (Card A's
 * `STATUS_GROUP_BY_CLICKUP_TYPE` is the same constant — aliased below.)
 */
export const STATUS_GROUP_BY_TYPE: Record<string, StatusGroup> = {
  open: 'open',
  custom: 'active',
  done: 'done',
  closed: 'closed',
};

/** Erratum alias — Card A step 2 name for the same map. */
export const STATUS_GROUP_BY_CLICKUP_TYPE = STATUS_GROUP_BY_TYPE;

// ── Phases (S2) ──────────────────────────────────────────────────────────────
/**
 * The nine lifecycle phases rendered by the WO-detail phase bar. A status maps
 * to exactly one phase, or to `null` for off-pipeline terminal states
 * (`!! canceled/postponed`), which the bar renders as "no phase".
 */
export type Phase =
  | 'Intake'
  | 'Assessment'
  | 'Quote'
  | 'Approval'
  | 'Scheduled'
  | 'In Progress'
  | 'Parts'
  | 'Done'
  | 'Invoiced';

/** Left-to-right order of the phase bar. `Parts` is the conditional branch. */
export const PHASE_ORDER: readonly Phase[] = [
  'Intake',
  'Assessment',
  'Quote',
  'Approval',
  'Scheduled',
  'In Progress',
  'Parts',
  'Done',
  'Invoiced',
];

/**
 * Status name → phase. Keyed by the seeded `status.name` verbatim (the 19
 * pipeline statuses plus the archive `invoiced`). The API is the authority:
 * it stamps `phase` onto every `Status` it returns, so the web never needs to
 * import this map — it exists here so both sides agree on the vocabulary.
 */
export const PHASE_BY_STATUS_NAME: Record<string, Phase | null> = {
  'Open': 'Intake',
  'emergency': 'Intake',
  'assessment scheduled': 'Assessment',
  'assessment ongoing': 'Assessment',
  'return trip needed': 'Assessment',
  'waiting for quote': 'Quote',
  'quote ready': 'Quote',
  'approved': 'Approval',
  '!! waiting for advice': 'Approval',
  '!! waiting for approval': 'Approval',
  'job scheduled': 'Scheduled',
  'pm scheduled': 'Scheduled',
  'job ongoing': 'In Progress',
  'please order parts': 'Parts',
  'waiting for parts': 'Parts',
  '!! ready to invoice': 'Done',
  'done/incurred': 'Done',
  '<< invoiced not paid >>': 'Invoiced',
  'invoiced': 'Invoiced',
  '!! canceled/postponed': null,
};

// ── Status ───────────────────────────────────────────────────────────────────
export interface Status {
  id: string;
  name: string;
  group: StatusGroup;
  color: string;
  position: number;
  is_archive: boolean;
  /** S2: lifecycle phase for the detail-page phase bar; null = off-pipeline. */
  phase: Phase | null;
}

/** Compact status descriptor embedded in work-order payloads. */
export interface StatusRef {
  id: string;
  name: string;
  group: StatusGroup;
  color: string;
}

export type Priority = 'urgent' | 'high' | 'normal' | 'low' | null;

// ── Work orders ──────────────────────────────────────────────────────────────
export interface WorkOrderListItem {
  id: string;
  wo_number: string;
  ext_name: string | null;
  title: string;
  client: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  billing_entity: string | null;
  nte: number | null;
  priority: Priority;
  date_received: string | null;
  home_list: string | null;
  status: StatusRef;
  age_days: number | null;
}

export interface WorkOrderListResponse {
  items: WorkOrderListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface Membership {
  list_id: string;
  list_name: string;
  is_home: boolean;
}

export interface WorkOrderDetail {
  id: string;
  wo_number: string;
  ext_name: string | null;
  title: string;
  description: string | null;
  client: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  billing_entity: string | null;
  nte: number | null;
  priority: Priority;
  date_received: string | null;
  status: StatusRef;
  fields: Record<string, unknown>;
  memberships: Membership[];
  recent_activity: ActivityEntry[];
  /** S2: the money block powering the NTE meter + financial rows. */
  money: Money;
}

// ── Money (S2) ───────────────────────────────────────────────────────────────
/**
 * Derived financial summary for one work order. Every member is a plain number
 * (never a string) or `null` when the underlying field is absent/non-numeric.
 * `marginPct` is a percentage (44.7 means 44.7%), not a fraction.
 */
export interface Money {
  nte: number | null;
  quote: number | null;
  cost: number | null;
  invoiced: number | null;
  profit: number | null;
  marginPct: number | null;
}

// ── Feed (S2) ────────────────────────────────────────────────────────────────
/** Principal reference as it appears in the feed (`name`, not `display_name`). */
export interface FeedActor {
  id: string;
  name: string;
  kind: 'human' | 'service';
}

/** A comment/update — the client-visibility boundary lives here. */
export interface FeedComment {
  type: 'comment';
  id: string;
  author: FeedActor;
  client_visible: boolean;
  body: string;
  created_at: string;
}

/** A status transition replayed from the activity log. */
export interface FeedStatusChanged {
  type: 'status_changed';
  id: string;
  actor: FeedActor;
  before: { status_name: string | null };
  after: { status_name: string | null };
  created_at: string;
}

/** The work order's creation event. `via` = intake channel when recorded. */
export interface FeedCreated {
  type: 'created';
  id: string;
  actor: FeedActor;
  via: string | null;
  created_at: string;
}

export type FeedItem = FeedComment | FeedStatusChanged | FeedCreated;

/** GET /api/work-orders/:id/feed — newest-first. */
export interface FeedResponse {
  items: FeedItem[];
  total: number;
}

/** POST /api/work-orders/:id/comments — 201 response. */
export interface CommentCreatedResponse {
  item: FeedComment;
}

// ── Messages / Quo mirror (S3) ───────────────────────────────────────────────
// The Messages tab mirrors the dispatcher↔technician Quo (OpenPhone) conversation
// for a work order. It is the EXTERNAL tech channel and is never client-visible —
// which is why no member below carries a `client_visible` flag (cf. FeedComment).
// `direction` is always relative to US: 'in' = from the technician,
// 'out' = from the dispatcher.

export type QuoDirection = 'in' | 'out';

/** One line of a call transcript, as delivered by Quo. */
export interface QuoTranscriptLine {
  speaker: string;
  line: string;
}

/** One MMS attachment: `name` is the file name, `label` the thumbnail badge. */
export interface QuoMedia {
  name: string;
  label: string;
}

/** A phone call. The UI renders the first lines of `transcript` and derives its
 *  "N more lines" affordance from `transcript.length`. */
export interface ThreadCall {
  type: 'call';
  id: string;
  direction: QuoDirection;
  duration_seconds: number | null;
  ai_summary: string | null;
  transcript: QuoTranscriptLine[];
  occurred_at: string;
}

/** An SMS/MMS. `media` is empty for a plain text. `pending_sync` marks a message
 *  composed in The One that the real Quo pipe has not sent yet (S3 always). */
export interface ThreadMessage {
  type: 'message';
  id: string;
  direction: QuoDirection;
  body: string;
  media: QuoMedia[];
  delivered: boolean;
  pending_sync: boolean;
  occurred_at: string;
}

/** A job-segment boundary (one tech visit). `occurred_at` mirrors `started_at`
 *  so every ThreadItem sorts on one field. */
export interface ThreadSegment {
  type: 'segment';
  id: string;
  label: string;
  started_at: string;
  occurred_at: string;
}

export type ThreadItem = ThreadCall | ThreadMessage | ThreadSegment;

/** The vendor (technician) on the other end of the line. */
export interface ConversationVendor {
  id: string;
  name: string;
  phone: string | null;
  trades: string[];
}

/** Counts powering the right rail: `texts` excludes MMS, `photos` is the total
 *  number of media attachments across every message. */
export interface ConversationCounts {
  calls: number;
  texts: number;
  photos: number;
}

export interface Conversation {
  id: string;
  vendor: ConversationVendor;
  quo_line_label: string | null;
  claimed_by: string | null;
  counts: ConversationCounts;
  /** Timestamp of the earliest call/message, or null on an empty thread. */
  first_contact: string | null;
  /** Timestamp of the latest call/message, or null on an empty thread. */
  last_activity: string | null;
}

/** GET /api/work-orders/:id/messages — `items` is OLDEST-FIRST (a chat log
 *  reads down the page). `conversation: null` = no Quo line linked to this WO. */
export interface MessagesResponse {
  conversation: Conversation | null;
  items: ThreadItem[];
}

/** POST /api/work-orders/:id/messages — 201 response. */
export interface MessageCreatedResponse {
  item: ThreadMessage;
}

// ── Roles & gates (S4) ───────────────────────────────────────────────────────
// There is no auth until S5. Until then the acting principal (X-Actor-Id, or the
// seeded Jordan Brown admin) carries a free-text `principal.role` and THAT is the
// permission. Both gates below are checked server-side; the web renders a gated
// control LOCKED WITH A TOOLTIP, never hidden (product/quotes-payments.md §3.5).

export type Role = 'om' | 'senior_om' | 'atl' | 'tl' | 'am' | 'admin';

/** Build / edit / submit a quote — Senior OM and above (§4 permission refinement). */
export const QUOTE_EDIT_ROLES: readonly string[] = ['senior_om', 'atl', 'tl', 'am', 'admin'];

/** Approve, reject and send a quote to the client CMMS — ATL and above (§1). */
export const QUOTE_APPROVE_ROLES: readonly string[] = ['atl', 'tl', 'am', 'admin'];

// ── Principals (S4.1 · "Viewing as" switcher) ────────────────────────────────
// GET /api/principals is the pre-auth read surface behind the role switcher:
// until S5 there is nothing to log into, so the client picks the acting
// principal and sends it as X-Actor-Id. `role` is `principal.role` VERBATIM
// (free text in v0), which is why it is a plain string, not `Role`.

/** One principal as the switcher lists it (`name`, not `display_name`). */
export interface PrincipalListItem {
  id: string;
  name: string;
  kind: 'human' | 'service';
  role: string | null;
}

/** GET /api/principals — humans only, ordered by name. */
export interface PrincipalsResponse {
  items: PrincipalListItem[];
}

// ── Quotes (S4) ──────────────────────────────────────────────────────────────
export type QuoteStatus = 'draft' | 'pending_approval' | 'approved' | 'sent';
export type QuoteSectionKind = 'incurred' | 'option';
export type QuoteLineType = 'service' | 'labor' | 'part' | 'material';

/**
 * One row of a section's line-item table. `amount` is COMPUTED
 * (qty × rate × (ot ? 1.5 : 1)) and never stored — see computeQuoteTotals().
 * `day_value` is the Day column's selected value verbatim; no math is done on
 * it anywhere (semantics TBD pending the real quote-builder import).
 */
export interface QuoteLine {
  id: string;
  line_type: QuoteLineType;
  description: string;
  qty: number;
  rate: number;
  day_value: string | null;
  ot: boolean;
  position: number;
  amount: number;
}

/**
 * INCURRED (work already performed) or one PROPOSED option. `label` is the
 * derived option letter ("Option A"), computed from `position` among the option
 * sections — the letter is never stored, so deleting A promotes B.
 * `subtotal` is the sum of the section's computed line amounts.
 */
export interface QuoteSection {
  id: string;
  kind: QuoteSectionKind;
  /** Derived: 'Incurred' for the incurred section, 'Option A' / 'Option B' … */
  label: string;
  name: string | null;
  narrative_reported: string | null;
  scope_lines: string[];
  include_in_summary: boolean;
  position: number;
  lines: QuoteLine[];
  subtotal: number;
}

/** One entry of `totals.option_totals` — the money rail's per-option row. */
export interface QuoteOptionTotal {
  section_id: string;
  label: string;
  name: string | null;
  include_in_summary: boolean;
  total: number;
}

/**
 * Every number on the quote screen, computed in ONE place (computeQuoteTotals).
 * `grand_total` is RULE B: the sum of the option sections flagged
 * include_in_summary. `incurred_subtotal` is context — it bills with the job and
 * is NOT added to the grand total.
 */
export interface QuoteTotals {
  incurred_subtotal: number;
  option_totals: QuoteOptionTotal[];
  grand_total: number;
  sales_tax: number;
  nte: number | null;
  total_cost: number | null;
  profit: number | null;
  margin_pct: number | null;
}

/** The client-facing text block. `pinned` non-null = hand-edited, auto-sync off. */
export interface QuoteSummary {
  auto: string;
  pinned: string | null;
}

/** What the ACTING principal may do with this quote right now. */
export interface QuotePermissions {
  can_edit: boolean;
  can_approve: boolean;
}

export interface Quote {
  id: string;
  task_id: string;
  wo_number: string;
  status: QuoteStatus;
  rev: number;
  specs: string | null;
  note_to_customer: string | null;
  created_by: ActivityActor | null;
  approved_by: ActivityActor | null;
  sent_by: ActivityActor | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  sections: QuoteSection[];
  totals: QuoteTotals;
  summary: QuoteSummary;
  permissions: QuotePermissions;
}

/** GET/POST/PUT /api/work-orders/:id/quote and every lifecycle POST. */
export interface QuoteResponse {
  quote: Quote;
}

// ── Payment requests (S4) ────────────────────────────────────────────────────
export type PaymentRequestStatus = 'requested' | 'approved' | 'paid' | 'rejected';

/**
 * The methods the request screen offers. `payment_request.method` is free TEXT,
 * not an enum: the real list (and the approval routing) is imported from the
 * existing project later (§4.3), and a CHECK constraint would have to be
 * migrated the day it lands. Seeded ledger rows use the short form the comp's
 * previous-payments table prints ("ACH").
 */
export const PAYMENT_METHODS: readonly string[] = [
  'Zelle',
  'ACH transfer',
  'Check',
  'Company card',
  'Cash App',
];

/** The technician: a vendor record when known, else a manual name + phone. */
export interface PaymentRequestPayee {
  vendor_id: string | null;
  name: string | null;
  phone: string | null;
}

export interface PaymentRequest {
  id: string;
  task_id: string;
  payee: PaymentRequestPayee;
  purpose: string;
  amount: number;
  method: string;
  note: string | null;
  /** Alternate payee ("send payment to someone other than the technician"). */
  recipient_name: string | null;
  status: PaymentRequestStatus;
  requested_by: ActivityActor | null;
  created_at: string;
}

/** GET /api/work-orders/:id/payment-requests — newest first. */
export interface PaymentRequestsResponse {
  items: PaymentRequest[];
  total: number;
  /** Sum of `paid` rows — the comp's "Total paid on this WO". */
  total_paid: number;
  /** Sum of every non-rejected row — the comp's "Payables total". */
  total_requested: number;
}

/** POST /api/work-orders/:id/payment-requests — 201 response. */
export interface PaymentRequestCreatedResponse {
  item: PaymentRequest;
}

// ── Obligations / notifications (S5) ─────────────────────────────────────────
// An OBLIGATION is who owes what, on which work order, by when — and what
// evidence silences it. Notifications are VIEWS of obligations.
//
// NOTE ON THE CONTRACT SEAM: apps/web declares its OWN, deliberately loose
// versions of these shapes in src/api/client.ts (every field optional, so the
// UI degrades instead of throwing while the engine is being built in parallel).
// The types below are the API's side of the same contract — a strict superset
// of what the web reads. They are ADDITIVE: no existing interface in this file
// changes, in particular `WorkOrderListItem` is untouched, because apps/web
// extends it (`WorkOrderListItemV2`) and widening a member here would break
// that declaration. The list endpoint sends `worst_obligation` as an extra
// member on the wire; the web's V2 type is what names it.

/** 0 ambient (<80% of clock) · 1 due-soon (>=80%) · 2 breached (>100%) · 3 critical (>200% or emergency breached). */
export type ObligationTier = 0 | 1 | 2 | 3;

/** Resolution is EVIDENCE-ONLY: the engine resolves, nobody dismisses. */
export type ObligationState = 'open' | 'snoozed' | 'resolved';

/** Business clocks pause outside Mon–Fri 08:00–18:00 CT; emergencies do not. */
export type ObligationClock = 'business' | '24x7';

/** What the clock is about: the work order, a quote, or a payment request. */
export type ObligationSubjectKind = 'wo' | 'quote' | 'payment';

/** The seven V1 rules. Rules are CONFIG rows, so unknown keys stay legal. */
export type ObligationRuleKey =
  | 'emergency_ack'
  | 'quote_owed'
  | 'schedule_owed'
  | 'approval_followup'
  | 'quote_review_owed'
  | 'payment_processing'
  | 'sla_blown';

/** Who owes it: a principal when the home list resolves to one, else a role. */
export interface ObligationOwner {
  principal_id: string | null;
  display_name: string | null;
  role: string | null;
  /** Ready-to-print: "Matt Hammond" or "Any ATL". */
  label: string;
}

/** The minimum a clock chip needs — also the shape of `worst_obligation`. */
export interface ObligationSummary {
  id: string;
  rule_key: ObligationRuleKey | string;
  /** Short chip label ("Quote owed"); the full sentence is `rule_name`. */
  label: string;
  tier: ObligationTier;
  state: ObligationState;
  due_at: string;
  started_at: string;
  wo_id: string | null;
  wo_number: string | null;
}

/** A full obligation row as the Pulse and the WO rail render it. */
export interface Obligation extends ObligationSummary {
  rule_name: string;
  subject_kind: ObligationSubjectKind;
  subject_id: string;
  clock: ObligationClock;
  wo_title: string | null;
  client: string | null;
  status_name: string | null;
  owed_by: ObligationOwner;
  owed_role: string | null;
  /** True when the acting principal is the one on the hook. */
  owed_by_me: boolean;
  overdue: boolean;
  /** Elapsed ÷ budget on this obligation's clock. 1.0 = exactly at the deadline. */
  progress: number;
  /** "1d 4h" of clock time remaining; null once overdue. */
  time_left: string | null;
  /** "3h 12m" past the deadline; null while still inside the clock. */
  overdue_by: string | null;
  /** "business hours" | "24/7" — what `time_left` is measured in. */
  clock_label: string;
  snooze_reason: string | null;
  snoozed_until: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /api/obligations — `{ items }`; also the WO rail's source. */
export interface ObligationsResponse {
  items: Obligation[];
  total: number;
}

export interface PulseCounts {
  needs_me_now: number;
  due_soon: number;
  watching: number;
  /** Obligations owed to the acting principal, any tier. */
  mine: number;
  breached: number;
  critical: number;
  open_total: number;
  unread_notifications: number;
}

/** GET /api/pulse — the three columns, for the acting principal. */
export interface PulseResponse {
  actor: { id: string; display_name: string; role: string | null };
  /** Tier 2–3 — the danger cards. */
  needs_me_now: Obligation[];
  /** Alias of `needs_me_now` (the brief's name for the same column). */
  needs_me: Obligation[];
  /** Tier 1 — the storm-front strip. */
  due_soon: Obligation[];
  /** Tier 0, plus other people's clocks when the actor is not leadership. */
  watching: Obligation[];
  counts: PulseCounts;
  generated_at: string;
}

/** One bell entry. A notification is a TIER TRANSITION that was pinged once. */
export interface NotificationItem {
  id: string;
  obligation_id: string;
  rule_key: string;
  tier: ObligationTier;
  title: string;
  body: string | null;
  wo_id: string | null;
  wo_number: string | null;
  due_at: string | null;
  created_at: string;
  read_at: string | null;
}

/** GET /api/notifications — newest first. `unread` and `unread_count` are the
 *  same number under both names the web reader accepts. */
export interface NotificationsResponse {
  items: NotificationItem[];
  total: number;
  unread: number;
  unread_count: number;
}

/** POST /api/obligations/:id/snooze — `reason` is MANDATORY, `hours` <= 72. */
export interface SnoozeInput {
  hours: number;
  reason: string;
}

export interface SnoozeResponse {
  obligation: Obligation;
}

// ── Activity log ─────────────────────────────────────────────────────────────
export interface ActivityActor {
  id: string;
  display_name: string;
  kind?: 'human' | 'service';
}

export interface ActivityEntry {
  id: number;
  action: string;
  field: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor: ActivityActor;
  created_at: string;
}

// ── KPIs ─────────────────────────────────────────────────────────────────────
export interface Kpis {
  active: { count: number };
  waitingApproval: { count: number; oldestAgeDays: number | null };
  readyToInvoice: { count: number; queuedAmount: number };
  margin: { pct: number; avgProfit: number; placeholder: boolean };
}

// ── Error shape ──────────────────────────────────────────────────────────────
// FORBIDDEN (403) is the S4 role gate: the actor exists, the route exists, but
// principal.role is below the bar (QUOTE_EDIT_ROLES / QUOTE_APPROVE_ROLES).
export type ApiErrorCode = 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'INTERNAL';

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    details: unknown;
  };
}
