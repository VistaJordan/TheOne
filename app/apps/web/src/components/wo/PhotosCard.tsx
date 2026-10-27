/* Photos and files on a work order (0043, review since 0061).
 *
 * Every image is fetched back through the API, which re-checks the work
 * order's scope on each read — so a photo is exactly as visible as the work
 * order it sits on, and a link copied out of this page is useless to anyone
 * who cannot open that work order.
 *
 * Rules 1.3.1–1.3.4: an upload lands Pending and is hidden from everyone but
 * the reviewers and the person who uploaded it. A reviewer names it, says
 * what it is (before photo, after photo, sign-off, other) and approves or
 * declines it — one decision per file. Only approved files are drawn in the
 * groups below, and those are what the Job is Done gate reads (11.3.4).
 *
 * 2026-10-27 (Elise) · the approved files sit in three columns side by side —
 * Before · After · Sign-off — with anything else (kind "other", or a
 * non-image marked before / after) listed underneath. The columns stack on a
 * narrow screen.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_KIND_LABEL,
  formatBytes,
  isImageType,
  type Attachment,
  type AttachmentKind,
  type AttachmentReview,
} from '@theone/shared';
import type { WorkOrderDetailV2 } from '../../api/client';
import { attachmentUrl, deleteAttachment, listAttachments, reviewAttachment } from '../../api/client';
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
  const files = approved.filter((a) => !before.includes(a) && !after.includes(a) && !signoff.includes(a));

  const onRemove = canRemove ? (id: string) => remove.mutate(id) : undefined;
  const viewerItems = viewer ? (viewer.list === 'pending' ? pending : declined) : [];

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Photos</h2>
        <span className="card-meta">
          {before.length} before · {after.length} after · {signoff.length} sign-off
          {files.length > 0 && ` · ${files.length} file${files.length === 1 ? '' : 's'}`}
          {pending.length > 0 && ` · ${pending.length} waiting`}
        </span>
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
          empty="Add a photo from the message box — it shows here once approved as a before photo"
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

/** One of the three columns: its images as a grid, any other file (a PDF
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
  const others = items.filter((a) => !isImageType(a.content_type));
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
