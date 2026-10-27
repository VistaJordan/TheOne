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
