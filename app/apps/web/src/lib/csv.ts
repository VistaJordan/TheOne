// CSV parsing, in the browser.
//
// The import flow parses the file HERE rather than posting it to the API,
// because the step that actually needs a human — deciding which column of the
// client's spreadsheet is the NTE — has to happen next to a preview of the
// data. Shipping the raw file to the server would mean either guessing the
// mapping there or round-tripping the file twice.
//
// A hand-rolled parser (rather than a dependency) because the job is small and
// exactly specified: RFC 4180, plus the two things real exports do — a UTF-8
// BOM, and CRLF line endings.

export interface ParsedCsv {
  headers: string[];
  /** One record per row, aligned to `headers`. Short rows are padded. */
  rows: string[][];
}

export function parseCsv(text: string): ParsedCsv {
  // Excel writes a BOM; left in place it becomes part of the first header name
  // and that column silently fails to map to anything.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;

  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    // A trailing newline produces one empty cell, not an empty record.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        // "" inside a quoted field is one literal quote.
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }

    if (c === '"' && cell === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      endCell();
      i += 1;
      continue;
    }
    if (c === '\r') {
      // CRLF or a lone CR — both end the record.
      endRow();
      i += src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (c === '\n') {
      endRow();
      i += 1;
      continue;
    }
    cell += c;
    i += 1;
  }
  if (cell !== '' || row.length > 0) endRow();

  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0].map((h) => h.trim());
  const width = headers.length;
  const body = rows.slice(1).map((r) => {
    const out = r.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });

  return { headers, rows: body };
}

/** Read a File as text. Kept here so the dialog does not have to hold a
    FileReader promise wrapper of its own. */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsText(file);
  });
}

/** Normalised for header matching: case, spaces, punctuation and the numeric
    prefixes ClickUp field names carry ("16. Client NTE 🔴") all discarded. */
export function headerKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/[^a-z0-9]+/g, '');
}
