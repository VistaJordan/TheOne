// The client-update email (0055), as pure functions: tracker data in, HTML and
// plain text out. No I/O, so the Preview button, the real send and the tests
// render exactly the same thing.
//
// Email clients (Outlook above all) ignore stylesheets and most modern CSS,
// so this is table layout with inline styles and fixed colours — the one
// place outside tokens.css where hex colours are right: an email has no
// theme, and Outlook's dark mode inverts it on its own.

export interface EmailSection {
  /** A group header ("Waiting for Approval"); null = no sections. */
  title: string | null;
  rows: string[][];
}

export interface EmailChart {
  label: string;
  total: number;
  buckets: { label: string; n: number }[];
}

export interface ClientUpdateEmailInput {
  trackerName: string;
  client: string | null;
  intro: string | null;
  generatedAt: Date;
  headers: string[];
  sections: EmailSection[];
  rowCount: number;
  truncated: boolean;
  summary: { label: string; value: string }[] | null;
  charts: EmailChart[];
  link: string | null;
  fromName: string;
  fromAddress: string;
}

const INK = '#1b2330';
const MUTED = '#5b6573';
const RULE = '#dfe3e8';
const HEAD_BG = '#f3f5f8';
const ACCENT = '#1f5fbf';
const BAR = '#3b7dd8';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function when(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d) + ' CT';
}

/** Split rows into sections by one column's value, keeping first-seen order. */
export function sectionRows(rows: string[][], groupIndex: number | null): EmailSection[] {
  if (groupIndex === null || groupIndex < 0) return [{ title: null, rows }];
  const order: string[] = [];
  const byKey = new Map<string, string[][]>();
  for (const r of rows) {
    const k = r[groupIndex] || '(not set)';
    if (!byKey.has(k)) {
      byKey.set(k, []);
      order.push(k);
    }
    byKey.get(k)!.push(r);
  }
  return order.map((k) => ({ title: k, rows: byKey.get(k)! }));
}

function summaryHtml(summary: { label: string; value: string }[]): string {
  // Inline blocks, not table cells, so the tiles wrap on a phone instead of
  // pushing the whole email wider than the screen. (Outlook desktop stacks
  // them, which still reads fine.)
  const cells = summary
    .map(
      (s) => `<div style="display:inline-block;vertical-align:top;min-width:120px;margin:0 8px 8px 0;padding:10px 14px;border:1px solid ${RULE};border-radius:6px;background:#ffffff">
        <div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.04em">${escapeHtml(s.label)}</div>
        <div style="font-size:22px;font-weight:700;color:${INK};padding-top:2px">${escapeHtml(s.value)}</div>
      </div>`,
    )
    .join('');
  return `<div style="margin:0 0 10px 0">${cells}</div>`;
}

function chartHtml(c: EmailChart): string {
  const max = Math.max(1, ...c.buckets.map((b) => b.n));
  const rows = c.buckets
    .map((b) => {
      const pct = Math.max(2, Math.round((b.n / max) * 100));
      return `<tr>
        <td style="padding:3px 10px 3px 0;font-size:13px;color:${INK};white-space:nowrap">${escapeHtml(b.label)}</td>
        <td style="padding:3px 0;width:100%"><table role="presentation" cellspacing="0" cellpadding="0" style="width:${pct}%"><tr><td style="background:${BAR};height:12px;border-radius:3px;font-size:0;line-height:0">&nbsp;</td></tr></table></td>
        <td style="padding:3px 0 3px 10px;font-size:13px;color:${INK};text-align:right;font-weight:600">${b.n}</td>
      </tr>`;
    })
    .join('');
  return `<td style="vertical-align:top;padding:0 12px 16px 0;width:50%">
    <div style="font-size:13px;font-weight:700;color:${INK};padding-bottom:6px">${escapeHtml(c.label)} <span style="color:${MUTED};font-weight:400">· ${c.total}</span></div>
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%">${rows}</table>
  </td>`;
}

function chartsHtml(charts: EmailChart[]): string {
  if (charts.length === 0) return '';
  const pairs: string[] = [];
  for (let i = 0; i < charts.length; i += 2) {
    pairs.push(`<tr>${chartHtml(charts[i])}${charts[i + 1] ? chartHtml(charts[i + 1]) : '<td></td>'}</tr>`);
  }
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin:0 0 8px 0">${pairs.join('')}</table>`;
}

/** A WO number, a date, a dollar amount: one token that must not break. */
function keepWhole(c: string): boolean {
  return c.length <= 18 && !/\s/.test(c);
}

function tableHtml(headers: string[], sections: EmailSection[]): string {
  const th = headers
    .map(
      (h) =>
        `<th style="text-align:left;padding:7px 8px;background:${HEAD_BG};border-bottom:1px solid ${RULE};font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.03em;vertical-align:bottom">${escapeHtml(h)}</th>`,
    )
    .join('');
  const body = sections
    .map((s) => {
      const title = s.title
        ? `<tr><td colspan="${headers.length}" style="padding:14px 10px 6px;font-size:14px;font-weight:700;color:${INK};border-bottom:2px solid ${ACCENT}">${escapeHtml(s.title)} <span style="color:${MUTED};font-weight:400">· ${s.rows.length}</span></td></tr>`
        : '';
      const rows = s.rows
        .map(
          (r) =>
            `<tr>${r
              .map(
                (c) =>
                  `<td style="padding:6px 8px;border-bottom:1px solid ${RULE};font-size:12.5px;color:${INK};vertical-align:top${keepWhole(c) ? ';white-space:nowrap' : ''}">${escapeHtml(c)}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('');
      return title + rows;
    })
    .join('');
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

export function buildClientUpdateEmail(input: ClientUpdateEmailInput): { html: string; text: string } {
  const title = input.client ? `${input.client} · ${input.trackerName}` : input.trackerName;
  const intro = input.intro?.trim()
    ? `<p style="margin:0 0 16px 0;font-size:14px;line-height:1.5;color:${INK}">${escapeHtml(input.intro.trim()).replace(/\r?\n/g, '<br>')}</p>`
    : '';
  const button = input.link
    ? `<p style="margin:0 0 18px 0"><a href="${escapeHtml(input.link)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 18px;border-radius:6px">Open the live tracker</a></p>`
    : '';
  const truncated = input.truncated
    ? `<p style="margin:10px 0 0 0;font-size:12px;color:${MUTED}">Showing the first ${input.rowCount} work orders.${input.link ? ' The live tracker has them all.' : ''}</p>`
    : '';
  const empty =
    input.rowCount === 0
      ? `<p style="margin:0;font-size:14px;color:${MUTED}">No work orders match this update right now.</p>`
      : tableHtml(input.headers, input.sections);

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#eef1f5">
<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;background:#eef1f5"><tr><td style="padding:24px 12px">
<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;max-width:1100px;margin:0 auto;background:#ffffff;border:1px solid ${RULE};border-radius:8px;font-family:Arial,Helvetica,sans-serif">
<tr><td style="padding:22px 24px 6px 24px">
  <div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.06em">${escapeHtml(input.fromName)} · Work order update</div>
  <h1 style="margin:4px 0 2px 0;font-size:22px;color:${INK}">${escapeHtml(title)}</h1>
  <div style="font-size:13px;color:${MUTED};padding-bottom:16px">As of ${escapeHtml(when(input.generatedAt))} · ${input.rowCount} work order${input.rowCount === 1 ? '' : 's'}</div>
  ${intro}${button}${input.summary && input.summary.length ? summaryHtml(input.summary) : ''}${chartsHtml(input.charts)}
</td></tr>
<tr><td style="padding:0 24px 22px 24px">${empty}${truncated}</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid ${RULE};font-size:12px;color:${MUTED}">Sent by ${escapeHtml(input.fromName)} from ${escapeHtml(input.fromAddress)}. Reply to this email with any questions about a work order.</td></tr>
</table></td></tr></table></body></html>`;

  const lines: string[] = [];
  lines.push(title);
  lines.push(`As of ${when(input.generatedAt)} · ${input.rowCount} work orders`);
  if (input.intro?.trim()) lines.push('', input.intro.trim());
  if (input.link) lines.push('', `Live tracker: ${input.link}`);
  if (input.summary?.length) lines.push('', input.summary.map((s) => `${s.label}: ${s.value}`).join(' · '));
  for (const s of input.sections) {
    lines.push('');
    if (s.title) lines.push(`== ${s.title} (${s.rows.length}) ==`);
    for (const r of s.rows) {
      lines.push(r.map((c, i) => (c ? `${input.headers[i]}: ${c}` : '')).filter(Boolean).join(' | '));
    }
  }
  if (input.truncated) lines.push('', `Showing the first ${input.rowCount} work orders.`);
  lines.push('', `Sent by ${input.fromName} from ${input.fromAddress}.`);
  return { html, text: lines.join('\n') };
}
