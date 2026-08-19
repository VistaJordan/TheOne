/* SharePoint folder naming for Ecotrak work orders.
 *
 * PURE — no Microsoft Graph calls, no I/O. Path construction only, so it is
 * testable without credentials and cannot accidentally touch the live library.
 * The Graph client that consumes these lands with the worker in Phase 1.
 *
 * The convention MUST match what the existing ecotrak-clickup-sync produces,
 * because a live SharePoint tree already holds folders in this shape and a
 * second naming scheme would silently fork it:
 *
 *   General/Work Orders - {YYYY}/{YYYY} - SFM/{client}/WO#{id}, {city}, {ST}
 *
 * Two rules carried over deliberately:
 *   1. Base segments are formulaic and auto-created, so January rollover cannot
 *      break ingestion.
 *   2. The CLIENT folder must pre-exist. A typo'd or newly-onboarded customer
 *      name must NOT silently spawn a duplicate client tree beside the real one
 *      — it raises instead, and someone adds an alias or creates the folder.
 */

/** Ecotrak customer name -> the SharePoint client folder that already exists. */
export const CLIENT_FOLDER_ALIAS: Record<string, string> = {
  'Flynn Restaurant Group': 'Flynn',
  // Ecotrak sends a curly apostrophe (U+2019); the live folder has a straight one.
  'Mimi’s Cafe': "Mimi's Cafe",
  // Onboarded 2026-08-19 — Ecotrak appends the initialism.
  'Green Thumb Industries (GTI)': 'Green Thumb Industries',
};

const US_STATE_ABBR: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

export function stateAbbr(name: string | null | undefined): string | null {
  if (!name) return null;
  const k = String(name).trim().toLowerCase();
  if (US_STATE_ABBR[k]) return US_STATE_ABBR[k];
  if (k.length === 2) return k.toUpperCase(); // already abbreviated
  return null;
}

/**
 * SharePoint rejects " * : < > ? / \ | in item names, and trailing dots or
 * spaces. Everything illegal becomes "-" so the name stays recognisable.
 */
export function sanitizeFolderName(name: string): string {
  return String(name)
    .replace(/["*:<>?/\\|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

/** Year-rolling base path. Formulaic, so it is safe to auto-create. */
export function baseFolderPath(year: number): string {
  return `General/Work Orders - ${year}/${year} - SFM`;
}

/** The minimum an Ecotrak work order must expose to be filed. */
export interface FilableWorkOrder {
  id: number | string;
  /** Our settable number. Null on 100% of production records — falls back to id. */
  work_order_id?: number | string | null;
  customer?: { customer_name?: string | null } | null;
  location?: { city?: string | null; state?: string | null } | null;
}

/** Client folder name, alias-resolved. Null when Ecotrak sent no customer. */
export function clientFolderName(wo: FilableWorkOrder): string | null {
  const name = wo.customer?.customer_name;
  if (!name) return null;
  return CLIENT_FOLDER_ALIAS[name] ?? name;
}

/**
 * Per-WO folder, e.g. "WO#6339414, Phoenix, AZ".
 *
 * Uses work_order_id when set, else the Ecotrak id — matching the existing
 * sync. In production work_order_id is null on every record, so in practice
 * this is always the Ecotrak id. Missing city/state segments are dropped
 * rather than rendered blank.
 */
export function woFolderName(wo: FilableWorkOrder): string {
  const num = wo.work_order_id ?? wo.id;
  return [`WO#${num}`, wo.location?.city, stateAbbr(wo.location?.state)]
    .filter(Boolean)
    .join(', ');
}

export interface FolderPlan {
  base: string;
  client: string;
  wo: string;
  /** Full path from the library root — what Graph addresses. */
  fullPath: string;
}

/**
 * Build the full folder plan. Throws when the client is unknown, because
 * guessing would fork the live client tree.
 *
 * `year` is injected rather than read from the clock so the result is
 * deterministic and testable.
 */
export function planFolder(wo: FilableWorkOrder, year: number): FolderPlan {
  const rawClient = clientFolderName(wo);
  if (!rawClient) {
    throw new Error(
      `work order ${wo.id} has no customer name — cannot resolve a SharePoint client folder`,
    );
  }
  const base = baseFolderPath(year);
  const client = sanitizeFolderName(rawClient);
  const woFolder = sanitizeFolderName(woFolderName(wo));
  return { base, client, wo: woFolder, fullPath: `${base}/${client}/${woFolder}` };
}

/**
 * Per-segment encoding. "#" in "WO#123" and "&" in client names both break
 * Graph path addressing unless encoded, but "/" must survive as a separator.
 */
export function encodeGraphPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * What the backend stores per work order. `webUrl` is the link to open the
 * folder; `fullPath` re-addresses it via Graph without another lookup.
 */
export interface SharePointRef {
  driveItemId: string;
  webUrl: string;
  fullPath: string;
}
