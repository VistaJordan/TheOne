// ── Status order per client portal (BRD 2.7, Elise 2026-11-04) ──────────────
//
// A work order no longer jumps from any status to any other: each client
// follows its portal's steps. The three tables are the default maps in
// product/status-maps/ (EcoTrack set by Jack 2026-10-08, Corrigo and
// ServiceChannel the same day, review fixes applied). The portal is read off
// the work order's `Client Portal Type` (`clientMessageTarget`); a work order
// with no portal, or one we do not know, is NOT restricted — Elise: "for the
// ones with no portal let's keep it on hold".
//
// Pure: the API asks it in changeStatus, bulk edit, a status request, its
// approval and Cancel (services/statusOrder.ts); the status menu offers only
// what it allows.
//
// Kept loose on purpose:
//   · A status a table does not name (an admin-added one, Emergency) is never
//     restricted, in or out — a work order can never be stranded.
//   · "New" is in the maps but not in our status list: a new work order is
//     Open with an acceptance task (rule 7.1), so the New rows are left out.
//   · Approved is ours, not the maps' (the client's yes moves a work order to
//     it, M5): it sits after Waiting for Approval and offers the maps'
//     "once the client approves" moves.
//   · The conditions on the portal's side ("only while the portal still
//     shows Accepted", "once the client approves / rejects") are not asked:
//     we do not read Corrigo or ServiceChannel, and the stored Ecotrak status
//     is checked separately (rule 2.6.3, ecotrak.ts). Every move a condition
//     can open is listed.
//   · Reschedules (Job Sched → Job Sched) are not status changes.
//   · Per-client modification files (`ecotrack-<client>.md`, …) are not in
//     yet; when they arrive they become overrides on these defaults.

import { clientMessageTarget, type ClientMessageTarget } from './messaging';

export type StatusOrderPortal = ClientMessageTarget;

export const STATUS_ORDER_CODE = 'STATUS_ORDER';

const CANCEL = 'Cancelled / Postponed';
const BILLING = {
  'Done / Incurred': ['Ready to Invoice'],
  'Ready to Invoice': ['Invoiced'],
  'Invoiced': ['Invoiced Not Paid'],
  'Invoiced Not Paid': ['Invoiced'],
  [CANCEL]: ['Open'],
} as const;

type Table = Readonly<Record<string, readonly string[]>>;

/** product/status-maps/ecotrack-default-map.md */
const ECOTRAK: Table = {
  'Open': ['Assessment Sched', 'Job Sched', 'PM Sched', 'Waiting for Advice', CANCEL],
  'Assessment Sched': ['On Site (Assessment)', 'Open', 'Waiting for Advice', CANCEL],
  'Job Sched': ['On Site (Job)', 'Open', 'Waiting for Advice', CANCEL],
  'PM Sched': ['On Site (Job)', 'Open', CANCEL],
  'On Site (Assessment)': ['Return Trip Needed', 'Waiting for Quote', 'Waiting for Advice'],
  'On Site (Job)': ['Done / Incurred', 'Return Trip Needed', 'Please Order Parts', 'Waiting for Parts', 'Waiting for Quote', 'Waiting for Advice'],
  'Return Trip Needed': ['Job Sched', 'Please Order Parts', 'Waiting for Parts', 'Waiting for Advice', CANCEL],
  'Waiting for Quote': ['Quote Ready', 'Waiting for Advice', CANCEL],
  'Quote Ready': ['Waiting for Approval', CANCEL],
  'Waiting for Approval': ['Approved', 'Job Sched', 'Please Order Parts', 'Waiting for Parts', 'Done / Incurred', 'Return Trip Needed', CANCEL],
  'Approved': ['Job Sched', 'Please Order Parts', 'Waiting for Parts', CANCEL],
  'Please Order Parts': ['Waiting for Parts', 'Waiting for Advice', CANCEL],
  'Waiting for Parts': ['Job Sched', CANCEL],
  'Waiting for Advice': ['Assessment Sched', 'Job Sched', 'Open', 'Return Trip Needed', CANCEL],
  ...BILLING,
};

/** product/status-maps/corrigo-default-map.md */
const CORRIGO: Table = {
  'Open': ['Assessment Sched', 'Job Sched', 'PM Sched', 'On Site (Assessment)', 'On Site (Job)', CANCEL],
  'Assessment Sched': ['Job Sched', 'PM Sched', 'On Site (Assessment)', CANCEL],
  'Job Sched': ['Assessment Sched', 'PM Sched', 'On Site (Job)', CANCEL],
  'PM Sched': ['Assessment Sched', 'Job Sched', 'On Site (Assessment)', 'On Site (Job)', CANCEL],
  'On Site (Assessment)': ['Return Trip Needed', 'Waiting for Quote', 'Waiting for Parts', 'Please Order Parts', 'Done / Incurred'],
  'On Site (Job)': ['Return Trip Needed', 'Waiting for Quote', 'Waiting for Parts', 'Please Order Parts', 'Done / Incurred'],
  'Please Order Parts': ['Return Trip Needed', 'Waiting for Quote', 'Waiting for Parts', 'Done / Incurred', CANCEL],
  'Return Trip Needed': ['Assessment Sched', 'Job Sched', 'PM Sched', 'On Site (Assessment)', 'On Site (Job)', 'Waiting for Advice', 'Waiting for Quote', CANCEL],
  'Waiting for Quote': ['Assessment Sched', 'Job Sched', 'PM Sched', 'On Site (Assessment)', 'On Site (Job)', 'Quote Ready', 'Waiting for Advice', CANCEL],
  'Waiting for Parts': ['Assessment Sched', 'Job Sched', 'PM Sched', 'On Site (Assessment)', 'On Site (Job)', 'Quote Ready', 'Waiting for Advice', 'Waiting for Approval', CANCEL],
  'Quote Ready': ['Waiting for Advice', 'Waiting for Approval', CANCEL],
  'Waiting for Advice': ['Assessment Sched', 'Job Sched', 'PM Sched', 'On Site (Assessment)', 'On Site (Job)', 'Waiting for Quote', CANCEL],
  'Waiting for Approval': ['Approved', 'Job Sched', 'PM Sched', 'On Site (Job)', 'Quote Ready', CANCEL],
  'Approved': ['Job Sched', 'PM Sched', 'On Site (Job)', CANCEL],
  ...BILLING,
};

/** product/status-maps/servicechannel-default-map.md */
const SERVICECHANNEL: Table = {
  'Open': ['Assessment Sched', 'Job Sched', 'PM Sched', 'On Site (Assessment)', 'On Site (Job)', CANCEL],
  'Assessment Sched': ['Job Sched', 'PM Sched', 'On Site (Assessment)', CANCEL],
  'Job Sched': ['Assessment Sched', 'PM Sched', 'On Site (Job)', CANCEL],
  'PM Sched': ['Assessment Sched', 'Job Sched', 'On Site (Assessment)', 'On Site (Job)', CANCEL],
  'On Site (Assessment)': ['Return Trip Needed', 'Waiting for Quote', 'Waiting for Parts', 'Please Order Parts', 'Done / Incurred'],
  'On Site (Job)': ['Return Trip Needed', 'Waiting for Quote', 'Waiting for Parts', 'Please Order Parts', 'Waiting for Approval', 'Done / Incurred'],
  'Please Order Parts': ['Return Trip Needed', 'Waiting for Quote', 'Waiting for Parts', 'Done / Incurred', CANCEL],
  'Return Trip Needed': ['Assessment Sched', 'Job Sched', 'PM Sched', 'On Site (Assessment)', 'On Site (Job)', 'Waiting for Advice', 'Waiting for Quote', CANCEL],
  'Waiting for Quote': ['Quote Ready', 'Waiting for Advice', 'Waiting for Approval', CANCEL],
  'Waiting for Parts': ['Job Sched', 'On Site (Job)', 'Waiting for Advice', 'Waiting for Quote', CANCEL],
  'Quote Ready': ['Waiting for Advice', 'Waiting for Approval', CANCEL],
  'Waiting for Advice': ['Assessment Sched', 'Job Sched', 'PM Sched', 'On Site (Assessment)', 'On Site (Job)', 'Waiting for Quote', CANCEL],
  'Waiting for Approval': ['Approved', 'Waiting for Quote', 'Job Sched', 'Please Order Parts', 'Waiting for Parts', CANCEL],
  'Approved': ['Job Sched', 'Please Order Parts', 'Waiting for Parts', CANCEL],
  ...BILLING,
};

export const STATUS_ORDER_BY_PORTAL: Readonly<Record<StatusOrderPortal, Table>> = {
  ecotrak: ECOTRAK,
  corrigo: CORRIGO,
  servicechannel: SERVICECHANNEL,
};

export const STATUS_ORDER_PORTAL_LABEL: Readonly<Record<StatusOrderPortal, string>> = {
  ecotrak: 'Ecotrak',
  corrigo: 'Corrigo',
  servicechannel: 'ServiceChannel',
};

const norm = (s: string) => s.trim().toLowerCase();

/** One table, keyed by folded name, built once per portal. */
const FOLDED: Record<StatusOrderPortal, { names: Set<string>; next: Map<string, Set<string>> }> = (() => {
  const out = {} as Record<StatusOrderPortal, { names: Set<string>; next: Map<string, Set<string>> }>;
  for (const [portal, table] of Object.entries(STATUS_ORDER_BY_PORTAL) as [StatusOrderPortal, Table][]) {
    const names = new Set<string>();
    const next = new Map<string, Set<string>>();
    for (const [from, tos] of Object.entries(table)) {
      names.add(norm(from));
      next.set(norm(from), new Set(tos.map(norm)));
      for (const t of tos) names.add(norm(t));
    }
    out[portal] = { names, next };
  }
  return out;
})();

/** The portal whose steps a work order follows, from its Client Portal Type;
    null = no portal (not restricted). */
export function statusOrderPortal(portalType: unknown): StatusOrderPortal | null {
  return typeof portalType === 'string' ? clientMessageTarget(portalType) : null;
}

export type StatusOrderOutcome = 'no_portal' | 'unlisted' | 'allowed' | 'blocked';

export interface StatusOrderVerdict {
  outcome: StatusOrderOutcome;
  portal: StatusOrderPortal | null;
  from: string;
  to: string;
}

/** May a work order on this portal move from `from` to `to`? Same status is
    always allowed (it is no move). */
export function checkStatusOrder(portalType: unknown, from: string, to: string): StatusOrderVerdict {
  const portal = statusOrderPortal(portalType);
  const v = (outcome: StatusOrderOutcome): StatusOrderVerdict => ({ outcome, portal, from, to });
  if (!portal) return v('no_portal');
  const f = norm(from);
  const t = norm(to);
  if (f === t) return v('allowed');
  const { names, next } = FOLDED[portal];
  if (!names.has(f) || !names.has(t)) return v('unlisted');
  return v(next.get(f)?.has(t) ? 'allowed' : 'blocked');
}

export function statusOrderRefused(v: StatusOrderVerdict): boolean {
  return v.outcome === 'blocked';
}

/** The statuses a table lets `from` move to, in the table's order; null when
    the work order is not restricted (no portal, or `from` is not in it). */
export function allowedNextStatusNames(portalType: unknown, from: string): readonly string[] | null {
  const portal = statusOrderPortal(portalType);
  if (!portal) return null;
  const table = STATUS_ORDER_BY_PORTAL[portal];
  const key = Object.keys(table).find((k) => norm(k) === norm(from));
  if (key) return table[key];
  return FOLDED[portal].names.has(norm(from)) ? [] : null;
}

/** The 409's sentence. */
export function describeStatusOrderRefusal(v: StatusOrderVerdict): string {
  const portal = v.portal ? STATUS_ORDER_PORTAL_LABEL[v.portal] : 'its portal';
  const next = allowedNextStatusNames(v.portal, v.from);
  const list = next && next.length > 0 ? ` From ${v.from} it can go to: ${next.join(', ')}.` : ` ${v.from} has no next step on ${portal}.`;
  return `This is a ${portal} work order, and ${portal}'s steps do not go from ${v.from} to ${v.to}.${list}`;
}
