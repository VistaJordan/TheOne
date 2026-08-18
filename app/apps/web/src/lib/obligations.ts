// S5 — obligation presentation. Pure functions only: labels, tier vocabulary,
// clock formatting and the breach ordering. Every screen that renders a clock
// (the board's Clock column, the WO header cluster, the rail card, the bell, the
// Pulse) reads its wording from HERE, so a rule renamed once is renamed
// everywhere.

import type { ObligationSummary, ObligationTier } from '../api/client';
import { initialsOf, roleLabel } from './actor';

/** Chip wording — short enough for a table cell. */
const RULE_CHIP_LABEL: Record<string, string> = {
  emergency_ack: 'Ack emergency',
  quote_owed: 'Quote owed',
  schedule_owed: 'ETA owed',
  approval_followup: 'Chase client',
  quote_review_owed: 'Quote review',
  payment_processing: 'Payment owed',
  sla_blown: 'SLA blown',
};

/** Card wording — the full sentence the Pulse and the rail card print. */
const RULE_FULL_LABEL: Record<string, string> = {
  emergency_ack: 'Emergency not acknowledged',
  quote_owed: 'Quote owed to the client',
  schedule_owed: 'ETA owed after approval',
  approval_followup: 'Client approval needs chasing',
  quote_review_owed: 'Quote waiting on review',
  payment_processing: 'Payment request unprocessed',
  sla_blown: 'SLA date blown',
};

/** One line of why the clock exists — the card's second line. */
const RULE_WHY: Record<string, string> = {
  emergency_ack: 'Emergency work orders are acknowledged within 2 hours, around the clock.',
  quote_owed: 'A quote is owed within 2 business days of the request.',
  schedule_owed: 'An ETA is owed within 2 business hours of approval.',
  approval_followup: 'Approvals sitting 5 business days get chased with the client.',
  quote_review_owed: 'A submitted quote is reviewed within 4 business hours.',
  payment_processing: 'Payment requests are processed within 2 business days.',
  sla_blown: 'The SLA due date has passed and the work order is still open.',
};

/** "quote_review_owed" → "Quote review owed" — an unseeded rule still reads. */
function humanise(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Chip label: the server's own `label` wins, then the vocabulary, then the key. */
export function ruleChipLabel(ob: Pick<ObligationSummary, 'rule_key' | 'label'>): string {
  if (ob.label) return ob.label;
  return RULE_CHIP_LABEL[ob.rule_key] ?? humanise(ob.rule_key);
}

export function ruleFullLabel(ob: Pick<ObligationSummary, 'rule_key' | 'label'>): string {
  return RULE_FULL_LABEL[ob.rule_key] ?? ob.label ?? humanise(ob.rule_key);
}

export function ruleWhy(ruleKey: string): string | null {
  return RULE_WHY[ruleKey] ?? null;
}

// ── Tiers ────────────────────────────────────────────────────────────────────

export const TIER_LABEL: Record<ObligationTier, string> = {
  0: 'Watching',
  1: 'Due soon',
  2: 'Breached',
  3: 'Critical',
};

/** Anything off the 0–3 scale is clamped rather than dropped. */
export function tierOf(ob: { tier?: number | null } | null | undefined): ObligationTier {
  const raw = Number(ob?.tier ?? 0);
  if (!Number.isFinite(raw)) return 0;
  const clamped = Math.max(0, Math.min(3, Math.round(raw)));
  return clamped as ObligationTier;
}

/** The single class hook every tier-coloured surface uses (`tier-0`…`tier-3`).
    The class carries only CSS CUSTOM PROPERTIES (--tier-ink/-bg/-border/-dot),
    so every chip, stripe, dot and card reads one ramp — no new hex anywhere. */
export function tierClass(tier: ObligationTier): string {
  return `tier-${tier}`;
}

// ── Clocks ───────────────────────────────────────────────────────────────────

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export interface ClockText {
  /** "1h 12m" while running, "2d over" once breached, "—" with no deadline. */
  text: string;
  overdue: boolean;
  /** True when there is no parsable due_at — the chip drops its countdown. */
  unknown: boolean;
}

/** Remaining time, coarse and readable. Overdue collapses to ONE unit ("2d
    over") because the exact minute stopped mattering the moment it blew. */
export function formatClock(dueAt: string | null | undefined, now: number): ClockText {
  const due = parseDate(dueAt);
  if (due == null) return { text: '—', overdue: false, unknown: true };

  const diff = due - now;
  const overdue = diff < 0;
  const mins = Math.floor(Math.abs(diff) / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (overdue) {
    if (days >= 1) return { text: `${days}d over`, overdue, unknown: false };
    if (hours >= 1) return { text: `${hours}h over`, overdue, unknown: false };
    return { text: `${Math.max(mins, 1)}m over`, overdue, unknown: false };
  }
  if (days >= 1) {
    const restHours = hours - days * 24;
    return { text: restHours ? `${days}d ${restHours}h` : `${days}d`, overdue, unknown: false };
  }
  if (hours >= 1) {
    const restMins = mins - hours * 60;
    return { text: restMins ? `${hours}h ${restMins}m` : `${hours}h`, overdue, unknown: false };
  }
  return { text: mins <= 0 ? 'due now' : `${mins}m`, overdue, unknown: false };
}

/** Absolute deadline for the chip's title attribute. */
export function dueTitle(ob: ObligationSummary): string {
  const due = parseDate(ob.due_at);
  const when = due == null ? 'no deadline recorded' : new Date(due).toLocaleString('en-US');
  return `${ruleFullLabel(ob)} · due ${when}`;
}

// ── Ordering ─────────────────────────────────────────────────────────────────

/**
 * Breach severity, worst-first. Tier dominates (a breached 2-hour clock outranks
 * a merely-warm 5-day one); minutes past due break the tie. Rows with no
 * obligation rank below every row that has one.
 *
 * The board's "Sort by breach" toggle sends `?sort=breach`; this is the same
 * order applied client-side so the toggle still bites if the server ignores it.
 */
export function breachRank(ob: ObligationSummary | null | undefined, now: number): number {
  if (!ob) return -1;
  const due = parseDate(ob.due_at);
  const minutesOver = due == null ? 0 : (now - due) / 60_000;
  const bounded = Math.max(-500_000, Math.min(500_000, minutesOver));
  return tierOf(ob) * 1_000_000 + bounded;
}

/** Worst of a set — what the header cluster leads with and the row chip shows. */
export function worstOf<T extends ObligationSummary>(
  items: readonly T[],
  now: number,
): T | null {
  let best: T | null = null;
  let bestRank = -Infinity;
  for (const ob of items) {
    const rank = breachRank(ob, now);
    if (rank > bestRank) {
      bestRank = rank;
      best = ob;
    }
  }
  return best;
}

/** Worst-first, for a column of cards. */
export function sortByBreach<T extends ObligationSummary>(items: readonly T[], now: number): T[] {
  return [...items].sort((a, b) => breachRank(b, now) - breachRank(a, now));
}

// ── Ownership ────────────────────────────────────────────────────────────────

export interface OwnerDisplay {
  name: string;
  initials: string;
  role: string | null;
  /** True when nobody resolved and the obligation is owed by a ROLE. */
  isRole: boolean;
}

/** Who owes it, as the avatar + caption render it. A role-owed obligation shows
    the role badge ("ATL") rather than pretending a person is on the hook. */
export function ownerDisplay(ob: {
  owed_by?: { name?: string | null; display_name?: string | null; role?: string | null } | null;
  owed_role?: string | null;
}): OwnerDisplay {
  const person = ob.owed_by?.name ?? ob.owed_by?.display_name ?? null;
  const role = ob.owed_by?.role ?? ob.owed_role ?? null;
  if (person) {
    return { name: person, initials: initialsOf(person), role, isRole: false };
  }
  if (role) {
    const label = roleLabel(role);
    return { name: `Anyone with ${label}`, initials: label.slice(0, 2).toUpperCase(), role, isRole: true };
  }
  return { name: 'Unassigned', initials: '—', role: null, isRole: true };
}
