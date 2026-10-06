// 0071 · Microsoft Graph, the drive half: the few calls that make folders and
// put files in a SharePoint document library. App-only (client credentials),
// like the mailer; nothing here knows about work orders or clients — it is
// given a path and makes it exist.
//
// Every call is bounded (GRAPH_TIMEOUT_MS) so a dead tenant cannot hang the
// request that creates a work order; the caller records the failure and the
// hourly sweep tries again. The drive id is resolved once per process and
// cached, because it never changes for a given site + library.

import { config } from '../config.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_TIMEOUT_MS = 20_000;
/** Graph's simple PUT takes up to 4 MB; anything near it goes by session. */
const SIMPLE_UPLOAD_MAX = 3_900_000;

export class GraphNotConfiguredError extends Error {
  constructor() {
    super('SharePoint credentials are not set (SHAREPOINT_TENANT_ID / _CLIENT_ID / _CLIENT_SECRET)');
    this.name = 'GraphNotConfiguredError';
  }
}

export function graphConfigured(): boolean {
  return config.sharepoint !== null;
}

function firstLine(s: string | undefined): string | undefined {
  return s?.split(/\r?\n/)[0]?.trim() || undefined;
}

// ── Token ────────────────────────────────────────────────────────────────────

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const g = config.sharepoint;
  if (!g) throw new GraphNotConfiguredError();
  const body = new URLSearchParams({
    client_id: g.clientId,
    client_secret: g.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(g.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Microsoft sign-in for SharePoint failed: ${firstLine(json.error_description) ?? `HTTP ${res.status}`}`);
  }
  token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3000) * 1000 };
  return token.value;
}

// ── Calls ────────────────────────────────────────────────────────────────────

interface GraphError {
  error?: { code?: string; message?: string };
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: T & GraphError }> {
  const t = await accessToken();
  const isBuffer = Buffer.isBuffer(body);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      ...(body !== undefined && !isBuffer ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isBuffer ? (body as Buffer) : JSON.stringify(body),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as T & GraphError;
  return { status: res.status, json };
}

function fail(what: string, status: number, json: GraphError): Error {
  const code = json.error?.code;
  const msg = firstLine(json.error?.message) ?? `HTTP ${status}`;
  if (status === 401) return new Error(`${what}: Microsoft refused the credentials (${msg})`);
  if (status === 403) {
    return new Error(
      `${what}: the app registration has no access to this site (${msg}). Grant it Sites.Selected on the site, or Files.ReadWrite.All.`,
    );
  }
  if (status === 404) return new Error(`${what}: not found (${msg})`);
  return new Error(`${what}: ${code ? `${code} — ` : ''}${msg}`);
}

/** Per-segment encoding: "#" in "WO#123" and "&" in names break path
    addressing unless encoded, but "/" must survive as the separator. */
export function encodeGraphPath(path: string): string {
  return path
    .split('/')
    .filter((p) => p !== '')
    .map((p) => encodeURIComponent(p))
    .join('/');
}

export interface DriveItem {
  id: string;
  name: string;
  webUrl: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
}

export interface ResolvedDrive {
  siteId: string;
  siteName: string;
  driveId: string;
  driveName: string;
  driveWebUrl: string;
}

const drives = new Map<string, ResolvedDrive>();

/** The site behind a URL like https://x.sharepoint.com/sites/SFM, and the
    library in it by display name ("Documents" is the default library, whose
    URL name is "Shared Documents" — both spellings match). */
export async function resolveDrive(siteUrl: string, library: string): Promise<ResolvedDrive> {
  const key = `${siteUrl}|${library.toLowerCase()}`;
  const hit = drives.get(key);
  if (hit) return hit;

  let host: string;
  let path: string;
  try {
    const u = new URL(siteUrl);
    host = u.hostname;
    path = u.pathname.replace(/\/+$/, '');
  } catch {
    throw new Error(`"${siteUrl}" is not a site URL`);
  }
  // /sites/{hostname}:/{server-relative-path} — or the root site of the tenant.
  const siteRes = await call<{ id: string; displayName?: string; name?: string }>(
    'GET',
    path === '' ? `${GRAPH}/sites/${encodeURIComponent(host)}` : `${GRAPH}/sites/${encodeURIComponent(host)}:/${encodeGraphPath(path)}`,
  );
  if (siteRes.status !== 200) throw fail('Finding the site', siteRes.status, siteRes.json);
  const siteId = siteRes.json.id;
  const siteName = siteRes.json.displayName ?? siteRes.json.name ?? host;

  const drRes = await call<{ value: { id: string; name: string; webUrl: string; driveType?: string }[] }>(
    'GET',
    `${GRAPH}/sites/${encodeURIComponent(siteId)}/drives?$select=id,name,webUrl,driveType`,
  );
  if (drRes.status !== 200) throw fail('Listing the libraries', drRes.status, drRes.json);
  const want = library.trim().toLowerCase();
  const alt = want === 'documents' ? 'shared documents' : want === 'shared documents' ? 'documents' : null;
  const list = drRes.json.value ?? [];
  const drive =
    list.find((d) => d.name.toLowerCase() === want) ??
    (alt ? list.find((d) => d.name.toLowerCase() === alt) : undefined) ??
    list.find((d) => decodeURIComponent(d.webUrl).toLowerCase().endsWith(`/${want}`));
  if (!drive) {
    throw new Error(`The site has no library called "${library}" (it has: ${list.map((d) => d.name).join(', ') || 'none'})`);
  }
  const out: ResolvedDrive = { siteId, siteName, driveId: drive.id, driveName: drive.name, driveWebUrl: drive.webUrl };
  drives.set(key, out);
  return out;
}

/** The item at a library-relative path, or null when nothing is there. */
export async function getItemByPath(driveId: string, path: string): Promise<DriveItem | null> {
  const enc = encodeGraphPath(path);
  const url = enc === '' ? `${GRAPH}/drives/${driveId}/root` : `${GRAPH}/drives/${driveId}/root:/${enc}`;
  const res = await call<DriveItem>('GET', `${url}?$select=id,name,webUrl,folder,file`);
  if (res.status === 404) return null;
  if (res.status !== 200) throw fail(`Looking up "${path}"`, res.status, res.json);
  return res.json;
}

/** One folder under a parent path (the library root when the parent is ""),
    returned whether it was just made or was already there. */
async function createFolder(driveId: string, parentPath: string, name: string): Promise<DriveItem> {
  const enc = encodeGraphPath(parentPath);
  const url = enc === '' ? `${GRAPH}/drives/${driveId}/root/children` : `${GRAPH}/drives/${driveId}/root:/${enc}:/children`;
  const res = await call<DriveItem>('POST', url, {
    name,
    folder: {},
    '@microsoft.graph.conflictBehavior': 'fail',
  });
  if (res.status === 201 || res.status === 200) return res.json;
  if (res.status === 409) {
    // Made by someone else between our look-up and our create: use theirs.
    const existing = await getItemByPath(driveId, parentPath === '' ? name : `${parentPath}/${name}`);
    if (existing) return existing;
  }
  throw fail(`Creating the folder "${name}" in "${parentPath || '/'}"`, res.status, res.json);
}

/**
 * Make every segment of a path exist, in order, and return the last one.
 * Existing folders are left exactly as they are (a folder is matched by its
 * name, which SharePoint compares without regard to case).
 */
export async function ensureFolderPath(driveId: string, path: string): Promise<DriveItem> {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0) {
    const root = await getItemByPath(driveId, '');
    if (!root) throw new Error('The library root could not be read');
    return root;
  }
  // The whole path first — the common case after the first work order of
  // the year — then segment by segment from the top.
  const whole = await getItemByPath(driveId, parts.join('/'));
  if (whole) return whole;
  let parent = '';
  let item: DriveItem | null = null;
  for (const name of parts) {
    const here = parent === '' ? name : `${parent}/${name}`;
    item = await getItemByPath(driveId, here);
    if (!item) item = await createFolder(driveId, parent, name);
    else if (!item.folder) throw new Error(`"${here}" exists in SharePoint but is a file, not a folder`);
    parent = here;
  }
  return item as DriveItem;
}

/**
 * Put a file in a folder. A name clash gets SharePoint's own " 1" suffix
 * (conflictBehavior=rename) rather than overwriting what a person put there.
 */
export async function uploadFile(
  driveId: string,
  folderPath: string,
  fileName: string,
  bytes: Buffer,
  contentType: string,
): Promise<DriveItem> {
  const target = `${encodeGraphPath(folderPath)}/${encodeURIComponent(fileName)}`;
  if (bytes.length <= SIMPLE_UPLOAD_MAX) {
    const res = await call<DriveItem>(
      'PUT',
      `${GRAPH}/drives/${driveId}/root:/${target}:/content?@microsoft.graph.conflictBehavior=rename`,
      bytes,
      { 'Content-Type': contentType || 'application/octet-stream' },
    );
    if (res.status === 200 || res.status === 201) return res.json;
    throw fail(`Uploading "${fileName}"`, res.status, res.json);
  }
  // Large file: an upload session, sent in one chunk (our files are capped
  // well under Graph's 60 MB single-chunk limit).
  const sess = await call<{ uploadUrl: string }>('POST', `${GRAPH}/drives/${driveId}/root:/${target}:/createUploadSession`, {
    item: { '@microsoft.graph.conflictBehavior': 'rename', name: fileName },
  });
  if (sess.status !== 200 || !sess.json.uploadUrl) throw fail(`Starting the upload of "${fileName}"`, sess.status, sess.json);
  const res = await fetch(sess.json.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(bytes.length),
      'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
    },
    body: bytes,
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS * 3),
  });
  const json = (await res.json().catch(() => ({}))) as DriveItem & GraphError;
  if (res.status === 200 || res.status === 201) return json;
  throw fail(`Uploading "${fileName}"`, res.status, json);
}

/** For tests and the Settings card: forget the cached drive. */
export function forgetDrives(): void {
  drives.clear();
  token = null;
}
