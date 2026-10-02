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
  const files = approved.filter((a) => !before.includes(a) && !after.includes(a));

  const onRemove = canRemove ? (id: string) => remove.mutate(id) : undefined;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Photos</h2>
        <span className="card-meta">
          {before.length} before · {after.length} after
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
            {pending.map((a) => (
              <ReviewRow
                key={a.id}
                woId={woId}
                item={a}
                canReview={canReview}
                busy={review.isPending}
                onDecide={(input) => review.mutate({ id: a.id, input })}
                onRemove={onRemove}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="photo-group">
        <div className="group-label">
          Before
          {before.length > 0 && (
            <>
              <span className="sep-dot">·</span>
              <span className="n">{before.length}</span>
            </>
          )}
        </div>
        {before.length > 0 ? (
          <PhotoGrid woId={woId} items={before} badge="Before" onRemove={onRemove} />
        ) : (
          <div className="empty">
            <Icon name="camera" />
            Add a photo from the message box — it shows here once approved as a before photo
          </div>
        )}
      </div>

      <div className="photo-group">
        <div className="group-label">
          After
          {after.length > 0 && (
            <>
              <span className="sep-dot">·</span>
              <span className="n">{after.length}</span>
            </>
          )}
        </div>
        {after.length > 0 ? (
          <PhotoGrid woId={woId} items={after} badge="After" onRemove={onRemove} />
        ) : (
          <div className="empty">
            <Icon name="camera" />
            An approved after photo is needed before Done / Incurred
          </div>
        )}
      </div>

      {files.length > 0 && (
        <div className="photo-group">
          <div className="group-label">
            Sign-off and files<span className="sep-dot">·</span>
            <span className="n">{files.length}</span>
          </div>
          <ul className="file-list">
            {files.map((a) => (
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
        </div>
      )}

      {declined.length > 0 && (
        <div className="photo-group">
          <div className="group-label">
            Declined<span className="sep-dot">·</span>
            <span className="n">{declined.length}</span>
          </div>
          <ul className="photo-review-list">
            {declined.map((a) => (
              <ReviewRow
                key={a.id}
                woId={woId}
                item={a}
                canReview={canReview}
                busy={review.isPending}
                onDecide={(input) => review.mutate({ id: a.id, input })}
                onRemove={onRemove}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** One quarantined file: its thumbnail, and — for a reviewer — the name, what
    it is, and the two decisions (rule 1.3.4: Approve / Decline per picture). */
function ReviewRow({
  woId,
  item,
  canReview,
  busy,
  onDecide,
  onRemove,
}: {
  woId: string;
  item: Attachment;
  canReview: boolean;
  busy: boolean;
  onDecide: (input: AttachmentReview) => void;
  onRemove?: (id: string) => void;
}) {
  const image = isImageType(item.content_type);
  const declined = item.review_status === 'declined';
  const [name, setName] = useState(item.file_name);
  const [kind, setKind] = useState<AttachmentKind | ''>(item.kind ?? '');

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
        {canReview ? (
          <div className="photo-review-fields">
            <input
              className="fld sm"
              aria-label="File name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
            <select
              className="fld sm"
              aria-label="What this file is"
              value={kind}
              onChange={(e) => setKind(e.target.value as AttachmentKind | '')}
            >
              <option value="">What is it?</option>
              {ATTACHMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ATTACHMENT_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <span className="photo-review-name" title={item.file_name}>
            {item.file_name}
          </span>
        )}
        <span className="file-meta">{meta}</span>
      </div>
      <div className="photo-review-actions">
        {canReview ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || kind === ''}
              title={kind === '' ? 'Say what this file is first' : undefined}
              onClick={() =>
                kind !== '' &&
                onDecide({ decision: 'approve', kind, file_name: name.trim() || item.file_name })
              }
            >
              Approve
            </button>
            {declined ? (
              onRemove && (
                <button type="button" className="btn btn-sm is-danger" disabled={busy} onClick={() => onRemove(item.id)}>
                  Remove
                </button>
              )
            ) : (
              <button
                type="button"
                className="btn btn-sm is-ghost"
                disabled={busy}
                onClick={() => onDecide({ decision: 'decline' })}
              >
                Decline
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
