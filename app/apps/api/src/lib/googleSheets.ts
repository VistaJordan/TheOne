// Reading a Google Sheet (the on-call roster, 2026-11-17).
//
// The same Google service account outgoing email uses (GMAIL_SERVICE_ACCOUNT_*,
// lib/gmail.ts) signs a JWT for the read-only Sheets scope — WITHOUT `sub`, so
// it reads as itself: the sheet must be shared with the service account's
// email (Viewer is enough). No domain-wide delegation is needed for that.
// Read only: nothing here writes to a sheet.

import { createSign } from 'node:crypto';
import type { GmailCredentials } from './gmail.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let token: { email: string; value: string; expiresAt: number } | null = null;

async function accessToken(c: GmailCredentials): Promise<string> {
  if (token && token.email === c.clientEmail && token.expiresAt > Date.now() + 60_000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: c.clientEmail, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(c.privateKey))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google refused the service account: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  }
  token = { email: c.clientEmail, value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3000) * 1000 };
  return token.value;
}

async function sheetsGet(c: GmailCredentials, path: string): Promise<unknown> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    headers: { Authorization: `Bearer ${await accessToken(c)}` },
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) {
    const why = json.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 403 || res.status === 404) {
      throw new Error(`The sheet could not be opened (${why}). Share it with ${c.clientEmail} as a Viewer.`);
    }
    throw new Error(`Google Sheets answered: ${why}`);
  }
  return json;
}

/** A tab's name from its gid (the number in a pasted URL), else the first tab's. */
async function tabName(c: GmailCredentials, sheetId: string, gid: string | null): Promise<string | null> {
  const meta = (await sheetsGet(c, `${encodeURIComponent(sheetId)}?fields=sheets.properties(sheetId,title)`)) as {
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  };
  const tabs = meta.sheets ?? [];
  const hit = gid ? tabs.find((t) => String(t.properties?.sheetId) === gid) : null;
  return (hit ?? tabs[0])?.properties?.title ?? null;
}

/** Every row of the tab as the cells' displayed text. */
export async function readSheetRows(
  c: GmailCredentials,
  sheetId: string,
  opts: { tab: string | null; gid: string | null },
): Promise<string[][]> {
  const tab = opts.tab?.trim() || (await tabName(c, sheetId, opts.gid));
  // The whole tab: the Vista calendar runs one column per day, far past Z.
  const range = tab ? `'${tab.replace(/'/g, "''")}'` : 'A1:ZZZ3000';
  const json = (await sheetsGet(
    c,
    `${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
  )) as { values?: unknown[][] };
  return (json.values ?? []).map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))));
}
