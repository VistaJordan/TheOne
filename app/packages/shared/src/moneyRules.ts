// Cost and Total Invoiced follow the money records (no migration).
//
// Two rules, written here once so the API, the tests and the assistant's
// guide say the same thing:
//
//   Cost            moves with the money that went out (0076, the Yoda rule
//                     UpdateCostInClickUp): paying a request ADDS its amount
//                     to whatever Cost holds, deleting a paid one subtracts it
//                     (apps/api moneySync.addToCost). BRD rule 11.3.2 called
//                     the hand-typed cost "manual input for V1, with
//                     automation planned"; this is that automation. The
//                     sum-of-requests helpers below (costFromPayments /
//                     costDecision) are the pre-0076 rule, kept for its tests.
//   Total Invoiced  = the total of the work order's quote, stamped when the
//                     status moves to Invoiced or Invoiced Not Paid.
//
// A field is only locked against hand edits while the figure in it is one the
// system wrote (its latest audit row is stamped via 'payment' / via 'quote').
// A work order with no paid payment still takes a typed Cost — or rule
// 11.3.2 would keep it from ever reaching Done — and figures typed before
// these rules existed stay correctable until the system first writes them.

export const COST_FIELD_KEY = '34. Cost';
export const TOTAL_INVOICED_FIELD_KEY = 'Total Invoiced';

/** The payment-request states the pre-0076 rule counted toward Cost. */
export const ACCEPTED_PAYMENT_STATUSES = ['approved', 'sent_to_yoda', 'paid'] as const;

export function isAcceptedPaymentStatus(status: string): boolean {
  return (ACCEPTED_PAYMENT_STATUSES as readonly string[]).includes(status);
}

/** The statuses that stamp Total Invoiced, by name (statuses are records an
    admin can rename; a renamed one simply stops stamping). */
export const INVOICED_STATUS_NAMES = ['Invoiced', 'Invoiced Not Paid'] as const;

export function isInvoicedStatusName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim().toLowerCase();
  return INVOICED_STATUS_NAMES.some((s) => s.toLowerCase() === n);
}

const cents = (n: number) => Math.round(n * 100) / 100;

export interface CostFromPayments {
  /** How many payment requests count. */
  accepted: number;
  /** Their sum to the cent; null when none count. */
  cost: number | null;
}

/** What Cost should read given the work order's payment requests. */
export function costFromPayments(rows: { status: string; amount: number | string | null }[]): CostFromPayments {
  let accepted = 0;
  let sum = 0;
  for (const r of rows) {
    if (!isAcceptedPaymentStatus(r.status)) continue;
    const amount = Number(r.amount ?? 0);
    if (!Number.isFinite(amount)) continue;
    accepted += 1;
    sum += amount;
  }
  return { accepted, cost: accepted === 0 ? null : cents(sum) };
}

/**
 * What to do with Cost after a payment request changed state.
 *   set   — at least one counts: Cost becomes their sum.
 *   clear — the last accepted one was just taken back (rejected after it had
 *           been approved): the figure it put there goes with it.
 *   keep  — none count and none was taken back: whatever is typed stays.
 */
export function costDecision(
  rows: { status: string; amount: number | string | null }[],
  justUnaccepted: boolean,
): { action: 'set'; cost: number } | { action: 'clear' } | { action: 'keep' } {
  const { accepted, cost } = costFromPayments(rows);
  if (accepted > 0 && cost !== null) return { action: 'set', cost };
  return justUnaccepted ? { action: 'clear' } : { action: 'keep' };
}

/** A quote total worth stamping: a real, positive figure. */
export function invoicedFromQuote(total: number | null | undefined): number | null {
  if (total === null || total === undefined || !Number.isFinite(total) || total <= 0) return null;
  return cents(total);
}

export const COST_LOCKED_MESSAGE =
  'Cost on this work order is written by the payments — it changes when AP pays a request or a paid request is deleted, and cannot be typed.';
export const INVOICED_LOCKED_MESSAGE =
  'Total Invoiced was set from the quote when this work order was invoiced and cannot be typed.';
