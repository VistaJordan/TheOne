// The Client NTE follows the client's portal (Elise, 2026-11-16).
//
// Once the portal's inbound sync is switched on in Admin › Integrations
// (today: "Ecotrak → OBI", key `ecotrak`), a work order linked to that portal
// takes its Client NTE from the sync ONLY. Nothing else here writes it: not a
// hand edit (field editor, bulk edit), not an automation, not the client's
// approval of a quote (which otherwise sets the NTE to the approved total),
// not an NTE increase request. The NTE is raised on the portal, and the next
// sync brings it in. A work order with no portal link — typed in here, a PM
// raise, a portal whose sync is off — keeps every other rule.
//
// Pure: the API decides `linked` / `syncOn` (services/nteSync.ts) and the
// work-order detail carries the answer as `nte_synced` for the screens.

export const NTE_SYNCED_CODE = 'NTE_SYNCED';

export const NTE_SYNCED_MESSAGE =
  'The Client NTE on this work order comes from Ecotrak. It changes when the client changes it there, and cannot be set here.';

/** True when this work order's NTE is the portal's alone. */
export function nteFollowsPortal(linked: boolean, syncOn: boolean): boolean {
  return linked && syncOn;
}
