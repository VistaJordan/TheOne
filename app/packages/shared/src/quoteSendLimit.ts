// How much a person may send to a client on their own (Elise, 2026-11-16).
//
// An ATL sends quotes up to $5,000 by default; a quote above their limit is
// still theirs to review, but they submit it for approval and a Team Lead
// (or anyone with no limit: TL, AM, Admin, a super admin) sends it. The
// limit is adjustable per person in Admin › Users (`principal.quote_send_limit`,
// migration 0143): a figure set there wins over the role's default; no figure
// = the role's default; a role with no default = no limit.
//
// The amount compared is the quote's dearest option (`quoteTotalForNte`), the
// most the client could approve. Pure: the API refuses with it (403
// QUOTE_SEND_LIMIT on Approve and Send) and the builder locks Send with the
// same sentence.

/** The role defaults. A role not listed has no limit. */
export const QUOTE_SEND_LIMIT_DEFAULT_BY_ROLE: Readonly<Record<string, number>> = {
  atl: 5000,
};

export const QUOTE_SEND_LIMIT_CODE = 'QUOTE_SEND_LIMIT';

/** The role's default limit, or null when the role has none. */
export function roleQuoteSendLimit(role: string | null | undefined): number | null {
  const v = QUOTE_SEND_LIMIT_DEFAULT_BY_ROLE[role ?? ''];
  return typeof v === 'number' ? v : null;
}

/** This person's limit: their own figure, else the role's default, else none
    (null). A super admin is never limited. */
export function quoteSendLimitFor(
  role: string | null | undefined,
  personal: number | null | undefined,
  isSuperAdmin = false,
): number | null {
  if (isSuperAdmin) return null;
  if (typeof personal === 'number' && Number.isFinite(personal) && personal >= 0) return personal;
  return roleQuoteSendLimit(role);
}

/** Is this quote total above the person's limit? */
export function quoteOverSendLimit(total: number | null | undefined, limit: number | null): boolean {
  if (limit === null || typeof total !== 'number' || !Number.isFinite(total)) return false;
  return Math.round(total * 100) > Math.round(limit * 100);
}

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The sentence on the 403 and on the locked Send button. */
export function quoteSendLimitSentence(total: number, limit: number): string {
  return `This quote (${usd(total)}) is above your sending limit (${usd(limit)}). Submit it for approval and a Team Lead will send it to the client.`;
}
