// 0070 · Drawing a blank sign-off sheet.
//
// One US-Letter page per billing entity, redrawn from the sheets the Make +
// Paperform automation used to produce (product samples, 2026-10-06), minus
// what was wrong with those: the blank second page, the "Powered by
// Paperform" stamp, and BKR's signature spilling onto its own page. The work
// order number and the service address are printed; the manager's name and
// signature are left as a writing line and a box, because the technician
// hands the sheet over to be signed by hand and texts a photo back.
//
// Pure: data in, PDF bytes out. pdf-lib's standard fonts need WinAnsi text,
// so anything outside Latin-1 is replaced before drawing rather than thrown.

import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb, type RGB } from 'pdf-lib';
import type { SignoffLayout, SignoffSheetData } from '@theone/shared';
import { SIGNOFF_ASSETS, type SignoffAssetName } from './signoffAssets.js';

// Shared with lib/woPdf.ts (0073), which draws the work-order PDF in the same
// branding: page geometry, colours and the brand table are exported for it.
export const PAGE_W = 612;
export const PAGE_H = 792;
export const MARGIN = 36;
export const CONTENT_W = PAGE_W - MARGIN * 2;

export const hex = (h: string): RGB => {
  const n = parseInt(h.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export const INK = hex('#222222');
export const INK_SOFT = hex('#333333');
export const RULE = hex('#c8c8c8');
const BOX = hex('#dcdcdc');

/** The brand of each layout: its colours and the wording on its labels. */
export interface Brand {
  title: string;
  titleSize: number;
  titleColor: RGB;
  labelColor: RGB;
  labelSize: number;
  valueColor: RGB;
  valueSize: number;
  valueBold: boolean;
  labels: { ref: string; address: string; manager: string; closeout?: string; signature: string };
}

export const BRANDS: Record<SignoffLayout, Brand> = {
  sfm: {
    title: 'Signoff Sheet', titleSize: 26, titleColor: hex('#003cff'),
    labelColor: hex('#003cff'), labelSize: 17, valueColor: hex('#000000'), valueSize: 12, valueBold: false,
    labels: { ref: 'Job Work Order Number:', address: 'Location:', manager: 'Name of Manager on Site:', signature: 'Signature of Manager on Site:' },
  },
  tpm: {
    title: 'Signoff Sheet', titleSize: 26, titleColor: hex('#fa833f'),
    labelColor: hex('#fa833f'), labelSize: 17, valueColor: hex('#040404'), valueSize: 12, valueBold: false,
    labels: { ref: 'Job Work Order Number:', address: 'Location:', manager: 'Name of Manager on Site:', signature: 'Signature of Manager on Site:' },
  },
  rf: {
    title: 'Signoff Sheet', titleSize: 26, titleColor: hex('#51b57e'),
    labelColor: hex('#53b880'), labelSize: 17, valueColor: hex('#040404'), valueSize: 12, valueBold: false,
    labels: { ref: 'Job Work Order Number:', address: 'Location:', manager: 'Name of Manager on Site:', signature: 'Signature of Manager on Site:' },
  },
  eds: {
    title: 'Sign-Off Submission', titleSize: 16, titleColor: hex('#e57620'),
    labelColor: hex('#e57620'), labelSize: 14, valueColor: INK_SOFT, valueSize: 11, valueBold: true,
    labels: { ref: 'Work Order Number:', address: 'Address/Location:', manager: 'Manager On-site Name:', signature: 'Manager On-Site Signature:' },
  },
  bkr: {
    title: 'Signoff Sheet', titleSize: 26, titleColor: INK,
    labelColor: INK, labelSize: 14, valueColor: hex('#e3244b'), valueSize: 11, valueBold: false,
    labels: { ref: 'Work Order #:', address: 'Service Address:', manager: 'Store Manager Name:', signature: 'Store Manager Signature:' },
  },
  bkr_emcor: {
    title: 'Signoff Sheet', titleSize: 26, titleColor: INK,
    labelColor: INK, labelSize: 14, valueColor: hex('#e3244b'), valueSize: 11, valueBold: false,
    labels: { ref: 'Work Order #:', address: 'Service Address:', manager: 'Store Manager Name:', closeout: 'Closeout Number:', signature: 'Store Manager Signature:' },
  },
  af: {
    title: 'Job Completion Slip', titleSize: 26, titleColor: INK_SOFT,
    labelColor: INK_SOFT, labelSize: 13, valueColor: INK_SOFT, valueSize: 11, valueBold: false,
    labels: { ref: 'Job Number:', address: 'Store Location:', manager: 'Manager on Duty:', signature: 'Signature:' },
  },
};

const AF_FOOTER = 'For questions or feedback, please call us on (530) 264-8213, or send us an email on info@alphafixers.com';

// ── Text helpers ─────────────────────────────────────────────────────────────

/** WinAnsi-safe: pdf-lib's standard fonts refuse anything else. */
export function safeText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip combining marks left by NFKD
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')
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

// ── Drawing ──────────────────────────────────────────────────────────────────

class Sheet {
  readonly page: PDFPage;
  /** Distance from the TOP of the page to the next free line. */
  y = MARGIN;
  constructor(readonly doc: PDFDocument, readonly regular: PDFFont, readonly bold: PDFFont) {
    this.page = doc.addPage([PAGE_W, PAGE_H]);
  }

  async image(name: SignoffAssetName): Promise<PDFImage> {
    return embedAsset(this.doc, name);
  }

  /** Full-width image at the current y; advances y. */
  async band(name: SignoffAssetName, width = CONTENT_W): Promise<void> {
    const img = await this.image(name);
    const h = (img.height / img.width) * width;
    const x = MARGIN + (CONTENT_W - width) / 2;
    this.page.drawImage(img, { x, y: PAGE_H - this.y - h, width, height: h });
    this.y += h;
  }

  /** Full-width image pinned to the bottom margin (does not move y). */
  async footerBand(name: SignoffAssetName): Promise<number> {
    const img = await this.image(name);
    const h = (img.height / img.width) * CONTENT_W;
    this.page.drawImage(img, { x: MARGIN, y: MARGIN, width: CONTENT_W, height: h });
    return h;
  }

  centered(text: string, font: PDFFont, size: number, color: RGB): void {
    const w = font.widthOfTextAtSize(text, size);
    this.page.drawText(text, { x: (PAGE_W - w) / 2, y: PAGE_H - this.y - size, size, font, color });
    this.y += size * 1.2;
  }

  text(text: string, font: PDFFont, size: number, color: RGB, x = MARGIN, maxWidth = CONTENT_W): void {
    for (const line of wrap(text, font, size, maxWidth)) {
      this.page.drawText(line, { x, y: PAGE_H - this.y - size, size, font, color });
      this.y += size * 1.3;
    }
  }

  /** A thin line to write on. */
  writingLine(width: number): void {
    this.y += 14;
    this.page.drawLine({
      start: { x: MARGIN, y: PAGE_H - this.y },
      end: { x: MARGIN + width, y: PAGE_H - this.y },
      thickness: 0.75,
      color: RULE,
    });
    this.y += 4;
  }

  /** The signature box: as tall as the space left above `reserveBottom`. */
  signatureBox(reserveBottom: number, minHeight = 110, maxHeight = 220): void {
    const available = PAGE_H - MARGIN - reserveBottom - this.y - 8;
    const h = Math.max(minHeight, Math.min(maxHeight, available));
    this.page.drawRectangle({
      x: MARGIN, y: PAGE_H - this.y - h, width: CONTENT_W, height: h,
      borderColor: BOX, borderWidth: 0.75, color: rgb(1, 1, 1),
    });
    this.y += h;
  }

  gap(n: number): void { this.y += n; }
}

/** One label / value pair in the stacked style five of the brands share. */
function field(s: Sheet, b: Brand, label: string, value: string | null, opts: { line?: number } = {}): void {
  s.text(label, s.bold, b.labelSize, b.labelColor);
  s.gap(2);
  if (value) {
    s.text(value, b.valueBold ? s.bold : s.regular, b.valueSize, b.valueColor);
    s.gap(10);
  } else {
    s.writingLine(opts.line ?? 300);
    s.gap(8);
  }
}

async function stacked(s: Sheet, layout: SignoffLayout, data: SignoffSheetData, header: SignoffAssetName | null, footer: SignoffAssetName | null, logoWidth?: number): Promise<void> {
  const b = BRANDS[layout];
  const footerH = footer ? await s.footerBand(footer) : 0;
  if (header) await s.band(header, logoWidth);
  s.gap(logoWidth ? 18 : 34);
  s.centered(b.title, s.bold, b.titleSize, b.titleColor);
  s.gap(logoWidth ? 14 : 28);

  field(s, b, b.labels.ref, safeText(data.wo_ref) || '-');
  field(s, b, b.labels.address, safeText(data.address) || null, { line: CONTENT_W });
  field(s, b, b.labels.manager, null);
  if (b.labels.closeout) field(s, b, b.labels.closeout, null, { line: 220 });
  s.text(b.labels.signature, s.bold, b.labelSize, b.labelColor);
  s.gap(8);
  s.signatureBox(footerH ? footerH + 10 : 0);
}

/** Alpha Fixers' slip is a bordered table rather than a stack. */
async function alphaFixers(s: Sheet, data: SignoffSheetData): Promise<void> {
  const b = BRANDS.af;
  await s.band('af_header');
  s.gap(30);
  s.centered(b.title, s.bold, b.titleSize, b.titleColor);
  s.gap(26);

  const labelW = 200;
  const pad = 12;
  const rows: { label: string; value: string | null; height: number }[] = [
    { label: b.labels.ref, value: safeText(data.wo_ref) || '-', height: 34 },
    { label: b.labels.address, value: safeText(data.address) || null, height: 34 },
    { label: b.labels.manager, value: null, height: 34 },
    { label: b.labels.signature, value: null, height: 230 },
  ];
  const valueW = CONTENT_W - labelW - pad * 2;
  for (const r of rows) {
    const lines = r.value ? wrap(r.value, s.regular, b.valueSize, valueW) : [];
    const h = Math.max(r.height, lines.length * b.valueSize * 1.3 + pad * 2);
    const top = PAGE_H - s.y;
    s.page.drawRectangle({ x: MARGIN, y: top - h, width: labelW, height: h, borderColor: BOX, borderWidth: 0.75, color: rgb(1, 1, 1) });
    s.page.drawRectangle({ x: MARGIN + labelW, y: top - h, width: CONTENT_W - labelW, height: h, borderColor: BOX, borderWidth: 0.75, color: rgb(1, 1, 1) });
    // Labels sit on the row's first line, except the signature's which is
    // vertically centred like the sample.
    const labelY = r.value === null && r.height > 100 ? top - h / 2 - b.labelSize / 2 : top - pad - b.labelSize;
    s.page.drawText(r.label, { x: MARGIN + pad, y: labelY, size: b.labelSize, font: s.regular, color: b.labelColor });
    let ly = top - pad - b.valueSize;
    for (const line of lines) {
      s.page.drawText(line, { x: MARGIN + labelW + pad, y: ly, size: b.valueSize, font: s.regular, color: b.valueColor });
      ly -= b.valueSize * 1.3;
    }
    s.y += h;
  }

  s.gap(40);
  s.text(AF_FOOTER, s.regular, 12, INK_SOFT);
}

/** The blank sheet, as PDF bytes. One page, always. */
export async function renderSignoffSheet(data: SignoffSheetData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Sign-off sheet ${safeText(data.wo_ref)}`);
  doc.setProducer('The One');
  doc.setCreator('The One');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const s = new Sheet(doc, regular, bold);

  switch (data.layout) {
    case 'sfm': await stacked(s, 'sfm', data, 'sfm_header', 'sfm_footer'); break;
    case 'tpm': await stacked(s, 'tpm', data, 'tpm_header', 'tpm_footer'); break;
    case 'rf': await stacked(s, 'rf', data, 'rf_header', null); break;
    case 'eds': await stacked(s, 'eds', data, 'eds_logo', null, 150); break;
    case 'bkr': await stacked(s, 'bkr', data, 'bkr_logo', 'bkr_footer', 140); break;
    case 'bkr_emcor': await stacked(s, 'bkr_emcor', data, 'bkr_logo', 'bkr_footer', 140); break;
    case 'af': await alphaFixers(s, data); break;
  }
  return doc.save();
}
