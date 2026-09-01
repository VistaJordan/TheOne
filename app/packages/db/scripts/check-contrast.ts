// Verifies every seeded status pill ≥4.5:1 in both themes, plus --ink-3 in both.
// Reproduces the CSS color-mix(in srgb, …) math and WCAG relative-luminance ratio.
// Objective pass/fail — no spot-checking. Run: npx tsx packages/db/scripts/check-contrast.ts
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: number[], b: number[]) => { const hi = Math.max(L(a), L(b)), lo = Math.min(L(a), L(b)); return (hi + 0.05) / (lo + 0.05); };
const hx = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16));
const mix = (c: number[], p: number, o: number[]) => c.map((x, i) => Math.round(x * p + o[i] * (1 - p)));
const WHITE = [255, 255, 255], BLACK = [0, 0, 0];
const NIGHT_SURFACE = hx('0c0d0e'), DAY_SURFACE = hx('ffffff');
// 19 pipeline colors + archive invoiced #b660e0:
const colors = ['ff3f48', 'ff3f48', 'ff3f48', 'ee5e99', 'ff3f48', 'f8ae00', 'f8ae00', 'ee5e99', 'ee5e99', 'b660e0', '4466ff', 'b660e0', 'aa8d80', '1090e0', '0f9d9f', '656f7d', '6bed5e', '64c6a2', '008844', 'b660e0'];
const DAY_OVERRIDE: Record<string, string> = { 'f8ae00': '#7c5700', '6bed5e': '#36772f', '64c6a2': '#326351' };
let fail = 0;
for (const h of colors) {
  const c = hx(h);
  const nightBg = mix(c, 0.26, NIGHT_SURFACE), nightTxt = mix(c, 0.78, WHITE);
  const dayBg = mix(c, 0.26, DAY_SURFACE);
  const dayTxt = DAY_OVERRIDE[h] ? hx(DAY_OVERRIDE[h]) : mix(c, 0.66, BLACK);
  const rn = ratio(nightTxt, nightBg), rd = ratio(dayTxt, dayBg);
  if (rn < 4.5 || rd < 4.5) { fail++; console.log(`FAIL #${h}  night=${rn.toFixed(2)} day=${rd.toFixed(2)}`); }
}
// --ink-3 on worst-case surface
const ink3 = [
  ['night --ink-3', hx('7f838c'), hx('0c0d0e')],
  ['day --ink-3 / surface', hx('6c727b'), hx('ffffff')],
  ['day --ink-3 / thead', hx('6c727b'), hx('fafbfc')],
] as const;
for (const [name, t, bg] of ink3) { const r = ratio(t as number[], bg as number[]); if (r < 4.5) { fail++; console.log(`FAIL ${name} = ${r.toFixed(2)}`); } }
console.log(fail === 0 ? 'PASS: all pills + --ink-3 ≥4.5:1 in both themes' : `${fail} contrast failure(s)`);
process.exit(fail === 0 ? 0 : 1);
