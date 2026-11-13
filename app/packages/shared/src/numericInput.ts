/**
 * Money and number boxes take figures only (Elise, 2026-11-13: "the client
 * NTE should take numbers only, no letters"). Pure; used by every typed field
 * input in the browser and mirrored by the API's coerceValue, which refuses
 * letters instead of dropping them (it used to read "5e3" as 53).
 */

/** What a money / number box keeps of a keystroke or a paste: digits and one
    decimal point (two decimals for money), a leading minus only where the
    field allows it. Letters, "e", "+", spaces and commas never get in. */
export function numericInputValue(
  raw: string,
  opts: { money?: boolean; allowNegative?: boolean } = {},
): string {
  const negative = !!opts.allowNegative && /^\s*-/.test(raw);
  let out = '';
  let dot = false;
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === '.' && !dot) { out += ch; dot = true; }
  }
  if (opts.money && dot) {
    const [whole, frac] = out.split('.');
    out = `${whole}.${(frac ?? '').slice(0, 2)}`;
  }
  return negative ? `-${out}` : out;
}

/** The API's reading of a typed figure: a number, a "$" and thousands commas
    allowed, anything else (letters included) refused with null. */
export function parseTypedNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw ?? '').trim().replace(/^\$\s*/, '').replace(/^(-?)\$\s*/, '$1').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
