/* Ecotrak Service-Provider status vocabulary -> The One.
 *
 * SOURCE OF TRUTH: 232 production work orders read 2026-08-19 (GET only), plus
 * the endpoint inventory in `PC Stuff/ECOTRAK API/README.md`.
 *
 * IMPORTANT — the API vocabulary is NOT the Ecotrak UI vocabulary. The UI shows
 * labels like "completed pending re…", "rfp submitted" and the RMA states; NONE
 * of those appear on the wire and none are in the SP API enum. Map only what the
 * API can actually send. Wire values are SCREAMING_SNAKE.
 *
 * Inbound is NOT the reverse of outbound. Inbound statuses land as FACTS with an
 * authority classification; they never write an internal sub-status directly.
 * See docs/MVP-BUILD-PLAN.md §8.1 — the shadow week ships with ZERO authoritative
 * rows, so `authority` is recorded but not yet acted on.
 */

/** Canonical (general) status — the only vocabulary that crosses to any CMMS. */
export type Canonical =
  | 'received'
  | 'assessing'
  | 'quoting'
  | 'awaiting_client'
  | 'approved'
  | 'scheduled'
  | 'in_progress'
  | 'awaiting_parts'
  | 'completed'
  | 'invoiced'
  | 'declined'
  | 'cancelled'
  | 'on_hold';

/**
 * How much a given inbound value is allowed to drive.
 *   authoritative — the client genuinely owns this fact
 *   advisory      — their view of OUR operation; activity row only
 *   divergent     — incompatible with our state; raise for a human
 */
export type Authority = 'authoritative' | 'advisory' | 'divergent-risk';

export interface InboundRule {
  canonical: Canonical;
  authority: Authority;
  /** Observed count in the 2026-08-19 production read (0 = documented, unseen). */
  seen: number;
  note: string;
}

/**
 * The 17 documented SP API statuses. 12 were observed live; the other 5 are
 * documented as settable/returnable but did not occur in the sample window.
 */
export const ECOTRAK_INBOUND: Record<string, InboundRule> = {
  // ── Intake ────────────────────────────────────────────────────────────────
  PENDING_SP_ACCEPTANCE: {
    canonical: 'received',
    authority: 'authoritative',
    seen: 1,
    note: 'SP = service provider = us. The client is offering us the job; they own that fact. Lands in the intake queue — never auto-creates a live WO.',
  },
  UNASSIGNED: {
    canonical: 'received',
    authority: 'advisory',
    seen: 0,
    note: 'No SP assigned yet. Nothing for us to do; log only.',
  },
  ACCEPTED: {
    canonical: 'received',
    authority: 'advisory',
    seen: 8,
    note: 'Echo of our own accept. Advisory — we caused it, so it must never overwrite dispatcher state.',
  },
  REASSIGN: {
    canonical: 'received',
    authority: 'divergent-risk',
    seen: 0,
    note: 'Work moved to another SP. If we hold a live WO, that is a divergence a human must resolve.',
  },

  // ── Quote / proposal ──────────────────────────────────────────────────────
  SUBMITTING_PROPOSAL: {
    canonical: 'quoting',
    authority: 'advisory',
    seen: 9,
    note: 'Their view of us drafting. Advisory.',
  },
  PROPOSAL_SUBMITTED: {
    canonical: 'awaiting_client',
    authority: 'advisory',
    seen: 17,
    note: 'Our proposal reached them. Ball is in the client court.',
  },
  PROPOSAL_APPROVED: {
    canonical: 'approved',
    authority: 'authoritative',
    seen: 20,
    note: 'The client approval decision — the one fact they unambiguously own. Starts the BR-OBL-010 schedule clock. Forward-only from the Approval phase.',
  },
  PROPOSAL_REJECTED: {
    canonical: 'completed',
    authority: 'authoritative',
    seen: 2,
    note: 'BFI — Bill For Incurred (plan §8.2). Moves to completed and flags the dispatcher; the invoice draws on incurred_subtotal, not grand_total. Warn when incurred is 0.',
  },

  // ── Field execution ───────────────────────────────────────────────────────
  ENROUTE: {
    canonical: 'in_progress',
    authority: 'advisory',
    seen: 0,
    note: 'Settable BY US — this is an outbound check-in, contractually required (plan §8.5). Inbound it is only an echo.',
  },
  ARRIVED: {
    canonical: 'in_progress',
    authority: 'advisory',
    seen: 4,
    note: 'Same as ENROUTE. Ambiguous between visit 1 and visit 2, so never authoritative.',
  },
  PENDING_PARTS: {
    canonical: 'awaiting_parts',
    authority: 'advisory',
    seen: 2,
    note: 'Cannot distinguish our two internal parts states; log only.',
  },
  RETURN_VISIT_REQUIRED: {
    canonical: 'in_progress',
    authority: 'divergent-risk',
    seen: 8,
    note: 'Benign against an active WO. Against a done/invoiced WO it is a billing-grade divergence: they think it is unfinished while we bill it.',
  },
  NOT_FIXED: {
    canonical: 'in_progress',
    authority: 'divergent-risk',
    seen: 0,
    note: 'An OUTCOME, where our statuses encode INTENT. The successor is a human judgement.',
  },

  // ── Terminal ──────────────────────────────────────────────────────────────
  SOFT_COMPLETED: {
    canonical: 'completed',
    authority: 'advisory',
    seen: 21,
    note: 'Our own soft close echoed back. The grey-flag audit still gates invoicing on our side.',
  },
  COMPLETED: {
    canonical: 'completed',
    authority: 'advisory',
    seen: 130,
    note: 'Most common status by far. Their completion, not our release — the grey flag is unaffected.',
  },
  CANCELLED: {
    canonical: 'cancelled',
    authority: 'authoritative',
    seen: 10,
    note: 'The client killed it; they own that. Must stop dispatch. Synthesize a reason when none is attached (plan §8.4c).',
  },
  REJECTED: {
    canonical: 'declined',
    authority: 'authoritative',
    seen: 0,
    note: 'Settable BY US — this is how we decline work outbound. Inbound it is an echo.',
  },
};

/** The 9 statuses Ecotrak lets us WRITE. Anything else is rejected by the API. */
export const ECOTRAK_WRITABLE = [
  'ACCEPTED',
  'ENROUTE',
  'ARRIVED',
  'SOFT_COMPLETED',
  'NOT_FIXED',
  'PENDING_PARTS',
  'REJECTED',
  'RETURN_VISIT_REQUIRED',
  'SUBMITTING_PROPOSAL',
] as const;

export type EcotrakWritable = (typeof ECOTRAK_WRITABLE)[number];

export function isWritable(status: string): status is EcotrakWritable {
  return (ECOTRAK_WRITABLE as readonly string[]).includes(status);
}

/**
 * Outbound projection: canonical -> Ecotrak, or null for "never push".
 * Lossy and deliberately NOT the inverse of the inbound map — several canonical
 * values are internal-only and must emit nothing.
 */
export const ECOTRAK_OUTBOUND: Record<Canonical, EcotrakWritable | null> = {
  received: 'ACCEPTED',
  assessing: null,        // internal — the client sees no assessment stage
  quoting: 'SUBMITTING_PROPOSAL',
  awaiting_client: null,  // they already know; the proposal push sets it
  approved: null,         // their own decision — echoing it back would loop
  scheduled: null,        // no Ecotrak equivalent; ETA is pushed separately
  in_progress: 'ARRIVED', // check-in channel, OA/dispatcher triggered ONLY
  awaiting_parts: 'PENDING_PARTS',
  completed: 'SOFT_COMPLETED',
  invoiced: null,         // invoicing is its own API and PM-only
  declined: 'REJECTED',
  cancelled: 'REJECTED',  // no writable CANCELLED — REJECTED is the SP path
  on_hold: null,          // no equivalent
};

/** Unknown inbound values are PARKED, never default-mapped. */
export function classifyInbound(status: string): InboundRule | null {
  return ECOTRAK_INBOUND[status] ?? null;
}
