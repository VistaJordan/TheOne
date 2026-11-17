// 0070 · Drawing the sign-off sheet. Redesigned 2026-11-17 (Elise approved
// the "Sign-off & Quote Designs" canvas): Seamless is "the seam" — a black
// band with the logo, one cyan-to-blue line that runs down the page through
// the four numbered steps to the signature; BKR is a field service ticket —
// slate and BKR red, condensed type, red numerals, and a tear-off stub for the
// store manager.
//
// One US-Letter page, always. Positions are written in the design's own
// units (816 × 1056 px, the page at 96 dpi) and turned into PDF points here,
// so the code reads like the design file. The blank sheet leaves the name,
// date and signature empty; a sheet signed on the form (0156) prints the name,
// the date, the closeout number and the drawn signature in their places.
//
// Pure: data in, PDF bytes out. The fonts are the design's (Sora, Inter,
// JetBrains Mono for Seamless; Barlow and Barlow Condensed for BKR), embedded
// from Latin-1 subsets (signoffFonts.ts), so text is folded to Latin-1 first.

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFFont, PDFImage, PDFPage, rgb, type RGB } from 'pdf-lib';
import type { SignoffLayout, SignoffSheetData } from '@theone/shared';
import { SIGNOFF_ASSETS, type SignoffAssetName } from './signoffAssets.js';
import { SIGNOFF_FONTS, type SignoffFontName } from './signoffFonts.js';

export const PAGE_W = 612;
export const PAGE_H = 792;

/** Design pixels → PDF points (816 px = 612 pt). */
const P = PAGE_W / 816;
const DW = 816;
const DH = 1056;

export const hex = (h: string): RGB => {
  const n = parseInt(h.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

const mix = (a: string, b: string, t: number): RGB => {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => (((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t) / 255;
  return rgb(ch(16), ch(8), ch(0));
};

// ── Text helpers ─────────────────────────────────────────────────────────────

/** Latin-1 only: the embedded fonts are Latin-1 subsets. */
export function safeText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip combining marks left by NFKD
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\x7e\xa1-\xff]/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

export function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const probe = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(probe, size) <= maxWidth || !line) line = probe;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * One inlined image, decoded into its OWN ArrayBuffer. `Buffer.from(base64)`
 * may hand back a slice of Node's shared pool (a non-zero byteOffset), and
 * pdf-lib's JPEG embedder reads `bytes.buffer` from offset 0 — "SOI not found
 * in JPEG" for an image that is perfectly fine. Whether a given decode lands
 * in the pool depends on size and on what was allocated before it, so the
 * copy is the only way to make every render come out the same.
 */
export function assetBytes(name: SignoffAssetName): Uint8Array {
  return new Uint8Array(Buffer.from(SIGNOFF_ASSETS[name].base64, 'base64'));
}

export async function embedAsset(doc: PDFDocument, name: SignoffAssetName): Promise<PDFImage> {
  const bytes = assetBytes(name);
  return SIGNOFF_ASSETS[name].kind === 'png' ? doc.embedPng(bytes) : doc.embedJpg(bytes);
}

// ── Drawing in design units ──────────────────────────────────────────────────

type Align = 'left' | 'right' | 'center';
interface TextOpts { spacing?: number; align?: Align; upper?: boolean }

class Pen {
  constructor(readonly page: PDFPage) {}

  rect(x: number, y: number, w: number, h: number, color: RGB): void {
    this.page.drawRectangle({ x: x * P, y: (DH - y - h) * P, width: w * P, height: h * P, color });
  }

  /** A horizontal (or vertical) gradient, as thin slices. */
  gradient(x: number, y: number, w: number, h: number, from: string, to: string, vertical = false): void {
    const steps = 64;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const c = mix(from, to, t);
      if (vertical) this.rect(x, y + (h * i) / steps, w, h / steps + 0.4, c);
      else this.rect(x + (w * i) / steps, y, w / steps + 0.4, h, c);
    }
  }

  line(x1: number, y1: number, x2: number, y2: number, thickness: number, color: RGB, dash?: number[]): void {
    this.page.drawLine({
      start: { x: x1 * P, y: (DH - y1) * P },
      end: { x: x2 * P, y: (DH - y2) * P },
      thickness: thickness * P,
      color,
      ...(dash ? { dashArray: dash.map((d) => d * P) } : {}),
    });
  }

  circle(cx: number, cy: number, r: number, fill: RGB | null, border?: { color: RGB; width: number }): void {
    this.page.drawCircle({
      x: cx * P,
      y: (DH - cy) * P,
      size: r * P,
      ...(fill ? { color: fill } : {}),
      ...(border ? { borderColor: border.color, borderWidth: border.width * P } : {}),
    });
  }

  width(text: string, font: PDFFont, size: number, spacing = 0): number {
    return font.widthOfTextAtSize(text, size * P) / P + spacing * Math.max(0, text.length - 1);
  }

  /**
   * Text whose line box starts at `top` (px). The baseline sits where a CSS
   * line of `size` would put it (≈ 0.8 of the size below the top), close
   * enough for every font here.
   */
  text(raw: string, x: number, top: number, font: PDFFont, size: number, color: RGB, o: TextOpts = {}): number {
    const text = o.upper ? raw.toUpperCase() : raw;
    const spacing = o.spacing ?? 0;
    const w = this.width(text, font, size, spacing);
    let left = x;
    if (o.align === 'right') left = x - w;
    else if (o.align === 'center') left = x - w / 2;
    const baseline = (DH - top - size * 0.8) * P;
    if (!spacing) {
      this.page.drawText(text, { x: left * P, y: baseline, size: size * P, font, color });
    } else {
      let cx = left;
      for (const ch of text) {
        this.page.drawText(ch, { x: cx * P, y: baseline, size: size * P, font, color });
        cx += font.widthOfTextAtSize(ch, size * P) / P + spacing;
      }
    }
    return w;
  }

  image(img: PDFImage, x: number, y: number, w: number, h: number): void {
    this.page.drawImage(img, { x: x * P, y: (DH - y - h) * P, width: w * P, height: h * P });
  }

  /** Fit an image inside a box (contain), sitting on the box's bottom edge. */
  imageContain(img: PDFImage, x: number, y: number, w: number, h: number): void {
    const scale = Math.min(w / img.width, h / img.height);
    const iw = img.width * scale;
    const ih = img.height * scale;
    this.image(img, x + (w - iw) / 2, y + h - ih, iw, ih);
  }
}

type Fonts = Record<SignoffFontName, PDFFont>;

async function embedFonts(doc: PDFDocument, names: SignoffFontName[]): Promise<Fonts> {
  const out = {} as Fonts;
  for (const n of names) {
    out[n] = await doc.embedFont(new Uint8Array(Buffer.from(SIGNOFF_FONTS[n], 'base64')), { subset: true });
  }
  return out;
}

// ── Seamless: the seam ───────────────────────────────────────────────────────

const SFM = {
  ink: '#0e1116', soft: '#4a5361', rule: '#9aa4b2', cyan: '#1ec8f5', mid: '#1290f0', blue: '#0b63f6',
  ref: '#c9d3df', tint: '#f5f8fc', mark: '#b8c6d8', footRule: '#e3e8ef',
};

async function drawSeamless(doc: PDFDocument, page: PDFPage, data: SignoffSheetData): Promise<void> {
  const f = await embedFonts(doc, ['Sora_Bold', 'Sora_SemiBold', 'Inter_Regular', 'Inter_Medium', 'JetBrainsMono_Medium']);
  const pen = new Pen(page);
  const c = (h: string) => hex(h);
  const ref = safeText(data.wo_ref) || '-';
  const address = safeText(data.address);
  const signed = data.signed;

  // Header band, the logo as Seamless uses it, on black.
  pen.rect(0, 0, DW, 136, c('#000000'));
  const logo = await embedAsset(doc, 'sfm_header');
  const logoH = 104;
  pen.image(logo, 24, 16, (logo.width / logo.height) * logoH, logoH);
  pen.text('Job completion record', 760, 52, f.Sora_SemiBold, 11, c(SFM.cyan), { spacing: 3, upper: true, align: 'right' });
  pen.text(ref, 760, 72, f.JetBrainsMono_Medium, 13, c(SFM.ref), { align: 'right' });
  // The seam, under the band.
  pen.gradient(0, 136, DW, 4, SFM.cyan, SFM.blue);

  // Title.
  pen.text('Sign-off Sheet', 64, 184, f.Sora_Bold, 40, c(SFM.ink), { spacing: -0.5 });
  pen.text(
    signed ? `Signed by the manager on site on ${safeText(signed.date_label)}.` : 'To be signed by the manager on site once the work is complete.',
    64, 238, f.Inter_Regular, 14, c(SFM.soft),
  );

  // Where each step sits.
  const X = 116;
  const CW = 752 - X;
  const addrLines = address ? wrap(address, f.Inter_Medium, 19 * P, CW * P).slice(0, 3) : [];
  const s1 = 303;
  const s2 = s1 + 52 + 34;
  const s3 = s2 + 22 + Math.max(1, addrLines.length) * 26.6 + 34;
  const s4 = s3 + 45 + 34;
  const boxTop = s4 + 26;
  const reserve = signed ? 52 : 34; // attestation (+ stamp) and a margin above the footer
  const boxH = Math.max(150, Math.min(240, 980 - 24 - reserve - boxTop));

  // The seam running down the page, joining every step (drawn under the nodes).
  pen.gradient(75, s1 + 12, 2, s4 - s1, SFM.cyan, SFM.blue, true);

  const node = (n: number, top: number, border: string, filled = false) => {
    pen.circle(76, top + 12, 11, filled ? c(SFM.blue) : c('#ffffff'), filled ? undefined : { color: c(border), width: 2 });
    pen.text(String(n), 76, top + 7.5, f.Sora_Bold, 10, filled ? c('#ffffff') : c(SFM.blue), { align: 'center' });
  };
  const label = (t: string, x: number, top: number) => pen.text(t, x, top, f.Sora_SemiBold, 11, c(SFM.soft), { spacing: 2, upper: true });

  // 1 · the work order.
  node(1, s1, SFM.cyan);
  label('Job work order number', X, s1 + 2);
  pen.text(ref, X, s1 + 22, f.JetBrainsMono_Medium, 24, c(SFM.ink));

  // 2 · where.
  node(2, s2, '#19aef2');
  label('Location', X, s2 + 2);
  if (addrLines.length) addrLines.forEach((l, i) => pen.text(l, X, s2 + 22 + i * 26.6, f.Inter_Medium, 19, c(SFM.ink)));
  else pen.line(X, s2 + 48, X + CW, s2 + 48, 1, c(SFM.rule));

  // 3 · who and when.
  node(3, s3, SFM.mid);
  const nameW = ((CW - 32) * 1.8) / 2.8;
  const dateX = X + nameW + 32;
  label('Name of manager on site', X, s3 + 2);
  label('Date', dateX, s3 + 2);
  if (signed) {
    pen.text(safeText(signed.manager_name), X, s3 + 22, f.Inter_Medium, 17, c(SFM.ink));
    pen.text(safeText(signed.date_label), dateX, s3 + 22, f.Inter_Medium, 17, c(SFM.ink));
  }
  pen.line(X, s3 + 45, X + nameW, s3 + 45, 1, c(SFM.rule));
  pen.line(dateX, s3 + 45, X + CW, s3 + 45, 1, c(SFM.rule));

  // 4 · the signature: a tinted field with crop corners instead of a box.
  node(4, s4, SFM.blue, true);
  label('Signature of manager on site', X, s4 + 2);
  const bx = X;
  const bw = CW;
  const bb = boxTop + boxH;
  pen.rect(bx, boxTop, bw, boxH, c(SFM.tint));
  const corner = (x: number, y: number, dx: number, dy: number, col: string) => {
    pen.line(x, y, x + 22 * dx, y, 2, c(col));
    pen.line(x, y, x, y + 22 * dy, 2, c(col));
  };
  corner(bx + 1, boxTop + 1, 1, 1, SFM.cyan);
  corner(bx + bw - 1, boxTop + 1, -1, 1, SFM.mid);
  corner(bx + 1, bb - 1, 1, -1, SFM.mid);
  corner(bx + bw - 1, bb - 1, -1, -1, SFM.blue);
  pen.text('×', bx + 28, bb - 60, f.Sora_SemiBold, 30, c(SFM.mark));
  pen.line(bx + 64, bb - 34, bx + bw - 32, bb - 34, 1, c(SFM.rule));
  if (signed) {
    const sig = await doc.embedPng(signed.signature_png);
    pen.imageContain(sig, bx + 64, boxTop + 14, bw - 96, boxH - 14 - 36);
  }
  pen.text('By signing, I confirm the work on this work order was completed on site.', X, bb + 12, f.Inter_Regular, 12, c(SFM.soft));
  if (signed) pen.text(safeText(signed.stamp), X, bb + 32, f.Inter_Medium, 11, c(SFM.blue));

  // Footer.
  pen.line(0, 980, DW, 980, 1, c(SFM.footRule));
  pen.text('Seamless Facility Management', 64, 1011, f.Sora_SemiBold, 12, c(SFM.ink), { spacing: 0.5 });
  pen.text('+1 (469) 501-1510 · info@seamlessfm.com', 752, 1001, f.Inter_Regular, 12, c(SFM.soft), { align: 'right' });
  pen.text('1910 Pacific Ave, Suite 2000 #3299, Dallas, TX 75201', 752, 1019, f.Inter_Regular, 12, c(SFM.soft), { align: 'right' });
}

// ── BKR: the field service ticket ────────────────────────────────────────────

const BKR = {
  ink: '#1f2933', slate: '#3e4a56', soft: '#5b6673', red: '#e3244b', band: '#c81e40',
  rule: '#d5dbe1', line: '#8a96a3', stub: '#f4f6f8', tear: '#b9c2cc', box: '#c3cbd3',
};

async function drawBkr(doc: PDFDocument, page: PDFPage, data: SignoffSheetData, emcor: boolean): Promise<void> {
  const f = await embedFonts(doc, ['BarlowCondensed_Bold', 'BarlowCondensed_SemiBold', 'Barlow_Regular', 'Barlow_Medium']);
  const pen = new Pen(page);
  const c = (h: string) => hex(h);
  const ref = safeText(data.wo_ref) || '-';
  const address = safeText(data.address);
  const signed = data.signed;
  const label = (t: string, x: number, top: number) => pen.text(t, x, top, f.BarlowCondensed_SemiBold, 14, c(BKR.soft), { spacing: 2, upper: true });

  // Header: the logo left, the ticket's title right.
  const logo = await embedAsset(doc, 'bkr_logo');
  const logoH = 118;
  pen.image(logo, 48, 36, (logo.width / logo.height) * logoH, logoH);
  pen.text('Field service ticket', 760, 58, f.BarlowCondensed_SemiBold, 13, c(BKR.soft), { spacing: 3, upper: true, align: 'right' });
  pen.text('Sign-off Sheet', 760, 82, f.BarlowCondensed_Bold, 56, c(BKR.slate), { spacing: 0.5, upper: true, align: 'right' });

  // The double rule, borrowed from the logo's underline.
  pen.rect(56, 180, 704, 4, c(BKR.red));
  pen.rect(56, 187, 704, 1, c(BKR.red));

  // The job.
  const NX = 56;
  const X = 138;
  const CW = 760 - X;
  const numeral = (n: string, top: number) => pen.text(n, NX, top - 4, f.BarlowCondensed_Bold, 44, c(BKR.red));

  let y = 219;
  numeral('01', y);
  label('Work order #', X, y);
  pen.text(ref, X, y + 22, f.BarlowCondensed_SemiBold, 30, c(BKR.ink), { spacing: 1 });
  pen.line(X, y + 73, 760, y + 73, 1, c(BKR.rule));
  y += 74 + 26;

  numeral('02', y);
  label('Service address', X, y);
  const addrLines = address ? wrap(address, f.Barlow_Medium, 20 * P, CW * P).slice(0, 3) : [];
  if (addrLines.length) addrLines.forEach((l, i) => pen.text(l, X, y + 23 + i * 27, f.Barlow_Medium, 20, c(BKR.ink)));
  const addrH = 23 + Math.max(1, addrLines.length) * 27 + 14;
  pen.line(X, y + addrH, 760, y + addrH, 1, c(BKR.rule));
  y += addrH + 1 + 26;

  if (emcor) {
    numeral('03', y);
    label('Closeout number', X, y);
    if (signed?.closeout_number) pen.text(safeText(signed.closeout_number), X, y + 20, f.Barlow_Medium, 18, c(BKR.ink));
    pen.line(X, y + 41, X + 300, y + 41, 1, c(BKR.line));
    y += 42 + 26;
  }

  // The tear line with its ticket notches: the manager's stub below.
  const stubTop = Math.max(486, y + 18);
  const stubBottom = DH - 44;
  pen.rect(0, stubTop, DW, stubBottom - stubTop, c(BKR.stub));
  pen.circle(0, stubTop, 18, c('#ffffff'));
  pen.circle(DW, stubTop, 18, c('#ffffff'));
  pen.line(30, stubTop, 786, stubTop, 2, c(BKR.tear), [7, 5]);

  const t0 = stubTop + 34;
  const tw = pen.text('Store manager sign-off', 56, t0, f.BarlowCondensed_Bold, 22, c(BKR.slate), { spacing: 2, upper: true });
  pen.line(56 + tw + 14, t0 + 12, 760, t0 + 12, 1, c(BKR.rule));

  const t1 = t0 + 50;
  const nameW = 448;
  const dateX = 56 + nameW + 32;
  label('Store manager name', 56, t1);
  label('Date', dateX, t1);
  if (signed) {
    pen.text(safeText(signed.manager_name), 56, t1 + 20, f.Barlow_Medium, 19, c(BKR.ink));
    pen.text(safeText(signed.date_label), dateX, t1 + 20, f.Barlow_Medium, 19, c(BKR.ink));
  }
  pen.line(56, t1 + 45, 56 + nameW, t1 + 45, 1, c(BKR.line));
  pen.line(dateX, t1 + 45, 760, t1 + 45, 1, c(BKR.line));

  const t2 = t1 + 45 + 24;
  label('Store manager signature', 56, t2);
  const boxTop = t2 + 24;
  const reserve = signed ? 56 : 38;
  const boxH = Math.max(140, Math.min(260, stubBottom - 24 - reserve - boxTop));
  const bb = boxTop + boxH;
  pen.rect(56, boxTop, 704, boxH, c(BKR.box));
  pen.rect(57, boxTop + 1, 702, boxH - 2, c('#ffffff'));
  pen.rect(56, boxTop, 6, boxH, c(BKR.red));
  pen.text('Sign here', 56 + 20, bb - 22 - 15, f.BarlowCondensed_SemiBold, 13, c(BKR.line), { spacing: 2, upper: true });
  pen.line(56 + 110, bb - 30, 760 - 28, bb - 30, 1, c(BKR.line));
  if (signed) {
    const sig = await doc.embedPng(signed.signature_png);
    pen.imageContain(sig, 56 + 110, boxTop + 14, 704 - 110 - 28, boxH - 14 - 32);
  }
  pen.text('By signing, I confirm the work on this work order was completed at my store.', 56, bb + 10, f.Barlow_Regular, 13, c(BKR.soft));
  if (signed) pen.text(safeText(signed.stamp), 56, bb + 30, f.Barlow_Medium, 12, c(BKR.band));

  // The footer band, as BKR uses it.
  pen.rect(0, stubBottom, DW, 44, c(BKR.band));
  pen.text('BKR National Facility Services', 56, stubBottom + 14, f.BarlowCondensed_SemiBold, 14, c('#ffffff'), { spacing: 3, upper: true });
  pen.text('www.bkrnational.com', 760, stubBottom + 14, f.Barlow_Medium, 14, c('#ffffff'), { align: 'right' });
}

// ── The sheet ────────────────────────────────────────────────────────────────

const DRAW: Record<SignoffLayout, (doc: PDFDocument, page: PDFPage, data: SignoffSheetData) => Promise<void>> = {
  sfm: drawSeamless,
  bkr: (doc, page, data) => drawBkr(doc, page, data, false),
  bkr_emcor: (doc, page, data) => drawBkr(doc, page, data, true),
};

/** The sheet, as PDF bytes: blank, or signed when `data.signed` is set. One page, always. */
export async function renderSignoffSheet(data: SignoffSheetData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`${data.signed ? 'Signed sign-off sheet' : 'Sign-off sheet'} ${safeText(data.wo_ref)}`);
  doc.setProducer('OBI');
  doc.setCreator('OBI');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  await DRAW[data.layout](doc, page, data);
  return doc.save();
}
