// The quote clock as the web reads it (rules 2.3.1–2.3.3, 0024): one place
// for "is this work order's quote late?" so the list cell, the Dates card and
// the CICO summary can never disagree.

import { PHASE_BY_STATUS_NAME, QUOTE_DUE_HOURS, QUOTE_DUE_KEY, isQuoteOwed } from '@theone/shared';
import { str } from './fields';

export const QUOTE_DUE_FIELD_KEY = `fields.${QUOTE_DUE_KEY}`;

export const QUOTE_DUE_HINT =
  `Assessment check-out + ${QUOTE_DUE_HOURS} working hours — Saturdays, Sundays and holidays skipped (Admin › Settings)`;

/** Is a quote still owed in this status? Reads the shared phase map, so an
    admin-added status the map does not know owes nothing (no false alarms). */
export function quoteOwedIn(statusName: string | null | undefined): boolean {
  const phase = statusName ? (PHASE_BY_STATUS_NAME[statusName] ?? null) : null;
  return isQuoteOwed(statusName, phase);
}

/** True when the Quote Due Date has passed AND the quote is still owed —
    the red the rule asks for. A quote that shipped on time stays plain. */
export function quoteDueBreached(
  raw: unknown,
  statusName: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const s = str(raw);
  if (!s) return false;
  const t = Date.parse(s.replace(' ', 'T'));
  return !Number.isNaN(t) && t < now && quoteOwedIn(statusName);
}
