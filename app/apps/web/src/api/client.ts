// Typed fetch wrappers over same-origin /api/* (Vite proxies to :5174).
// TYPE-ONLY imports from @theone/shared — no runtime value ever crosses this
// boundary (SPRINT1-SPEC §8 Card C). Web never imports @theone/db.
import type {
  Kpis,
  Status,
  WorkOrderDetail,
  WorkOrderListItem,
  WorkOrderListResponse,
  ActivityEntry,
  ApiError,
  CommentCreatedResponse,
  FeedResponse,
  // S4 — aliased so the local envelope/input types below can reference the
  // shared shapes without shadowing the re-exports they sit beside.
  Quote as SharedQuote,
  QuoteLineType as SharedQuoteLineType,
  QuotePermissions as SharedQuotePermissions,
  QuoteStatus as SharedQuoteStatus,
  PaymentRequest as SharedPaymentRequest,
  PaymentRequestsResponse as SharedPaymentRequestsResponse,
  // S4.1 — the "Viewing as" list.
  PrincipalsResponse as SharedPrincipalsResponse,
  // S6 — the list's field catalogue, filter vocabulary and saved views.
  WoFieldCatalogue,
  WoFilterSet,
  WoFilterOp,
  WoFieldType,
  WoSort,
  SavedView,
  BulkUpdateResult,
  ImportResult,
  // Automations — the admin rules engine.
  AutomationItem,
  AutomationRunItem,
  AutomationTrigger,
  AutomationAction,
  AutomationEntity,
  AutomationEnrollResult,
  // Metrics — dashboard cards over any field, durations between two events.
  MetricEvent,
  MetricBreakdown,
  MetricDuration,
  WoFieldTime,
} from '@theone/shared';

// ── S2 contract types ────────────────────────────────────────────────────────
// The Sprint-2 shapes are authored in @theone/shared alongside the S1 ones.
// Re-exported here so page/component modules keep importing from one place.
export type {
  // S6 — the work-order list's own contract.
  WoFieldCatalogue,
  WoFieldDescriptor,
  WoFieldOption,
  WoFieldType,
  WoFilterOp,
  WoFilterRule,
  WoFilterSet,
  WoSort,
  WorkOrderGroupCount,
  SavedView,
  BulkUpdateResult,
  ImportResult,
  ImportRowResult,
  Phase,
  Money,
  FeedActor,
  FeedComment,
  FeedStatusChanged,
  FeedCreated,
  FeedItem,
  FeedResponse,
  CommentCreatedResponse,
  AutomationItem,
  AutomationRunItem,
  AutomationTrigger,
  AutomationTriggerKind,
  AutomationAction,
  AutomationEntity,
  AutomationEnrollResult,
  MetricEvent,
  MetricBreakdown,
  MetricBreakdownBucket,
  MetricDuration,
  MetricDurationSample,
  WoFieldTime,
} from '@theone/shared';

/** GET /api/statuses items — `phase` is part of Status as of S2. */
export type StatusWithPhase = Status;

/** Attachment rows the detail response may carry. The S1 DDL ships the table
    but no route populates it yet, so the field is optional on the client. */
export interface WorkOrderAttachment {
  id: string;
  file_name: string;
  storage_key?: string | null;
  content_type?: string | null;
  client_visible?: boolean;
  created_at?: string | null;
}

/** GET /api/work-orders/:id, plus the not-yet-served attachment list. */
export interface WorkOrderDetailV2 extends WorkOrderDetail {
  attachments?: WorkOrderAttachment[] | null;
}

// ── S3 contract types — Messages / Quo mirror ────────────────────────────────
// These describe the Sprint-3 endpoints below. They are NOT in @theone/shared
// (packages/** is Agent A's; web never edits it), so they are declared here —
// the single place the web app describes an API payload. Shapes are the S3
// contract verbatim.

/** The vendor the conversation is correlated to (WO → payable/seed link). */
export interface QuoVendor {
  id: string;
  name: string;
  phone: string | null;
  trades: string[] | null;
}

export interface QuoConversation {
  id: string;
  vendor: QuoVendor;
  quo_line_label: string | null;
  claimed_by: string | null;
  counts: { calls: number; texts: number; photos: number };
  first_contact: string | null;
  last_activity: string | null;
  /** Optional: when the channel was linked. Not part of the required contract,
      so the channel header falls back to `first_contact` when it is absent. */
  created_at?: string | null;
}

/** One line of a call transcript (quo_call.transcript JSONB). */
export interface QuoTranscriptLine { speaker: string; line: string }

/** One MMS attachment (quo_message.media JSONB). */
export interface QuoMedia { name: string; label: string }

export interface ThreadCall {
  type: 'call';
  id: string;
  conversation_id?: string;
  direction: 'in' | 'out';
  duration_seconds: number | null;
  ai_summary: string | null;
  transcript: QuoTranscriptLine[] | null;
  occurred_at: string;
}

export interface ThreadMessage {
  type: 'message';
  id: string;
  conversation_id?: string;
  direction: 'in' | 'out';
  body: string;
  media: QuoMedia[] | null;
  delivered: boolean;
  pending_sync: boolean;
  occurred_at: string;
}

export interface ThreadSegment {
  type: 'segment';
  id: string;
  conversation_id?: string;
  label: string;
  started_at: string;
}

export type ThreadItem = ThreadCall | ThreadMessage | ThreadSegment;

/** GET /api/work-orders/:id/messages — items are OLDEST-FIRST. */
export interface MessagesResponse {
  conversation: QuoConversation | null;
  items: ThreadItem[];
}

/** POST /api/work-orders/:id/messages — 201 { item }. */
export interface MessageCreatedResponse { item: ThreadMessage }

/** The API's Zod bound on the outbound text body. */
export const MESSAGE_MAX = 1600;

export interface ListWorkOrdersParams {
  /** A status_group_def code (admins can add groups beyond the built-in five). */
  status_group?: string;
  status_id?: string;
  search?: string;
  /** S6 — serialised as JSON in the query string (see `toQuery`). */
  filters?: WoFilterSet;
  sort?: WoSort | null;
  group_by?: string | null;
  /** Which columns to project. Custom fields arrive on `item.custom`. */
  columns?: string[];
  limit?: number;
  offset?: number;
  /** S5 — orders worst-obligation first (tier desc, then most overdue), ahead of `sort`. */
  breach?: boolean;
}

// ── S4 contract types — Quotes & payment requests ────────────────────────────
// UNLIKE the S3 block above, these are NOT re-declared here: @theone/shared
// carries the whole Sprint-4 contract (it is "the single source of truth for
// cross-boundary types") and apps/api implements exactly those shapes against
// migration 0003. They are re-exported so page modules keep importing from one
// place, and the web never diverges from what the server actually sends.
//
// Money crosses the wire as a NUMBER on these payloads. The builder still
// validates the RAW STRING the operator typed (lib/quoteTotals.ts — "-75" must
// stay invalid, not silently become 75) and converts exactly once, on save.
// Amounts/subtotals/totals are NEVER stored: computeQuoteTotals() owns the
// arithmetic on both sides (RULE B).
export type {
  Role,
  QuoteStatus,
  QuoteSectionKind,
  QuoteLineType,
  QuoteLine,
  QuoteSection,
  QuoteOptionTotal,
  QuoteTotals,
  QuoteSummary,
  QuotePermissions,
  Quote,
  PaymentRequestStatus,
  PaymentRequestPayee,
  PaymentRequest,
  PaymentRequestsResponse,
  // S4.1 — principals ("Viewing as").
  PrincipalListItem,
  PrincipalsResponse,
} from '@theone/shared';

/**
 * GET /api/work-orders/:id/quote.
 *
 * `quote: null` = no quote has been built yet. `permissions` is optional at the
 * envelope level: the gates normally ride on `quote.permissions`, but when
 * there is no quote there is nothing to hang them off, so the route may lift
 * them onto the envelope. Absent both, the create CTA stays live and a 403
 * from the POST is surfaced inline (see QuoteBuilderPage).
 */
export interface QuoteEnvelope {
  quote: SharedQuote | null;
  permissions?: SharedQuotePermissions;
}

/** POST/PUT /api/work-orders/:id/quote and every lifecycle POST — 200 { quote }. */
export interface QuoteResponse {
  quote: SharedQuote;
}

/** One line of the PUT body. `amount` is not sent — the server computes it. */
export interface QuoteLineInput {
  line_type: SharedQuoteLineType;
  description: string;
  qty: number;
  rate: number;
  /** Day column: stored VERBATIM, no math (semantics TBD — requirements §4.1). */
  day_value: string | null;
  ot: boolean;
}

/** One section of the PUT body. Sections are REPLACED whole, in array order:
    the incurred section first, then the options (whose A/B/C labels are derived
    from that position server-side and never stored). */
export interface QuoteSectionInput {
  kind: 'incurred' | 'option';
  name: string | null;
  narrative_reported: string | null;
  scope_lines: string[];
  include_in_summary: boolean;
  lines: QuoteLineInput[];
}

/** PUT /api/work-orders/:id/quote — everything an editor can change. */
export interface QuoteUpdateInput {
  sales_tax: number;
  specs: string | null;
  note_to_customer: string | null;
  /** Non-null once someone used "Edit text": a PINNED manual summary that stops
      the auto-sync. Null = the summary tracks the generated `summary.auto`. */
  summary_pinned: string | null;
  sections: QuoteSectionInput[];
}

/** GET /api/quotes — the sidebar "Quotes" list page. Not part of the shared
    contract (no other consumer), so it is declared here. */
export interface QuoteListItem {
  id: string;
  task_id: string;
  wo_number: string;
  title: string | null;
  client: string | null;
  status: SharedQuoteStatus;
  grand_total: number | null;
  updated_at: string | null;
}

export interface QuoteListResponse {
  items: QuoteListItem[];
  total: number;
}

// ── Payment requests (payables) ──────────────────────────────────────────────

/** Payment methods (requirements §2 — the real list is imported later). The
    column is free text, so this is the UI's vocabulary, not a DB enum. */
export const PAYMENT_METHODS = [
  'Zelle',
  'ACH transfer',
  'Check',
  'Company card',
  'Cash App',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * POST /api/work-orders/:id/payment-requests.
 *
 * FLAT, not nested under `payee` the way the RESPONSE is: the route's Zod schema
 * is `.strict()`, so an unrecognised key is a 400. The payee is EITHER a vendor
 * record (`vendor_id`) OR a manual name + phone — and the manual branch needs
 * BOTH halves, which is why the free-entry fallback makes the phone required.
 */
export interface PaymentRequestInput {
  vendor_id: string | null;
  payee_name: string | null;
  payee_phone: string | null;
  purpose: string;
  amount: number;
  method: string;
  note: string | null;
  recipient_name: string | null;
}

export interface PaymentRequestCreatedResponse {
  item: SharedPaymentRequest;
}

/** Thrown for any non-2xx response, carrying the API's { error } envelope. */
export class ApiRequestError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(status: number, body: ApiError | null, fallback: string) {
    const err = body?.error;
    super(err?.message ?? fallback);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = err?.code ?? 'INTERNAL';
    this.details = err?.details ?? null;
  }
}

/** S5 — the acting principal now comes from the SESSION, not from the client.
    Until S5 this module read a pinned uuid out of localStorage and sent it as an
    `X-Actor-Id` header, which meant the browser chose its own identity and
    therefore its own permissions. The API ignores that header entirely now.

    `credentials: 'same-origin'` is what carries the httpOnly session cookie.
    Vite proxies /api to :5174 so every call here is same-origin by construction.

    A 401 anywhere means the session is gone — expired, signed out in another
    tab, or the account was disabled. Rather than let each caller invent its own
    recovery, one listener bounces to the sign-in screen. */

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  onUnauthorized = fn;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    let body: ApiError | null = null;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      /* non-JSON error body */
    }
    // /auth/me answers "not signed in" with a 200, so a 401 here is always a
    // session that died mid-flight — never the initial unauthenticated load.
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiRequestError(res.status, body, `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function toQuery(params: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    // S6 — `filters`/`sort` travel as JSON and `columns` as a comma list, so
    // the browser and the API exchange exactly the object a saved view stores
    // rather than a flattened encoding each side has to reassemble.
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      q.set(k, v.join(','));
    } else if (typeof v === 'object') {
      q.set(k, JSON.stringify(v));
    } else {
      q.set(k, String(v));
    }
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** S5: the list rows may carry `worst_obligation` (the Clock column). The type
    is a SUPERSET of the shared one — every S1–S4 caller keeps type-checking. */
export function listWorkOrders(
  params: ListWorkOrdersParams = {},
): Promise<WorkOrderListResponseV2> {
  return request<WorkOrderListResponseV2>(`/work-orders${toQuery(params)}`);
}

export function getWorkOrder(idOrNumber: string): Promise<WorkOrderDetailV2> {
  return request<WorkOrderDetailV2>(`/work-orders/${encodeURIComponent(idOrNumber)}`);
}

/** GET /api/work-orders/:id/feed — comments + status changes + creation, newest-first. */
export function getWorkOrderFeed(idOrNumber: string): Promise<FeedResponse> {
  return request<FeedResponse>(`/work-orders/${encodeURIComponent(idOrNumber)}/feed`);
}

/** POST /api/work-orders/:id/comments — 201 { item: FeedItem(comment) }. */
export function postWorkOrderComment(
  idOrNumber: string,
  input: { body: string; client_visible: boolean },
): Promise<CommentCreatedResponse> {
  return request<CommentCreatedResponse>(
    `/work-orders/${encodeURIComponent(idOrNumber)}/comments`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

/** GET /api/work-orders/:id/messages — the Quo conversation mirror.
    `conversation: null` means no Quo thread is correlated to this WO. */
export function getWorkOrderMessages(idOrNumber: string): Promise<MessagesResponse> {
  return request<MessagesResponse>(`/work-orders/${encodeURIComponent(idOrNumber)}/messages`);
}

/** POST /api/work-orders/:id/messages — queues an outbound text (direction
    'out', pending_sync=true) and writes a `tech_message_sent` activity row. */
export function postWorkOrderMessage(
  idOrNumber: string,
  input: { body: string },
): Promise<MessageCreatedResponse> {
  return request<MessageCreatedResponse>(
    `/work-orders/${encodeURIComponent(idOrNumber)}/messages`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function patchStatus(
  idOrNumber: string,
  status_id: string,
): Promise<WorkOrderDetail> {
  return request<WorkOrderDetail>(
    `/work-orders/${encodeURIComponent(idOrNumber)}/status`,
    { method: 'PATCH', body: JSON.stringify({ status_id }) },
  );
}

export function getStatuses(): Promise<StatusWithPhase[]> {
  return request<StatusWithPhase[]>(`/statuses`);
}

/** One phase group (status_group_def row) — tabs, menus and admin read these. */
export interface StatusGroupItem {
  code: string;
  label: string;
  position: number;
  is_builtin: boolean;
  status_count?: number;
}

export function getStatusGroups(): Promise<{ items: StatusGroupItem[] }> {
  return request(`/status-groups`);
}

export function getKpis(): Promise<Kpis> {
  return request<Kpis>(`/kpis`);
}

// ── Metrics — the dashboard's card engine ────────────────────────────────────

/** GET /api/metrics/breakdown — the filtered set bucketed by any field. */
export function getMetricBreakdown(
  field: string,
  filters?: WoFilterSet,
  limit?: number,
): Promise<MetricBreakdown> {
  return request<MetricBreakdown>(`/metrics/breakdown${toQuery({ field, filters, limit })}`);
}

/** GET /api/metrics/duration — per work order, first `from` event → next `to`
    event after it, aggregated. Events are field changes the audit trail
    recorded, so only in-app edits are measured. */
export function getMetricDuration(
  from: MetricEvent,
  to: MetricEvent,
  filters?: WoFilterSet,
): Promise<MetricDuration> {
  return request<MetricDuration>(`/metrics/duration${toQuery({ from, to, filters })}`);
}

/** GET /api/work-orders/:id/field-times — when each field first/last changed
    on one work order, whether or not any page displays it. */
export function getWorkOrderFieldTimes(idOrNumber: string): Promise<{ items: WoFieldTime[] }> {
  return request(`/work-orders/${encodeURIComponent(idOrNumber)}/field-times`);
}

export function getActivity(wo: string): Promise<ActivityEntry[]> {
  return request<ActivityEntry[]>(`/activity${toQuery({ wo })}`);
}

/** GET /api/principals — every human principal, name-ordered. Read-only and
    ungated: it is the source list for the "Viewing as" switcher, so it has to
    answer before any actor is pinned. */
export function getPrincipals(): Promise<SharedPrincipalsResponse> {
  return request<SharedPrincipalsResponse>(`/principals`);
}

// ── S4 — quotes ──────────────────────────────────────────────────────────────
// Every route is addressed by the WORK ORDER (`task_id` is UNIQUE on `quote` —
// one quote per WO, revisions tracked by `quote.rev`), which is why no path
// below carries a quote id.

const quotePath = (idOrNumber: string, suffix = '') =>
  `/work-orders/${encodeURIComponent(idOrNumber)}/quote${suffix}`;

/** GET /api/work-orders/:id/quote — the quote plus this actor's role gates.
    A work order with no quote yet answers `{ quote: null }`; a route that
    prefers 404 for the same condition is normalised to the same envelope. */
export async function getWorkOrderQuote(idOrNumber: string): Promise<QuoteEnvelope> {
  try {
    return await request<QuoteEnvelope>(quotePath(idOrNumber));
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return { quote: null };
    throw err;
  }
}

/** POST /api/work-orders/:id/quote — opens a Draft. 403 when the actor is below
    Senior OM (the UI renders the control locked whenever it knows in advance). */
export function createWorkOrderQuote(idOrNumber: string): Promise<QuoteResponse> {
  return request<QuoteResponse>(quotePath(idOrNumber), {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** PUT /api/work-orders/:id/quote — the autosave path (debounced while editable). */
export function putWorkOrderQuote(
  idOrNumber: string,
  input: QuoteUpdateInput,
): Promise<QuoteResponse> {
  return request<QuoteResponse>(quotePath(idOrNumber), {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/** POST …/quote/submit — Draft → Pending approval (senior_om+). */
export function submitQuote(idOrNumber: string): Promise<QuoteResponse> {
  return request<QuoteResponse>(quotePath(idOrNumber, '/submit'), {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** POST …/quote/approve — Pending approval → Approved; fills money.quote (atl+). */
export function approveQuote(idOrNumber: string): Promise<QuoteResponse> {
  return request<QuoteResponse>(quotePath(idOrNumber, '/approve'), {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** POST …/quote/send — Approved → Sent; pushes the summary to the client CMMS
    and posts the client-visible feed update (atl+). The comp's single
    "Approve & Send to CMMS" CTA runs approve then send. */
export function sendQuote(idOrNumber: string): Promise<QuoteResponse> {
  return request<QuoteResponse>(quotePath(idOrNumber, '/send'), {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** POST …/quote/reject — back to Draft with the reviewer's note attached (atl+). */
export function rejectQuote(idOrNumber: string, note: string): Promise<QuoteResponse> {
  return request<QuoteResponse>(quotePath(idOrNumber, '/reject'), {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

/** GET /api/quotes — every quote, newest-updated first. */
export function listQuotes(): Promise<QuoteListResponse> {
  return request<QuoteListResponse>(`/quotes`);
}

// ── S4 — payment requests ────────────────────────────────────────────────────

/** GET /api/work-orders/:id/payment-requests — newest first, with the two
    rolled-up totals the screen's footer and money rail render. */
export function getPaymentRequests(idOrNumber: string): Promise<SharedPaymentRequestsResponse> {
  return request<SharedPaymentRequestsResponse>(
    `/work-orders/${encodeURIComponent(idOrNumber)}/payment-requests`,
  );
}

/** POST /api/work-orders/:id/payment-requests — submits into the AP queue. */
export function postPaymentRequest(
  idOrNumber: string,
  input: PaymentRequestInput,
): Promise<PaymentRequestCreatedResponse> {
  return request<PaymentRequestCreatedResponse>(
    `/work-orders/${encodeURIComponent(idOrNumber)}/payment-requests`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

// ── S5 contract types — obligations, notifications, the Pulse ────────────────
// An OBLIGATION is who owes what, on which work order, by when — and what
// evidence silences it. Notifications are VIEWS of obligations, never a second
// source of truth. Declared here (not in @theone/shared) for the same reason the
// S3 block is: packages/** belongs to another agent, and the web must keep
// type-checking whether or not the S5 routes have landed yet.
//
// Every optional member below is optional ON PURPOSE. The engine is being built
// in parallel, so the reader treats anything beyond {id, rule_key, tier, due_at}
// as a bonus and degrades to a muted chip rather than throwing.

/** 0 ambient · 1 due-soon (>=80% of clock) · 2 breached · 3 critical (>200%). */
export type ObligationTier = 0 | 1 | 2 | 3;

/** Resolution is EVIDENCE-ONLY — the engine resolves, nobody dismisses. */
export type ObligationState = 'open' | 'snoozed' | 'resolved';

/** The seven V1 rules. Rules are CONFIG rows, so an unknown key is legal: the
    UI humanises anything it does not recognise instead of dropping the row. */
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
  id?: string | null;
  principal_id?: string | null;
  name?: string | null;
  display_name?: string | null;
  role?: string | null;
}

/** The minimum a clock chip needs. `worst_obligation` on a list row is this. */
export interface ObligationSummary {
  id: string;
  rule_key: ObligationRuleKey | string;
  /** Server-supplied display label; absent → derived from `rule_key`. */
  label?: string | null;
  tier: ObligationTier;
  state?: ObligationState;
  /** The deadline the countdown counts to. Null = no clock (fires-once rules). */
  due_at: string | null;
  started_at?: string | null;
  wo_id?: string | null;
  wo_number?: string | null;
}

/** A full row as the Pulse and the WO rail render it. */
export interface Obligation extends ObligationSummary {
  state: ObligationState;
  wo_title?: string | null;
  client?: string | null;
  /** The subject when it is not the WO itself (quote id, payment request id). */
  subject_id?: string | null;
  owed_by?: ObligationOwner | null;
  /** Set instead of `owed_by` when the obligation is owed by a ROLE, not a person. */
  owed_role?: string | null;
  snooze_reason?: string | null;
  snoozed_until?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** A work-order row with its worst open obligation (S5 Clock column). */
export interface WorkOrderListItemV2 extends WorkOrderListItem {
  worst_obligation?: ObligationSummary | null;
}

export interface WorkOrderListResponseV2 extends Omit<WorkOrderListResponse, 'items'> {
  items: WorkOrderListItemV2[];
}

/** One bell entry. A notification is a TIER TRANSITION that was pinged once. */
export interface PulseNotification {
  id: string;
  obligation_id?: string | null;
  rule_key?: ObligationRuleKey | string | null;
  tier: ObligationTier;
  title: string;
  body?: string | null;
  wo_id?: string | null;
  wo_number?: string | null;
  due_at?: string | null;
  read_at?: string | null;
  created_at: string;
}

export interface NotificationsResult {
  items: PulseNotification[];
  unread: number;
}

/** The three columns of /pulse. Grouped server-side when the route exists, and
    client-side from the obligation list when it does not. */
export interface PulseBoard {
  /** Tier 2–3 — the danger cards. */
  needs_me_now: Obligation[];
  /** Tier 1 — the storm-front strip. */
  due_soon: Obligation[];
  /** Tier 0 — the compact watch list. */
  watching: Obligation[];
  /** True when NO obligation route answered (404) — the difference between
      "nothing is owed" and "nobody is watching". The Pulse says which. */
  unavailable?: boolean;
}

export interface SnoozeInput {
  /** <= 72, enforced server-side. */
  hours: number;
  /** MANDATORY — a snooze with no reason is just a dismissal. */
  reason: string;
}

// ── S5 readers ───────────────────────────────────────────────────────────────
// Every reader below tolerates three shapes: a bare array, `{ items }`, or a
// named envelope. A 404 is read as "this route has not shipped yet" and answers
// empty; anything else propagates so react-query can render its error state.

function pluckArray(raw: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

async function getSoft<T>(path: string, empty: T): Promise<T> {
  try {
    return await request<T>(path);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return empty;
    throw err;
  }
}

/** A list read that also reports whether the ROUTE answered at all. */
async function getListSoft(
  path: string,
): Promise<{ items: unknown[]; available: boolean }> {
  try {
    const raw = await request<unknown>(path);
    return { items: pluckArray(raw, 'items', 'obligations', 'notifications'), available: true };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return { items: [], available: false };
    throw err;
  }
}

export interface ObligationQuery {
  /** WO id or WO number — scopes the list to one work order. */
  wo?: string;
  state?: ObligationState;
  limit?: number;
}

/** GET /api/obligations — open obligations (this read also nudges the lazy
    evaluator server-side, which is why the Pulse never needs a cron). */
export async function getObligations(params: ObligationQuery = {}): Promise<Obligation[]> {
  const { items } = await getListSoft(`/obligations${toQuery(params)}`);
  return items as Obligation[];
}

/** Tier → column. The ONE place the three-column split is defined, so the
    server-grouped and client-grouped paths can never drift. */
export function groupObligations(items: Obligation[]): PulseBoard {
  const board: PulseBoard = { needs_me_now: [], due_soon: [], watching: [] };
  for (const ob of items) {
    if (ob.state === 'resolved') continue;
    const tier = Number(ob.tier ?? 0);
    if (tier >= 2) board.needs_me_now.push(ob);
    else if (tier === 1) board.due_soon.push(ob);
    else board.watching.push(ob);
  }
  return board;
}

/** GET /api/pulse — the three columns. Falls back to grouping /api/obligations
    client-side when the route is absent or answers a flat list. */
export async function getPulse(): Promise<PulseBoard> {
  const raw = await getSoft<unknown>(`/pulse`, null);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (
      Array.isArray(obj.needs_me_now) ||
      Array.isArray(obj.due_soon) ||
      Array.isArray(obj.watching)
    ) {
      return {
        needs_me_now: (obj.needs_me_now ?? []) as Obligation[],
        due_soon: (obj.due_soon ?? []) as Obligation[],
        watching: (obj.watching ?? []) as Obligation[],
      };
    }
  }
  const flat = pluckArray(raw, 'items', 'obligations') as Obligation[];
  if (flat.length > 0) return groupObligations(flat);

  const fallback = await getListSoft(`/obligations${toQuery({ state: 'open', limit: 200 })}`);
  const board = groupObligations(fallback.items as Obligation[]);
  // Neither route exists yet → say so rather than claiming an all-clear.
  if (!fallback.available && raw == null) board.unavailable = true;
  return board;
}

/** GET /api/notifications — the bell. `unread` is taken from the envelope when
    the server counts it, else derived from `read_at`. */
export async function getNotifications(): Promise<NotificationsResult> {
  const raw = await getSoft<unknown>(`/notifications`, { items: [] });
  const items = pluckArray(raw, 'items', 'notifications') as PulseNotification[];
  const envelope = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const counted = envelope.unread ?? envelope.unread_count;
  const unread =
    typeof counted === 'number' ? counted : items.filter((n) => !n.read_at).length;
  return { items, unread };
}

/** POST /api/notifications/:id/read — one entry, on click. */
export function markNotificationRead(id: string): Promise<void> {
  return request<void>(`/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** POST /api/notifications/read-all — the dropdown's footer action. */
export function markAllNotificationsRead(): Promise<void> {
  return request<void>(`/notifications/read-all`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** POST /api/obligations/:id/snooze — moves due_at and logs the reason.
    403 when a tier-3 obligation is snoozed by someone below ATL. */
export function snoozeObligation(id: string, input: SnoozeInput): Promise<{ obligation?: Obligation }> {
  return request<{ obligation?: Obligation }>(
    `/obligations/${encodeURIComponent(id)}/snooze`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

// ── S5 · authentication ──────────────────────────────────────────────────────

export type AuthMode = 'entra' | 'bypass';
export type UserStatus = 'invited' | 'active' | 'disabled';

/** The resolved capability set (/auth/me `can`, S7). Mirrors what the server
    enforces — the UI gates on these instead of guessing from the role code. */
export interface SessionCapabilities {
  edit_quote: boolean;
  approve_quote: boolean;
  manage_users: boolean;
  edit_wo_fields: boolean;
  view_field_history: boolean;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  is_super_admin: boolean;
  status: UserStatus;
  /** Optional so the dev-candidates list (which has no session) still types. */
  can?: SessionCapabilities;
}

export interface MeResponse {
  authenticated: boolean;
  auth_mode: AuthMode;
  user: SessionUser | null;
  acting_as: SessionUser | null;
  is_impersonating?: boolean;
}

// ── Admin › Audit log ────────────────────────────────────────────────────────

export interface AuditLogEntry extends ActivityEntry {
  entity_type: string;
  wo_number: string | null;
  ext_name: string | null;
}

export interface AuditLogFilters {
  from?: string;
  to?: string;
  actor_id?: string;
  action?: string;
  field?: string;
  q?: string;
}

export interface AuditLogPage {
  items: AuditLogEntry[];
  total: number;
  facets: { actors: { id: string; name: string }[]; actions: string[] };
}

export function listAuditLog(
  params: AuditLogFilters & { limit?: number; offset?: number },
): Promise<AuditLogPage> {
  return request<AuditLogPage>(`/admin/audit${toQuery(params)}`);
}

/** A real link, so the browser handles the download (same pattern as the
    work-order export). */
export function auditLogExportUrl(params: AuditLogFilters): string {
  return `/api/admin/audit/export${toQuery(params)}`;
}

export interface AdminUserItem extends SessionUser {
  role_label: string | null;
  initials: string | null;
  last_login_at: string | null;
  has_signed_in: boolean;
}

export interface RoleRecord {
  id: string;
  code: string;
  label: string;
  description: string | null;
  is_system: boolean;
  can_edit_quote: boolean;
  can_approve_quote: boolean;
  can_manage_users: boolean;
  can_edit_wo_fields: boolean;
  can_view_field_history: boolean;
  position: number;
  user_count: number;
}

/** Who am I. Answers `authenticated: false` with a 200 — never throws on a
    signed-out visitor, because that is the normal first load, not an error. */
export function getMe(): Promise<MeResponse> {
  return request<MeResponse>('/auth/me');
}

/** Full-page navigation, not fetch: the Entra round trip is a browser redirect. */
export function startMicrosoftSignIn(redirectTo = '/'): void {
  window.location.href = `/api/auth/login?redirect_to=${encodeURIComponent(redirectTo)}`;
}

export function listDevCandidates(): Promise<{ items: SessionUser[] }> {
  return request<{ items: SessionUser[] }>('/auth/dev-candidates');
}

export function devSignIn(principalId: string): Promise<{ user: SessionUser }> {
  return request<{ user: SessionUser }>('/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify({ principal_id: principalId }),
  });
}

export function signOut(): Promise<{ ok: true; microsoft_logout_url: string | null }> {
  return request('/auth/logout', { method: 'POST' });
}

export function startImpersonating(principalId: string): Promise<{ impersonating: string | null }> {
  return request('/auth/impersonate', {
    method: 'POST',
    body: JSON.stringify({ principal_id: principalId }),
  });
}

export function stopImpersonating(): Promise<{ impersonating: null }> {
  return request('/auth/impersonate', { method: 'DELETE' });
}

// ── S5 · admin › users ───────────────────────────────────────────────────────

export function listAdminUsers(): Promise<{ items: AdminUserItem[] }> {
  return request('/admin/users');
}

export function listRoles(): Promise<{ items: RoleRecord[] }> {
  return request('/admin/roles');
}

export interface RoleInput {
  code?: string;
  label: string;
  description?: string | null;
  can_edit_quote?: boolean;
  can_approve_quote?: boolean;
  can_manage_users?: boolean;
  can_edit_wo_fields?: boolean;
  can_view_field_history?: boolean;
}

export function createRole(input: RoleInput): Promise<{ role: RoleRecord }> {
  return request('/admin/roles', { method: 'POST', body: JSON.stringify(input) });
}

export function updateRole(id: string, input: Partial<RoleInput>): Promise<{ role: RoleRecord }> {
  return request(`/admin/roles/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteRole(id: string): Promise<{ ok: true }> {
  return request(`/admin/roles/${id}`, { method: 'DELETE' });
}

export interface InviteUserInput {
  email: string;
  name: string;
  role: string;
  is_super_admin?: boolean;
}

export function inviteUser(input: InviteUserInput): Promise<{ user: AdminUserItem }> {
  return request('/admin/users', { method: 'POST', body: JSON.stringify(input) });
}

export interface UpdateUserInput {
  name?: string;
  role?: string;
  is_super_admin?: boolean;
  status?: UserStatus;
}

export function updateUser(id: string, input: UpdateUserInput): Promise<{ user: AdminUserItem }> {
  return request(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

// ── S5 · admin studio — settings, workflow, fields, trash ────────────────────

export interface AdminSettings {
  auth: {
    mode: AuthMode;
    tenant_id: string | null;
    redirect_uri: string | null;
    session_ttl_hours: number;
    invite_only: true;
  };
  server: { node_env: string; web_origin: string; api_port: number; cookie_secure: boolean };
  database: { engine: string; migrations_applied: number; latest_migration: string | null };
  counts: { users: number; roles: number; work_orders: number; statuses: number; fields: number };
}

export function getAdminSettings(): Promise<AdminSettings> {
  return request('/admin/settings');
}

export interface AdminWorkflowItem {
  id: string;
  name: string;
  /** A status_group_def code — built-ins plus admin-added groups. */
  status_group: string;
  color: string;
  position: number;
  is_archive: boolean;
  wo_count: number;
}

export function listAdminWorkflow(): Promise<{
  items: AdminWorkflowItem[];
  groups: StatusGroupItem[];
}> {
  return request('/admin/workflow');
}

// ── Admin › workflows — the status engine's writes ───────────────────────────

export function createAdminStatus(input: {
  name: string;
  group: string;
  color?: string;
}): Promise<{ item: AdminWorkflowItem }> {
  return request('/admin/workflow/statuses', { method: 'POST', body: JSON.stringify(input) });
}

export function updateAdminStatus(
  id: string,
  input: { name?: string; color?: string },
): Promise<{ item: AdminWorkflowItem }> {
  return request(`/admin/workflow/statuses/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteAdminStatus(id: string): Promise<{ ok: true }> {
  return request(`/admin/workflow/statuses/${id}`, { method: 'DELETE' });
}

export function createAdminGroup(label: string): Promise<{ item: StatusGroupItem }> {
  return request('/admin/workflow/groups', { method: 'POST', body: JSON.stringify({ label }) });
}

export function updateAdminGroup(code: string, label: string): Promise<{ item: StatusGroupItem }> {
  return request(`/admin/workflow/groups/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  });
}

export function deleteAdminGroup(code: string): Promise<{ ok: true }> {
  return request(`/admin/workflow/groups/${encodeURIComponent(code)}`, { method: 'DELETE' });
}

// ── Admin › automations — the rules engine ───────────────────────────────────

export interface AutomationInput {
  name: string;
  enabled?: boolean;
  entity?: AutomationEntity;
  trigger: AutomationTrigger;
  conditions?: WoFilterSet;
  actions: AutomationAction[];
}

export function listAutomations(): Promise<{ items: AutomationItem[] }> {
  return request('/admin/automations');
}

export function createAutomation(input: AutomationInput): Promise<{ item: AutomationItem }> {
  return request('/admin/automations', { method: 'POST', body: JSON.stringify(input) });
}

export function updateAutomation(
  id: string,
  input: Partial<AutomationInput>,
): Promise<{ item: AutomationItem }> {
  return request(`/admin/automations/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteAutomation(id: string): Promise<{ ok: true }> {
  return request(`/admin/automations/${id}`, { method: 'DELETE' });
}

export function listAutomationRuns(id: string): Promise<{ items: AutomationRunItem[] }> {
  return request(`/admin/automations/${id}/runs`);
}

// The operator-facing side: the Enroll menu on the work-orders bulk bar.

/** An enabled work-order rule, as the Enroll menu needs it. */
export interface EnrollableAutomation {
  id: string;
  name: string;
  entity: AutomationEntity;
  trigger: AutomationTrigger;
}

export function listEnrollableAutomations(): Promise<{ items: EnrollableAutomation[] }> {
  return request('/automations');
}

/** Run one rule over the selected work orders (a rule with a wait arms its
    timers instead of acting now). Needs can_edit_wo_fields. */
export function enrollWorkOrders(
  automationId: string,
  ids: string[],
): Promise<AutomationEnrollResult> {
  return request(`/automations/${automationId}/enroll`, {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export interface AdminFieldItem {
  id: string;
  key: string;
  label: string;
  type: string;
  container: string | null;
  position: number | null;
  option_count: number;
  /** The dropdown vocabulary, for the options editor (S7). */
  options: string[];
  used_by: number;
}

export function listAdminFields(): Promise<{ items: AdminFieldItem[] }> {
  return request('/admin/fields');
}

// ── S7 · admin › custom fields — the field engine's writes ───────────────────

export interface AdminFieldInput {
  label?: string;
  type?: string;
  options?: string[];
}

export function createAdminField(
  input: AdminFieldInput & { label: string; type: string },
): Promise<{ field: AdminFieldItem }> {
  return request('/admin/fields', { method: 'POST', body: JSON.stringify(input) });
}

export function updateAdminField(
  id: string,
  input: AdminFieldInput,
): Promise<{ field: AdminFieldItem }> {
  return request(`/admin/fields/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function reorderAdminFields(ids: string[]): Promise<{ items: AdminFieldItem[] }> {
  return request('/admin/fields/order', { method: 'PUT', body: JSON.stringify({ ids }) });
}

export interface TrashItem {
  id: string;
  wo_number: string;
  title: string;
  client: string | null;
  status: string;
  deleted_at: string;
}

export function listTrash(): Promise<{ items: TrashItem[] }> {
  return request('/admin/trash');
}

export function restoreFromTrash(id: string): Promise<{ item: { wo_number: string } }> {
  return request(`/admin/trash/${id}/restore`, { method: 'POST' });
}

// ── S6 — the work-order list: fields, saved views, bulk, import/export ───────
// The list stopped being a fixed table. Which columns it shows, what it filters
// on, how it groups and sorts are now the user's choices, so the FIELD
// CATALOGUE has to come from the server: roughly a hundred of the addressable
// fields are custom-field definitions an administrator can add to at any time.

/** GET /api/wo-fields — every filterable/sortable/displayable field, plus the
    operator table (which tests apply to which field type). */
export function getWoFields(): Promise<WoFieldCatalogue & {
  ops_by_type: Record<WoFieldType, WoFilterOp[]>;
}> {
  return request('/wo-fields');
}

/** GET /api/work-orders/ids — every id the current filters match, so that
    "select all" acts on the whole result set rather than the loaded page. */
export function listMatchingWorkOrderIds(
  params: Omit<ListWorkOrdersParams, 'limit' | 'offset'>,
): Promise<{ ids: string[]; total: number }> {
  return request(`/work-orders/ids${toQuery(params)}`);
}

/** The CSV export is a plain same-origin link, not a fetch: letting the browser
    handle the download is what gives the user a real Save dialog and a filename
    from Content-Disposition. The session cookie rides along automatically. */
export function workOrdersExportUrl(
  params: Omit<ListWorkOrdersParams, 'limit' | 'offset'>,
): string {
  return `/api/work-orders/export${toQuery(params)}`;
}

/** One patch applied to many work orders. Every field it changes writes its own
    activity row, exactly as a single-row edit does. */
export function bulkUpdateWorkOrders(
  ids: string[],
  patch: Record<string, unknown>,
): Promise<BulkUpdateResult> {
  return request('/work-orders/bulk', {
    method: 'POST',
    body: JSON.stringify({ ids, patch }),
  });
}

/** Soft delete — the rows land in Admin → Trash, which can restore them. */
export function bulkDeleteWorkOrders(ids: string[]): Promise<BulkUpdateResult> {
  return request('/work-orders/bulk/delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

/** POST /api/work-orders/import — rows keyed by FIELD KEY, already mapped from
    the CSV headers in the browser. `dry_run` reports what would happen and
    writes nothing; the dialog always runs it before the real thing. */
export function importWorkOrders(input: {
  rows: Record<string, string | null>[];
  mode: 'create' | 'upsert';
  dry_run: boolean;
}): Promise<ImportResult> {
  return request('/work-orders/import', { method: 'POST', body: JSON.stringify(input) });
}

// ── Saved views ──────────────────────────────────────────────────────────────

export interface SavedViewInput {
  name: string;
  columns?: string[];
  filters?: WoFilterSet;
  group_by?: string | null;
  sort?: WoSort | null;
  is_shared?: boolean;
}

export function listSavedViews(): Promise<{ items: SavedView[] }> {
  return request('/views');
}

export function createSavedView(input: SavedViewInput): Promise<{ view: SavedView }> {
  return request('/views', { method: 'POST', body: JSON.stringify(input) });
}

export function updateSavedView(
  id: string,
  input: Partial<SavedViewInput>,
): Promise<{ view: SavedView }> {
  return request(`/views/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteSavedView(id: string): Promise<{ ok: true }> {
  return request(`/views/${id}`, { method: 'DELETE' });
}

// ── S7 · inline field edit, field history, per-account prefs ─────────────────

/** PATCH /api/work-orders/:id/fields — values keyed by CATALOGUE key
    (`fields.<json key>`). Needs the can_edit_wo_fields capability. */
export function patchWorkOrderFields(
  idOrNumber: string,
  values: Record<string, unknown>,
): Promise<{ changed: number; detail: WorkOrderDetailV2 }> {
  return request(`/work-orders/${encodeURIComponent(idOrNumber)}/fields`, {
    method: 'PATCH',
    body: JSON.stringify({ values }),
  });
}

/** GET /api/work-orders/:id/field-history?field= — one field's trail, newest
    first. Needs the can_view_field_history capability. */
export function getFieldHistory(
  idOrNumber: string,
  field: string,
): Promise<{ items: ActivityEntry[] }> {
  return request(
    `/work-orders/${encodeURIComponent(idOrNumber)}/field-history${toQuery({ field })}`,
  );
}

/** Per-ACCOUNT preferences (user_pref) — unlike localStorage these follow the
    signed-in person across machines. First tenant: the All-fields tab order. */
export function getUserPref<T>(key: string): Promise<{ key: string; value: T | null }> {
  return request(`/prefs/${encodeURIComponent(key)}`);
}

export function setUserPref(key: string, value: unknown): Promise<{ ok: true }> {
  return request(`/prefs/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

/** GET /api/lists — the routing lists a work order can be homed in. Reference
    data for the bulk "move to a list" action, which sends an id, not a name. */
export interface RoutingList {
  id: string;
  name: string;
  wo_count: number;
}

export function listRoutingLists(): Promise<{ items: RoutingList[] }> {
  return request('/lists');
}
