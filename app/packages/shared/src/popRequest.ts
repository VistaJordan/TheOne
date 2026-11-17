// The POP Request (Elise, 2026-11-16, UAT #44): how the team asks for parts.
// The work order's `Parts Required` field (rule 11.2.2's list, which Waiting
// for Parts and Please Order Parts need filled) is written in this shape:
//
//   1- POP: Home Depot #4512
//   2- Link: https://…
//   3- QTY: 2
//   …
//   10- Screenshot reference: B3.png
//
// It stays ONE long-text field, so the parts gate, ClickUp and every reader
// of the bag see text as before; the Parts tab draws a form over it. Text
// that is not one of the ten lines (a list typed before the form existed) is
// kept as notes after them, never dropped. Pure: no I/O.

export type PopRequestKey =
  | 'pop'
  | 'link'
  | 'qty'
  | 'estimated_total_cost'
  | 'specs'
  | 'delivery_address'
  | 'store_or_tech'
  | 'phone'
  | 'full_address'
  | 'screenshot';

export interface PopRequestLine {
  key: PopRequestKey;
  /** As the team writes it on the numbered line. */
  label: string;
  /** Elise, 2026-11-17: every line but "Specs if Applicable" is required. */
  required: boolean;
}

export const POP_REQUEST_LINES: readonly PopRequestLine[] = [
  { key: 'pop', label: 'POP', required: true },
  { key: 'link', label: 'Link', required: true },
  { key: 'qty', label: 'QTY', required: true },
  { key: 'estimated_total_cost', label: 'Estimated Total Cost', required: true },
  { key: 'specs', label: 'Specs if Applicable', required: false },
  { key: 'delivery_address', label: 'Delivery Address', required: true },
  { key: 'store_or_tech', label: "Store or Tech's name", required: true },
  { key: 'phone', label: 'Phone Number', required: true },
  { key: 'full_address', label: 'Full Address', required: true },
  { key: 'screenshot', label: 'Screenshot reference', required: true },
];

/** The required lines left blank, in order (labels). Empty = complete. */
export function popRequestMissing(r: PopRequest): string[] {
  return POP_REQUEST_LINES.filter((l) => l.required && r.values[l.key].trim() === '').map((l) => l.label);
}

/** Does this stored text use the POP form (at least one of its numbered
    lines)? A free-text list typed before the form existed does not, and is
    not held to the required lines. */
export function isPopRequestText(text: unknown): boolean {
  if (text === null || text === undefined) return false;
  const r = parsePopRequest(text);
  return POP_REQUEST_LINES.some((l) => r.values[l.key].trim() !== '') ||
    /^\s*\d{1,2}\s*-\s*POP\s*:/im.test(String(text));
}

/** The sentence for a POP request saved with required lines blank. */
export function popRequestMissingSentence(missing: readonly string[]): string {
  return `The POP request needs: ${missing.join(', ')}`;
}

export type PopRequestValues = Record<PopRequestKey, string>;

export interface PopRequest {
  values: PopRequestValues;
  /** Whatever the text held that is not one of the ten lines. */
  notes: string;
}

export function emptyPopRequest(): PopRequest {
  const values = {} as PopRequestValues;
  for (const l of POP_REQUEST_LINES) values[l.key] = '';
  return { values, notes: '' };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** "3- QTY: 2", "3) QTY - 2", "QTY: 2" → the line it fills. A label match
    decides; the number alone never does (lines may be renumbered). */
const LINE_RE = /^\s*(?:\d{1,2}\s*[-.)]\s*)?([^:]{1,40}?)\s*:\s?(.*)$/;

/** Reads `Parts Required` text back into the ten lines + notes. */
export function parsePopRequest(text: unknown): PopRequest {
  const out = emptyPopRequest();
  if (text === null || text === undefined) return out;
  const byLabel = new Map(POP_REQUEST_LINES.map((l) => [norm(l.label), l.key]));
  // A few spellings the team uses for the same line.
  byLabel.set('specs', 'specs');
  byLabel.set('quantity', 'qty');
  byLabel.set('estimatedcost', 'estimated_total_cost');
  byLabel.set('phone', 'phone');
  byLabel.set('screenshot', 'screenshot');
  const notes: string[] = [];
  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const m = LINE_RE.exec(raw);
    const key = m ? byLabel.get(norm(m[1])) : undefined;
    if (m && key && out.values[key] === '') {
      out.values[key] = m[2].trim();
    } else {
      notes.push(raw);
    }
  }
  out.notes = notes.join('\n').trim();
  return out;
}

/** True when the request says nothing at all. */
export function popRequestEmpty(r: PopRequest): boolean {
  return r.notes.trim() === '' && POP_REQUEST_LINES.every((l) => r.values[l.key].trim() === '');
}

/** The text stored in `Parts Required`: all ten numbered lines (a blank one
    stays, so the list always reads the same), then the notes; null when the
    request is empty, so the parts gate still sees "no parts listed". */
export function formatPopRequest(r: PopRequest): string | null {
  if (popRequestEmpty(r)) return null;
  const lines = POP_REQUEST_LINES.map(
    (l, i) => `${i + 1}- ${l.label}: ${r.values[l.key].replace(/\s*\n\s*/g, ' ').trim()}`.trimEnd(),
  );
  const notes = r.notes.trim();
  return notes ? `${lines.join('\n')}\n\n${notes}` : lines.join('\n');
}
