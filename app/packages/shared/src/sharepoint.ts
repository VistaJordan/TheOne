// 0071 · SharePoint folders — the pure half.
//
// Seamless FM keeps one folder per work order in the team's SharePoint
// library, filed under the client, under the billing entity, under the year:
//
//   Documents / General / Work Orders - 2026 / 2026 - SFM / Bashas / WO#345437406, Phoenix, AZ
//
// The app creates those folders as clients and work orders are added, and
// copies approved files into the work-order folder. Everything that decides
// WHERE a folder goes lives here, with no I/O, so it is testable without a
// tenant and cannot touch the live library by accident. The Graph calls are
// in apps/api/src/lib/graphDrive.ts; the queue in services/sharepoint.ts.
//
// The naming convention is deliberately the same one the Ecotrak sync
// already produces (modules/integrations/ecotrak/sharepointPath.ts); the two
// must not fork, because a live tree already holds folders in this shape.
// The templates below are editable from Admin › Settings all the same, so a
// renamed root does not need a deploy.

export interface SharePointSettings {
  /** The site, e.g. https://contoso.sharepoint.com/sites/SeamlessFM. Null = not set up. */
  site_url: string | null;
  /** The document library, by its display name ("Documents"). */
  library: string;
  /** Path from the library root to the year's folder. `{year}` is replaced. */
  root_path: string;
  /** The billing-entity folder inside it. `{year}` and `{entity}` are replaced. */
  entity_folder: string;
  /** The work-order folder inside the client's. `{number}`, `{city}`, `{state}` are replaced. */
  wo_folder: string;
  /** A folder for each client added under Clients (under its billing entity). */
  client_folders: boolean;
  /** A folder for each work order created. */
  wo_folders: boolean;
  /** Approved files on a work order are copied into its folder. */
  copy_files: boolean;
  /** When each switch was last turned on. The hourly sweep files only what
      was created after that moment, so turning a switch on never backfills
      years of records by surprise. Null while the switch is off. */
  client_folders_since: string | null;
  wo_folders_since: string | null;
  copy_files_since: string | null;
}

export const SHAREPOINT_DEFAULTS: SharePointSettings = {
  site_url: null,
  library: 'Documents',
  root_path: 'General/Work Orders - {year}',
  entity_folder: '{year} - {entity}',
  wo_folder: 'WO#{number}, {city}, {state}',
  client_folders: false,
  wo_folders: false,
  copy_files: false,
  client_folders_since: null,
  wo_folders_since: null,
  copy_files_since: null,
};

const TOGGLES = ['client_folders', 'wo_folders', 'copy_files'] as const;
type Toggle = (typeof TOGGLES)[number];

function text(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const t = v.trim().replace(/^\/+|\/+$/g, '');
  return t === '' ? fallback : t;
}

/**
 * Whatever was stored or posted, made whole. `now` stamps a switch that is
 * being turned on; a switch that stays on keeps its stamp, one turned off
 * loses it.
 */
export function cleanSharePointSettings(raw: unknown, now: string = new Date().toISOString()): SharePointSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const site = typeof r.site_url === 'string' ? r.site_url.trim().replace(/\/+$/, '') : '';
  const out: SharePointSettings = {
    site_url: /^https:\/\/[^/\s]+/.test(site) ? site : null,
    library: text(r.library, SHAREPOINT_DEFAULTS.library),
    root_path: text(r.root_path, SHAREPOINT_DEFAULTS.root_path),
    entity_folder: text(r.entity_folder, SHAREPOINT_DEFAULTS.entity_folder),
    wo_folder: text(r.wo_folder, SHAREPOINT_DEFAULTS.wo_folder),
    client_folders: r.client_folders === true,
    wo_folders: r.wo_folders === true,
    copy_files: r.copy_files === true,
    client_folders_since: null,
    wo_folders_since: null,
    copy_files_since: null,
  };
  for (const t of TOGGLES) {
    const key = `${t}_since` as `${Toggle}_since`;
    const prev = typeof r[key] === 'string' ? (r[key] as string) : null;
    out[key] = out[t] ? prev ?? now : null;
  }
  return out;
}

/** Is the site known at all? (Credentials are a separate, server-side check.) */
export function sharePointSiteSet(s: SharePointSettings): boolean {
  return s.site_url !== null;
}

// ── Names ───────────────────────────────────────────────────────────────────

/**
 * SharePoint rejects " * : < > ? / \ | in item names, and trailing dots or
 * spaces. Everything illegal becomes "-" so the name stays recognisable.
 * (Same rule as the Ecotrak sync — keep them identical.)
 */
export function sharePointSafeName(name: string): string {
  return String(name)
    .replace(/["*:<>?/\\|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

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

/** "Arizona" → "AZ"; "az" → "AZ"; anything else as typed (trimmed) or null. */
export function sharePointStateAbbr(name: string | null | undefined): string | null {
  if (!name) return null;
  const k = String(name).trim();
  if (k === '') return null;
  const hit = US_STATE_ABBR[k.toLowerCase()];
  if (hit) return hit;
  if (k.length === 2) return k.toUpperCase();
  return k;
}

/**
 * The number that follows "WO#" in the folder name. A work order the Ecotrak
 * sync raised is numbered ECO-<id> with the Ecotrak id in ext_name, and the
 * live tree files it as WO#<id>; a hand-typed WO-39403 becomes WO#39403.
 * Anything else is used as written.
 */
export function sharePointWoNumber(woNumber: string, extName: string | null | undefined): string {
  const n = String(woNumber ?? '').trim();
  const ext = String(extName ?? '').trim();
  if (/^ECO-/i.test(n) && ext !== '') return ext;
  return n.replace(/^WO\s*[#:\-–]?\s*/i, '') || n;
}

/** `{name}` placeholders, each value made safe for a single folder name. */
export function fillSharePointTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

/** A template segment, filled, cleaned of the ", " a missing value leaves. */
function segment(template: string, vars: Record<string, string | number | null | undefined>): string {
  const filled = fillSharePointTemplate(template, vars)
    .replace(/,\s*(?=,|$)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[,\s]+$/, '');
  return sharePointSafeName(filled);
}

export interface SharePointClientPlace {
  year: number;
  /** The billing entity (`21. Comp`): AF, SFM, BKR, TPM, EDS, RF. */
  entity: string;
  /** The client's name as written on the client record. */
  client: string;
}

export interface SharePointWoPlace extends SharePointClientPlace {
  number: string;
  city: string | null;
  state: string | null;
}

/** "General/Work Orders - 2026/2026 - SFM" — the root path may hold slashes. */
export function sharePointEntityPath(s: SharePointSettings, year: number, entity: string): string {
  const root = fillSharePointTemplate(s.root_path, { year })
    .split('/')
    .map((p) => sharePointSafeName(p))
    .filter((p) => p !== '')
    .join('/');
  const ent = segment(s.entity_folder, { year, entity: entity.trim() });
  return [root, ent].filter((p) => p !== '').join('/');
}

/** "General/Work Orders - 2026/2026 - SFM/Bashas" */
export function sharePointClientPath(s: SharePointSettings, p: SharePointClientPlace): string {
  return `${sharePointEntityPath(s, p.year, p.entity)}/${sharePointSafeName(p.client)}`;
}

/** "WO#345437406, Phoenix, AZ" — a missing city or state is dropped, not left blank. */
export function sharePointWoFolderName(s: SharePointSettings, p: SharePointWoPlace): string {
  return segment(s.wo_folder, { number: p.number, city: p.city?.trim() || null, state: sharePointStateAbbr(p.state) });
}

/** "General/Work Orders - 2026/2026 - SFM/Bashas/WO#345437406, Phoenix, AZ" */
export function sharePointWoPath(s: SharePointSettings, p: SharePointWoPlace): string {
  return `${sharePointClientPath(s, p)}/${sharePointWoFolderName(s, p)}`;
}

/** The year a work order is filed under: when it was received, else when it was created. */
export function sharePointYearOf(dateReceived: string | null | undefined, createdAt: string | null | undefined, now = new Date()): number {
  for (const v of [dateReceived, createdAt]) {
    if (!v) continue;
    const y = Number(String(v).slice(0, 4));
    if (Number.isFinite(y) && y >= 2000 && y <= 2100) return y;
  }
  return now.getUTCFullYear();
}

// ── Rows the API hands the browser ──────────────────────────────────────────

export type SharePointFolderKind = 'client' | 'work_order';
export type SharePointFolderStatus = 'pending' | 'created' | 'failed' | 'skipped';
export type SharePointFileStatus = 'pending' | 'copied' | 'failed' | 'skipped';

export interface SharePointFolderRef {
  id: string;
  kind: SharePointFolderKind;
  entity_id: string;
  entity_name: string;
  path: string;
  web_url: string | null;
  status: SharePointFolderStatus;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface SharePointConnection {
  /** SHAREPOINT_* (or the mail / sign-in registration) credentials are set. */
  credentials: boolean;
  /** A site URL is on file. */
  site: boolean;
  /** Both, so folders can be made. */
  ready: boolean;
}

export interface SharePointOverview {
  settings: SharePointSettings;
  connection: SharePointConnection;
  counts: Record<SharePointFolderKind, Record<SharePointFolderStatus, number>>;
  files: Record<SharePointFileStatus, number>;
  recent_failures: SharePointFolderRef[];
  can_edit: boolean;
}

/** What "Test connection" answers. */
export interface SharePointTestResult {
  ok: boolean;
  site_name?: string;
  library_name?: string;
  root_web_url?: string;
  error?: string;
}

/** The one-line reading of a folder row for a chip or a table cell. */
export function describeSharePointStatus(f: Pick<SharePointFolderRef, 'status' | 'error' | 'attempts'>): string {
  switch (f.status) {
    case 'created':
      return 'In SharePoint';
    case 'pending':
      return f.attempts > 0 ? 'Retrying…' : 'Folder pending';
    case 'failed':
      return `Folder failed${f.error ? ` — ${f.error}` : ''}`;
    case 'skipped':
      return `Not filed${f.error ? ` — ${f.error}` : ''}`;
  }
}
