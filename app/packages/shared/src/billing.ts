/**
 * Billing proposals (0053) — BRD §6.4: "vendor payments can be automated
 * from the contract held with the vendor and the hours spent on site. If
 * enabled, an invoice is generated automatically once the work order is
 * completed; confirming it creates the invoice."
 *
 * A proposal is the generated half: the lines a contract implies once the
 * work is done, held until a person confirms (which files the invoice or the
 * vendor bill) or dismisses it. The arithmetic that turns rates and hours
 * into lines is here, pure, so the API and the tests agree and the browser
 * can show the same figures before anything is written.
 */

import { invoiceTotals } from './invoices';
import type { ResolvedRates } from './contracts';

export const BILLING_PROPOSAL_KINDS = ['invoice', 'vendor_bill'] as const;
export type BillingProposalKind = (typeof BILLING_PROPOSAL_KINDS)[number];

export const BILLING_PROPOSAL_KIND_LABELS: Record<BillingProposalKind, string> = {
  invoice: 'Client invoice',
  vendor_bill: 'Vendor bill',
};

export const BILLING_PROPOSAL_STATUSES = ['pending', 'confirmed', 'dismissed'] as const;
export type BillingProposalStatus = (typeof BILLING_PROPOSAL_STATUSES)[number];

export interface BillingProposalLine {
  kind: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

export interface BillingProposal {
  id: string;
  task_id: string;
  wo_number: string;
  client: string | null;
  billing_entity: string | null;
  title: string | null;
  kind: BillingProposalKind;
  contract_id: string | null;
  contract_name: string;
  vendor_name: string | null;
  /** Where the lines came from: 'quote' or 'contract'. */
  basis: string;
  hours: number;
  visits: number;
  lines: BillingProposalLine[];
  subtotal: number;
  tax: number;
  total: number;
  status: BillingProposalStatus;
  /** The invoice or vendor bill a confirmation created. */
  result_id: string | null;
  decided_by: { id: string; display_name: string } | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export interface BillingProposalsResponse {
  items: BillingProposal[];
}

/**
 * The lines a time-and-materials contract implies for `hours` on site over
 * `visits` trips: labor at the standard rate, and a trip charge per visit.
 * Nothing when the contract states no hourly rate, or when no visit has been
 * completed — a proposal for nothing is noise, not a bill.
 */
export function contractBillingLines(
  rates: Pick<ResolvedRates, 'standard' | 'trip_charge'>,
  hours: number,
  visits: number,
  contractName: string,
): BillingProposalLine[] {
  const lines: BillingProposalLine[] = [];
  const h = Math.round(hours * 100) / 100;
  if (rates.standard !== null && rates.standard > 0 && h > 0) {
    lines.push({
      kind: 'labor',
      description: `Labor — ${h} h on site at contract rate (${contractName})`,
      quantity: h,
      unit_price: rates.standard,
      amount: 0,
    });
  }
  if (rates.trip_charge !== null && rates.trip_charge > 0 && visits > 0) {
    lines.push({
      kind: 'trip',
      description: `Trip charge × ${visits} visit${visits === 1 ? '' : 's'} (${contractName})`,
      quantity: visits,
      unit_price: rates.trip_charge,
      amount: 0,
    });
  }
  return withAmounts(lines);
}

/** Fill each line's amount and return the same list — integer-cent math,
    like the invoice's. */
export function withAmounts(lines: BillingProposalLine[]): BillingProposalLine[] {
  return lines.map((l) => {
    const { subtotal } = invoiceTotals([{ quantity: l.quantity, unit_price: l.unit_price }], 0, 0);
    return { ...l, amount: subtotal };
  });
}

/** Subtotal and total for a proposal, the invoice's way. */
export function proposalTotals(lines: BillingProposalLine[], tax: number): { subtotal: number; total: number } {
  return invoiceTotals(lines, tax, 0);
}
