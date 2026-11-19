/* Photos and files on a work order (0043, review since 0061).
 *
 * Every image is fetched back through the API, which re-checks the work
 * order's scope on each read — so a photo is exactly as visible as the work
 * order it sits on, and a link copied out of this page is useless to anyone
 * who cannot open that work order.
 *
 * Rules 1.3.1–1.3.4: an upload lands Pending and is hidden from everyone but
 * the reviewers and the person who uploaded it. A reviewer names it, says
 * what it is (before photo, after photo, sign-off, from client, other) and approves or
 * declines it — one decision per file. Only approved files are drawn in the
 * groups below, and those are what the Job is Done gate reads (11.3.4).
 *
 * 2026-10-27 (Elise) · the approved files sit in three columns side by side —
 * Before · After · Sign-off — with anything else (kind "other", or a
 * non-image marked before / after) listed underneath. The columns stack on a
 * narrow screen.
 *
 * 2026-10-28 (Elise) · a fourth column, From client: the pictures and files
 * the client shares with us (kind "client", 0106). Like a sign-off, any file
 * type belongs there. It is not proof of work — the Done gate never reads it.
 *
 * 2026-11-16 (Elise) · files can be added here too, not only from the
 * message box: Add photo / Upload files in the head, or a drop onto the
 * card. They land Pending (internal) like any upload and the reviewer sorts
 * them into the columns.
 *
 * 2026-11-16 (Elise, UAT #47) · the drop is caught on the whole page while
 * the Drive tab is open, not on the card alone: a file let go just outside
 * the card used to be opened by the browser in place of the app. The
 * listeners sit on the window, so nothing inside (an image link, the grid)
 * can swallow the drag.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ATTACHMENT_ALLOWED_TYPES,
  ATTACHMENT_KINDS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_KIND_LABEL,
  formatBytes,
  isImageType,
  type Attachment,
  type AttachmentKind,
  type AttachmentReview,
} from '@theone/shared';
import type { WorkOrderDetailV2 } from '../../api/client';
import { attachmentUrl, deleteAttachment, listAttachments, reviewAttachment, uploadAttachment } from '../../api/client';
import { prepareFile } from '../../lib/upload';
import { numericDate } from '../../lib/fields';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../Icon';
import { PhotoReviewViewer } from './PhotoReviewViewer';

interface PhotosCardProps {
  wo: WorkOrderDetailV2;
}

/** Real attachments when the work order has any; otherwise the two empty
    groups — the card keeps its shape so the page never collapses. */
export function PhotosCard({ wo }: PhotosCardProps) {
  const woId = wo.id;
  const qc = useQueryClient();
  const { can } = useAuth();
  const canRemove = can('work_orders/attachments', 'delete');
  const [error, setError] = useState<string | null>(null);
  // M14 (Wave D): the full-size viewer, open on one list (waiting / declined).
  const [viewer, setViewer] = useState<{ list: 'pending' | 'declined'; start: number } | null>(null);

  const q = useQuery({
    queryKey: ['wo-attachments', woId],
    queryFn: () => listAttachments(woId),
    retry: 0,
  });

  const refresh = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: ['wo-attachments', woId] });
    void qc.invalidateQueries({ queryKey: ['wo-activity', woId] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => deleteAttachment(woId, id),
    onSuccess: refresh,
    onError: () => setError('That file could not be removed'),
  });

  const review = useMutation({
    mutationFn: (v: { id: string; input: AttachmentReview }) => reviewAttachment(woId, v.id, v.input),
    onSuccess: refresh,
    onError: (err) => setError(err instanceof Error ? err.message : 'That decision could not be saved'),
  });

  const canReview = q.data?.can_review ?? false;
  const items = (q.data?.items ?? []).filter((a) => a.has_file);
  const approved = items.filter((a) => a.review_status === 'approved');
  const pending = items.filter((a) => a.review_status === 'pending');
  const declined = items.filter((a) => a.review_status === 'declined');

  const before = approved.filter((a) => a.kind === 'before' && isImageType(a.content_type));
  const after = approved.filter((a) => a.kind === 'after' && isImageType(a.content_type));
  // A sign-off is a scan or a PDF as often as a photo: any type belongs here.
  const signoff = approved.filter((a) => a.kind === 'signoff');
  const fromClient = approved.filter((a) => a.kind === 'client');
  const files = approved.filter(
    (a) => !before.includes(a) && !after.includes(a) && !signoff.includes(a) && !fromClient.includes(a),
  );

  const onRemove = canRemove ? (id: string) => remove.mutate(id) : undefined;

  // 2026-11-16 · uploading from the Drive tab itself.
  const canAttach = can('work_orders/attachments', 'create');
  const photoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  // Drag depth, not a boolean: dragenter / dragleave fire for every child.
  const [dragDepth, setDragDepth] = useState(0);
  const uploadsClosed = !canAttach
    ? 'Your role cannot add files'
    : q.data && !q.data.storage_ready
      ? 'File storage is not configured on this server'
      : null;

  const sendFiles = async (list: FileList | File[] | null) => {
    if (!list || list.length === 0) return;
    if (uploadsClosed) {
      setError(uploadsClosed);
      return;
    }
    setError(null);
    setUploading(list.length);
    try {
      for (const file of Array.from(list)) {
        const prepared = await prepareFile(file);
        // Only the fields the route's strict schema accepts.
        await uploadAttachment(woId, {
          file_name: prepared.file_name,
          content_type: prepared.content_type,
          data: prepared.data,
          client_visible: false,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file did not upload');
    } finally {
      setUploading(0);
      if (photoInput.current) photoInput.current.value = '';
      if (fileInput.current) fileInput.current.value = '';
      void qc.invalidateQueries({ queryKey: ['wo-attachments', woId] });
      void qc.invalidateQueries({ queryKey: ['wo-activity', woId] });
    }
  };

  // Kept in refs so the window listeners, added once, read today's values.
  const sendRef = useRef(sendFiles);
  sendRef.current = sendFiles;
  const busyRef = useRef(false);
  busyRef.current = uploading > 0;
  const closedRef = useRef<string | null>(null);
  closedRef.current = uploadsClosed;

  useEffect(() => {
    const hasFiles = (e: globalThis.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragDepth((d) => d + 1);
    };
    const onOver = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      // Always prevent the default, or the browser opens the file itself.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = closedRef.current || busyRef.current ? 'none' : 'copy';
    };
    const onLeave = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      setDragDepth((d) => Math.max(0, d - 1));
    };
    const onDrop = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragDepth(0);
      // A drop meant for another box (the message composer has its own) is left to it.
      if (e.defaultPrevented && e.target instanceof Element && e.target.closest('.composer')) return;
      if (busyRef.current) return;
      void sendRef.current(Array.from(e.dataTransfer?.files ?? []));
    };
    const reset = () => setDragDepth(0);
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', reset);
    };
  }, []);
  const dragging = dragDepth > 0;
  const uploadDisabled = !!uploadsClosed || !q.data || uploading > 0;
  const uploadTitle = (what: string) =>
    uploadsClosed ?? `${what} (up to ${formatBytes(ATTACHMENT_MAX_BYTES)} each) — or drop files anywhere on this tab`;

  const viewerItems = viewer ? (viewer.list === 'pending' ? pending : declined) : [];

  return (
    <section className={`card photos-card${dragging ? ' is-dragging' : ''}`}>
      {dragging && (
        <div className="photo-drop" aria-hidden="true">
          <Icon name={uploadsClosed ? 'alert' : 'upload'} size={16} />
          {uploadsClosed ?? 'Drop to upload — it waits for approval like any upload'}
        </div>
      )}
      <div className="card-head">
        <h2 className="card-title">Photos</h2>
        <span className="card-meta">
          {before.length} before · {after.length} after · {signoff.length} sign-off · {fromClient.length} from client
          {files.length > 0 && ` · ${files.length} file${files.length === 1 ? '' : 's'}`}
          {pending.length > 0 && ` · ${pending.length} waiting`}
        </span>
        {canAttach && (
          <div className="photo-actions">
            <input
              ref={photoInput}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => void sendFiles(e.target.files)}
            />
            <input
              ref={fileInput}
              type="file"
              accept={ATTACHMENT_ALLOWED_TYPES.join(',')}
              multiple
              hidden
              onChange={(e) => void sendFiles(e.target.files)}
            />
            {uploading > 0 && <span className="card-meta">Uploading {uploading}…</span>}
            <button
              type="button"
              className="btn btn-sm"
              disabled={uploadDisabled}
              title={uploadTitle('Take or pick a photo')}
              onClick={() => photoInput.current?.click()}
            >
              <Icon name="camera" size={12} />
              Add photo
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={uploadDisabled}
              title={uploadTitle('Upload photos or files')}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="upload" size={12} />
              Upload files
            </button>
          </div>
        )}
      </div>

      {error && <p className="composer-err" role="alert">{error}</p>}

      {q.data && !q.data.storage_ready && (
        <p className="hint">
          <Icon name="alert" size={12} /> File storage is not connected to this environment yet, so
          nothing can be uploaded here.
        </p>
      )}

      {pending.length > 0 && (
        <div className="photo-group">
          <div className="group-label">
            Waiting for approval<span className="sep-dot">·</span>
            <span className="n">{pending.length}</span>
          </div>
          <p className="hint photo-review-note">
            {canReview
              ? 'Hidden from everyone else until approved. Say what each one is, then approve or decline it.'
              : 'Your uploads — hidden from everyone else until a reviewer approves them.'}
          </p>
          <ul className="photo-review-list">
            {pending.map((a, i) => (
              <ReviewRow
                key={a.id}
                woId={woId}
                item={a}
                canReview={canReview}
                busy={review.isPending}
                onOpen={() => setViewer({ list: 'pending', start: i })}
                onRemove={onRemove}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="photo-columns">
        <PhotoColumn
          woId={woId}
          label="Before"
          items={before}
          empty="Add a photo here or from the message box — it shows here once approved as a before photo"
          onRemove={onRemove}
        />
        <PhotoColumn
          woId={woId}
          label="After"
          items={after}
          empty="An approved after photo is needed before Done / Incurred"
          onRemove={onRemove}
        />
        <PhotoColumn
          woId={woId}
          label="Sign-off"
          items={signoff}
          empty="The signed sheet shows here once it is approved as a sign-off"
          onRemove={onRemove}
        />
        <PhotoColumn
          woId={woId}
          label="From client"
          items={fromClient}
          empty="Pictures the client shares show here once approved as From client"
          onRemove={onRemove}
        />
      </div>

      {files.length > 0 && (
        <div className="photo-group">
          <div className="group-label">
            Other files<span className="sep-dot">·</span>
            <span className="n">{files.length}</span>
          </div>
          <FileList woId={woId} items={files} onRemove={onRemove} />
        </div>
      )}

      {declined.length > 0 && (
        <div className="photo-group">
          <div className="group-label">
            Declined<span className="sep-dot">·</span>
            <span className="n">{declined.length}</span>
          </div>
          <ul className="photo-review-list">
            {declined.map((a, i) => (
              <ReviewRow
                key={a.id}
                woId={woId}
                item={a}
                canReview={canReview}
                busy={review.isPending}
                onOpen={() => setViewer({ list: 'declined', start: i })}
                onRemove={onRemove}
              />
            ))}
          </ul>
        </div>
      )}

      {viewer && canReview && viewerItems.length > 0 && (
        <PhotoReviewViewer
          woId={woId}
          items={viewerItems}
          start={viewer.start}
          busy={review.isPending}
          onDecide={(id, input) => review.mutate({ id, input })}
          onClose={() => setViewer(null)}
        />
      )}
    </section>
  );
}

/** One quarantined file: its thumbnail and name; for a reviewer, Review
    opens the full-size viewer — the only place Approve / Decline are
    (M14, rule 1.3.4: one decision per picture). */
function ReviewRow({
  woId,
  item,
  canReview,
  busy,
  onOpen,
  onRemove,
}: {
  woId: string;
  item: Attachment;
  canReview: boolean;
  busy: boolean;
  onOpen: () => void;
  onRemove?: (id: string) => void;
}) {
  const image = isImageType(item.content_type);
  const declined = item.review_status === 'declined';

  const meta = [
    formatBytes(item.byte_size),
    item.uploaded_by?.display_name,
    numericDate(item.created_at),
    declined && item.reviewed_by ? `declined by ${item.reviewed_by.display_name}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className={`photo-review${declined ? ' is-declined' : ''}`}>
      <a
        className="photo-review-thumb"
        href={attachmentUrl(woId, item.id)}
        target="_blank"
        rel="noreferrer"
        title={`Open ${item.file_name}`}
      >
        {image ? (
          <img src={attachmentUrl(woId, item.id)} alt={item.file_name} loading="lazy" />
        ) : (
          <Icon name="clip" size={16} />
        )}
      </a>
      <div className="photo-review-body">
        <span className="photo-review-name" title={item.file_name}>
          {item.file_name}
        </span>
        <span className="file-meta">{meta}</span>
      </div>
      <div className="photo-review-actions">
        {canReview ? (
          <>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={onOpen} title="Open it full size to approve or decline">
              Review
            </button>
            {declined && onRemove && (
              <button type="button" className="btn btn-sm is-danger" disabled={busy} onClick={() => onRemove(item.id)}>
                Remove
              </button>
            )}
          </>
        ) : (
          <span className={`chip chip-sm photo-review-state${declined ? ' is-declined' : ''}`}>
            {declined ? 'Declined' : 'Waiting for approval'}
          </span>
        )}
      </div>
    </li>
  );
}

/** One of the four columns: its images as a grid, any other file (a PDF
    sign-off sheet, say) as a list under them. */
function PhotoColumn({
  woId,
  label,
  items,
  empty,
  onRemove,
}: {
  woId: string;
  label: string;
  items: Attachment[];
  empty: string;
  onRemove?: (id: string) => void;
}) {
  const images = items.filter((a) => isImageType(a.content_type));
  const pdfs = items.filter((a) => isPdfType(a.content_type));
  const others = items.filter((a) => !isImageType(a.content_type) && !isPdfType(a.content_type));
  return (
    <div className="photo-group photo-column">
      <div className="group-label">
        {label}
        {items.length > 0 && (
          <>
            <span className="sep-dot">·</span>
            <span className="n">{items.length}</span>
          </>
        )}
      </div>
      {items.length === 0 ? (
        <div className="empty">
          <Icon name="camera" />
          {empty}
        </div>
      ) : (
        <>
          {images.length > 0 && <PhotoGrid woId={woId} items={images} badge={label} onRemove={onRemove} />}
          {pdfs.length > 0 && <PdfGrid woId={woId} items={pdfs} badge={label} onRemove={onRemove} />}
          {others.length > 0 && <FileList woId={woId} items={others} onRemove={onRemove} />}
        </>
      )}
    </div>
  );
}

function FileList({ woId, items, onRemove }: { woId: string; items: Attachment[]; onRemove?: (id: string) => void }) {
  return (
    <ul className="file-list">
      {items.map((a) => (
        <li key={a.id}>
          <a href={attachmentUrl(woId, a.id)} target="_blank" rel="noreferrer">
            <Icon name="clip" size={12} />
            {a.file_name}
          </a>
          <span className="file-meta">
            {a.kind ? `${ATTACHMENT_KIND_LABEL[a.kind]} · ` : ''}
            {formatBytes(a.byte_size)}
            {a.uploaded_by ? ` · ${a.uploaded_by.display_name}` : ''}
            {numericDate(a.created_at) ? ` · ${numericDate(a.created_at)}` : ''}
          </span>
          {onRemove && (
            <button type="button" className="linkbtn" onClick={() => onRemove(a.id)}>
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function PhotoGrid({
  woId,
  items,
  badge,
  onRemove,
}: {
  woId: string;
  items: Attachment[];
  badge: string;
  onRemove?: (id: string) => void;
}) {
  return (
    <div className="photo-grid">
      {items.map((a) => (
        <figure className="photo" key={a.id}>
          {/* The full-size image opens in a tab, authenticated the same way
              this page is: it works for whoever may see the work order, and
              for nobody else. */}
          <a
            className="photo-img is-real"
            href={attachmentUrl(woId, a.id)}
            target="_blank"
            rel="noreferrer"
            title={`Open ${a.file_name}`}
          >
            <img src={attachmentUrl(woId, a.id)} alt={a.file_name} loading="lazy" />
            <span className="photo-badge">{badge}</span>
          </a>
          <figcaption title={a.file_name}>
            {a.file_name}
            {numericDate(a.created_at) ? ` · ${numericDate(a.created_at)}` : ''}
            {onRemove && (
              <button type="button" className="linkbtn photo-remove" onClick={() => onRemove(a.id)}>
                Remove
              </button>
            )}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

const isPdfType = (type: string | null | undefined) => (type ?? '').toLowerCase() === 'application/pdf';

/** Elise, 2026-11-19: a PDF on Drive (the signed sign-off sheet, a file from
    the client) shows its first page as a tile, like a photo; a click opens it
    full screen. The file stays a PDF: the preview is the browser's own PDF
    viewer in a frame, which cannot be clicked into (the tile is the button). */
function PdfGrid({
  woId,
  items,
  badge,
  onRemove,
}: {
  woId: string;
  items: Attachment[];
  badge: string;
  onRemove?: (id: string) => void;
}) {
  const [open, setOpen] = useState<Attachment | null>(null);
  return (
    <>
      <div className="photo-grid">
        {items.map((a) => (
          <figure className="photo" key={a.id}>
            <button type="button" className="photo-img is-real is-pdf" onClick={() => setOpen(a)} title={`Open ${a.file_name}`}>
              <iframe
                src={`${attachmentUrl(woId, a.id)}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
                title={`Preview of ${a.file_name}`}
                loading="lazy"
                tabIndex={-1}
                aria-hidden="true"
              />
              <span className="photo-badge">{badge}</span>
              <span className="pdf-tag">PDF</span>
            </button>
            <figcaption title={a.file_name}>
              {a.file_name}
              {numericDate(a.created_at) ? ` · ${numericDate(a.created_at)}` : ''}
              {onRemove && (
                <button type="button" className="linkbtn photo-remove" onClick={() => onRemove(a.id)}>
                  Remove
                </button>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
      {open && <PdfViewer url={attachmentUrl(woId, open.id)} name={open.file_name} onClose={() => setOpen(null)} />}
    </>
  );
}

function PdfViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="pdf-viewer" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <div className="pdf-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="pdf-viewer-name">{name}</span>
        <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer">
          Open in a new tab
        </a>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" autoFocus>
          <Icon name="x" size={16} />
        </button>
      </div>
      <iframe className="pdf-viewer-frame" src={`${url}#view=FitH&navpanes=0`} title={name} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}
