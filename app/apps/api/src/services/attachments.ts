// Attachments (0043) — the photos and files on a work order.
//
// Where files live: a PRIVATE Vercel Blob store, addressed by pathname. The
// URL is never stored and never handed out, because a URL outlives the
// permission that produced it. Every read goes back through the API, which
// resolves the work order's scope first (resolveTaskId, 0026) and only then
// streams the bytes — so a photo is exactly as visible as the work order it
// belongs to, and revoking someone's access to the work order revokes the
// photo with it.
//
// Where the token comes from: BLOB_READ_WRITE_TOKEN, which Vercel sets when a
// Blob store is connected to the project. Without it this module is honest
// rather than broken — `storageReady()` is false, the browser is told so, and
// the upload button explains itself instead of failing on click.

import { del, get, put } from '@vercel/blob';
import {
  ATTACHMENT_ALLOWED_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_STORAGE_MISSING,
  type Attachment,
  type AttachmentUpload,
} from '@theone/shared';
import { query } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { requirePerm } from './permissions.js';
import type { ActingPrincipal } from './activity.js';

function token(): string | undefined {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  return t && t.trim() !== '' ? t : undefined;
}

/** False = no store connected; the UI asks for a file only when this is true. */
export function storageReady(): boolean {
  return token() !== undefined;
}

function requireStorage(): string {
  const t = token();
  if (!t) {
    throw new ApiError(
      'CONFLICT',
      'File storage is not connected to this environment yet, so uploads are off',
      { code: ATTACHMENT_STORAGE_MISSING },
    );
  }
  return t;
}

// ── Permissions ──────────────────────────────────────────────────────────────
//
// Seeing a file is seeing the work order; adding one is the same act as
// adding an update, and removing one is an edit. The dedicated path lets an
// admin tighten any of the three without touching the rest.

function requireView(p: ActingPrincipal): void {
  requirePerm(p, 'work_orders', 'view', 'You cannot view work orders');
}

function requireAdd(p: ActingPrincipal): void {
  requireView(p);
  requirePerm(p, 'work_orders/attachments', 'create', 'You cannot add files to work orders');
}

function requireRemove(p: ActingPrincipal): void {
  requireView(p);
  requirePerm(p, 'work_orders/attachments', 'delete', 'You cannot remove files from work orders');
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  task_id: string;
  file_name: string;
  content_type: string | null;
  byte_size: string | number | null;
  client_visible: boolean;
  visit_id: string | null;
  storage_key: string | null;
  uploaded_by_id: string | null;
  uploaded_by_name: string | null;
  created_at: string;
}

const SELECT = `
  SELECT a.id::text AS id,
         a.task_id::text AS task_id,
         a.file_name,
         a.content_type,
         a.byte_size,
         a.client_visible,
         a.visit_id::text AS visit_id,
         a.storage_key,
         a.uploaded_by::text AS uploaded_by_id,
         p.display_name AS uploaded_by_name,
         to_char((a.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
    FROM attachment a
    LEFT JOIN principal p ON p.id = a.uploaded_by`;

function mapRow(r: Row): Attachment {
  return {
    id: r.id,
    task_id: r.task_id,
    file_name: r.file_name,
    content_type: r.content_type,
    byte_size: r.byte_size === null ? null : Number(r.byte_size),
    client_visible: r.client_visible,
    visit_id: r.visit_id,
    uploaded_by: r.uploaded_by_id
      ? { id: r.uploaded_by_id, display_name: r.uploaded_by_name ?? '—' }
      : null,
    created_at: r.created_at,
    // A row from before 0043 has no file behind it: it is metadata only, and
    // the UI must not offer to open it.
    has_file: Boolean(r.storage_key),
  };
}

export async function listAttachments(taskId: string, actor: ActingPrincipal): Promise<Attachment[]> {
  requireView(actor);
  const res = await query<Row>(`${SELECT} WHERE a.task_id = $1 ORDER BY a.created_at DESC`, [taskId]);
  return res.rows.map(mapRow);
}

// ── Writing ──────────────────────────────────────────────────────────────────

/** A name that is safe as part of a storage path and as a download name. */
function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 120) || 'file';
}

export async function addAttachment(
  taskId: string,
  woNumber: string,
  input: AttachmentUpload,
  actor: ActingPrincipal,
): Promise<Attachment> {
  requireAdd(actor);
  const blobToken = requireStorage();

  const contentType = (input.content_type ?? '').toLowerCase().split(';')[0].trim();
  if (!ATTACHMENT_ALLOWED_TYPES.includes(contentType)) {
    throw badRequest(`Files of type "${contentType || 'unknown'}" cannot be uploaded here`);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.data ?? '', 'base64');
  } catch {
    throw badRequest('That file could not be read');
  }
  if (bytes.length === 0) throw badRequest('That file is empty');
  if (bytes.length > ATTACHMENT_MAX_BYTES) {
    throw badRequest(
      `That file is larger than ${Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB. Shrink it and try again.`,
    );
  }

  const fileName = safeName(input.file_name ?? 'file');
  // The work order's number leads the path so the store is browsable by a
  // human in an emergency; the random suffix keeps two files of the same name
  // apart without a lookup.
  const pathname = `work-orders/${safeName(woNumber)}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}-${fileName}`;

  const blob = await put(pathname, bytes, {
    access: 'private',
    token: blobToken,
    contentType,
    addRandomSuffix: false,
  });

  const res = await query<Row>(
    `WITH ins AS (
       INSERT INTO attachment
         (task_id, file_name, storage_key, content_type, byte_size, client_visible, visit_id, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8)
       RETURNING id
     )
     ${SELECT} WHERE a.id = (SELECT id FROM ins)`,
    [
      taskId,
      fileName,
      blob.pathname,
      contentType,
      bytes.length,
      input.client_visible ?? false,
      input.visit_id ?? null,
      actor.id,
    ],
  );

  // Rule 1.2.1: every button leaves a trace. The snapshot carries enough to
  // read the row back after the file itself is gone.
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'attachment_added', $3, NULL, $4::jsonb)`,
    [
      actor.id,
      taskId,
      `attachment:${res.rows[0].id}`,
      JSON.stringify({
        file_name: fileName,
        content_type: contentType,
        byte_size: bytes.length,
        client_visible: input.client_visible ?? false,
        visit_id: input.visit_id ?? null,
      }),
    ],
  );

  return mapRow(res.rows[0]);
}

/** The bytes, for the API to stream. Throws 404 for a row with no file. */
export async function readAttachment(
  taskId: string,
  attachmentId: string,
  actor: ActingPrincipal,
): Promise<{ stream: ReadableStream; contentType: string; fileName: string }> {
  requireView(actor);
  const blobToken = requireStorage();

  const res = await query<Row>(`${SELECT} WHERE a.id = $1 AND a.task_id = $2`, [attachmentId, taskId]);
  const row = res.rows[0];
  if (!row) throw notFound('No such file');
  if (!row.storage_key) throw notFound('That row has no file behind it');

  const blob = await get(row.storage_key, { access: 'private', token: blobToken });
  if (!blob || blob.statusCode !== 200 || !blob.stream) {
    throw notFound('That file is no longer in storage');
  }

  return {
    stream: blob.stream,
    contentType: row.content_type ?? 'application/octet-stream',
    fileName: row.file_name,
  };
}

export async function removeAttachment(
  taskId: string,
  attachmentId: string,
  actor: ActingPrincipal,
): Promise<void> {
  requireRemove(actor);

  const res = await query<Row>(`${SELECT} WHERE a.id = $1 AND a.task_id = $2`, [attachmentId, taskId]);
  const row = res.rows[0];
  if (!row) throw notFound('No such file');

  // The row goes whatever happens to the blob: a file left in storage costs
  // pennies, but a row pointing at nothing makes the card lie.
  if (row.storage_key && storageReady()) {
    try {
      await del(row.storage_key, { token: requireStorage() });
    } catch {
      /* already gone, or storage is unreachable — the row still goes */
    }
  }
  await query(`DELETE FROM attachment WHERE id = $1`, [attachmentId]);

  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'attachment_removed', $3, $4::jsonb, NULL)`,
    [
      actor.id,
      taskId,
      `attachment:${attachmentId}`,
      JSON.stringify({ file_name: row.file_name, content_type: row.content_type }),
    ],
  );
}
