/* 0075 · Downloads for the documents: a Markdown file, a Word document built
   from the rendered page, or the lifecycle chart as SVG. Everything happens
   in the browser from what is already on screen. */

export function downloadText(name: string, text: string, type = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

const WORD_CSS = `
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #111; }
  h1 { font-size: 22pt; color: #1f3b63; } h2 { font-size: 16pt; color: #1f3b63; margin-top: 18pt; }
  h3 { font-size: 13pt; color: #1f3b63; } h4 { font-size: 11.5pt; } h5 { font-size: 11pt; font-style: italic; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; }
  th { background: #1f3b63; color: #fff; text-align: left; padding: 4pt 6pt; font-size: 9.5pt; }
  td { border: 1px solid #c8d2e0; padding: 4pt 6pt; vertical-align: top; font-size: 10pt; }
  .doc-box { background: #eaf1fb; border: 1px solid #c8d2e0; padding: 6pt 8pt; margin: 8pt 0; }
  .doc-box-title { color: #1f3b63; display: block; margin-bottom: 2pt; }
  .doc-lead { color: #666; font-style: italic; }
  .doc-feature { margin: 8pt 0 10pt; }
  .doc-kv b { color: #1f3b63; }
  code { font-family: Consolas, monospace; font-size: 9.5pt; }
  .no-print, .doc-toc { display: none; }
`;

/** Wraps the rendered document in a Word-readable HTML file (.doc). */
export function downloadWord(name: string, title: string, html: string): void {
  const doc =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">` +
    `<head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${WORD_CSS}</style></head><body>${html}</body></html>`;
  downloadText(name, doc, 'application/msword');
}

export function downloadSvg(name: string, svg: SVGSVGElement): void {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // Bake the theme tokens in: a standalone file has no :root to read.
  const cs = getComputedStyle(document.documentElement);
  const vars = ['--ink', '--ink-2', '--ink-3', '--border', '--border-strong', '--surface', '--surface-2', '--accent', '--danger', '--warn', '--ok', '--chip'];
  const style = document.createElement('style');
  style.textContent = `:root{${vars.map((v) => `${v}:${cs.getPropertyValue(v).trim() || '#888'}`).join(';')}} text{font-family:Inter,Segoe UI,Arial,sans-serif}`;
  clone.insertBefore(style, clone.firstChild);
  downloadText(name, `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`, 'image/svg+xml');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);
}
