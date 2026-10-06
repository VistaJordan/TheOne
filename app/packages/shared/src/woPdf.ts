// 0073 · Save a work order as a PDF — the vocabulary shared by the API and
// the browser.
//
// Two documents can be drawn from one work order, both in the billing
// entity's branding (the same header / footer art as the sign-off sheets):
//
//   full      the work order as the team sees it — the main fields, which an
//             administrator picks and reorders in Admin › Settings;
//   request   what the client sent — who they are, where the site is and
//             what they asked for. Its field list is edited the same way.
//
// A layout is one row per kind in `wo_pdf_layout`: a title, an ordered list
// of catalogue keys (`wo_number`, `client`, … for the promoted columns,
// `fields.<json key>` for the bag) and whether empty fields are left off.
// Whatever the list says, a field the person may not SEE is never printed —
// the renderer runs the same redaction as the work-order payload.

export const WO_PDF_KINDS = ['full', 'request'] as const;
export type WoPdfKind = (typeof WO_PDF_KINDS)[number];

export const WO_PDF_KIND_LABELS: Record<WoPdfKind, string> = {
  full: 'Work order',
  request: 'Request',
};

/** The one-line explanation under each kind in Admin › Settings. */
export const WO_PDF_KIND_HINTS: Record<WoPdfKind, string> = {
  full: 'The work order as the team sees it: the main fields, in the order below.',
  request: "What the client sent: who they are, where the site is and what they asked for.",
};

export const WO_PDF_PERM_KEY = 'work_orders/pdf';

export interface WoPdfLayout {
  kind: WoPdfKind;
  /** The heading on the document ("Work order", "Service request", …). */
  title: string;
  /** Ordered catalogue keys. */
  items: string[];
  /** Leave a field off the page when the work order has no value for it. */
  hide_empty: boolean;
  /** Printed under the fields — a disclaimer, a contact line, instructions. */
  note: string | null;
  updated_at: string | null;
}

export interface WoPdfLayoutInput {
  title?: string;
  items?: string[];
  hide_empty?: boolean;
  note?: string | null;
}

/** One field the layout editor can offer: its key, label and section title. */
export interface WoPdfFieldInfo {
  key: string;
  label: string;
  section: string;
}

export interface WoPdfLayoutsResponse {
  layouts: WoPdfLayout[];
  fields: WoPdfFieldInfo[];
  can: { edit: boolean };
}

/**
 * The lists migration 0073 seeds, and what the API falls back to should a
 * row be missing. If you change one, change the other.
 */
export const WO_PDF_DEFAULTS: Record<WoPdfKind, { title: string; items: string[]; hide_empty: boolean }> = {
  full: {
    title: 'Work order',
    hide_empty: false,
    items: [
      'wo_number',
      'ext_name',
      'status',
      'priority',
      'client',
      'billing_entity',
      'trade',
      'date_received',
      'fields.SLA Due Date',
      'fields.Due Date',
      'fields.Scheduled Date',
      'fields.Store',
      'fields.17. Address',
      'fields.City',
      'fields.State',
      'fields.Zip Code',
      'fields.22. FM',
      'fields.Assignee',
      'fields.TL',
      'fields.AM',
      'fields.Tech Name',
      'fields.Tech Phone Number',
      'nte',
      'fields.16. Client NTE 🔴',
      'fields.Client Quote',
      'fields.34. Cost',
      'fields.Total Invoiced',
      'fields.Checked-in At',
      'fields.Checked-out At',
      'fields.35. WO Description',
      'fields.Parts Required',
      'fields.20. Last Update',
    ],
  },
  request: {
    title: 'Service request',
    hide_empty: true,
    items: [
      'client',
      'ext_name',
      'wo_number',
      'date_received',
      'fields.Store',
      'fields.17. Address',
      'fields.City',
      'fields.State',
      'fields.Zip Code',
      'fields.22. FM',
      'fields.✅ Client AFM',
      'trade',
      'fields.Sub Category',
      'fields.Problem Type',
      'priority',
      'fields.16. Client NTE 🔴',
      'fields.SLA Due Date',
      'fields.Client Portal Type',
      'description',
      'fields.35. WO Description',
    ],
  },
};

/** The promoted columns a layout may list (the rest of the catalogue is
    `fields.*`). `location`, `age_days` and the message columns are list-only
    projections with no place on a document. */
export const WO_PDF_CORE_KEYS = [
  'wo_number',
  'ext_name',
  'title',
  'description',
  'client',
  'city',
  'state',
  'trade',
  'billing_entity',
  'nte',
  'priority',
  'date_received',
  'status',
] as const;

export function woPdfFileName(woNumber: string, kind: WoPdfKind): string {
  const safe = woNumber.replace(/[^A-Za-z0-9._-]+/g, '-');
  return kind === 'request' ? `${safe}-request.pdf` : `${safe}.pdf`;
}

/** The download link of one kind for one work order (id or WO number). */
export function woPdfPath(idOrNumber: string, kind: WoPdfKind, download = true): string {
  return `/api/work-orders/${encodeURIComponent(idOrNumber)}/pdf?kind=${kind}${download ? '&download=1' : ''}`;
}
