/**
 * Vendor bills (0047) — the bill FROM the vendor, the AP half of invoicing.
 *
 * The invoice (0045) is what we charge the client. This is what the
 * technician or the sub-contractor charges us for the same job: their own
 * invoice number, their lines, when it is due. A payment request may then
 * settle a bill rather than an amount somebody remembered.
 *
 *   received → approved → paid
 *   received | approved → disputed → received   (once the query is resolved)
 *   received | approved | disputed → void
 *
 * Approving is `payments:approve` and paying is `payments/process:edit`, the
 * grants that already decide and process payment requests: AP is one job.
 */

import { invoiceTotals, lineAmount } from './invoices';

export const VENDOR_BILL_STATUSES = ['received', 'approved', 'paid', 'disputed', 'void'] as const;
export type VendorBillStatus = (typeof VENDOR_BILL_STATUSES)[number];

export const VENDOR_BILL_STATUS_LABELS: Record<VendorBillStatus, string> = {
  received: 'Received',
  approved: 'Approved',
  paid: 'Paid',
  disputed: 'Disputed',
  void: 'Void',
};

export const VENDOR_BILL_STATUS_HINTS: Record<VendorBillStatus, string> = {
  received: 'On file, not yet agreed',
  approved: 'Agreed — waiting to be paid',
  paid: 'Settled',
  disputed: 'Queried with the vendor',
  void: 'Cancelled',
};

export interface VendorBillLine {
  id: string;
  kind: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  position: number;
}

export interface VendorBill {
  id: string;
  task_id: string;
  wo_number: string;
  client: string | null;
  vendor_id: string | null;
  vendor_name: string;
  bill_number: string | null;
  received_on: string;
  due_on: string | null;
  status: VendorBillStatus;
  subtotal: number;
  tax: number;
  total: number;
  note: string | null;
  dispute_note: string | null;
  approved_by: { id: string; display_name: string } | null;
  approved_at: string | null;
  paid_by: { id: string; display_name: string } | null;
  paid_at: string | null;
  paid_reference: string | null;
  payment_request_id: string | null;
  /** 0053 · the vendor contract whose rates this bill was proposed from. */
  contract_id: string | null;
  contract_name: string | null;
  created_by: { id: string; display_name: string } | null;
  created_at: string;
  updated_at: string;
  lines: VendorBillLine[];
  /** Days past due_on and still unpaid; null unless overdue. */
  overdue_days: number | null;
  /** Rule 6.2.3: the band this bill's total falls in, and whether the
      viewer's role may approve inside it. */
  tier: { label: string; allowed: boolean } | null;
}

export interface VendorBillsResponse {
  items: VendorBill[];
  totals: {
    received: number;
    approved: number;
    overdue: number;
    paid_30d: number;
  };
}

export interface VendorBillLineInput {
  kind?: string;
  description: string;
  quantity?: number;
  unit_price?: number;
}

export interface VendorBillCreateInput {
  task_id: string;
  vendor_id?: string | null;
  vendor_name: string;
  bill_number?: string | null;
  received_on?: string;
  due_on?: string | null;
  tax?: number;
  note?: string | null;
  lines: VendorBillLineInput[];
  /** 0053 · set when the bill is confirmed from a contract's proposal. */
  contract_id?: string | null;
}

export interface VendorBillUpdateInput {
  vendor_name?: string;
  bill_number?: string | null;
  received_on?: string;
  due_on?: string | null;
  tax?: number;
  note?: string | null;
  lines?: VendorBillLineInput[];
}

/** Money is money: the same integer-cent arithmetic as the client invoice. */
export const vendorBillLineAmount = lineAmount;
export function vendorBillTotals(
  lines: Array<{ quantity: number; unit_price: number }>,
  tax: number,
): { subtotal: number; total: number } {
  return invoiceTotals(lines, tax, 0);
}

/** A bill's figures may change until it is agreed. */
export function vendorBillEditable(status: VendorBillStatus): boolean {
  return status === 'received' || status === 'disputed';
}

export type VendorBillAction = 'approve' | 'mark_paid' | 'dispute' | 'resolve' | 'void';

/** What may be done next, so the browser and the API agree on the verbs. */
export function vendorBillNextActions(status: VendorBillStatus): VendorBillAction[] {
  switch (status) {
    case 'received':
      return ['approve', 'dispute', 'void'];
    case 'approved':
      return ['mark_paid', 'dispute', 'void'];
    case 'disputed':
      return ['resolve', 'void'];
    default:
      return [];
  }
}

/** `details.code` when a bill that is past editing is edited. */
export const VENDOR_BILL_LOCKED_CODE = 'VENDOR_BILL_LOCKED';
