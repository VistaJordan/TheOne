// 0067 · Financials, the rest: purchase requests, requests for quotation and
// the vendor quotes they collect, purchase orders, tax rates, document
// templates, cost centers, AFEs and budgets. The vocabulary the API and the
// browser share, and the arithmetic both must agree on.

import type { FeedActor } from './index';
import type { PermNode } from './permissions';

export const PURCHASING_PERM_KEY = 'purchasing';
export const PURCHASING_PERM = {
  requests: 'purchasing/requests',
  rfqs: 'purchasing/rfqs',
  orders: 'purchasing/orders',
  budgets: 'purchasing/budgets',
} as const;

export function purchasingPermNodes(): PermNode[] {
  return [
    {
      key: PURCHASING_PERM_KEY,
      label: 'Purchasing',
      actions: ['view', 'create', 'edit', 'delete', 'approve'],
      note: 'Purchase requests, requests for quotation, purchase orders, and the cost centers, AFEs and budgets they are filed under. Each row below can differ; unset follows this one.',
      children: [
        { key: PURCHASING_PERM.requests, label: 'Purchase requests', actions: ['view', 'create', 'edit', 'approve'], note: 'Create = raise and submit one; approve also covers reject.' },
        { key: PURCHASING_PERM.rfqs, label: 'Requests for quotation', actions: ['view', 'create', 'edit'], note: 'Edit also covers recording the quotes vendors send back and awarding one.' },
        { key: PURCHASING_PERM.orders, label: 'Purchase orders', actions: ['view', 'create', 'edit', 'approve'], note: 'Approve = issue an order to the vendor; edit also covers receiving what arrived.' },
        { key: PURCHASING_PERM.budgets, label: 'Cost centers, AFEs and budgets', actions: ['view', 'edit'] },
      ],
    },
  ];
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Tax rates ────────────────────────────────────────────────────────────────

export interface TaxRate {
  id: string;
  name: string;
  /** Percent: 8.25 = 8.25 %. */
  rate: number;
  state: string | null;
  is_default: boolean;
  is_active: boolean;
}

/** Tax on an amount at a percent rate, to the cent. */
export function taxOn(amount: number, ratePct: number): number {
  return round2((amount * ratePct) / 100);
}

// ── Document templates ───────────────────────────────────────────────────────

export const DOC_TEMPLATE_KINDS = ['quote', 'invoice', 'purchase_order'] as const;
export type DocTemplateKind = (typeof DOC_TEMPLATE_KINDS)[number];
export const DOC_TEMPLATE_KIND_LABELS: Record<DocTemplateKind, string> = { quote: 'Quote', invoice: 'Invoice', purchase_order: 'Purchase order' };

export interface DocTemplate {
  id: string;
  kind: DocTemplateKind;
  name: string;
  company_name: string | null;
  company_details: string | null;
  terms: string | null;
  footer: string | null;
  is_default: boolean;
  is_active: boolean;
}

export interface DocTemplateInput {
  kind?: DocTemplateKind;
  name?: string;
  company_name?: string | null;
  company_details?: string | null;
  terms?: string | null;
  footer?: string | null;
  is_default?: boolean;
  is_active?: boolean;
}

export interface FinanceSetup {
  tax_rates: TaxRate[];
  templates: DocTemplate[];
  can: { edit: boolean };
}

// ── Cost centers, AFEs, budgets ──────────────────────────────────────────────

export interface CostCenter {
  id: string;
  code: string;
  name: string;
  client: string | null;
  description: string | null;
  is_active: boolean;
}

export interface Afe {
  id: string;
  afe_number: string;
  title: string;
  cost_center: { id: string; code: string; name: string } | null;
  amount: number;
  status: 'open' | 'closed';
  valid_from: string | null;
  valid_to: string | null;
  note: string | null;
  /** What cites it: work-order Cost plus the purchase orders not tied to a
   *  work order (those tied to one are already inside its Cost). */
  used: number;
  remaining: number;
  over: boolean;
}

export interface BudgetRow {
  cost_center: CostCenter;
  year: number;
  /** Null = no budget set for the year. */
  budget: number | null;
  /** Work-order Cost of the work orders filed under it, received this year. */
  wo_cost: number;
  work_orders: number;
  /** Received value of its purchase orders that are not tied to a work order. */
  po_received: number;
  /** What its issued purchase orders (not tied to a work order) still have to deliver. */
  committed: number;
  actual: number;
  remaining: number | null;
  used_pct: number | null;
  over: boolean;
}

/** How a budget stands. Committed counts against it too: money promised is
 *  money gone. */
export function budgetPosition(budget: number | null, actual: number, committed: number): { remaining: number | null; used_pct: number | null; over: boolean } {
  if (budget === null) return { remaining: null, used_pct: null, over: false };
  const used = actual + committed;
  return { remaining: round2(budget - used), used_pct: budget > 0 ? Math.round((used / budget) * 100) : used > 0 ? 100 : 0, over: used > budget + 0.005 };
}

export interface BudgetsResponse {
  year: number;
  rows: BudgetRow[];
  afes: Afe[];
  cost_centers: CostCenter[];
  clients: string[];
  totals: { budget: number; actual: number; committed: number };
  can: { edit: boolean };
}

// ── Lines and totals ─────────────────────────────────────────────────────────

export interface PurchaseLine {
  id: string;
  description: string;
  qty: number;
  unit: string;
  /** A request's estimate, an order's agreed price. Null on a request with no estimate. */
  unit_cost: number | null;
  /** Purchase orders only. */
  received_qty?: number;
}

export interface PurchaseLineInput {
  description: string;
  qty?: number;
  unit?: string;
  unit_cost?: number | null;
}

export const purchaseLineAmount = (qty: number, unitCost: number | null | undefined): number => round2(qty * (unitCost ?? 0));

export function purchaseTotals(lines: { qty: number; unit_cost: number | null }[], taxPct: number): { subtotal: number; tax: number; total: number } {
  const subtotal = round2(lines.reduce((s, l) => s + purchaseLineAmount(l.qty, l.unit_cost), 0));
  const tax = taxOn(subtotal, taxPct);
  return { subtotal, tax, total: round2(subtotal + tax) };
}

// ── Purchase requests ────────────────────────────────────────────────────────

export const PR_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled'] as const;
export type PrStatus = (typeof PR_STATUSES)[number];
export const PR_STATUS_LABELS: Record<PrStatus, string> = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
  ordered: 'Ordered',
  cancelled: 'Cancelled',
};

export interface PurchaseRequest {
  id: string;
  pr_number: string;
  task: { id: string; wo_number: string } | null;
  title: string;
  reason: string | null;
  needed_by: string | null;
  vendor: { id: string | null; name: string } | null;
  cost_center: { id: string; code: string; name: string } | null;
  status: PrStatus;
  lines: PurchaseLine[];
  estimate: number;
  requested_by: FeedActor | null;
  submitted_at: string | null;
  decided_by: FeedActor | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  /** The order(s) and request(s) for quotation raised from it. */
  orders: { id: string; po_number: string }[];
  rfqs: { id: string; rfq_number: string }[];
}

export interface PurchaseRequestInput {
  task_ref?: string | null;
  title?: string;
  reason?: string | null;
  needed_by?: string | null;
  vendor_id?: string | null;
  vendor_name?: string | null;
  cost_center_id?: string | null;
  lines?: PurchaseLineInput[];
}

export type PrAction = 'submit' | 'approve' | 'reject' | 'cancel' | 'reopen';

/** Why a request cannot be submitted; null when it can. */
export function purchaseRequestProblem(title: string, lines: { description: string; qty: number }[]): string | null {
  if (!title.trim()) return 'Say what is being bought.';
  const real = lines.filter((l) => l.description.trim() !== '');
  if (real.length === 0) return 'List at least one item.';
  if (real.some((l) => !(l.qty > 0))) return 'Every item needs a quantity above zero.';
  return null;
}

// ── Requests for quotation and vendor quotes ─────────────────────────────────

export const RFQ_STATUSES = ['draft', 'sent', 'closed', 'awarded', 'cancelled'] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];
export const RFQ_STATUS_LABELS: Record<RfqStatus, string> = {
  draft: 'Draft',
  sent: 'Out to vendors',
  closed: 'Closed to quotes',
  awarded: 'Awarded',
  cancelled: 'Cancelled',
};

export interface VendorQuote {
  id: string;
  vendor: { id: string; name: string };
  quote_ref: string | null;
  total: number;
  lead_days: number | null;
  valid_until: string | null;
  note: string | null;
  status: 'received' | 'selected' | 'rejected';
  received_on: string;
  /** rfq_line id → the unit price they gave for it. */
  prices: Record<string, number>;
}

export interface Rfq {
  id: string;
  rfq_number: string;
  task: { id: string; wo_number: string } | null;
  request: { id: string; pr_number: string } | null;
  title: string;
  description: string | null;
  due_on: string | null;
  status: RfqStatus;
  lines: PurchaseLine[];
  vendors: { id: string; name: string; quoted: boolean }[];
  quotes: VendorQuote[];
  created_by: FeedActor | null;
  created_at: string;
  sent_at: string | null;
  order: { id: string; po_number: string } | null;
}

export interface RfqInput {
  task_ref?: string | null;
  request_id?: string | null;
  title?: string;
  description?: string | null;
  due_on?: string | null;
  lines?: PurchaseLineInput[];
  vendor_ids?: string[];
}

export interface VendorQuoteInput {
  vendor_id: string;
  quote_ref?: string | null;
  /** Per rfq_line id. When every line has one, the total is their sum. */
  prices?: Record<string, number>;
  /** Used when no per-line prices are given. */
  total?: number | null;
  lead_days?: number | null;
  valid_until?: string | null;
  note?: string | null;
}

export type RfqAction = 'send' | 'close' | 'reopen' | 'cancel';

/** The comparison a buyer reads: who is cheapest overall, and per line. */
export function compareQuotes(lines: { id: string; qty: number }[], quotes: { id: string; total: number; lead_days: number | null; prices: Record<string, number> }[]): {
  lowest_total: string | null;
  fastest: string | null;
  lowest_by_line: Record<string, string>;
} {
  const priced = quotes.filter((q) => q.total > 0);
  const lowest = priced.length ? priced.reduce((a, b) => (b.total < a.total ? b : a)) : null;
  const timed = quotes.filter((q) => q.lead_days !== null);
  const fastest = timed.length ? timed.reduce((a, b) => ((b.lead_days as number) < (a.lead_days as number) ? b : a)) : null;
  const byLine: Record<string, string> = {};
  for (const l of lines) {
    let best: { id: string; price: number } | null = null;
    for (const q of quotes) {
      const price = q.prices[l.id];
      if (typeof price === 'number' && (best === null || price < best.price)) best = { id: q.id, price };
    }
    if (best) byLine[l.id] = best.id;
  }
  return { lowest_total: lowest?.id ?? null, fastest: fastest?.id ?? null, lowest_by_line: byLine };
}

/** A vendor quote's total: the sum of its line prices when every line has one. */
export function quoteTotalFromLines(lines: { id: string; qty: number }[], prices: Record<string, number>): number | null {
  if (lines.length === 0 || lines.some((l) => typeof prices[l.id] !== 'number')) return null;
  return round2(lines.reduce((s, l) => s + l.qty * prices[l.id], 0));
}

// ── Purchase orders ──────────────────────────────────────────────────────────

export const PO_STATUSES = ['draft', 'issued', 'partially_received', 'received', 'closed', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  partially_received: 'Partly received',
  received: 'Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export interface PurchaseOrder {
  id: string;
  po_number: string;
  task: { id: string; wo_number: string } | null;
  vendor: { id: string | null; name: string };
  request: { id: string; pr_number: string } | null;
  rfq: { id: string; rfq_number: string } | null;
  cost_center: { id: string; code: string; name: string } | null;
  afe: { id: string; afe_number: string } | null;
  status: PoStatus;
  order_date: string | null;
  expected_on: string | null;
  ship_to: string | null;
  note: string | null;
  tax_rate_name: string | null;
  tax_pct: number;
  subtotal: number;
  tax: number;
  total: number;
  lines: PurchaseLine[];
  /** What has arrived, at the agreed prices, before tax. */
  received_value: number;
  created_by: FeedActor | null;
  approved_by: FeedActor | null;
  approved_at: string | null;
  created_at: string;
  /** Things worth a second look before it is issued. Never a block. */
  warnings: string[];
}

export interface PurchaseOrderInput {
  task_ref?: string | null;
  vendor_id?: string | null;
  vendor_name?: string | null;
  request_id?: string | null;
  rfq_id?: string | null;
  cost_center_id?: string | null;
  afe_id?: string | null;
  order_date?: string | null;
  expected_on?: string | null;
  ship_to?: string | null;
  note?: string | null;
  tax_rate_id?: string | null;
  lines?: PurchaseLineInput[];
}

export type PoAction = 'issue' | 'close' | 'cancel' | 'reopen';

/** The status a purchase order reads as once quantities have arrived. */
export function poStatusAfterReceipt(lines: { qty: number; received_qty: number }[]): 'issued' | 'partially_received' | 'received' {
  if (lines.length === 0 || lines.every((l) => l.received_qty <= 0)) return 'issued';
  return lines.every((l) => l.received_qty >= l.qty) ? 'received' : 'partially_received';
}

export interface PurchasingMeta {
  cost_centers: { id: string; code: string; name: string }[];
  afes: { id: string; afe_number: string; title: string; cost_center_id: string | null }[];
  tax_rates: TaxRate[];
  can: {
    requests: { view: boolean; create: boolean; edit: boolean; approve: boolean };
    rfqs: { view: boolean; create: boolean; edit: boolean };
    orders: { view: boolean; create: boolean; edit: boolean; approve: boolean };
    budgets: { view: boolean; edit: boolean };
  };
}

export interface PurchasingList<T> {
  items: T[];
  counts: Record<string, number>;
}

/** Everything purchasing on one work order. */
export interface WoPurchasing {
  requests: PurchaseRequest[];
  rfqs: Rfq[];
  orders: PurchaseOrder[];
  cost_center: { id: string; code: string; name: string } | null;
  afe: { id: string; afe_number: string; title: string } | null;
  meta: PurchasingMeta;
  can_file: boolean;
}

/** A printed document: the template that dresses it. */
export interface PrintTemplate {
  company_name: string | null;
  company_details: string | null;
  terms: string | null;
  footer: string | null;
}
