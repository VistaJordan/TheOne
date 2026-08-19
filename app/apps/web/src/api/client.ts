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
} from '@theone/shared';
import { readActorId, writeActorId } from '../lib/actor';

// ── S2 contract types ────────────────────────────────────────────────────────
// The Sprint-2 shapes are authored in @theone/shared alongside the S1 ones.
// Re-exported here so page/component modules keep importing from one place.
export type {
  Phase,
  Money,
  FeedActor,
  FeedComment,
  FeedStatusChanged,
  FeedCreated,
  FeedItem,
  FeedResponse,
  CommentCreatedResponse,
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
  status_group?: 'open' | 'active' | 'pending' | 'done' | 'closed';
  status_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
  /** S5 — `breach` orders worst-obligation first (tier desc, then most overdue). */
  sort?: 'breach';
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

/** S4.1 — acting principal override.
    There is no auth until S5: the API resolves the actor from an optional
    `X-Actor-Id` header and falls back to the seeded Jordan Brown (admin). The
    topbar "Viewing as" switcher pins one (lib/actor.ts owns the storage), and
    the header rides on EVERY request below — not just the mutations — because
    the quote GET's `permissions{}` is resolved per-actor server-side. Absent a
    pin the header is never sent and the API's default applies.

    `?actor_id=<uuid>` stays as the deep-link escape hatch, but it is applied
    ONCE at module load (empty value = clear the pin): re-reading it per request
    would let a stale URL fight the switcher on every fetch. */
if (typeof window !== 'undefined') {
  const fromUrl = new URLSearchParams(window.location.search).get('actor_id');
  if (fromUrl !== null) writeActorId(fromUrl === '' ? null : fromUrl);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const actor = readActorId();
  const res = await fetch(`/api${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(actor ? { 'X-Actor-Id': actor } : {}),
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
    throw new ApiRequestError(res.status, body, `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function toQuery(params: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
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

export function getKpis(): Promise<Kpis> {
  return request<Kpis>(`/kpis`);
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
