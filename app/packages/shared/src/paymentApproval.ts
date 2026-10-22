// ── Who has to say yes to a payment request (Elise, 2026-10-22) ──────────────
//
// The pure half: given the REQUESTER's role and the amount, does the request
// wait in the queue (`requested`) or land already cleared for AP (`approved`)?
// The API asks it once, at create; the amount bands that then decide WHO may
// approve a waiting request are the approval tiers (0047, Admin › Settings),
// re-applied to payments by migration 0090:
//   under $500          anyone with payments:approve
//   $500 to $3,000      TL / ATL (and Admin)
//   $3,000 and over     AM (and Admin)
//
// The rule by requester:
//   OM Under Probation  every request waits, whatever the amount
//   OM / Senior OM      a request under $500 is approved as it is raised;
//                       $500 and over waits for the band's approver
//   everyone else       unchanged — every request waits
//
// Pay still needs `approved` and a second person (D2), and the NTE / quote
// holds are asked again before any money goes out, so an auto-approved
// request is cleared for AP, not paid.

import { dispatcherTier } from './access';

/** A dispatcher's (OM / Senior OM) request under this amount needs no approval. */
export const PAYMENT_AUTO_APPROVE_UNDER = 500;

export interface PaymentApprovalVerdict {
  /** true = the request waits in the queue; false = approved as it is raised. */
  needed: boolean;
  /** One sentence for the audit row and the requester. */
  reason: string;
}

export function paymentApprovalVerdict(
  requesterRole: string | null | undefined,
  amount: number,
): PaymentApprovalVerdict {
  const tier = dispatcherTier(requesterRole);
  if (tier === 'probation') {
    return { needed: true, reason: 'Every payment request from an OM Under Probation needs approval' };
  }
  if (tier === 'dispatcher' || tier === 'senior') {
    if (Number.isFinite(amount) && amount < PAYMENT_AUTO_APPROVE_UNDER) {
      return {
        needed: false,
        reason: `Under $${PAYMENT_AUTO_APPROVE_UNDER} from a dispatcher — approved as requested`,
      };
    }
    return { needed: true, reason: `$${PAYMENT_AUTO_APPROVE_UNDER} and over needs approval` };
  }
  return { needed: true, reason: 'Payment requests need approval' };
}
