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
  ATTACHMENT_KINDS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_STORAGE_MISSING,
  type Attachment,
  type AttachmentKind,
  type AttachmentReview,
  type AttachmentReviewStatus,
  type AttachmentUpload,
} from '@theone/shared';
import { query } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { allowFor, requirePerm } from './permissions.js';
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

// ── Review (0061, rules 1.3.1–1.3.4) ─────────────────────────────────────────
//
// An upload is quarantined until someone with `approve` says yes: until then
// it exists for the reviewers and for the person who uploaded it, and for
// nobody else — not in the list, and not as bytes. A declined file stays in
// the same quarantine, so the reviewer can change their mind and the uploader
// can see what happened to it.

/** May this person approve / decline files? */
export function canReviewAttachments(p: ActingPrincipal): boolean {
  return allowFor(p)('work_orders/attachments', 'approve');
}

function visibleTo(row: Row, p: ActingPrincipal): boolean {
  return row.review_status === 'approved' || row.uploaded_by_id === p.id || canReviewAttachments(p);
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
  review_status: AttachmentReviewStatus;
  kind: AttachmentKind | null;
  reviewed_by_id: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
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
         to_char((a.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
         a.review_status,
         a.kind,
         a.reviewed_by::text AS reviewed_by_id,
         rp.display_name AS reviewed_by_name,
         to_char((a.reviewed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at
    FROM attachment a
    LEFT JOIN principal p ON p.id = a.uploaded_by
    LEFT JOIN principal rp ON rp.id = a.reviewed_by`;

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
    review_status: r.review_status,
    kind: r.kind,
    reviewed_by: r.reviewed_by_id
      ? { id: r.reviewed_by_id, display_name: r.reviewed_by_name ?? '—' }
      : null,
    reviewed_at: r.reviewed_at,
  };
}

/** The files this person may see: the approved ones, plus — rule 1.3.2 — the
    quarantined ones only for a reviewer or for whoever uploaded them. */
export async function listAttachments(taskId: string, actor: ActingPrincipal): Promise<Attachment[]> {
  requireView(actor);
  const res = await query<Row>(`${SELECT} WHERE a.task_id = $1 ORDER BY a.created_at DESC`, [taskId]);
  return res.rows.filter((r) => visibleTo(r, actor)).map(mapRow);
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
        // 0061 / rule 1.3.1: it waits for a reviewer.
        review_status: 'pending',
      }),
    ],
  );

  return mapRow(res.rows[0]);
}

/**
 * 0070 · A file a MACHINE files on a work order — the signed sign-off sheet
 * a technician texted back through Quo. Same path, same quarantine (rule
 * 1.3.1: pending until a reviewer approves), but no permission check — the
 * actor is a service principal and the caller has already decided the file
 * belongs here. `kind` is pre-filled so the reviewer only has to say yes.
 * `storageKey` set = the bytes are already in the store under that key
 * (a held reply being claimed); otherwise `bytes` are written now.
 */
export async function addSystemAttachment(
  taskId: string,
  woNumber: string,
  input: { bytes?: Buffer; storageKey?: string; byteSize?: number; fileName: string; contentType: string; kind: AttachmentKind; actorId: string; via: string },
): Promise<Attachment> {
  const blobToken = requireStorage();
  const contentType = input.contentType.toLowerCase().split(';')[0].trim();
  if (!ATTACHMENT_ALLOWED_TYPES.includes(contentType)) {
    throw badRequest(`Files of type "${contentType || 'unknown'}" cannot be filed here`);
  }
  const fileName = safeName(input.fileName);
  let storageKey = input.storageKey ?? null;
  let byteSize: number;
  if (storageKey) {
    byteSize = input.byteSize ?? 0;
  } else {
    const bytes = input.bytes ?? Buffer.alloc(0);
    if (bytes.length === 0) throw badRequest('That file is empty');
    if (bytes.length > ATTACHMENT_MAX_BYTES) throw badRequest('That file is too large to file');
    const pathname = `work-orders/${safeName(woNumber)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${fileName}`;
    const blob = await put(pathname, bytes, { access: 'private', token: blobToken, contentType, addRandomSuffix: false });
    storageKey = blob.pathname;
    byteSize = bytes.length;
  }
  const res = await query<Row>(
    `WITH ins AS (
       INSERT INTO attachment
         (task_id, file_name, storage_key, content_type, byte_size, client_visible, uploaded_by, kind)
       VALUES ($1, $2, $3, $4, $5, false, $6, $7)
       RETURNING id
     )
     ${SELECT} WHERE a.id = (SELECT id FROM ins)`,
    [taskId, fileName, storageKey, contentType, byteSize, input.actorId, input.kind],
  );
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'attachment_added', $3, NULL, $4::jsonb)`,
    [
      input.actorId,
      taskId,
      `attachment:${res.rows[0].id}`,
      JSON.stringify({ file_name: fileName, content_type: contentType, byte_size: byteSize, client_visible: false, visit_id: null, review_status: 'pending', kind: input.kind, via: input.via }),
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
  // A quarantined file answers exactly like a missing one (rule 1.3.2).
  if (!row || !visibleTo(row, actor)) throw notFound('No such file');
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

/**
 * Rules 1.3.3 / 1.3.4: approve or decline one file. Approving says what the
 * file is (`kind` — required unless it already has one) and may rename it;
 * from then on everyone who can open the work order sees it. Declining keeps
 * it in quarantine. A decision can be reversed by deciding again; each
 * decision is its own audit row.
 */
export async function reviewAttachment(
  taskId: string,
  attachmentId: string,
  input: AttachmentReview,
  actor: ActingPrincipal,
): Promise<Attachment> {
  requireView(actor);
  requirePerm(actor,'work_orders/attachments', 'approve', 'You cannot approve or decline files');

  const res = await query<Row>(`${SELECT} WHERE a.id = $1 AND a.task_id = $2`, [attachmentId, taskId]);
  const row = res.rows[0];
  if (!row) throw notFound('No such file');

  const approving = input.decision === 'approve';
  const kind = approving ? (input.kind ?? row.kind) : row.kind;
  if (approving && (!kind || !ATTACHMENT_KINDS.includes(kind))) {
    throw badRequest('Say what this file is — before photo, after photo, sign-off or other — to approve it');
  }
  const fileName = input.file_name?.trim() ? safeName(input.file_name) : row.file_name;
  const status: AttachmentReviewStatus = approving ? 'approved' : 'declined';

  await query(
    `UPDATE attachment
        SET review_status = $2, kind = $3, file_name = $4, reviewed_by = $5, reviewed_at = now()
      WHERE id = $1`,
    [attachmentId, status, kind, fileName, actor.id],
  );

  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      actor.id,
      taskId,
      approving ? 'attachment_approved' : 'attachment_declined',
      `attachment:${attachmentId}`,
      JSON.stringify({ file_name: row.file_name, review_status: row.review_status, kind: row.kind }),
      JSON.stringify({ file_name: fileName, review_status: status, kind }),
    ],
  );

  // 0071 � an approved file goes into the work order's SharePoint folder,
  // when that switch is on. Bounded, never throws; retried hourly.
  if (approving) {
    const { fileAttachment } = await import('./sharepoint.js');
    await fileAttachment(attachmentId, actor.id);
  }

  const out = await query<Row>(`${SELECT} WHERE a.id = $1`, [attachmentId]);
  return mapRow(out.rows[0]);
}

export async function removeAttachment(
  taskId: string,
  attachmentId: string,
  actor: ActingPrincipal,
): Promise<void> {
  requireRemove(actor);

  const res = await query<Row>(`${SELECT} WHERE a.id = $1 AND a.task_id = $2`, [attachmentId, taskId]);
  const row = res.rows[0];
  if (!row || !visibleTo(row, actor)) throw notFound('No such file');

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
