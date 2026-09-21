/**
 * Approval tiers by amount (0047, rule 6.2.3).
 *
 * A tier is a band of money and the roles allowed to say yes inside it.
 * Three kinds of decision read them: approving a payment request, approving
 * a vendor bill, and sending a client invoice. Empty `roles` means anyone
 * holding the base permission — the band still exists so the audit row can
 * say which one the amount fell in.
 *
 * Bands are configuration (Admin › Settings), so nothing here is hard-coded
 * beyond the vocabulary; the seed of 0047 puts rule 6.2.3's bands in place.
 */

export const APPROVAL_TIER_KINDS = ['payment', 'vendor_bill', 'invoice'] as const;
export type ApprovalTierKind = (typeof APPROVAL_TIER_KINDS)[number];

export const APPROVAL_TIER_KIND_LABELS: Record<ApprovalTierKind, string> = {
  payment: 'Payment requests',
  vendor_bill: 'Vendor bills',
  invoice: 'Client invoices',
};

/** What "approve" means for each kind, for the settings card's wording. */
export const APPROVAL_TIER_KIND_VERBS: Record<ApprovalTierKind, string> = {
  payment: 'approve a payment request',
  vendor_bill: 'approve a vendor bill',
  invoice: 'send an invoice to the client',
};

export interface ApprovalTier {
  id: string;
  kind: ApprovalTierKind;
  label: string;
  min_amount: number;
  /** null = no ceiling. */
  max_amount: number | null;
  /** role.code values; empty = anyone with the base permission. */
  roles: string[];
  position: number;
}

export interface ApprovalTierInput {
  kind: ApprovalTierKind;
  label: string;
  min_amount: number;
  max_amount?: number | null;
  roles?: string[];
  position?: number;
}

/** The band an amount falls in: min inclusive, max exclusive. The first
    matching band in position order wins; none = no tier applies. */
export function tierFor(
  tiers: ApprovalTier[],
  kind: ApprovalTierKind,
  amount: number,
): ApprovalTier | null {
  const list = tiers.filter((t) => t.kind === kind).sort((a, b) => a.position - b.position);
  for (const t of list) {
    if (amount < t.min_amount) continue;
    if (t.max_amount !== null && amount >= t.max_amount) continue;
    return t;
  }
  return null;
}

/** Whether a role may decide inside a band. Super admins always may; an
    empty band restricts nobody. */
export function tierAllows(
  tier: ApprovalTier | null,
  role: string | null | undefined,
  isSuperAdmin: boolean,
): boolean {
  if (tier === null || isSuperAdmin) return true;
  if (tier.roles.length === 0) return true;
  return Boolean(role) && tier.roles.includes(role as string);
}

/** "$500 to $3,000" / "Over $3,000" — how a band reads when it has no label. */
export function describeTierBand(min: number, max: number | null): string {
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  if (max === null) return min <= 0 ? 'Any amount' : `Over ${usd(min)}`;
  if (min <= 0) return `Under ${usd(max)}`;
  return `${usd(min)} to ${usd(max)}`;
}

/** `details.code` on the 403 when the amount's band excludes the actor. */
export const APPROVAL_TIER_CODE = 'APPROVAL_TIER';
