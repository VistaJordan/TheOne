/**
 * Attachments (0043) — the photos and files on a work order.
 *
 * Proof of work is the whole point: a completed job with no before/after
 * photo is a job somebody has to take on trust. Until now the three upload
 * buttons in the app were disabled, because there was nowhere to put a file.
 *
 * Two rules the browser and the API both hold to:
 *
 *   an upload is bounded.  The API runs on a serverless host with a hard
 *   request-body ceiling, so the browser shrinks photographs BEFORE sending
 *   (a phone photo is 3–8MB; the same picture at 2000px wide is well under
 *   one) and anything still over the limit is refused with a sentence rather
 *   than a failed request.
 *
 *   a file is exactly as visible as its work order.  Nothing is served from a
 *   storage URL; every read goes back through the API, which checks the work
 *   order's scope first.
 */

/** The largest file the API will accept, after any shrinking. */
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

/** Longest side of a photo after the browser shrinks it, and its quality. */
export const PHOTO_MAX_EDGE = 2000;
export const PHOTO_QUALITY = 0.82;

/** What may be uploaded. Anything executable is refused: this is a file the
    next person will click on. */
export const ATTACHMENT_ALLOWED_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export function isImageType(contentType: string | null | undefined): boolean {
  return (contentType ?? '').startsWith('image/');
}

/** One file on a work order. */
export interface Attachment {
  id: string;
  task_id: string;
  file_name: string;
  content_type: string | null;
  byte_size: number | null;
  /** Client-visible files are the ones that would sync outward (7.x). */
  client_visible: boolean;
  /** Which visit it belongs to (0021), when it was taken on one. */
  visit_id: string | null;
  uploaded_by: { id: string; display_name: string } | null;
  created_at: string;
  /** False for a pre-0043 row: metadata with no file behind it. */
  has_file: boolean;
}

export interface AttachmentsResponse {
  items: Attachment[];
  /** False when the server has no file storage configured — the UI says so
      instead of offering a button that cannot work. */
  storage_ready: boolean;
}

/** POST body. `data` is base64 (no data: prefix). */
export interface AttachmentUpload {
  file_name: string;
  content_type: string;
  data: string;
  client_visible?: boolean;
  visit_id?: string | null;
}

/** `details.code` when the server has no storage connected yet. */
export const ATTACHMENT_STORAGE_MISSING = 'ATTACHMENT_STORAGE_MISSING';

/** "2.4 MB" / "812 KB" — the size as a person would say it. */
export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The permission path attachments hang from (0015). */
export const ATTACHMENT_PERM_KEY = 'work_orders/attachments';
