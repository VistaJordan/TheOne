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

// ── Review (0061, rules 1.3.1–1.3.4) ─────────────────────────────────────────
//
// Every upload lands `pending` and is quarantined: only the people who may
// review files (`work_orders/attachments` approve) and the person who
// uploaded it see it. A reviewer approves or declines each one; approving is
// also where the file is named and told apart — before photo, after photo,
// sign-off — because that tag is what the Job is Done gate reads (11.3.4).

export type AttachmentReviewStatus = 'pending' | 'approved' | 'declined';

export type AttachmentKind = 'before' | 'after' | 'signoff' | 'other';

export const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['before', 'after', 'signoff', 'other'];

export const ATTACHMENT_KIND_LABEL: Record<AttachmentKind, string> = {
  before: 'Before photo',
  after: 'After photo',
  signoff: 'Sign-off',
  other: 'Other',
};

/** POST …/attachments/:id/review. Approving needs a `kind` unless the file
    already has one; `file_name` renames it on the way through (1.3.3). */
export interface AttachmentReview {
  decision: 'approve' | 'decline';
  kind?: AttachmentKind;
  file_name?: string;
}

/** Bag key of rule 11.3.4's BFI_Checkbox (0061 / seed.ts): the job is billed
    for what was incurred, so there is no finished work to photograph. */
export const BFI_KEY = 'Bill For Incurred';

/** A checkbox bag value, read the way the browser's `bool` reads one. */
export function checkboxOn(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

/** Rule 11.3.4, which proof is absent. `approvedKinds` = the kinds of the
    work order's APPROVED files. Standard completion needs an after photo; a
    BFI job needs a before photo and a sign-off instead. */
export function completionProofMissing(
  bfi: unknown,
  approvedKinds: readonly string[],
): 'after_photo' | 'bfi_proof' | null {
  if (checkboxOn(bfi)) {
    return approvedKinds.includes('before') && approvedKinds.includes('signoff') ? null : 'bfi_proof';
  }
  return approvedKinds.includes('after') ? null : 'after_photo';
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
  /** 0061 · pending until a reviewer approves or declines it. */
  review_status: AttachmentReviewStatus;
  /** What the file is, set at approval. Null while nobody has said. */
  kind: AttachmentKind | null;
  reviewed_by: { id: string; display_name: string } | null;
  reviewed_at: string | null;
}

export interface AttachmentsResponse {
  items: Attachment[];
  /** False when the server has no file storage configured — the UI says so
      instead of offering a button that cannot work. */
  storage_ready: boolean;
  /** Whether the viewer may approve / decline files here (0061). */
  can_review: boolean;
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
