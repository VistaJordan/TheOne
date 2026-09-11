// Rules 11.2.1 / 11.2.2 — the "Quoting & Parts" gate (pausing the job) —
// and rules 11.3.1–11.3.3 — the "Job is Done" gate (completion).
//
// Three statuses cannot be entered empty-handed:
//   11.2.1  Quote Ready needs the work order's quote to carry data. (Waiting
//           for Quote needs nothing — it is where the quote is still owed.)
//   11.2.2  Waiting for Parts and Please Order Parts need the Parts Required
//           list, so the person is asked to type the parts before the move.
//   11.3.x  Done / Incurred needs a visit that checked in AND out (11.3.1),
//           the final vendor cost (11.3.2, the Cost field, hand-typed in V1)
//           and a quote with data (11.3.3 — the same test as 11.2.1). The
//           rule's photo / BFI check (11.3.4) and tech rating (11.3.5) wait
//           for the drive and the technician database, which do not exist.
//
// The check itself needs the database (apps/api/src/services/statusGates.ts,
// which every status-change path calls: the single move, the bulk move, a
// status-change REQUEST and its approval, and an automation's status action).
// This file is the vocabulary both sides share: which status opens which
// gate, what "filled" means, and the sentence the person reads.

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

/** The Done gate's three checks, in the rule's order. */
export type DoneGateCheck = 'visit' | 'cost' | 'quote';
export const DONE_GATE_CHECKS: readonly DoneGateCheck[] = ['visit', 'cost', 'quote'];

/** `details.code` on the 409 a refused move returns; `details.gate` says which. */
export const STATUS_GATE_ERROR_CODE = 'STATUS_GATE';

/** Which gate, if any, stands in front of a status. Names compare
    case-insensitively so a re-capitalised status keeps its rule. */
export function statusGateFor(targetStatusName: string | null | undefined): StatusGate | null {
  if (!targetStatusName) return null;
  const n = targetStatusName.trim().toLowerCase();
  if (n === QUOTE_READY_STATUS_NAME.toLowerCase()) return 'quote';
  if (PARTS_GATED_STATUS_NAMES.some((s) => s.toLowerCase() === n)) return 'parts';
  if (n === DONE_STATUS_NAME.toLowerCase()) return 'done';
  return null;
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
    Empty = the move may go ahead. */
export function doneGateMissing(state: {
  visitComplete: boolean;
  costValue: unknown;
  quoteFilled: boolean;
}): DoneGateCheck[] {
  const missing: DoneGateCheck[] = [];
  if (!state.visitComplete) missing.push('visit');
  if (!costFilled(state.costValue)) missing.push('cost');
  if (!state.quoteFilled) missing.push('quote');
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

const DONE_CHECK_TEXT: Record<DoneGateCheck, string> = {
  visit: 'a visit checked in and checked out (CICO tab)',
  cost: `the final vendor cost (${FINAL_COST_KEY})`,
  quote: 'a quote with at least one line or scope item (Quote tab)',
};

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The sentence the person sees when a move is refused. For the Done gate,
    `missing` narrows it to what is actually absent (all three when unknown). */
export function describeStatusGate(
  gate: StatusGate,
  statusName: string,
  missing?: readonly DoneGateCheck[],
): string {
  if (gate === 'quote') {
    return `${statusName} needs a quote first — add at least one line or scope item on the Quote tab.`;
  }
  if (gate === 'parts') {
    return `Enter the parts required (${PARTS_REQUIRED_KEY}) before moving to ${statusName}.`;
  }
  const checks = missing && missing.length > 0 ? missing : DONE_GATE_CHECKS;
  return `${statusName} needs ${joinAnd(checks.map((c) => DONE_CHECK_TEXT[c]))} first.`;
}

/** The short tag the status menu draws on a pick the gate would refuse. */
export function statusGateTag(gate: StatusGate, missing?: readonly DoneGateCheck[]): string {
  if (gate === 'quote') return 'Needs quote';
  if (gate === 'parts') return 'Needs parts';
  if (missing && missing.length === 1) {
    return missing[0] === 'visit' ? 'Needs check-out' : missing[0] === 'cost' ? 'Needs cost' : 'Needs quote';
  }
  return 'Not ready';
}
