// 0114 · Ecotrak → OBI, the pure half: who wrote a note, which work order
// a webhook delivery is about, and the address line a work order carries.
// No I/O; the API's ingest and webhook receiver call these
// (tests/ecotrak-inbound.test.ts).

/** The two webhook events OBI registers on Ecotrak. */
export const ECOTRAK_WEBHOOK_ACTIONS = ['WEBHOOK_WORKORDER_ACTIVITY', 'WEBHOOK_WORKORDER_COMMENT'] as const;
export type EcotrakWebhookAction = (typeof ECOTRAK_WEBHOOK_ACTIONS)[number];

/** While webhooks are registered, the minute cron reads Ecotrak only this
    often — the safety net for a delivery Ecotrak gave up on (5 retries at
    most) and for new work orders, which no webhook event names. */
export const ECOTRAK_SAFETY_NET_MINUTES = 15;

interface NoteAuthorParts {
  customer_name?: string | null;
  user_fist_name?: string | null;
  user_first_name?: string | null;
  user_last_name?: string | null;
}

/** "Jane Doe · Dave's Burgers" — the person, then their company; either alone
    when that is all the note says; null when it says neither. Ecotrak's
    placeholder account names ("ExternalApi") are dropped. */
export function ecotrakNoteAuthor(n: NoteAuthorParts): string | null {
  const clean = (v: unknown) => {
    const s = String(v ?? '').trim();
    return s && s.toLowerCase() !== 'externalapi' ? s : '';
  };
  const person = [clean(n.user_fist_name ?? n.user_first_name), clean(n.user_last_name)].filter(Boolean).join(' ');
  const company = clean(n.customer_name);
  const parts = [person, company && company !== person ? company : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const WO_ID_KEY = /^(work_?order_?id|wo_?id|workorder)$/i;

/**
 * Ecotrak's own work-order id(s) a webhook delivery may be about, best first.
 * Ecotrak does not document the delivery, so this reads it loosely: any
 * `workOrderId` / `work_order_id` / `woId` key at any depth, then a nested
 * `work_order` / `workOrder` object's `id`, then the top-level `id` when the
 * payload itself looks like a work order (it has a `status`). Numbers and
 * digit strings only; at most five. The receiver never trusts these: it reads
 * each one back from Ecotrak and uses the first that exists.
 */
export function ecotrakIdsFromPayload(payload: unknown): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
    if (/^\d{1,18}$/.test(s) && !out.includes(s)) out.push(s);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 50)) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (WO_ID_KEY.test(k)) add(x);
      if (/^(work_?order)$/i.test(k) && x && typeof x === 'object' && !Array.isArray(x)) add((x as { id?: unknown }).id);
      walk(x, depth + 1);
    }
  };
  walk(payload, 0);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const top = payload as { id?: unknown; status?: unknown };
    if (top.status != null) add(top.id);
  }
  return out.slice(0, 5);
}

interface LocationParts {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  zip?: string | null;
}

/** "281 S. Beverly Dr, Suite 2, Beverly Hills, CA 90212" — the team's shape
    for `17. Address`; null without a street. `stateCode` is the two letters. */
export function ecotrakAddressLine(loc: LocationParts | null | undefined, stateCode: string | null): string | null {
  if (!loc) return null;
  const street = String(loc.address1 ?? '').trim();
  if (!street) return null;
  const tail = [stateCode ?? '', String(loc.zip ?? '').trim()].filter(Boolean).join(' ');
  return [street, String(loc.address2 ?? '').trim(), String(loc.city ?? '').trim(), tail].filter(Boolean).join(', ');
}
