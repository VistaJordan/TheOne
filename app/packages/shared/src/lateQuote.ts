// ── Late Quote ticks itself (Elise, 2026-11-16) ──────────────────────────────
//
// The `Late Quote` penalty (Penalties section, 0094) is ticked automatically
// once the work order's Quote Due Date (the computed one: the assessment
// check-out + 48 business hours, rule 2.3.1) has passed and no quote has been
// submitted yet — there is none, or it is still a draft — while the work
// order still owes one (`isQuoteOwed`: Intake / Assessment / Quote phases,
// not Quote Ready). The tick is signed by the "Late quotes" service
// principal, and an empty Manager Description is filled with the reason.
//
// A manager takes it off like any penalty (the dispatchers are view-only on
// the section, 0094). Once the field has ever been written — by this sweep or
// by a person — the sweep never touches it again, so a removal sticks.
//
// The database half is apps/api/src/services/lateQuote.ts.

/** The business time zone (BUSINESS_TIME_ZONE in index.ts; not imported, to keep this file leaf). */
const BUSINESS_TIME_ZONE = 'America/Chicago';

export const LATE_QUOTE_KEY = 'Late Quote';
export const LATE_QUOTE_ACTOR_NAME = 'Late quotes';

/** Quote statuses that are still "not submitted". */
export const LATE_QUOTE_UNSUBMITTED_STATUSES: readonly string[] = ['draft'];

export interface LateQuoteFacts {
  /** The Quote Due Date as stored (ISO), or null. */
  quoteDueAt: string | null;
  /** The work order's quote status, or null when it has none. */
  quoteStatus: string | null;
  /** isQuoteOwed(status, phase) for the work order. */
  quoteOwed: boolean;
  /** Late Quote already ticked. */
  ticked: boolean;
  /** The field has been written before (by anyone) — never touched again. */
  touchedBefore: boolean;
}

export function shouldMarkLateQuote(f: LateQuoteFacts, now: Date = new Date()): boolean {
  if (f.ticked || f.touchedBefore || !f.quoteOwed || !f.quoteDueAt) return false;
  const due = Date.parse(f.quoteDueAt);
  if (Number.isNaN(due) || due >= now.getTime()) return false;
  return f.quoteStatus === null || LATE_QUOTE_UNSUBMITTED_STATUSES.includes(f.quoteStatus);
}

/** The Manager Description written when it is empty. */
export function lateQuoteDescription(quoteDueAt: string): string {
  const d = new Date(quoteDueAt);
  const when = Number.isNaN(d.getTime())
    ? quoteDueAt
    : d.toLocaleString('en-US', {
        timeZone: BUSINESS_TIME_ZONE,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
  return `Late quote — not submitted by the quote due date (${when} CT). Marked automatically.`;
}
