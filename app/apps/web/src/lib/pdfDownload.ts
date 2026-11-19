/* Save a drawn document as a PDF file, with no print dialog (Elise,
 * 2026-11-19: "it should be saved as PDF directly if we click download").
 *
 * The element is captured as the browser draws it (html-to-image, so the
 * fonts, the brand bands and the colours are exactly the screen's), then cut
 * into US Letter pages with jsPDF. Page breaks fall at the bottom of a row, a
 * list item or a section, never through a line of text. The text in the file
 * is a picture of the text (not selectable) — the price of an exact copy of
 * the design without a second renderer to keep in step. Both libraries load
 * only when someone downloads. */

const PAGE_W_PT = 612; // 8.5 in
const PAGE_H_PT = 792; // 11 in
const MARGIN_PT = 36; // 0.5 in
const PIXEL_RATIO = 2;
/** Where a page may end: the bottom of one of these. */
const BREAK_SELECTOR = 'section, header, footer, table, tr, li, p, h3, dl, .qdoc-b-accept, .qdoc-b-strip';
/** Blocks never cut in two: the client acceptance (signature lines) and the totals. */
const KEEP_TOGETHER = '.qdoc-b-accept, .qdoc-totals';

async function imagesLoaded(el: HTMLElement): Promise<void> {
  await Promise.all(
    Array.from(el.querySelectorAll('img')).map((img) =>
      img.complete
        ? null
        : new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
    ),
  );
}

/** The y (CSS px from the element's top) of every place a page may end. */
function breakPoints(el: HTMLElement): number[] {
  const top = el.getBoundingClientRect().top;
  const ys = new Set<number>();
  el.querySelectorAll<HTMLElement>(BREAK_SELECTOR).forEach((n) => {
    const r = n.getBoundingClientRect();
    if (r.height > 0) ys.add(Math.round(r.bottom - top));
  });
  const keep = Array.from(el.querySelectorAll<HTMLElement>(KEEP_TOGETHER)).map((n) => {
    const r = n.getBoundingClientRect();
    return [Math.round(r.top - top), Math.round(r.bottom - top)] as const;
  });
  // A page may still end just above a kept block: its top is a break too.
  keep.forEach(([t]) => ys.add(t));
  return [...ys].filter((y) => !keep.some(([t, b]) => y > t && y < b)).sort((a, b) => a - b);
}

export async function downloadElementAsPdf(el: HTMLElement, fileName: string): Promise<void> {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')]);
  if (document.fonts?.ready) await document.fonts.ready;
  await imagesLoaded(el);

  const widthPx = el.offsetWidth;
  const heightPx = el.offsetHeight;
  const canvas = await toCanvas(el, { pixelRatio: PIXEL_RATIO, backgroundColor: '#ffffff', width: widthPx, height: heightPx });

  const contentW = PAGE_W_PT - 2 * MARGIN_PT;
  const ptPerPx = contentW / widthPx;
  const pageHpx = Math.floor((PAGE_H_PT - 2 * MARGIN_PT) / ptPerPx);
  const breaks = breakPoints(el);

  const pdf = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait', compress: true });
  let start = 0;
  let first = true;
  while (start < heightPx - 1) {
    const limit = start + pageHpx;
    let end = heightPx;
    if (limit < heightPx) {
      // The last clean break on this page, as long as it fills at least half of it.
      const fit = breaks.filter((y) => y > start + pageHpx / 2 && y <= limit);
      end = fit.length ? fit[fit.length - 1] : limit;
    }
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    slice.height = Math.max(1, Math.round((end - start) * PIXEL_RATIO));
    const ctx = slice.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw the PDF');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(canvas, 0, Math.round(start * PIXEL_RATIO), canvas.width, slice.height, 0, 0, slice.width, slice.height);
    if (!first) pdf.addPage('letter', 'portrait');
    first = false;
    pdf.addImage(slice.toDataURL('image/jpeg', 0.94), 'JPEG', MARGIN_PT, MARGIN_PT, contentW, (end - start) * ptPerPx);
    start = end;
  }
  pdf.save(fileName);
}

/** A file name from a document number: letters, digits, dots, dashes. */
export function pdfFileName(...parts: Array<string | null | undefined>): string {
  const base = parts
    .filter((p): p is string => !!p && p.trim() !== '')
    .map((p) => p.trim().replace(/[^A-Za-z0-9._-]+/g, '-'))
    .join(' - ');
  return `${base || 'document'}.pdf`;
}
