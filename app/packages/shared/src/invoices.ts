/**
 * Invoices (0045) — the bill to the client.
 *
 * The last part of the money story to become a record. A quote is a record, a
 * payment to a technician is a record, the completion audit is a record — but
 * what we charged the client lived in React state and vanished on reload.
 *
 * Three rules worth keeping in mind while reading the rest:
 *
 *   an invoice is a snapshot.  Its lines are copied from the quote when it is
 *   raised, not joined to it. A sent invoice must keep saying what it said
 *   when it was sent, whatever happens to the quote afterwards.
 *
 *   the number belongs to the entity.  SFM and BKR bill as separate
 *   companies, so each gets its own sequence per year. A number, once issued,
 *   is never reused — a voided invoice keeps it, because the client has seen
 *   it.
 *
 *   sending is the irreversible bit.  A draft can be edited freely; once it
 *   is sent it is what the client holds, so it can only be paid or voided.
 */

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  paid: 'Paid',
  void: 'Void',
};

/** What each status means for the reader, in the tone the app uses. */
export const INVOICE_STATUS_HINTS: Record<InvoiceStatus, string> = {
  draft: 'Not sent yet — edit freely',
  sent: 'With the client, awaiting payment',
  paid: 'Settled',
  void: 'Cancelled; the number stays used',
};

export const INVOICE_LINE_KINDS = ['service', 'labor', 'part', 'material', 'trip'] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

export const INVOICE_LINE_KIND_LABELS: Record<InvoiceLineKind, string> = {
  service: 'Service',
  labor: 'Labor',
  part: 'Part',
  material: 'Material',
  trip: 'Trip charge',
};

/** How long a client has to pay, unless someone sets a date by hand. */
export const INVOICE_DEFAULT_TERMS_DAYS = 30;

export interface InvoiceLine {
  id: string;
  kind: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  position: number;
}

export interface Invoice {
  id: string;
  task_id: string;
  wo_number: string;
  number: string;
  billing_entity: string | null;
  client: string | null;
  status: InvoiceStatus;
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  /** What the job cost us — carried so margin survives on the invoice. */
  cost: number | null;
  /** 0053 · BRD §6.4 "invoice contents": the work order's name and location
      and the vendor on the job, snapshotted when the invoice is raised. */
  title: string | null;
  site: string | null;
  vendor_name: string | null;
  vendor_contact: string | null;
  /** 0053 · the contract that priced it, when one did. */
  contract_id: string | null;
  contract_name: string | null;
  note: string | null;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  paid_reference: string | null;
  created_by: { id: string; display_name: string } | null;
  sent_by: { id: string; display_name: string } | null;
  created_at: string;
  updated_at: string;
  lines: InvoiceLine[];
  /** Days since it was sent and still not paid; null unless it is overdue. */
  overdue_days: number | null;
}

export interface InvoicesResponse {
  items: Invoice[];
  totals: {
    draft: number;
    outstanding: number;
    overdue: number;
    paid_30d: number;
  };
}

/** POST /api/invoices — everything else is pre-filled from the work order. */
export interface InvoiceCreateInput {
  task_id: string;
}

export interface InvoiceLineInput {
  kind?: string;
  description: string;
  quantity?: number;
  unit_price?: number;
}

export interface InvoiceUpdateInput {
  note?: string | null;
  discount?: number;
  tax?: number;
  due_at?: string | null;
  lines?: InvoiceLineInput[];
}

/**
 * A line's own money — computed in integer hundredths, not in floats.
 *
 * `1.5 × 99.99` is 149.985, which bills as 149.99. Done the obvious way it
 * does not: the nearest double to 149.985 is 149.98499999999999, so
 * `Math.round(x * 100) / 100` quietly rounds it DOWN and the client is
 * short-changed a cent. Quantities and prices are two-decimal values, so
 * scaling both to integers first makes the half-way case exact and the
 * rounding honest.
 *
 * Shared by the browser and the API on purpose: a running total that
 * disagrees with the saved one by a cent is a support ticket.
 */
export function lineAmount(quantity: number, unitPrice: number): number {
  const q = Math.round(quantity * 100); // hundredths of a unit
  const p = Math.round(unitPrice * 100); // cents
  return Math.round((q * p) / 100) / 100;
}

/** Subtotal → total, with the discount taken off and the tax put on. Summed
    in cents for the same reason a line is: adding rounded floats drifts. */
export function invoiceTotals(
  lines: Array<{ quantity: number; unit_price: number }>,
  tax: number,
  discount: number,
): { subtotal: number; total: number } {
  const subtotalCents = lines.reduce(
    (n, l) => n + Math.round(lineAmount(l.quantity, l.unit_price) * 100),
    0,
  );
  const totalCents =
    subtotalCents - Math.round((discount || 0) * 100) + Math.round((tax || 0) * 100);
  return { subtotal: subtotalCents / 100, total: totalCents / 100 };
}

/** 'SFM' + 2026 + 7 → 'SFM-2026-0007'. An entity we do not know bills as INV. */
export function formatInvoiceNumber(
  billingEntity: string | null | undefined,
  year: number,
  n: number,
): string {
  const prefix = (billingEntity ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'INV';
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}

/** A draft is the only status that may be edited. */
export function isEditable(status: InvoiceStatus): boolean {
  return status === 'draft';
}

/** What may be done next, so the browser and the API agree on the verbs. */
export function nextActions(status: InvoiceStatus): Array<'send' | 'mark_paid' | 'void' | 'reopen'> {
  if (status === 'draft') return ['send', 'void'];
  if (status === 'sent') return ['mark_paid', 'void'];
  if (status === 'void') return ['reopen'];
  return [];
}

/** `details.code` when a work order is billed twice. */
export const INVOICE_EXISTS_CODE = 'INVOICE_EXISTS';
/** `details.code` when an invoice that has left the building is edited. */
export const INVOICE_LOCKED_CODE = 'INVOICE_LOCKED';

/** The permission path the module is gated on (live since 0045). */
export const INVOICE_PERM_KEY = 'invoicing';
