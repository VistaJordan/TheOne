/**
 * The check-in method per client and billing entity (migration 0100, Elise,
 * 2026-10-27).
 *
 * How a technician checks in (IVR, Portal, Email …) depends on the client and
 * on which of our companies bills the work, the same key as the account team
 * (0096): one row per (client, Comp), edited on Clients › a client › Check-in
 * method. A new visit takes the row for its work order's Client + Comp — a
 * client with a single row uses it while the Comp is blank (`pickClientTeam`
 * does the matching for both) — and falls back to the FM table
 * (fm_cico_method) when the client has none.
 */

export interface ClientCicoMethod {
  id: string;
  /** The billing entity, a `21. Comp` value (SFM, BKR, AF, TPM, RF). */
  billing_entity: string;
  /** One of VISIT_METHODS. */
  method: string;
  /** Which portal — kept only while the method is Portal (0098's rule). */
  portal: string | null;
  /** The instruction shown on the visit: the IVR number, "Picture + manager
      name", "Service Channel · (516) 500-7776". */
  detail: string | null;
  /** The mailbox the work is handled from. */
  email: string | null;
  updated_at: string;
}

export interface ClientCicoInput {
  billing_entity: string;
  method: string;
  portal?: string | null;
  detail?: string | null;
  email?: string | null;
}

/** GET /clients/:id/cico */
export interface ClientCicoResponse {
  items: ClientCicoMethod[];
  /** The Comp values a row may be filed under. */
  billing_entities: string[];
  can_edit: boolean;
}

/** Where a visit's default method came from, as the CICO card names it:
    "PH · BKR" for a client row, "FM Powerhouse" for the FM table. */
export function cicoSourceLabel(
  source: { kind: 'client'; client: string; billing_entity: string } | { kind: 'fm'; fm: string } | null,
): string | null {
  if (!source) return null;
  return source.kind === 'client' ? `${source.client.trim()} · ${source.billing_entity}` : `FM ${source.fm.trim()}`;
}

// ── Client Portal Type follows the client (Elise, 2026-10-30) ─────────────────
//
// The client's check-in row already says which portal its work comes through
// (7-11 → Portal "7-11", WKS → Portal "Corrigo", Qdoba → IVR "Service Channel
// · (516) 500-7776"). So `Client Portal Type` fills itself from the row for
// the work order's Client + Comp — on Add work order, on create, and when an
// edit changes the Client or the Comp. Only a value the dropdown offers is
// ever written (an admin adding "Metryx" to the list in Admin › Custom fields
// is enough for PH to fill); a portal the list lacks fills nothing.

/** The bag key (0033). Same string as messaging.ts's CLIENT_PORTAL_TYPE_KEY. */
export const PORTAL_TYPE_KEY = 'Client Portal Type';

/** Spellings of one portal, compared without case, spaces or punctuation. */
const PORTAL_ALIASES: readonly (readonly string[])[] = [
  ['711', '7eleven', 'seveneleven'],
  ['ecotrak', 'ecotrack'],
  ['servicechannel'],
];
const portalKey = (s: string | null | undefined): string => {
  const k = (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const group = PORTAL_ALIASES.find((g) => g.includes(k));
  return group ? group[0] : k;
};

/** The dropdown option a portal name stands for, in the option's spelling,
    or null when the list has none. */
export function portalTypeOption(portal: string | null | undefined, options: readonly string[]): string | null {
  const k = portalKey(portal);
  if (k === '') return null;
  return options.find((o) => portalKey(o) === k) ?? null;
}

/** The Client Portal Type a check-in row implies: a Portal row's portal, else
    the portal the sheet put in front of the detail ("Service Channel · …"). */
export function portalTypeFromCico(
  row: { method: string; portal: string | null; detail: string | null } | null | undefined,
  options: readonly string[],
): string | null {
  if (!row) return null;
  const fromPortal = portalTypeOption(row.portal, options);
  if (fromPortal) return fromPortal;
  const lead = (row.detail ?? '').split('·')[0];
  return lead.trim() !== '' && (row.detail ?? '').includes('·') ? portalTypeOption(lead, options) : null;
}

/** One client + Comp's Client Portal Type, as the Add work order form reads it. */
export interface ClientPortalTypeForForm {
  client: string;
  billing_entity: string;
  portal_type: string;
}
