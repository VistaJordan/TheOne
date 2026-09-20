/* Photos and files on a work order (0043).
 *
 * Until now this card drew coloured placeholders, because there was nowhere
 * to put a file. It shows the real thing now: every image is fetched back
 * through the API, which re-checks the work order's scope on each read — so a
 * photo is exactly as visible as the work order it sits on, and a link copied
 * out of this page is useless to anyone who cannot open that work order.
 *
 * Before / after is the reading that matters at soft close: an internal photo
 * is the assessment ("before"), a client-visible one is what was shown at
 * sign-off ("after"). Non-images are listed underneath rather than mixed into
 * the grid — a PDF has no thumbnail worth drawing.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBytes, isImageType, type Attachment } from '@theone/shared';
import type { WorkOrderDetailV2 } from '../../api/client';
import { attachmentUrl, deleteAttachment, listAttachments } from '../../api/client';
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

  const remove = useMutation({
    mutationFn: (id: string) => deleteAttachment(woId, id),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['wo-attachments', woId] });
      void qc.invalidateQueries({ queryKey: ['wo-activity', woId] });
    },
    onError: () => setError('That file could not be removed'),
  });

  const items = q.data?.items ?? [];
  const images = items.filter((a) => a.has_file && isImageType(a.content_type));
  const files = items.filter((a) => a.has_file && !isImageType(a.content_type));
  const before = images.filter((a) => !a.client_visible);
  const after = images.filter((a) => a.client_visible);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Photos</h2>
        <span className="card-meta">
          {before.length} before · {after.length} after
          {files.length > 0 && ` · ${files.length} file${files.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {error && <p className="composer-err" role="alert">{error}</p>}

      {q.data && !q.data.storage_ready && (
        <p className="hint">
          <Icon name="alert" size={12} /> File storage is not connected to this environment yet, so
          nothing can be uploaded here.
        </p>
      )}

      <div className="photo-group">
        <div className="group-label">
          Assessment visit
          {before.length > 0 && (
            <>
              <span className="sep-dot">·</span>
              <span className="n">{before.length}</span>
            </>
          )}
        </div>
        {before.length > 0 ? (
          <PhotoGrid
            woId={woId}
            items={before}
            badge="Before"
            onRemove={canRemove ? (id) => remove.mutate(id) : undefined}
          />
        ) : (
          <div className="empty">
            <Icon name="camera" />
            Add a photo from the update box below
          </div>
        )}
      </div>

      <div className="photo-group">
        <div className="group-label">
          Fulfillment visit
          {after.length > 0 && (
            <>
              <span className="sep-dot">·</span>
              <span className="n">{after.length}</span>
            </>
          )}
        </div>
        {after.length > 0 ? (
          <PhotoGrid
            woId={woId}
            items={after}
            badge="After"
            onRemove={canRemove ? (id) => remove.mutate(id) : undefined}
          />
        ) : (
          <div className="empty">
            <Icon name="camera" />
            A photo posted as client-visible lands here
          </div>
        )}
      </div>

      {files.length > 0 && (
        <div className="photo-group">
          <div className="group-label">
            Files<span className="sep-dot">·</span>
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
                  {formatBytes(a.byte_size)}
                  {a.uploaded_by ? ` · ${a.uploaded_by.display_name}` : ''}
                  {numericDate(a.created_at) ? ` · ${numericDate(a.created_at)}` : ''}
                </span>
                {canRemove && (
                  <button type="button" className="linkbtn" onClick={() => remove.mutate(a.id)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
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
