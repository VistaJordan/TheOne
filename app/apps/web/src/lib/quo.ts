/* Formatters + derivations for the Messages tab (Sprint 3). Everything here is
   pure and null-tolerant: the Quo mirror is an EXTERNAL feed, so any column can
   arrive empty and the panel must still look intentional rather than broken. */

import type { ThreadItem, ThreadMessage } from '../api/client';
import { DASH } from './fields';

/** `272` → `'4m 32s'`; `125` → `'2m 05s'`. Seconds are always two digits so a
    column of durations stays aligned under `font-variant-numeric: tabular-nums`. */
export function callDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return DASH;
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Local calendar day key ('2026-07-15') used to decide where day dividers go. */
export function dayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 'Wed · Jul 16' — the comp's day-divider label. */
export function dayLabel(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${wd} · ${md}`;
}

/** The timestamp a thread item is ordered/divided by. */
export function itemTime(item: ThreadItem): string {
  return item.type === 'segment' ? item.started_at : item.occurred_at;
}

/** GSM-7 segmentation: a single SMS holds 160 chars; concatenated parts hold
    153 each (7 chars go to the UDH). Mirrors what the carrier will bill. */
export function smsSegments(length: number): number {
  if (length <= 0) return 1;
  if (length <= 160) return 1;
  return Math.ceil(length / 153);
}

/** `tel:`/`sms:` need the bare digits — '(409) 555-0143' → '+14095550143'.
    Returns null when there is no dialable number, so the caller can disable
    the action rather than render a dead link. */
export function dialHref(scheme: 'tel' | 'sms', phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 7) return null;
  const e164 = digits.startsWith('+')
    ? digits
    : digits.length === 10
      ? `+1${digits}`
      : `+${digits}`;
  return `${scheme}:${e164}`;
}

/** Delivery receipt shown under an OUTBOUND bubble. Inbound texts carry no
    receipt (we never sent them), so this returns null for those. */
export interface Receipt { label: string; icon: 'check-check' | 'clock'; pending: boolean }

export function receiptFor(m: ThreadMessage): Receipt | null {
  if (m.direction !== 'out') return null;
  if (m.pending_sync) return { label: 'Pending sync to Quo', icon: 'clock', pending: true };
  if (m.delivered) return { label: 'Delivered', icon: 'check-check', pending: false };
  return null;
}

/** Optimistic stand-in for a text the user just sent — same shape the API will
    return, so the bubble does not jump when the real row arrives. */
export function optimisticMessage(body: string, conversationId: string): ThreadMessage {
  return {
    type: 'message',
    id: `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: conversationId,
    direction: 'out',
    body,
    media: null,
    delivered: false,
    pending_sync: true,
    occurred_at: new Date().toISOString(),
  };
}

/** Status names carry an operational '!!' prefix ('!! waiting for approval');
    the thread foot reads as prose, so strip it. */
export function plainStatus(name: string | null | undefined): string | null {
  if (!name) return null;
  const t = name.replace(/^!+\s*/, '').replace(/^<<\s*/, '').replace(/\s*>>$/, '').trim();
  return t.length > 0 ? t : null;
}
