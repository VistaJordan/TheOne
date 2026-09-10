// The Main Dashboard's card model.
//
// A card is a small saved question: "how many rows match this filter?", "how
// does the set break down by this field?", "how long between these two
// events?". Cards are per-ACCOUNT (user_pref key 'dashboard.cards') for the
// same reason the All-fields tab order is: "my dashboard, on every machine".
// The server never interprets a card — it stores the array opaquely and the
// browser evaluates each card against the metrics endpoints.

import type { MetricEvent, WoFieldDescriptor, WoFilterSet } from '../api/client';

export const DASH_CARDS_PREF = 'dashboard.cards';

export type DashCardKind = 'count' | 'breakdown' | 'duration';

export interface DashCard {
  id: string;
  kind: DashCardKind;
  label: string;
  /** count: which rows to count (also the deep link into the list). */
  filters?: WoFilterSet;
  /** breakdown: the field to bucket by. */
  field?: string;
  /** duration: the two moments being measured. */
  from?: MetricEvent;
  to?: MetricEvent;
}

export function newCardId(): string {
  // crypto.randomUUID needs a secure context; dev over plain http falls back.
  try {
    return crypto.randomUUID();
  } catch {
    return `card-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/** A stored pref parsed defensively — a card from an older build or a
    hand-edited pref must not crash the dashboard, just disappear. */
export function normalizeCards(raw: unknown): DashCard[] {
  if (!Array.isArray(raw)) return [];
  const out: DashCard[] = [];
  for (const c of raw as Partial<DashCard>[]) {
    if (!c || typeof c.id !== 'string' || typeof c.label !== 'string') continue;
    if (c.kind === 'count' && c.filters && Array.isArray(c.filters.rules)) {
      out.push({ id: c.id, kind: c.kind, label: c.label, filters: c.filters });
    } else if (c.kind === 'breakdown' && typeof c.field === 'string') {
      out.push({ id: c.id, kind: c.kind, label: c.label, field: c.field });
    } else if (c.kind === 'duration' && typeof c.from?.field === 'string' && typeof c.to?.field === 'string') {
      out.push({ id: c.id, kind: c.kind, label: c.label, from: c.from, to: c.to });
    }
  }
  return out;
}

/** "Checked-in → Checked-out", "Priority is Urgent" — the label a fresh card
    starts with; the person can rename it in the editor. */
export function defaultLabel(
  card: Omit<DashCard, 'id' | 'label'>,
  labelOf: (key: string) => string,
): string {
  if (card.kind === 'breakdown') return `By ${labelOf(card.field ?? '')}`;
  if (card.kind === 'duration') {
    const leg = (e?: MetricEvent) =>
      e ? (e.value ? e.value : `${labelOf(e.field)} changed`) : '';
    return `${leg(card.from)} → ${leg(card.to)}`;
  }
  const rule = card.filters?.rules[0];
  if (!rule) return 'All work orders';
  const name = labelOf(rule.field);
  if (rule.op === 'is_not_set') return `${name} not set`;
  if (rule.op === 'is_set') return `${name} is set`;
  return `${name}: ${String(rule.value ?? '')}`;
}

/** Seconds → "3d 4h", "2h 14m", "45m", "30s" — two units, largest first. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** The catalogue label for a key, falling back to the key itself so a card
    over a deleted field still reads as something. */
export function fieldLabeler(fields: WoFieldDescriptor[] | undefined): (key: string) => string {
  const byKey = new Map((fields ?? []).map((f) => [f.key, f.label]));
  return (key) => byKey.get(key) ?? key.replace(/^fields\./, '');
}
