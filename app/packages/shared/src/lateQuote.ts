// ── Late Quote ticks itself (Elise, 2026-11-16; clock changed 2026-11-19) ──
//
// The `Late Quote` penalty (Penalties section, 0094) is ticked automatically
// when a work order has sat in Waiting for Quote for QUOTE_DUE_AFTER_HOURS
// (48) working hours — weekends and holidays skipped, counted from the moment
// it entered the status — and no quote has been submitted. That is the same
// clock and the same test as the "Quote due" notices (services/notices.ts),
// so a work order is marked late the moment its "due" notice's time passes.
// (Until 2026-11-19 it keyed off the Quote Due Date field, which only an
// Assessment check-out sets, so a work order moved to Waiting for Quote any
// other way was never marked.) "Submitted" = a quote in one of
// QUOTE_ON_ITS_WAY_STATUSES; none, a draft or a declined one still owes it.
// The tick is signed by the "Late quotes" service principal, and an empty
// Manager Description is filled with the reason.
//
// A manager takes it off like any penalty (the dispatchers are view-only on
// the section, 0094). Once the field has been written — by this sweep or by a
// person — since the work order last entered Waiting for Quote, the sweep
// leaves it alone, so a removal sticks; a work order sent back to Waiting for
// Quote starts a new clock and can be marked again.
//
// The database half is apps/api/src/services/lateQuote.ts.

/** The business time zone (BUSINESS_TIME_ZONE in index.ts; not imported, to keep this file leaf). */
const BUSINESS_TIME_ZONE = 'America/Chicago';

export const LATE_QUOTE_KEY = 'Late Quote';
export const LATE_QUOTE_ACTOR_NAME = 'Late quotes';

/** Quote statuses that count as submitted ("on its way"): any other — none,
    a draft, a declined one — still owes the quote. Shared with the "Quote
    due" notices. */
export const QUOTE_ON_ITS_WAY_STATUSES: readonly string[] = [
  'pending_correction',
  'pending_approval',
  'approved',
  'sent',
  'client_approved',
];

export interface LateQuoteFacts {
  /** When the quote was due: entry into Waiting for Quote + 48 working hours
      (ISO), or null. */
  dueAt: string | null;
  /** The work order sits in Waiting for Quote now. */
  waitingForQuote: boolean;
  /** The work order's quote status, or null when it has none. */
  quoteStatus: string | null;
  /** Late Quote already ticked. */
  ticked: boolean;
  /** The field was written since the work order entered Waiting for Quote. */
  touchedSinceEntered: boolean;
}

export function shouldMarkLateQuote(f: LateQuoteFacts, now: Date = new Date()): boolean {
  if (f.ticked || f.touchedSinceEntered || !f.waitingForQuote || !f.dueAt) return false;
  const due = Date.parse(f.dueAt);
  if (Number.isNaN(due) || due > now.getTime()) return false;
  return f.quoteStatus === null || !QUOTE_ON_ITS_WAY_STATUSES.includes(f.quoteStatus);
}

/** The Manager Description written when it is empty. */
export function lateQuoteDescription(dueAt: string): string {
  const d = new Date(dueAt);
  const when = Number.isNaN(d.getTime())
    ? dueAt
    : d.toLocaleString('en-US', {
        timeZone: BUSINESS_TIME_ZONE,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
  return `Late quote — not submitted within 48 working hours of Waiting for Quote (due ${when} CT). Marked automatically.`;
}
