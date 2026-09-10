// Rules 11.2.1 / 11.2.2 — the "Quoting & Parts" gate (pausing the job).
//
// Two statuses cannot be entered empty-handed:
//   11.2.1  Quote Ready needs the work order's quote to carry data. (Waiting
//           for Quote needs nothing — it is where the quote is still owed.)
//   11.2.2  Waiting for Parts and Please Order Parts need the Parts Required
//           list, so the person is asked to type the parts before the move.
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

export type StatusGate = 'quote' | 'parts';

/** `details.code` on the 409 a refused move returns; `details.gate` says which. */
export const STATUS_GATE_ERROR_CODE = 'STATUS_GATE';

/** Which gate, if any, stands in front of a status. Names compare
    case-insensitively so a re-capitalised status keeps its rule. */
export function statusGateFor(targetStatusName: string | null | undefined): StatusGate | null {
  if (!targetStatusName) return null;
  const n = targetStatusName.trim().toLowerCase();
  if (n === QUOTE_READY_STATUS_NAME.toLowerCase()) return 'quote';
  if (PARTS_GATED_STATUS_NAMES.some((s) => s.toLowerCase() === n)) return 'parts';
  return null;
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

/** The sentence the person sees when a move is refused. */
export function describeStatusGate(gate: StatusGate, statusName: string): string {
  return gate === 'quote'
    ? `${statusName} needs a quote first — add at least one line or scope item on the Quote tab.`
    : `Enter the parts required (${PARTS_REQUIRED_KEY}) before moving to ${statusName}.`;
}

/** The short tag the status menu draws on a pick the gate would refuse. */
export function statusGateTag(gate: StatusGate): string {
  return gate === 'quote' ? 'Needs quote' : 'Needs parts';
}
