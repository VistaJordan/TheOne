// ── Who has to say yes to a payment request ──────────────────────────────────
//
// The pure half: given the amount, does the request wait in the queue
// (`requested`) or land already cleared for AP (`approved`)? The API asks it
// once, at create; the amount bands that then decide WHO may approve a
// waiting request are the approval tiers (0047, Admin › Settings), set by
// migration 0115 (Elise, 2026-11-02) for payments and purchase requests alike:
//   under $500          no approval — approved as it is raised
//   $500 to $3,000      TL / ATL
//   $3,000 and over     AM
// (a super admin may always approve.)
//
// 0090 had asked an OM Under Probation's request to wait whatever the
// amount, and let only the OM / Senior OM skip it under $500; since 0115
// the amount alone decides, whoever raises it. `requesterRole` is kept so
// callers and the audit row read as before.
//
// Pay still needs `approved` and a second person (D2), and the NTE / quote
// holds are asked again before any money goes out, so an auto-approved
// request is cleared for AP, not paid. A request that takes Cost past the
// NTE or the approved quote is never auto-approved (payments.ts).

/** Below this amount a payment request or a purchase request needs no approval. */
export const APPROVAL_NOT_NEEDED_UNDER = 500;
/** The payments name for the same threshold. */
export const PAYMENT_AUTO_APPROVE_UNDER = APPROVAL_NOT_NEEDED_UNDER;

export interface PaymentApprovalVerdict {
  /** true = the request waits in the queue; false = approved as it is raised. */
  needed: boolean;
  /** One sentence for the audit row and the requester. */
  reason: string;
}

export function paymentApprovalVerdict(
  _requesterRole: string | null | undefined,
  amount: number,
): PaymentApprovalVerdict {
  if (Number.isFinite(amount) && amount >= 0 && amount < APPROVAL_NOT_NEEDED_UNDER) {
    return { needed: false, reason: `Under $${APPROVAL_NOT_NEEDED_UNDER} — approved as requested` };
  }
  return { needed: true, reason: `$${APPROVAL_NOT_NEEDED_UNDER} and over needs approval` };
}
