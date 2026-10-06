// 0071 · SharePoint folders — the database half.
//
// One folder per client and per work order in the team's library, and the
// approved files of a work order copied into its folder:
//
//   General / Work Orders - 2026 / 2026 - SFM / Bashas / WO#345437406, Phoenix, AZ
//
// How it runs:
//   - Each kind of filing is a switch in Admin › Settings (client_folders,
//     wo_folders, copy_files), off until an admin turns it on. A switch
//     stamps when it was turned on; only records created after that are
//     filed, so switching on never backfills by surprise.
//   - The creating code (Add work order, intake, planned maintenance, the
//     import; Add client; approving a file) calls `fileWorkOrder` /
//     `fileClient` / `fileAttachment` AFTER its commit. Each is bounded and
//     never throws: a failure is written on the row, and the hourly sweep
//     (`sweepSharePoint`, on the client-updates cron) retries it, up to
//     MAX_ATTEMPTS. The sweep also files anything created by a path that
//     does not call us (the Ecotrak sync, which this module must not touch).
//   - A work-order folder needs its client folder. The client is matched by
//     name against Clients; an unknown name fails with a clear reason rather
//     than spawning a near-duplicate tree beside the real one (the lesson
//     the Ecotrak sync learned).
//   - Nothing here deletes or renames in SharePoint. A deleted work order
//     keeps its folder; a renamed client keeps its old folder.
//
// The paths are pure (packages/shared/src/sharepoint.ts); the Graph calls are
// lib/graphDrive.ts.

import { get as blobGet } from '@vercel/blob';
import {
  SHAREPOINT_DEFAULTS,
  cleanSharePointSettings,
  sharePointClientPath,
  sharePointWoNumber,
  sharePointWoPath,
  sharePointYearOf,
  type SharePointConnection,
  type SharePointFileStatus,
  type SharePointFolderKind,
  type SharePointFolderRef,
  type SharePointFolderStatus,
  type SharePointOverview,
  type SharePointSettings,
  type SharePointTestResult,
} from '@theone/shared';
import { query } from '../db.js';
import { ApiError, conflict } from '../errors.js';
import { ensureFolderPath, forgetDrives, getItemByPath, graphConfigured, resolveDrive, uploadFile } from '../lib/graphDrive.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { integrationOn } from './integrations.js';
import { allowFor, requirePerm } from './permissions.js';

const MAX_ATTEMPTS = 6;
/** How many rows one sweep may touch — the cron tick must stay short. */
const SWEEP_BATCH = 40;

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getSharePointSettings(): Promise<SharePointSettings> {
  const res = await query<{ value: unknown }>(`SELECT value FROM sharepoint_setting WHERE key = 'config'`);
  return res.rows[0] ? cleanSharePointSettings(res.rows[0].value) : { ...SHAREPOINT_DEFAULTS };
}

/** A partial save: what is posted is laid over what is stored, then made whole. */
export async function saveSharePointSettings(input: unknown, actor: ActingPrincipal): Promise<SharePointSettings> {
  requirePerm(actor, 'admin/settings', 'edit', 'You cannot change the SharePoint settings');
  const before = await getSharePointSettings();
  const next = cleanSharePointSettings({ ...before, ...(input && typeof input === 'object' ? input : {}) });
  if (JSON.stringify(before) === JSON.stringify(next)) return before;
  await query(
    `INSERT INTO sharepoint_setting (key, value, updated_by) VALUES ('config', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(next), actor.id],
  );
  // A changed site or library must not be answered from the old cache.
  if (before.site_url !== next.site_url || before.library !== next.library) forgetDrives();
  await logAdminEvent({
    actorId: actor.id,
    entity: 'sharepoint_setting',
    entityId: 'config',
    action: 'sharepoint_settings_updated',
    before: { name: 'SharePoint folders', ...before },
    after: { name: 'SharePoint folders', ...next },
  });
  return next;
}

export function connectionOf(s: SharePointSettings): SharePointConnection {
  const credentials = graphConfigured();
  const site = s.site_url !== null;
  return { credentials, site, ready: credentials && site };
}

/** "Test connection": the site, the library, and the year root readable. */
export async function testSharePoint(actor: ActingPrincipal): Promise<SharePointTestResult> {
  requirePerm(actor, 'admin/settings', 'view', 'Admin › settings is not available to you');
  const s = await getSharePointSettings();
  if (!graphConfigured()) return { ok: false, error: 'No credentials: set SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID and SHAREPOINT_CLIENT_SECRET on the server.' };
  if (!s.site_url) return { ok: false, error: 'No site URL on file yet.' };
  try {
    forgetDrives();
    const d = await resolveDrive(s.site_url, s.library);
    const root = await getItemByPath(d.driveId, '');
    return { ok: true, site_name: d.siteName, library_name: d.driveName, root_web_url: root?.webUrl ?? d.driveWebUrl };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────

interface FolderRow {
  id: string;
  kind: SharePointFolderKind;
  entity_id: string;
  entity_name: string;
  path: string;
  item_id: string | null;
  web_url: string | null;
  status: SharePointFolderStatus;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

const FOLDER_SELECT = `SELECT id::text AS id, kind, entity_id, entity_name, path, item_id, web_url, status, error, attempts,
                              created_at::text AS created_at, updated_at::text AS updated_at
                         FROM sharepoint_folder`;

function mapFolder(r: FolderRow): SharePointFolderRef {
  return {
    id: r.id,
    kind: r.kind,
    entity_id: r.entity_id,
    entity_name: r.entity_name,
    path: r.path,
    web_url: r.web_url,
    status: r.status,
    error: r.error,
    attempts: Number(r.attempts),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function folderFor(kind: SharePointFolderKind, entityId: string): Promise<FolderRow | null> {
  const res = await query<FolderRow>(`${FOLDER_SELECT} WHERE kind = $1 AND entity_id = $2`, [kind, entityId]);
  return res.rows[0] ?? null;
}

/** A pending row for the record, made or re-armed; returns it. */
async function armFolder(kind: SharePointFolderKind, entityId: string, entityName: string, path: string): Promise<FolderRow> {
  const res = await query<FolderRow>(
    `INSERT INTO sharepoint_folder (kind, entity_id, entity_name, path, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (kind, entity_id) DO UPDATE
       SET entity_name = EXCLUDED.entity_name,
           path = CASE WHEN sharepoint_folder.status = 'created' THEN sharepoint_folder.path ELSE EXCLUDED.path END,
           status = CASE WHEN sharepoint_folder.status = 'created' THEN 'created' ELSE 'pending' END,
           error = CASE WHEN sharepoint_folder.status = 'created' THEN sharepoint_folder.error ELSE NULL END
     RETURNING id::text AS id, kind, entity_id, entity_name, path, item_id, web_url, status, error, attempts,
               created_at::text AS created_at, updated_at::text AS updated_at`,
    [kind, entityId, entityName, path],
  );
  return res.rows[0];
}

async function markFolder(id: string, patch: { status: SharePointFolderStatus; error?: string | null; item_id?: string | null; web_url?: string | null; bump?: boolean }): Promise<void> {
  await query(
    `UPDATE sharepoint_folder
        SET status = $2,
            error = $3,
            item_id = COALESCE($4, item_id),
            web_url = COALESCE($5, web_url),
            attempts = attempts + $6
      WHERE id = $1`,
    [id, patch.status, patch.error ?? null, patch.item_id ?? null, patch.web_url ?? null, patch.bump ? 1 : 0],
  );
}

// ── Where a record goes ──────────────────────────────────────────────────────

interface TaskPlace {
  id: string;
  wo_number: string;
  ext_name: string | null;
  client: string | null;
  city: string | null;
  state: string | null;
  billing_entity: string | null;
  date_received: string | null;
  created_at: string;
  deleted_at: string | null;
  fm: string | null;
}

async function loadTask(taskId: string): Promise<TaskPlace | null> {
  const res = await query<TaskPlace>(
    `SELECT id::text AS id, wo_number, ext_name, client, city, state, billing_entity,
            date_received::text AS date_received, created_at::text AS created_at, deleted_at::text AS deleted_at,
            NULLIF(btrim(fields->>'22. FM'), '') AS fm
       FROM task WHERE id = $1::uuid`,
    [taskId],
  );
  return res.rows[0] ?? null;
}

interface ClientPlace {
  id: string;
  name: string;
  billing_entity: string | null;
}

/** The client on file whose name matches, spelled as the record spells it. */
async function clientByName(name: string): Promise<ClientPlace | null> {
  const res = await query<ClientPlace>(
    `SELECT id::text AS id, name, billing_entity FROM client
      WHERE deleted_at IS NULL AND lower(btrim(name)) = lower(btrim($1)) LIMIT 1`,
    [name],
  );
  return res.rows[0] ?? null;
}

async function loadClient(clientId: string): Promise<ClientPlace | null> {
  const res = await query<ClientPlace>(`SELECT id::text AS id, name, billing_entity FROM client WHERE id = $1::uuid AND deleted_at IS NULL`, [clientId]);
  return res.rows[0] ?? null;
}

type Plan = { ok: true; path: string; clientPath: string; name: string } | { ok: false; why: string; skip: boolean; name: string };

/** Where a work order's folder goes, or why it cannot go anywhere. */
async function planTask(s: SharePointSettings, t: TaskPlace): Promise<Plan> {
  const name = t.wo_number;
  const entity = (t.billing_entity ?? '').trim();
  if (entity === '') return { ok: false, why: 'The work order has no billing entity (21. Comp)', skip: false, name };
  const clientName = (t.client ?? t.fm ?? '').trim();
  if (clientName === '') return { ok: false, why: 'The work order has no client', skip: false, name };
  const client = await clientByName(clientName);
  if (!client) return { ok: false, why: `No client named "${clientName}" is on file — add it under Clients`, skip: false, name };
  const year = sharePointYearOf(t.date_received, t.created_at);
  const place = { year, entity, client: client.name };
  return {
    ok: true,
    name,
    clientPath: sharePointClientPath(s, place),
    path: sharePointWoPath(s, { ...place, number: sharePointWoNumber(t.wo_number, t.ext_name), city: t.city, state: t.state }),
  };
}

function planClient(s: SharePointSettings, c: ClientPlace, now = new Date()): Plan {
  const entity = (c.billing_entity ?? '').trim();
  if (entity === '') return { ok: false, why: 'The client has no billing entity — set one on its record', skip: true, name: c.name };
  const path = sharePointClientPath(s, { year: now.getUTCFullYear(), entity, client: c.name });
  return { ok: true, name: c.name, path, clientPath: path };
}

// ── Making folders ───────────────────────────────────────────────────────────

async function driveFor(s: SharePointSettings): Promise<{ driveId: string }> {
  if (!graphConfigured()) throw new Error('SharePoint credentials are not set on the server');
  if (!s.site_url) throw new Error('No SharePoint site URL is on file');
  const d = await resolveDrive(s.site_url, s.library);
  return { driveId: d.driveId };
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 500 ? `${m.slice(0, 497)}…` : m;
}

/** One attempt at a folder row: make the path, record the outcome. */
async function attemptFolder(s: SharePointSettings, row: FolderRow, actorId: string | null): Promise<SharePointFolderRef> {
  try {
    const { driveId } = await driveFor(s);
    const item = await ensureFolderPath(driveId, row.path);
    await markFolder(row.id, { status: 'created', error: null, item_id: item.id, web_url: item.webUrl, bump: true });
    await query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, $2, $3, 'sharepoint_folder_created', 'sharepoint:folder', NULL, $4::jsonb)`,
      [
        actorId,
        row.kind === 'work_order' ? 'task' : 'client',
        row.entity_id,
        JSON.stringify({ name: row.entity_name, path: row.path, web_url: item.webUrl, kind: row.kind }),
      ],
    );
  } catch (e) {
    await markFolder(row.id, { status: 'failed', error: errText(e), bump: true });
  }
  const after = await query<FolderRow>(`${FOLDER_SELECT} WHERE id = $1`, [row.id]);
  return mapFolder(after.rows[0]);
}

/**
 * File a work order: its folder (and its client's, which the path includes).
 * Called after the creating transaction commits; never throws. `force` files
 * it even while the switch is off (the "Create folder now" button).
 */
export async function fileWorkOrder(taskId: string, actorId: string | null, force = false): Promise<SharePointFolderRef | null> {
  try {
    if (!integrationOn('sharepoint')) return null; // 0074 · Admin › Integrations
    const s = await getSharePointSettings();
    if (!force && !s.wo_folders) return null;
    const t = await loadTask(taskId);
    if (!t) return null;
    const plan = await planTask(s, t);
    if (!plan.ok) {
      const row = await armFolder('work_order', t.id, t.wo_number, '');
      if (row.status === 'created') return mapFolder(row);
      await markFolder(row.id, { status: plan.skip ? 'skipped' : 'failed', error: plan.why, bump: true });
      return mapFolder({ ...row, status: plan.skip ? 'skipped' : 'failed', error: plan.why, attempts: row.attempts + 1 });
    }
    const row = await armFolder('work_order', t.id, t.wo_number, plan.path);
    if (row.status === 'created') return mapFolder(row);
    return await attemptFolder(s, row, actorId);
  } catch (e) {
    console.error('[sharepoint] fileWorkOrder failed', taskId, e);
    return null;
  }
}

/** File a client: its folder under its billing entity. Never throws. */
export async function fileClient(clientId: string, actorId: string | null, force = false): Promise<SharePointFolderRef | null> {
  try {
    const s = await getSharePointSettings();
    if (!force && !s.client_folders) return null;
    const c = await loadClient(clientId);
    if (!c) return null;
    const plan = planClient(s, c);
    if (!plan.ok) {
      const row = await armFolder('client', c.id, c.name, '');
      if (row.status === 'created') return mapFolder(row);
      await markFolder(row.id, { status: plan.skip ? 'skipped' : 'failed', error: plan.why, bump: true });
      return mapFolder({ ...row, status: plan.skip ? 'skipped' : 'failed', error: plan.why, attempts: row.attempts + 1 });
    }
    const row = await armFolder('client', c.id, c.name, plan.path);
    if (row.status === 'created') return mapFolder(row);
    return await attemptFolder(s, row, actorId);
  } catch (e) {
    console.error('[sharepoint] fileClient failed', clientId, e);
    return null;
  }
}

// ── Files ────────────────────────────────────────────────────────────────────

interface FileRow {
  attachment_id: string;
  task_id: string;
  file_name: string;
  status: SharePointFileStatus;
  error: string | null;
  attempts: number;
}

interface AttachmentBytes {
  id: string;
  task_id: string;
  file_name: string;
  storage_key: string | null;
  content_type: string | null;
  review_status: string;
}

async function readBlob(storageKey: string): Promise<Buffer> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('File storage is not connected (BLOB_READ_WRITE_TOKEN)');
  const blob = await blobGet(storageKey, { access: 'private', token });
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw new Error('The file is no longer in storage');
  const chunks: Buffer[] = [];
  const reader = blob.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Copy one approved attachment into its work order's folder (making the
 * folder first when it is not there yet). Called after the approval is
 * written; never throws.
 */
export async function fileAttachment(attachmentId: string, actorId: string | null, force = false): Promise<void> {
  try {
    if (!integrationOn('sharepoint')) return; // 0074 · Admin › Integrations
    const s = await getSharePointSettings();
    if (!force && !s.copy_files) return;
    const a = (
      await query<AttachmentBytes>(
        `SELECT id::text AS id, task_id::text AS task_id, file_name, storage_key, content_type, review_status
           FROM attachment WHERE id = $1::uuid`,
        [attachmentId],
      )
    ).rows[0];
    if (!a || !a.task_id) return;
    if (a.review_status !== 'approved') return;
    const row = (
      await query<FileRow>(
        `INSERT INTO sharepoint_file (attachment_id, task_id, file_name, status)
         VALUES ($1::uuid, $2::uuid, $3, 'pending')
         ON CONFLICT (attachment_id) DO UPDATE
           SET file_name = EXCLUDED.file_name,
               status = CASE WHEN sharepoint_file.status = 'copied' THEN 'copied' ELSE 'pending' END
         RETURNING attachment_id::text AS attachment_id, task_id::text AS task_id, file_name, status, error, attempts`,
        [a.id, a.task_id, a.file_name],
      )
    ).rows[0];
    if (row.status === 'copied') return;
    await attemptFile(s, row, a, actorId);
  } catch (e) {
    console.error('[sharepoint] fileAttachment failed', attachmentId, e);
  }
}

async function attemptFile(s: SharePointSettings, row: FileRow, a: AttachmentBytes, actorId: string | null): Promise<void> {
  const mark = async (status: SharePointFileStatus, error: string | null, extra?: { path: string; item_id: string; web_url: string }) => {
    await query(
      `UPDATE sharepoint_file
          SET status = $2, error = $3, path = COALESCE($4, path), item_id = COALESCE($5, item_id), web_url = COALESCE($6, web_url),
              attempts = attempts + 1
        WHERE attachment_id = $1::uuid`,
      [row.attachment_id, status, error, extra?.path ?? null, extra?.item_id ?? null, extra?.web_url ?? null],
    );
  };
  try {
    if (!a.storage_key) {
      await mark('skipped', 'The row has no file behind it');
      return;
    }
    // The folder first — forced, because a file with nowhere to go is the
    // same failure whichever switch is off.
    let folder = await folderFor('work_order', a.task_id);
    if (!folder || folder.status !== 'created') {
      const made = await fileWorkOrder(a.task_id, actorId, true);
      if (!made || made.status !== 'created') {
        await mark('failed', made?.error ? `Folder: ${made.error}` : 'The work-order folder could not be made');
        return;
      }
      folder = await folderFor('work_order', a.task_id);
    }
    if (!folder) throw new Error('The work-order folder row vanished');
    const { driveId } = await driveFor(s);
    const bytes = await readBlob(a.storage_key);
    const item = await uploadFile(driveId, folder.path, a.file_name, bytes, a.content_type ?? 'application/octet-stream');
    await mark('copied', null, { path: `${folder.path}/${item.name}`, item_id: item.id, web_url: item.webUrl });
    await query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'sharepoint_file_copied', $3, NULL, $4::jsonb)`,
      [actorId, a.task_id, `attachment:${a.id}`, JSON.stringify({ file_name: item.name, path: `${folder.path}/${item.name}`, web_url: item.webUrl })],
    );
  } catch (e) {
    await mark('failed', errText(e));
  }
}

// ── The sweep ────────────────────────────────────────────────────────────────

export interface SweepResult {
  folders_tried: number;
  folders_created: number;
  files_tried: number;
  files_copied: number;
  skipped: 'off' | 'not_ready' | null;
}

/**
 * The hourly tick (and the "Run now" button): retry what failed, and file
 * what the switches cover but nothing has filed yet. Bounded per run.
 */
export async function sweepSharePoint(actorId: string | null = null): Promise<SweepResult> {
  const out: SweepResult = { folders_tried: 0, folders_created: 0, files_tried: 0, files_copied: 0, skipped: null };
  const s = await getSharePointSettings();
  // 0074 · the master switch in Admin › Integrations outranks the three here.
  if (!integrationOn('sharepoint') || (!s.client_folders && !s.wo_folders && !s.copy_files)) {
    out.skipped = 'off';
    return out;
  }
  if (!connectionOf(s).ready) {
    out.skipped = 'not_ready';
    return out;
  }

  // 1. Records the switches cover that have no row yet.
  if (s.client_folders && s.client_folders_since) {
    const fresh = await query<{ id: string }>(
      `SELECT c.id::text AS id FROM client c
        WHERE c.deleted_at IS NULL AND c.created_at >= $1::timestamptz
          AND NOT EXISTS (SELECT 1 FROM sharepoint_folder f WHERE f.kind = 'client' AND f.entity_id = c.id::text)
        ORDER BY c.created_at LIMIT $2`,
      [s.client_folders_since, SWEEP_BATCH],
    );
    for (const r of fresh.rows) {
      out.folders_tried++;
      const made = await fileClient(r.id, actorId);
      if (made?.status === 'created') out.folders_created++;
    }
  }
  if (s.wo_folders && s.wo_folders_since) {
    const fresh = await query<{ id: string }>(
      `SELECT t.id::text AS id FROM task t
        WHERE t.deleted_at IS NULL AND t.created_at >= $1::timestamptz
          AND NOT EXISTS (SELECT 1 FROM sharepoint_folder f WHERE f.kind = 'work_order' AND f.entity_id = t.id::text)
        ORDER BY t.created_at LIMIT $2`,
      [s.wo_folders_since, SWEEP_BATCH],
    );
    for (const r of fresh.rows) {
      out.folders_tried++;
      const made = await fileWorkOrder(r.id, actorId);
      if (made?.status === 'created') out.folders_created++;
    }
  }

  // 2. Rows that failed last time, oldest first, while attempts remain.
  const retry = await query<FolderRow>(
    `${FOLDER_SELECT} WHERE status IN ('pending', 'failed') AND attempts < $1 AND path <> ''
      ORDER BY updated_at LIMIT $2`,
    [MAX_ATTEMPTS, SWEEP_BATCH],
  );
  for (const row of retry.rows) {
    if (row.kind === 'work_order' && !s.wo_folders) continue;
    if (row.kind === 'client' && !s.client_folders) continue;
    out.folders_tried++;
    const made = row.kind === 'work_order' ? await fileWorkOrder(row.entity_id, actorId) : await fileClient(row.entity_id, actorId);
    if (made?.status === 'created') out.folders_created++;
  }
  // A row that failed on its plan (no client on file…) has an empty path:
  // re-plan it, since the client may have been added since.
  const replan = await query<FolderRow>(
    `${FOLDER_SELECT} WHERE status = 'failed' AND attempts < $1 AND path = '' ORDER BY updated_at LIMIT $2`,
    [MAX_ATTEMPTS, SWEEP_BATCH],
  );
  for (const row of replan.rows) {
    if (row.kind === 'work_order' && !s.wo_folders) continue;
    if (row.kind === 'client' && !s.client_folders) continue;
    out.folders_tried++;
    const made = row.kind === 'work_order' ? await fileWorkOrder(row.entity_id, actorId) : await fileClient(row.entity_id, actorId);
    if (made?.status === 'created') out.folders_created++;
  }

  // 3. Files: approved since the switch went on and never copied, then the
  //    failed ones.
  if (s.copy_files && s.copy_files_since) {
    const fresh = await query<{ id: string }>(
      `SELECT a.id::text AS id FROM attachment a
        WHERE a.task_id IS NOT NULL AND a.review_status = 'approved' AND a.storage_key IS NOT NULL
          AND COALESCE(a.reviewed_at, a.created_at) >= $1::timestamptz
          AND NOT EXISTS (SELECT 1 FROM sharepoint_file f WHERE f.attachment_id = a.id)
        ORDER BY a.created_at LIMIT $2`,
      [s.copy_files_since, SWEEP_BATCH],
    );
    const failed = await query<{ id: string }>(
      `SELECT attachment_id::text AS id FROM sharepoint_file
        WHERE status IN ('pending', 'failed') AND attempts < $1 ORDER BY updated_at LIMIT $2`,
      [MAX_ATTEMPTS, SWEEP_BATCH],
    );
    for (const r of [...fresh.rows, ...failed.rows]) {
      out.files_tried++;
      await fileAttachment(r.id, actorId);
    }
    if (out.files_tried > 0) {
      const copied = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM sharepoint_file WHERE status = 'copied' AND updated_at >= now() - interval '10 minutes'`,
      );
      out.files_copied = copied.rows[0]?.n ?? 0;
    }
  }
  return out;
}

/** "Retry failed": give every failed row its attempts back, then sweep. */
export async function retrySharePoint(actor: ActingPrincipal): Promise<SweepResult> {
  requirePerm(actor, 'admin/settings', 'edit', 'You cannot run the SharePoint filing');
  await query(`UPDATE sharepoint_folder SET attempts = 0, status = 'pending' WHERE status = 'failed'`);
  await query(`UPDATE sharepoint_file SET attempts = 0, status = 'pending' WHERE status = 'failed'`);
  return sweepSharePoint(actor.id);
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function sharePointOverview(actor: ActingPrincipal): Promise<SharePointOverview> {
  requirePerm(actor, 'admin/settings', 'view', 'Admin › settings is not available to you');
  const settings = await getSharePointSettings();
  const counts: SharePointOverview['counts'] = {
    client: { pending: 0, created: 0, failed: 0, skipped: 0 },
    work_order: { pending: 0, created: 0, failed: 0, skipped: 0 },
  };
  const c = await query<{ kind: SharePointFolderKind; status: SharePointFolderStatus; n: number }>(
    `SELECT kind, status, count(*)::int AS n FROM sharepoint_folder GROUP BY kind, status`,
  );
  for (const r of c.rows) counts[r.kind][r.status] = Number(r.n);
  const files: SharePointOverview['files'] = { pending: 0, copied: 0, failed: 0, skipped: 0 };
  const f = await query<{ status: SharePointFileStatus; n: number }>(`SELECT status, count(*)::int AS n FROM sharepoint_file GROUP BY status`);
  for (const r of f.rows) files[r.status] = Number(r.n);
  const recent = await query<FolderRow>(`${FOLDER_SELECT} WHERE status IN ('failed', 'skipped') ORDER BY updated_at DESC LIMIT 12`);
  return {
    settings,
    connection: connectionOf(settings),
    counts,
    files,
    recent_failures: recent.rows.map(mapFolder),
    can_edit: allowFor(actor)('admin/settings', 'edit'),
  };
}

/** The folder of one work order, for the header chip. Null = never filed. */
export async function workOrderFolder(taskId: string): Promise<SharePointFolderRef | null> {
  const row = await folderFor('work_order', taskId);
  return row ? mapFolder(row) : null;
}

export async function clientFolder(clientId: string): Promise<SharePointFolderRef | null> {
  const row = await folderFor('client', clientId);
  return row ? mapFolder(row) : null;
}

/** The "Create folder now" button on a work order: files it whatever the switch says. */
export async function fileWorkOrderNow(taskId: string, actor: ActingPrincipal): Promise<SharePointFolderRef> {
  requirePerm(actor, 'work_orders/attachments', 'create', 'You cannot file this work order');
  const s = await getSharePointSettings();
  if (!connectionOf(s).ready) {
    throw conflict('SharePoint is not connected yet — an admin sets the site and credentials under Admin › Settings', {
      code: 'SHAREPOINT_NOT_READY',
    });
  }
  const made = await fileWorkOrder(taskId, actor.id, true);
  if (!made) throw new ApiError('NOT_FOUND', 'Work order not found');
  return made;
}

/** The same for a client, from its record. */
export async function fileClientNow(clientId: string, actor: ActingPrincipal): Promise<SharePointFolderRef> {
  requirePerm(actor, 'clients', 'edit', 'You cannot file this client');
  const s = await getSharePointSettings();
  if (!connectionOf(s).ready) {
    throw conflict('SharePoint is not connected yet — an admin sets the site and credentials under Admin › Settings', {
      code: 'SHAREPOINT_NOT_READY',
    });
  }
  const made = await fileClient(clientId, actor.id, true);
  if (!made) throw new ApiError('NOT_FOUND', 'Client not found');
  return made;
}
