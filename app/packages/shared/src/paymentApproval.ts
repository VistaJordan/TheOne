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
// (a super admin may always approve.) Since 0149 (Elise, 2026-11-16) the
// payment bands are one ladder: ATL up to $3,000, TL up to $5,000, AM up to
// $50,000, a super admin above; purchase requests keep 0115's.
//
// 0090 had asked an OM Under Probation's request to wait whatever the
// amount, and let only the OM / Senior OM skip it under $500; since 0115
// the amount alone decides, whoever raises it. `requesterRole` is kept so
// callers and the audit row read as before.
//
// The NTE / quote holds are asked again before any money goes out, so an
// auto-approved request is cleared for AP, not paid. Since 2026-11-17 a
// manager whose band covers the amount may also Pay it straight from
// requested (the pay is the approval); AP still pays only approved requests. A request that takes Cost past the
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

// ── Zelle and Cash App always ask a manager (Elise, 2026-11-13) ─────────────
//
// A payment made by Zelle or Cash App is never approved as it is raised,
// whatever the amount, and only a TL, an ATL or an AM (or a super admin) may
// approve or decline it. The amount bands still apply on top: $3,000 and over
// stays the AM's. A processor who switches an approved request to one of these
// methods sends it back to the queue unless a manager approved it.

export const MANAGER_APPROVAL_METHODS: readonly string[] = ['zelle', 'cashapp'];
export const MANAGER_APPROVAL_ROLES: readonly string[] = ['tl', 'atl', 'am'];
export const MANAGER_METHOD_TIER_LABEL = 'Zelle / Cash App — TL, ATL or AM';

export function needsManagerForMethod(method: string | null | undefined): boolean {
  return MANAGER_APPROVAL_METHODS.includes((method ?? '').trim().toLowerCase());
}

/** May this person approve (or decline) a Zelle / Cash App payment? */
export function mayApproveManagerMethod(role: string | null | undefined, isSuperAdmin: boolean): boolean {
  return isSuperAdmin || MANAGER_APPROVAL_ROLES.includes(role ?? '');
}

// ── Maker ≠ checker, unless the maker has the clearance (Elise, 2026-11-16,
// UAT #33) ─────────────────────────────────────────────────────────────────
//
// Replaces 0115's "under $500 needs no approval" for payments: every payment
// request, small ones included, waits for a second person — UNLESS the person
// raising it could approve that very request themselves (they hold
// `payments` approve, their role is in the amount's band — 0153 gives the
// under-$500 band to ATL / TL / AM — and for Zelle / Cash App they are a TL /
// ATL / AM). Then a checker adds nothing and the request lands approved,
// signed by its requester. The API works out `requesterClears` (it has the
// bands); this function words it. A request that takes Cost past the NTE or
// the approved quote is still never approved as it is raised (payments.ts).
// Purchase requests keep APPROVAL_NOT_NEEDED_UNDER.

//
// 2026-11-17 (Elise, UAT #36 restated): under $500 needs nobody's approval
// again — the request is approved as it is raised, whoever raises it, except
// Zelle / Cash App (a TL / ATL / AM still approves) and a payment that takes
// the job past its NTE or the approved quote (payments.ts asks those). From
// $500 the bands decide, each level covering the ones below it — ATL to
// $3,000, TL to $5,000, AM to $50,000 — and a manager whose band covers the
// amount may approve or pay it, their own request included
// (`mayPayDirectly` in payments.ts).

export function paymentApprovalVerdict(
  _requesterRole: string | null | undefined,
  amount: number,
  method?: string | null,
  requesterClears = false,
): PaymentApprovalVerdict {
  if (!Number.isFinite(amount) || amount < 0) {
    return { needed: true, reason: 'Waits for a manager to approve it' };
  }
  if (needsManagerForMethod(method) && !requesterClears) {
    return { needed: true, reason: 'Zelle and Cash App payments always need a manager’s approval' };
  }
  if (amount < APPROVAL_NOT_NEEDED_UNDER) {
    return { needed: false, reason: 'Under $500 — no approval needed' };
  }
  if (requesterClears) {
    return { needed: false, reason: 'Approved as requested — the requester may approve this amount' };
  }
  return { needed: true, reason: 'Waits for a manager whose band covers this amount' };
}
