// UAT round 1, Wave A — money integrity (migration 0083).
//
// The pure half of the guards the API enforces and the browser draws before
// the click: maker ≠ checker (D2), the numeric bounds a column can hold (M1),
// the payment purpose codes (#24), the "would this go over" sums behind the
// approval holds (#5, #7, #20, #21) and the invoicing gate (#2, money half).
// Nothing here touches a database; apps/api binds it to rows.
//
// House rule D1: an integrity fault is a hard refusal (409, a details.code);
// a business-judgment overage raises an approval task that holds the money
// step until a manager decides it; everything else is a warning.

import { PHASE_BY_STATUS_NAME } from './index';

// ── D2 · maker ≠ checker ─────────────────────────────────────────────────────

/** details.code of the 403 a person gets for deciding their own request. */
export const SELF_APPROVAL_CODE = 'SELF_APPROVAL';

export type SelfApprovalVerdict = 'ok' | 'blocked' | 'self_approved';

/**
 * Whoever requested, submitted, created or uploaded a thing cannot approve it.
 * A super admin may decide their own — the decision is logged with
 * `self_approved: true`. A thing with no recorded maker (legacy rows, a
 * service principal) is never blocked.
 */
export function selfApprovalVerdict(
  makerId: string | null | undefined,
  deciderId: string,
  deciderIsSuperAdmin: boolean,
): SelfApprovalVerdict {
  if (!makerId || makerId !== deciderId) return 'ok';
  return deciderIsSuperAdmin ? 'self_approved' : 'blocked';
}

/** The sentence both sides print. `what` reads like "this payment request". */
export function selfApprovalMessage(what: string, verb = 'approve'): string {
  return `You raised ${what}, so someone else has to ${verb} it (maker ≠ checker).`;
}

// ── M1 · bounds ──────────────────────────────────────────────────────────────

/** The largest amount any money input takes (numeric(12,2) leaves headroom
    for sums of several). */
export const MONEY_MAX = 9_999_999.99;
/** The largest percent (numeric(5,2) — markup, tax). */
export const PERCENT_MAX = 999.99;
/** details.code of a 400 for a number the database cannot hold. */
export const VALIDATION_CODE = 'VALIDATION';

export function withinMoneyBound(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) <= MONEY_MAX;
}

// ── #24 · payment purpose codes ──────────────────────────────────────────────

export const PAYMENT_PURPOSE_CODES = ['J', 'M', 'A'] as const;
export type PaymentPurposeCode = (typeof PAYMENT_PURPOSE_CODES)[number];

export const PAYMENT_PURPOSE_LABEL: Record<PaymentPurposeCode, string> = {
  J: 'Job',
  M: 'Materials',
  A: 'Assessment',
};

export function isPaymentPurposeCode(v: unknown): v is PaymentPurposeCode {
  return typeof v === 'string' && (PAYMENT_PURPOSE_CODES as readonly string[]).includes(v);
}

/** "J" / "J1" / "J12" → "J"; anything else (a pre-0083 free-text purpose) → null. */
export function purposeBase(stored: string | null | undefined): PaymentPurposeCode | null {
  const m = /^([JMA])(\d*)$/.exec((stored ?? '').trim().toUpperCase());
  return m ? (m[1] as PaymentPurposeCode) : null;
}

/**
 * The stored purpose for a new payment of `code` on a work order that already
 * holds `existing` purposes: the first is the bare letter, repeats are
 * numbered J1, J2… (never reusing a number, so a deleted J1 does not come
 * back). Free-text purposes from before 0083 are ignored.
 */
export function nextPurpose(code: PaymentPurposeCode, existing: (string | null | undefined)[]): string {
  let max = -1;
  for (const raw of existing) {
    const m = /^([JMA])(\d*)$/.exec((raw ?? '').trim().toUpperCase());
    if (!m || m[1] !== code) continue;
    const n = m[2] === '' ? 0 : Number(m[2]);
    if (n > max) max = n;
  }
  return max < 0 ? code : `${code}${max + 1}`;
}

/** "J2" → "Job (J2)"; free text is shown as it was typed. */
export function purposeLabel(stored: string): string {
  const base = purposeBase(stored);
  return base ? `${PAYMENT_PURPOSE_LABEL[base]} (${stored.trim().toUpperCase()})` : stored;
}

// ── #5 / #7 · the payment holds ──────────────────────────────────────────────

/** details.code of the 409 while a payment would take Cost past the NTE. */
export const NTE_OVERRIDE_REQUIRED_CODE = 'NTE_OVERRIDE_REQUIRED';
/** details.code of the 409 while a payment would take Cost past the approved quote. */
export const OVER_QUOTE_CODE = 'OVER_QUOTE';
/** details.code of the 409 while a vendor bill is above what is still owed. */
export const BILL_OVER_OWED_CODE = 'BILL_OVER_OWED';

const cents = (n: number) => Math.round(n * 100);

/** What Cost would read once this payment is paid. */
export function projectedCost(cost: number | null | undefined, amount: number): number {
  return (cents(cost ?? 0) + cents(amount)) / 100;
}

/** True when the projected cost is over the NTE and no approved override
    already covers that much (`covered` = the largest cost a manager OK'd). */
export function overNte(projected: number, nte: number | null | undefined, covered: number | null | undefined): boolean {
  if (nte === null || nte === undefined || !Number.isFinite(nte)) return false;
  if (cents(projected) <= cents(nte)) return false;
  return !(covered !== null && covered !== undefined && cents(covered) >= cents(projected));
}

/**
 * #7: the approved quote is the ceiling of what goes out. Over its cost side
 * (`quoteCost`, the vendor cost the quote was built on) or over its price
 * (`quoteTotal` — paying more than the client pays is a negative margin).
 * Returns the reason, or null. No approved quote = no ceiling.
 */
export function overQuoteReason(
  projected: number,
  quote: { total: number | null; cost: number | null } | null,
  covered: number | null | undefined,
): string | null {
  if (!quote) return null;
  if (covered !== null && covered !== undefined && cents(covered) >= cents(projected)) return null;
  if (quote.total !== null && quote.total > 0 && cents(projected) > cents(quote.total)) {
    return `Cost would be ${usd(projected)}, more than the approved quote's ${usd(quote.total)} — a negative margin`;
  }
  if (quote.cost !== null && quote.cost > 0 && cents(projected) > cents(quote.cost)) {
    return `Cost would be ${usd(projected)}, more than the approved quote's cost of ${usd(quote.cost)}`;
  }
  return null;
}

/** UAT T5 (lock before the click): what holds approving or paying one
    payment request, for the button's lock — the same questions the API asks
    at the click (assertPaymentNotHeld), answered from the row: an open hold
    first, then the NTE projection, then the over-quote projection against
    the approved quote's price and cost side (`quote`, null when there is no
    approved quote) less what a manager already covered. Only a waiting
    request (requested / approved) is ever held. */
export interface PaymentLockInput {
  status: string;
  overQuoteOpen: boolean;
  nteOverrideOpen: boolean;
  cost: number | null;
  amount: number;
  nte: number | null;
  nteCovers: number | null;
  quote: { total: number | null; cost: number | null } | null;
  quoteCovers: number | null;
}

export function paymentLockReason(r: PaymentLockInput): string | null {
  if (r.status !== 'requested' && r.status !== 'approved') return null;
  if (r.overQuoteOpen) return 'On hold — paying more than the approved quote waits on a manager (Approvals › Money holds)';
  const projected = projectedCost(r.cost, r.amount);
  if (!r.nteOverrideOpen && overNte(projected, r.nte, r.nteCovers)) {
    return `Paying this takes Cost to ${usd(projected)}, over the client NTE ${usd(r.nte ?? 0)} — the click raises an NTE override for a manager`;
  }
  const over = overQuoteReason(projected, r.quote, r.quoteCovers);
  if (over) return `${over} — the click raises an over-quote hold for a manager`;
  return null;
}

/** UAT T5b: why Approve is locked on a quote row for this viewer — they
    submitted it (D2) — or null. A super admin may decide their own. */
export function quoteSelfApprovalLock(
  makerId: string | null | undefined,
  viewerId: string | null | undefined,
  viewerIsSuperAdmin: boolean,
): string | null {
  if (!viewerId) return null;
  return selfApprovalVerdict(makerId, viewerId, viewerIsSuperAdmin) === 'blocked'
    ? 'You submitted this quote — someone else has to approve it (maker ≠ checker)'
    : null;
}

/**
 * #20: what is still owed to vendors on a work order — the approved quote's
 * cost side less what already went out (paid payment requests) and the other
 * live bills. Null when there is no approved quote cost to measure against.
 */
export function vendorOwed(quoteCost: number | null, paid: number, otherBills: number): number | null {
  if (quoteCost === null || !(quoteCost > 0)) return null;
  return (cents(quoteCost) - cents(paid) - cents(otherBills)) / 100;
}

export function billOverOwed(total: number, owed: number | null, covered: number | null | undefined): boolean {
  if (owed === null) return false;
  if (cents(total) <= cents(owed)) return false;
  return !(covered !== null && covered !== undefined && cents(covered) >= cents(total));
}

// ── #21 · purchasing ─────────────────────────────────────────────────────────

/** A purchase order raised without a purchase request above this needs a
    second person's approval before it is issued (setting `po_limit`). */
export const PO_LIMIT_DEFAULT = 5000;
export const PO_OVER_LIMIT_CODE = 'PO_OVER_LIMIT';
export const PO_EXISTS_CODE = 'PO_EXISTS';
export const VENDOR_REQUIRED_CODE = 'VENDOR_REQUIRED';

export function poNeedsLimitApproval(
  po: { total: number; request_id: string | null; limit_approved: boolean },
  limit: number,
): boolean {
  return !po.request_id && !po.limit_approved && cents(po.total) > cents(limit);
}

// ── #2 (money half) · invoicing needs the job done ───────────────────────────

export const INVOICE_NOT_DONE_CODE = 'INVOICE_NOT_DONE';

/**
 * An invoice is raised only once the work order is in the done group or
 * later: a status the phase map knows must be in Done or Invoiced; one it
 * does not know must sit in the `done` group. Cancelled is never billable.
 */
export function invoiceAllowedForStatus(statusName: string, group: string | null | undefined): boolean {
  const known = Object.keys(PHASE_BY_STATUS_NAME).find((k) => k.toLowerCase() === statusName.trim().toLowerCase());
  if (known !== undefined) {
    const phase = PHASE_BY_STATUS_NAME[known];
    return phase === 'Done' || phase === 'Invoiced';
  }
  return group === 'done';
}

// ── #23 · quotes ─────────────────────────────────────────────────────────────

export const QUOTE_OVER_NTE_CODE = 'QUOTE_OVER_NTE';

/** A quote priced above the NTE is not sent until the NTE is raised. */
export function quoteOverNte(total: number, nte: number | null | undefined): boolean {
  if (nte === null || nte === undefined || !Number.isFinite(nte)) return false;
  return cents(total) > cents(nte);
}

// ── M7 · Mark paid ───────────────────────────────────────────────────────────

export const INVOICE_PAYMENT_DETAILS_CODE = 'INVOICE_PAYMENT_DETAILS';

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
