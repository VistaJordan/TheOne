/* Readers over the task.fields JSONB bag + the small formatters the WO detail
   page shares. The bag is keyed by the VERBATIM ClickUp field name (DDL §3),
   so every key here is a literal from packages/db/seed/clickup-data.json.
   Every reader returns null rather than throwing — most of the 28 seeded WOs
   are archived with a sparse bag and the page must still look intentional. */

export type Fields = Record<string, unknown>;

/** Canonical field keys used by the detail page. */
export const FIELD = {
  nte: '16. Client NTE 🔴',
  cost: '34. Cost',
  invoiced: 'Total Invoiced',
  profit: 'Profit',
  description: '35. WO Description',
  address: '17. Address',
  city: 'City',
  state: 'State',
  zip: 'Zip Code',
  store: 'Store',
  fm: '22. FM',
  comp: '21. Comp',
  am: 'AM',
  salesOwner: 'Sales Owner',
  completionAssignee: 'Completion Assignee',
  assigneeName: 'Assignee Name TXT',
  previousAssignees: 'Previous Assignees',
  facilityManager: 'Facility Manager',
  clientQuote: 'Client Quote',
  quoteReadyToSend: '✅ Quote Ready To Send',
  quoteCheck: 'Quote Check',
  adminCheck: 'Admin Check',
  gtg: 'GTG',
  pdf: '37. PDF',
  dateReceived: 'Date-Time Received',
  slaDue: 'SLA Due Date',
  greyFlag: 'Grey Flag Date',
  invoiceDate: 'Invoice Date',
  actEta: 'Act ETA',
  partsOrderDate: '👣 Parts Order Date',
  orderTracking: '👣 Order/Tracking Details',
  checkInOut: '18. Check-in/out Status',
  wko: '38. WKO#',
  quoteCheckoutDate: 'QuoteReqCheckoutDate',
} as const;

/** The four penalty-exposure checkboxes rendered by FlagsRow. */
export const FLAG_FIELDS = [
  '14. Missed ETA',
  '13. Late quote',
  '15. Recall',
  '11. Penalty',
] as const;

// ── Primitive readers ────────────────────────────────────────────────────────

/** Non-empty trimmed string, else null. */
export function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Finite number, tolerating the numeric-string values the bag carries
    (e.g. Profit arrives as "-412"). Returns null for anything else. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s]/g, '');
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

/** A YYYY-MM-DD (or ISO) date string, else null. Rejects placeholders like
    'MM/DD/YYYY' that the real ClickUp export leaves in unset date fields. */
export function dateVal(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (Number.isNaN(Date.parse(s))) return null;
  return s;
}

export const field = (fields: Fields | undefined | null, key: string): unknown =>
  fields ? fields[key] : undefined;

// ── Formatters ───────────────────────────────────────────────────────────────

export const DASH = '—';

/** Whole dollars for round amounts, cents when they carry information.
    Seeded NTEs include $0.01 and $724.19 — flat 0-decimal rounding would
    render both as "$0"/"$724" and make the NTE meter look broken. */
export function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  const cents = !Number.isInteger(n);
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

/** 'Jul 21' — used by the aging cluster and date rows. */
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** '07-14' — the compact numeric form the comp uses in notes + date rows. */
export function numericDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

/** 'Jul 21 · 09:40' — the feed timestamp. */
export function feedTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} · ${time}`;
}

/** Whole days between an ISO date and now (negative = in the future). */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const ms = Date.now() - then.getTime();
  return Math.floor(ms / 86_400_000);
}

/** 'Gulf Coast Refrigeration LLC' → 'GC'; 'Peter Hope' → 'PH'. */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '··';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Renders any JSONB leaf for the "All fields" tab. */
export function fieldValueToString(v: unknown): string {
  if (v === null || v === undefined) return DASH;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim() === '' ? DASH : v;
  return JSON.stringify(v);
}
