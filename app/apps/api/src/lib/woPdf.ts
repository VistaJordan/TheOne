// 0073 · Drawing a work order as a PDF.
//
// The same page and the same branding as the sign-off sheets (signoffPdf.ts:
// US Letter, Helvetica, the entity's header / footer art inlined in
// signoffAssets.ts) but a DOCUMENT rather than a form: a title block, then
// the chosen fields in a two-column grid that runs over as many pages as it
// needs, long text (the description) across the full width, a note under the
// fields, and a running head + "Page n of m" on every page.
//
// Pure: rows in, PDF bytes out. Which fields appear, in what order and with
// which values is the service's business (services/woPdf.ts); this file only
// knows how to lay them out. A work order whose entity has no art (Comp unset
// or unknown) gets a neutral, unbranded page rather than a wrong logo.

import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb, type RGB } from 'pdf-lib';
import type { SignoffLayout, WoPdfKind } from '@theone/shared';
import type { SignoffAssetName } from './signoffAssets.js';
import { BRANDS, CONTENT_W, INK, INK_SOFT, MARGIN, PAGE_H, PAGE_W, RULE, embedAsset, hex, safeText } from './signoffPdf.js';

export interface WoPdfRow {
  label: string;
  /** Already formatted. Null / empty prints as a dash. */
  value: string | null;
  /** Spans both columns (descriptions, notes, long text). */
  wide?: boolean;
}

export interface WoPdfDoc {
  layout: SignoffLayout | null;
  entity_name: string;
  kind: WoPdfKind;
  /** The layout's heading ("Work order", "Service request"). */
  title: string;
  wo_number: string;
  /** The work order's own title, under the heading. */
  headline: string | null;
  rows: WoPdfRow[];
  note: string | null;
  generated_at: Date;
  generated_by: string | null;
}

// ── Branding ─────────────────────────────────────────────────────────────────

interface Art {
  header: SignoffAssetName | null;
  footer: SignoffAssetName | null;
  /** A logo rather than a full-width band: drawn at this width, left-aligned. */
  logoWidth?: number;
}

/** Which images each entity's document carries — the sign-off sheet's set
    (see renderSignoffSheet's switch); logos are a little smaller here. */
const ART: Record<SignoffLayout, Art> = {
  sfm: { header: 'sfm_header', footer: 'sfm_footer' },
  tpm: { header: 'tpm_header', footer: 'tpm_footer' },
  rf: { header: 'rf_header', footer: null },
  eds: { header: 'eds_logo', footer: null, logoWidth: 130 },
  bkr: { header: 'bkr_logo', footer: 'bkr_footer', logoWidth: 120 },
  bkr_emcor: { header: 'bkr_logo', footer: 'bkr_footer', logoWidth: 120 },
  af: { header: 'af_header', footer: null },
};

interface Palette {
  title: RGB;
  label: RGB;
}

const NEUTRAL: Palette = { title: INK, label: hex('#5c5c5c') };
const MUTED = hex('#8a8a8a');
const EMPTY = hex('#a8a8a8');
const GRID = hex('#e4e4e4');

function paletteFor(layout: SignoffLayout | null): Palette {
  if (!layout) return NEUTRAL;
  const b = BRANDS[layout];
  // The sign-off sheets print BKR's values in red; on a dense document the
  // brand colour stays on the title and the labels, and the values stay ink.
  return { title: b.titleColor, label: b.labelColor };
}

// ── Type ─────────────────────────────────────────────────────────────────────

const T = {
  title: 20,
  woNumber: 13,
  headline: 11.5,
  meta: 8.5,
  label: 7.5,
  value: 10,
  note: 9,
  foot: 7.5,
  runHead: 9,
};
const LH = 1.3;
const GUTTER = 18;
const COL_W = (CONTENT_W - GUTTER) / 2;
const CELL_PAD_BOTTOM = 9;
const LABEL_GAP = 3;

/** Wrap to a width, breaking a token longer than the line (an address with no
    spaces, a URL) by characters rather than letting it run off the page. */
function lines(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(' ').filter((w, i, a) => w !== '' || a.length === 1);
    let line = '';
    const push = () => {
      out.push(line);
      line = '';
    };
    for (const w of words) {
      const probe = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(probe, size) <= maxWidth) {
        line = probe;
        continue;
      }
      if (line) push();
      if (font.widthOfTextAtSize(w, size) <= maxWidth) {
        line = w;
        continue;
      }
      // Too long for a whole line: cut it where it stops fitting.
      let chunk = '';
      for (const ch of w) {
        if (font.widthOfTextAtSize(chunk + ch, size) <= maxWidth) chunk += ch;
        else {
          out.push(chunk);
          chunk = ch;
        }
      }
      line = chunk;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

// ── The page ─────────────────────────────────────────────────────────────────

class Doc {
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  /** Distance from the TOP of the page to the next free line. */
  y = MARGIN;
  private header: PDFImage | null = null;
  private footer: PDFImage | null = null;
  private footerH = 0;

  constructor(
    readonly pdf: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly palette: Palette,
    readonly art: Art | null,
    readonly runHead: { left: string; right: string },
  ) {}

  async embed(): Promise<void> {
    if (!this.art) return;
    if (this.art.header) this.header = await embedAsset(this.pdf, this.art.header);
    if (this.art.footer) {
      this.footer = await embedAsset(this.pdf, this.art.footer);
      this.footerH = (this.footer.height / this.footer.width) * CONTENT_W;
    }
  }

  /** Where the page line sits (baseline, from the bottom). */
  private get footLineY(): number {
    return this.footerH ? MARGIN + this.footerH + 7 : MARGIN;
  }

  /** The lowest y (from the top) the content may reach. */
  get bottom(): number {
    return PAGE_H - this.footLineY - 14;
  }

  newPage(): void {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = MARGIN;
    if (this.footer) {
      this.page.drawImage(this.footer, { x: MARGIN, y: MARGIN, width: CONTENT_W, height: this.footerH });
    }
    if (this.pages.length === 1) {
      this.firstHeader();
    } else {
      this.runningHeader();
    }
  }

  private firstHeader(): void {
    if (this.header && this.art) {
      const w = this.art.logoWidth ?? CONTENT_W;
      const h = (this.header.height / this.header.width) * w;
      this.page.drawImage(this.header, { x: MARGIN, y: PAGE_H - this.y - h, width: w, height: h });
      this.y += h + 16;
    } else {
      this.y += 6;
    }
  }

  private runningHeader(): void {
    const size = T.runHead;
    const baseline = PAGE_H - this.y - size;
    this.page.drawText(this.runHead.left, { x: MARGIN, y: baseline, size, font: this.bold, color: this.palette.label });
    const rw = this.regular.widthOfTextAtSize(this.runHead.right, size);
    this.page.drawText(this.runHead.right, { x: PAGE_W - MARGIN - rw, y: baseline, size, font: this.regular, color: INK_SOFT });
    this.y += size + 6;
    this.rule(this.palette.label, 0.75);
    this.y += 12;
  }

  /** Make room for `h` points; starts a new page when they do not fit. */
  ensure(h: number): void {
    if (this.y + h > this.bottom) this.newPage();
  }

  rule(color: RGB = RULE, thickness = 0.5): void {
    this.page.drawLine({
      start: { x: MARGIN, y: PAGE_H - this.y },
      end: { x: PAGE_W - MARGIN, y: PAGE_H - this.y },
      thickness,
      color,
    });
  }

  text(text: string, font: PDFFont, size: number, color: RGB, x = MARGIN, maxWidth = CONTENT_W, lh = LH): void {
    for (const line of lines(text, font, size, maxWidth)) {
      this.ensure(size * lh);
      this.page.drawText(line, { x, y: PAGE_H - this.y - size, size, font, color });
      this.y += size * lh;
    }
  }

  /** The page line on every page, once the count is known. */
  finish(left: string): void {
    const n = this.pages.length;
    this.pages.forEach((p, i) => {
      const right = `Page ${i + 1} of ${n}`;
      const y = this.footLineY;
      p.drawText(left, { x: MARGIN, y, size: T.foot, font: this.regular, color: MUTED });
      const rw = this.regular.widthOfTextAtSize(right, T.foot);
      p.drawText(right, { x: PAGE_W - MARGIN - rw, y, size: T.foot, font: this.regular, color: MUTED });
    });
  }
}

// ── Cells ────────────────────────────────────────────────────────────────────

interface Cell {
  label: string;
  value: string[];
  empty: boolean;
  width: number;
}

function cellOf(d: Doc, row: WoPdfRow, width: number): Cell {
  const raw = safeText(row.value);
  const empty = raw === '';
  // safeText collapses newlines; keep paragraphs for the wide rows.
  const kept = row.wide && row.value ? row.value.split(/\r?\n/).map((l) => safeText(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim() : raw;
  return {
    label: safeText(row.label).toUpperCase(),
    value: empty ? ['-'] : lines(kept, d.regular, T.value, width),
    empty,
    width,
  };
}

function cellHeight(c: Cell): number {
  return T.label + LABEL_GAP + c.value.length * T.value * LH + CELL_PAD_BOTTOM;
}

function drawCell(d: Doc, c: Cell, x: number, top: number): void {
  d.page.drawText(c.label, { x, y: PAGE_H - top - T.label, size: T.label, font: d.bold, color: d.palette.label });
  let y = top + T.label + LABEL_GAP;
  for (const line of c.value) {
    d.page.drawText(line, { x, y: PAGE_H - y - T.value, size: T.value, font: d.regular, color: c.empty ? EMPTY : INK });
    y += T.value * LH;
  }
}

/** A wide cell that may not fit on the page it starts on: as many lines as
    fit, then the rest under a "(continued)" label on the next page. */
function drawWide(d: Doc, c: Cell): void {
  let rest = c.value;
  let label = c.label;
  while (rest.length) {
    const headH = T.label + LABEL_GAP;
    const lineH = T.value * LH;
    // At least the label and three lines together, else start a new page.
    if (d.y + headH + lineH * Math.min(3, rest.length) + CELL_PAD_BOTTOM > d.bottom) d.newPage();
    const room = Math.floor((d.bottom - d.y - headH - CELL_PAD_BOTTOM) / lineH);
    const take = Math.max(1, Math.min(rest.length, room));
    const part: Cell = { label, value: rest.slice(0, take), empty: c.empty, width: c.width };
    drawCell(d, part, MARGIN, d.y);
    d.y += cellHeight(part);
    rest = rest.slice(take);
    label = `${c.label} (CONTINUED)`;
    if (rest.length) continue;
    d.y -= 4;
    d.rule(GRID);
    d.y += 6;
  }
}

function drawPair(d: Doc, a: Cell, b: Cell | null): void {
  const h = Math.max(cellHeight(a), b ? cellHeight(b) : 0);
  d.ensure(h + 2);
  drawCell(d, a, MARGIN, d.y);
  if (b) drawCell(d, b, MARGIN + COL_W + GUTTER, d.y);
  d.y += h - 4;
  d.rule(GRID);
  d.y += 6;
}

// ── Formatting shared with the service ───────────────────────────────────────

const CHICAGO = 'America/Chicago';

export function stampText(d: Date): string {
  return d.toLocaleString('en-US', {
    timeZone: CHICAGO,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ── The document ─────────────────────────────────────────────────────────────

export async function renderWorkOrderPdf(doc: WoPdfDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const kindLabel = doc.kind === 'request' ? 'Request' : 'Work order';
  pdf.setTitle(`${safeText(doc.title)} ${safeText(doc.wo_number)}`);
  pdf.setSubject(`${kindLabel} · ${safeText(doc.entity_name)}`);
  pdf.setProducer('The One');
  pdf.setCreator('The One');
  pdf.setCreationDate(doc.generated_at);
  pdf.setModificationDate(doc.generated_at);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const palette = paletteFor(doc.layout);
  const art = doc.layout ? ART[doc.layout] : null;
  const woNumber = safeText(doc.wo_number);
  const title = safeText(doc.title) || kindLabel;
  const entity = safeText(doc.entity_name);

  const d = new Doc(pdf, regular, bold, palette, art, { left: entity, right: `${title} · ${woNumber}` });
  await d.embed();
  d.newPage();

  // ── Title block ──
  {
    const numW = bold.widthOfTextAtSize(woNumber, T.woNumber);
    const titleW = CONTENT_W - numW - 16;
    const titleLines = lines(title, bold, T.title, titleW);
    const baseline = PAGE_H - d.y - T.title;
    d.page.drawText(titleLines[0], { x: MARGIN, y: baseline, size: T.title, font: bold, color: palette.title });
    d.page.drawText(woNumber, { x: PAGE_W - MARGIN - numW, y: baseline + (T.title - T.woNumber) / 2, size: T.woNumber, font: bold, color: INK });
    d.y += T.title * 1.15;
    for (const extra of titleLines.slice(1)) {
      d.page.drawText(extra, { x: MARGIN, y: PAGE_H - d.y - T.title, size: T.title, font: bold, color: palette.title });
      d.y += T.title * 1.15;
    }
    d.y += 4;
    const headline = safeText(doc.headline);
    if (headline && headline !== woNumber) d.text(headline, bold, T.headline, INK);
    d.y += 3;
    const by = doc.generated_by ? ` by ${safeText(doc.generated_by)}` : '';
    const meta = [entity, kindLabel, `Generated ${stampText(doc.generated_at)}${by}`].filter(Boolean).join('   ·   ');
    d.text(meta, regular, T.meta, MUTED);
    d.y += 8;
    d.rule(palette.label, 1);
    d.y += 14;
  }

  // ── The grid: pairs of narrow cells, wide cells on their own line ──
  let pending: Cell | null = null;
  const flush = () => {
    if (pending) drawPair(d, pending, null);
    pending = null;
  };
  for (const row of doc.rows) {
    if (row.wide) {
      flush();
      drawWide(d, cellOf(d, row, CONTENT_W));
      continue;
    }
    const cell = cellOf(d, row, COL_W);
    if (pending) {
      drawPair(d, pending, cell);
      pending = null;
    } else {
      pending = cell;
    }
  }
  flush();

  if (doc.rows.length === 0) {
    d.text('No fields are set for this document. An administrator picks them in Admin > Settings > Work-order PDFs.', regular, T.value, MUTED);
  }

  // ── Note ──
  const note = doc.note ? doc.note.split(/\r?\n/).map((l) => safeText(l)).join('\n').trim() : '';
  if (note) {
    d.y += 10;
    d.ensure(T.label + LABEL_GAP + T.note * LH * 2);
    d.page.drawText('NOTE', { x: MARGIN, y: PAGE_H - d.y - T.label, size: T.label, font: bold, color: palette.label });
    d.y += T.label + LABEL_GAP + 1;
    d.text(note, regular, T.note, INK_SOFT, MARGIN, CONTENT_W, 1.4);
  }

  d.finish(`${entity ? `${entity}  ·  ` : ''}${title} ${woNumber}`);
  return pdf.save();
}
