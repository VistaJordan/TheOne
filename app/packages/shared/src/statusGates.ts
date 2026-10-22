// Rules 11.2.1 / 11.2.2 — the "Quoting & Parts" gate (pausing the job) —
// and rules 11.3.1–11.3.3 — the "Job is Done" gate (completion).
//
// Three statuses cannot be entered empty-handed:
//   11.2.1  Quote Ready needs the work order's quote to carry data, and —
//           since 2026-10-22 (Elise) — the quote SUBMITTED for approval (it
//           has left draft) and at least one APPROVED picture on the work
//           order (an image that passed the 1.3.x review, on the Drive tab).
//           (Waiting for Quote needs nothing — it is where the quote is
//           still owed.)
//   11.2.2  Waiting for Parts and Please Order Parts need the Parts Required
//           list, so the person is asked to type the parts before the move.
//   11.3.x  Done / Incurred needs a visit that checked in AND out (11.3.1),
//           the final vendor cost (11.3.2, the Cost field, hand-typed in V1)
//           a quote with data (11.3.3 — the same test as 11.2.1) and proof
//           (11.3.4, 0061): an APPROVED after photo, or — when the Bill For
//           Incurred box is ticked — an approved before photo and an approved
//           sign-off instead. The tech rating (11.3.5) waits for the rating
//           flow, which does not exist.
//
// The check itself needs the database (apps/api/src/services/statusGates.ts,
// which every status-change path calls: the single move, the bulk move, a
// status-change REQUEST and its approval, and an automation's status action).
// This file is the vocabulary both sides share: which status opens which
// gate, what "filled" means, and the sentence the person reads.

import { completionProofMissing } from './attachments';

/** Bag key of rule 11.2.2's Parts_Required_List — a long-text field in the
    Overview section (migration 0035 / seed.ts). */
export const PARTS_REQUIRED_KEY = 'Parts Required';

/** Rule 11.2.1's target. Matched by name, like isQuoteOwed and the Ecotrak
    push table: the status vocabulary (0020) is the contract. */
export const QUOTE_READY_STATUS_NAME = 'Quote Ready';

/** Rule 11.2.2's targets. */
export const PARTS_GATED_STATUS_NAMES: readonly string[] = ['Waiting for Parts', 'Please Order Parts'];

/** Rules 11.3.1–11.3.3's target. */
export const DONE_STATUS_NAME = 'Done / Incurred';

/** Bag key of rule 11.3.2's Final_Vendor_Cost: the work order's Cost — the
    same field rules 1.5.1 / 1.5.2 hold against the NTE. */
export const FINAL_COST_KEY = '34. Cost';

export type StatusGate = 'quote' | 'parts' | 'done';

/** The Quote Ready gate's checks (11.2.1, widened 2026-10-22), in order:
    the quote carries data, it was submitted (left draft), an approved
    picture is on file. */
export type QuoteGateCheck = 'quote' | 'quote_submitted' | 'photo';
export const QUOTE_GATE_CHECKS: readonly QuoteGateCheck[] = ['quote', 'quote_submitted', 'photo'];

/** The Done gate's three checks, in the rule's order. */
export type DoneGateCheck = 'visit' | 'cost' | 'quote' | 'after_photo' | 'bfi_proof';
/** What a standard completion needs; a BFI job swaps the last for 'bfi_proof'. */
export const DONE_GATE_CHECKS: readonly DoneGateCheck[] = ['visit', 'cost', 'quote', 'after_photo'];

/** Any check a gate can report missing (`details.missing` on the 409). */
export type GateCheck = DoneGateCheck | QuoteGateCheck;

/** `details.code` on the 409 a refused move returns; `details.gate` says which. */
export const STATUS_GATE_ERROR_CODE = 'STATUS_GATE';

/** UAT round 1, Wave C (#2): the billing statuses past Done. Each is
    entered only with the Done gate satisfied — unless the work order already
    sits in Done or later (it passed the gate on the way in, or was loaded
    there before the gate existed; M3 keeps the Cost from being cleared
    while it stays). */
export const INVOICING_GATED_STATUS_NAMES: readonly string[] = ['Ready to Invoice', 'Invoiced Not Paid', 'Invoiced'];

/** The statuses of the Done and Invoiced phases (PHASE_BY_STATUS_NAME):
    "done or later". Listed here, not read from the phase map, so this file
    keeps no import of the barrel; tests/uat-wave-c.test.ts pins the two
    together. */
export const DONE_OR_LATER_STATUS_NAMES: readonly string[] = [
  'Ready to Invoice',
  'Done / Incurred',
  'Invoiced Not Paid',
  'Invoiced',
];

const lowerIn = (list: readonly string[], name: string | null | undefined): boolean => {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return list.some((s) => s.toLowerCase() === n);
};

/** Is this status in the done group or later (Done / Invoiced phases)? */
export function isDoneOrLaterStatus(statusName: string | null | undefined): boolean {
  return lowerIn(DONE_OR_LATER_STATUS_NAMES, statusName);
}

/** Which gate, if any, stands in front of a status. Names compare
    case-insensitively so a re-capitalised status keeps its rule.
    `currentStatusName` (when the caller knows it) exempts a move between
    the billing statuses from inside Done or later (#2); without it the
    billing statuses are always gated. */
export function statusGateFor(
  targetStatusName: string | null | undefined,
  currentStatusName?: string | null,
): StatusGate | null {
  if (!targetStatusName) return null;
  const n = targetStatusName.trim().toLowerCase();
  if (n === QUOTE_READY_STATUS_NAME.toLowerCase()) return 'quote';
  if (PARTS_GATED_STATUS_NAMES.some((s) => s.toLowerCase() === n)) return 'parts';
  if (n === DONE_STATUS_NAME.toLowerCase()) return 'done';
  if (lowerIn(INVOICING_GATED_STATUS_NAMES, n)) {
    return isDoneOrLaterStatus(currentStatusName) ? null : 'done';
  }
  return null;
}

// ── M3 · a gated status holds its field ──────────────────────────────────────
// The gates above are checked on ENTRY. While the work order stays in the
// gated status, emptying what the gate asked for would leave it somewhere it
// could not have entered: Parts Required while it waits for parts, the Cost
// while it is done or billed, the quote while it is Quote Ready or done.

/** The gate that holds `jsonKey` while the work order sits in
    `currentStatusName`, when `nextValue` would empty it; null = the write is
    fine. Bag json keys (no `fields.` prefix). */
export function gateHoldingField(
  currentStatusName: string | null | undefined,
  jsonKey: string,
  nextValue: unknown,
): StatusGate | null {
  if (jsonKey === PARTS_REQUIRED_KEY && lowerIn(PARTS_GATED_STATUS_NAMES, currentStatusName)) {
    return partsRequiredFilled(nextValue) ? null : 'parts';
  }
  if (jsonKey === FINAL_COST_KEY && isDoneOrLaterStatus(currentStatusName)) {
    return costFilled(nextValue) ? null : 'done';
  }
  return null;
}

/** Does this status require the quote to keep its data (11.2.1 / 11.3.3)? */
export function statusHoldsQuote(currentStatusName: string | null | undefined): boolean {
  if (!currentStatusName) return false;
  return currentStatusName.trim().toLowerCase() === QUOTE_READY_STATUS_NAME.toLowerCase() || isDoneOrLaterStatus(currentStatusName);
}

/** The sentence for a refused clear (409 STATUS_GATE, `details.held: true`). */
export function describeGateHold(what: string, statusName: string): string {
  return `${what} cannot be emptied while the work order is in ${statusName} — move it out of ${statusName} first.`;
}

/** "NOT NULL" for the cost (11.3.2): a number, or text that reads as one —
    "$1,610.00" counts, "" and "TBD" do not. Zero is a value: a job can cost
    nothing (a warranty visit) and still be done. */
export function costFilled(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === 'boolean') return false;
  if (typeof value === 'number') return Number.isFinite(value);
  const s = String(value).replace(/[$,\s]/g, '');
  return s !== '' && Number.isFinite(Number(s));
}

/** Which of the Done gate's checks fail, given what the caller knows:
    `visitComplete` = some visit has both stamps (11.3.1), `costValue` = the
    Cost bag value (11.3.2), `quoteFilled` = quoteSectionsHaveData (11.3.3).
    `proof` = rule 11.3.4's inputs, the BFI checkbox and the kinds of the
    APPROVED files (omitted = not known here, never reported missing).
    Empty = the move may go ahead. */
export function doneGateMissing(state: {
  visitComplete: boolean;
  costValue: unknown;
  quoteFilled: boolean;
  proof?: { bfi: unknown; approvedKinds: readonly string[] } | null;
}): DoneGateCheck[] {
  const missing: DoneGateCheck[] = [];
  if (!state.visitComplete) missing.push('visit');
  if (!costFilled(state.costValue)) missing.push('cost');
  if (!state.quoteFilled) missing.push('quote');
  if (state.proof) {
    const absent = completionProofMissing(state.proof.bfi, state.proof.approvedKinds);
    if (absent) missing.push(absent);
  }
  return missing;
}

/** "Submitted" for the Quote Ready gate: the quote has left draft —
    pending_correction (a dispatcher's Submit for correction), pending_approval,
    approved, sent, or decided by the client. A quote sent back to draft by
    an edit (Wave A #8) or a rejection counts as not submitted again. */
export function quoteSubmitted(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.trim() !== '' && status.trim().toLowerCase() !== 'draft';
}

/** Which of the Quote Ready gate's checks fail (11.2.1 as widened on
    2026-10-22): `quoteFilled` = quoteSectionsHaveData, `quoteSubmitted` =
    the quote left draft, `approvedPhotos` = how many APPROVED images with a
    file behind them the work order holds (the Drive tab; the uploader's own
    approval counts, as the photo review allows it). A quote with no data
    reports only 'quote' — submitting is the next step, not a second fault.
    Empty = the move may go ahead. */
export function quoteGateMissing(state: {
  quoteFilled: boolean;
  quoteSubmitted: boolean;
  approvedPhotos: number;
}): QuoteGateCheck[] {
  const missing: QuoteGateCheck[] = [];
  if (!state.quoteFilled) missing.push('quote');
  else if (!state.quoteSubmitted) missing.push('quote_submitted');
  if (!(state.approvedPhotos > 0)) missing.push('photo');
  return missing;
}

/** "NOT NULL" for a hand-typed list: something other than whitespace. A
    value that arrived as an array (a future list widget) counts when any
    entry is non-blank. */
export function partsRequiredFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((v) => String(v ?? '').trim() !== '');
  return String(value).trim() !== '';
}

/** What "the quote contains data" means (11.2.1): at least one line item, or
    at least one "Required is to…" scope line, in any section. An empty
    draft (the incurred section every quote opens with) is NOT data — it is
    what createQuote leaves behind before anyone types. The API asks the
    same question in SQL (services/statusGates.ts); the browser asks it of
    the Quote payload to tag the pick before the click. */
export function quoteSectionsHaveData(
  sections: readonly { lines?: readonly unknown[]; scope_lines?: readonly unknown[] }[] | null | undefined,
): boolean {
  if (!sections) return false;
  return sections.some(
    (s) => (s.lines?.length ?? 0) > 0 || (s.scope_lines?.some((l) => String(l ?? '').trim() !== '') ?? false),
  );
}

const CHECK_TEXT: Record<GateCheck, string> = {
  visit: 'a visit checked in and checked out (CICO tab)',
  cost: `the final vendor cost (${FINAL_COST_KEY})`,
  quote: 'a quote with at least one line or scope item (Quote tab)',
  quote_submitted: 'the quote submitted (Submit for correction or Submit for approval on the Quote tab)',
  photo: 'at least one approved picture (Drive tab)',
  after_photo: 'an approved after photo (Drive tab)',
  bfi_proof: 'an approved before photo and an approved sign-off (Drive tab — this job is Bill For Incurred)',
};

const CHECK_TAG: Record<GateCheck, string> = {
  visit: 'Needs check-out',
  cost: 'Needs cost',
  quote: 'Needs quote',
  quote_submitted: 'Needs quote submitted',
  photo: 'Needs photo',
  after_photo: 'Needs after photo',
  bfi_proof: 'Needs sign-off',
};

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The sentence the person sees when a move is refused. For the Done and
    Quote Ready gates, `missing` narrows it to what is actually absent (every
    check when unknown). */
export function describeStatusGate(
  gate: StatusGate,
  statusName: string,
  missing?: readonly GateCheck[],
): string {
  if (gate === 'parts') {
    return `Enter the parts required (${PARTS_REQUIRED_KEY}) before moving to ${statusName}.`;
  }
  const all: readonly GateCheck[] = gate === 'quote' ? QUOTE_GATE_CHECKS : DONE_GATE_CHECKS;
  const checks = missing && missing.length > 0 ? missing : all;
  return `${statusName} needs ${joinAnd(checks.map((c) => CHECK_TEXT[c]))} first.`;
}

/** The short tag the status menu draws on a pick the gate would refuse. */
export function statusGateTag(gate: StatusGate, missing?: readonly GateCheck[]): string {
  if (gate === 'parts') return 'Needs parts';
  if (missing && missing.length === 1) return CHECK_TAG[missing[0]];
  if (gate === 'quote' && !missing) return 'Needs quote';
  return 'Not ready';
}
