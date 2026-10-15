/* M14 (UAT round 1, Wave D) · the full-size viewer where photos are approved.
 *
 * Approve and Decline live ONLY here: a reviewer sees the picture at full
 * size before deciding, and steps through the waiting ones with ← / → (Esc
 * closes). The decision it sends carries `viewed: true`, which the API asks
 * for (reviewAttachment, 400 ATTACHMENT_NOT_VIEWED otherwise) — a soft pin
 * that the click came from here. The uploader may approve their own photo:
 * rule 1.3 has no maker ≠ checker (Wave A's D2 is about money).
 */

import { useEffect, useState } from 'react';
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_KIND_LABEL,
  formatBytes,
  isImageType,
  type Attachment,
  type AttachmentKind,
  type AttachmentReview,
} from '@theone/shared';
import { attachmentUrl } from '../../api/client';
import { numericDate } from '../../lib/fields';
import { Icon } from '../Icon';

export function PhotoReviewViewer({
  woId,
  items,
  start,
  busy,
  onDecide,
  onClose,
}: {
  woId: string;
  items: Attachment[];
  start: number;
  busy: boolean;
  onDecide: (id: string, input: AttachmentReview) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() => Math.min(Math.max(start, 0), Math.max(items.length - 1, 0)));
  const item = items[index] ?? null;
  const [name, setName] = useState(item?.file_name ?? '');
  const [kind, setKind] = useState<AttachmentKind | ''>(item?.kind ?? '');

  // A decided photo leaves the list; keep the index on the next one.
  useEffect(() => {
    if (index > items.length - 1) setIndex(Math.max(items.length - 1, 0));
  }, [items.length, index]);
  useEffect(() => {
    setName(item?.file_name ?? '');
    setKind(item?.kind ?? '');
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
      if (e.key === 'Escape') onClose();
      else if (!typing && e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, items.length - 1));
      else if (!typing && e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items.length, onClose]);

  if (!item) return null;
  const image = isImageType(item.content_type);
  const url = attachmentUrl(woId, item.id);
  const meta = [formatBytes(item.byte_size), item.uploaded_by?.display_name, numericDate(item.created_at)].filter(Boolean).join(' · ');

  return (
    <div className="modal-scrim prv-scrim" role="presentation" onClick={busy ? undefined : onClose}>
      <div className="prv" role="dialog" aria-modal="true" aria-label="Review photos" onClick={(e) => e.stopPropagation()}>
        <div className="prv-head">
          <span className="prv-count">
            {index + 1} of {items.length} waiting
          </span>
          <span className="prv-hint">← → to step · Esc to close</span>
          <button type="button" className="btn btn-sm is-ghost" onClick={onClose} aria-label="Close the viewer">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="prv-stage">
          <button
            type="button"
            className="prv-nav is-prev"
            disabled={index === 0}
            onClick={() => setIndex((i) => Math.max(i - 1, 0))}
            aria-label="Previous"
          >
            <Icon name="arrow-l" size={18} />
          </button>
          {image ? (
            <img className="prv-img" src={url} alt={item.file_name} />
          ) : (
            <a className="prv-file" href={url} target="_blank" rel="noreferrer">
              <Icon name="clip" size={18} /> Open {item.file_name}
            </a>
          )}
          <button
            type="button"
            className="prv-nav is-next"
            disabled={index >= items.length - 1}
            onClick={() => setIndex((i) => Math.min(i + 1, items.length - 1))}
            aria-label="Next"
          >
            <Icon name="arrow-r" size={18} />
          </button>
        </div>
        <div className="prv-foot">
          <div className="photo-review-fields">
            <input className="fld sm" aria-label="File name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            <select className="fld sm" aria-label="What this file is" value={kind} onChange={(e) => setKind(e.target.value as AttachmentKind | '')}>
              <option value="">What is it?</option>
              {ATTACHMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ATTACHMENT_KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <span className="file-meta">{meta}</span>
          </div>
          <div className="photo-review-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || kind === ''}
              title={kind === '' ? 'Say what this file is first' : undefined}
              onClick={() =>
                kind !== '' && onDecide(item.id, { decision: 'approve', kind, file_name: name.trim() || item.file_name, viewed: true })
              }
            >
              Approve
            </button>
            {item.review_status !== 'declined' && (
              <button type="button" className="btn btn-sm is-ghost" disabled={busy} onClick={() => onDecide(item.id, { decision: 'decline', viewed: true })}>
                Decline
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** M14 (Wave D): the APPROVED photos, for the AR side — the invoice card shows
    what the client will be billed against (before, after, sign-off) without a
    trip to the Photos tab. Quarantined files never appear (the list route
    already hides them from anyone who is not a reviewer or their uploader). */
export function ApprovedPhotosStrip({ woId, items }: { woId: string; items: Attachment[] }) {
  const shown = items.filter((a) => a.has_file && a.review_status === 'approved' && isImageType(a.content_type));
  if (shown.length === 0) return <p className="hint">No approved photos on this work order yet.</p>;
  return (
    <div className="photo-grid prv-strip">
      {shown.map((a) => (
        <figure className="photo" key={a.id}>
          <a className="photo-img is-real" href={attachmentUrl(woId, a.id)} target="_blank" rel="noreferrer" title={`Open ${a.file_name}`}>
            <img src={attachmentUrl(woId, a.id)} alt={a.file_name} loading="lazy" />
            {a.kind && <span className="photo-badge">{ATTACHMENT_KIND_LABEL[a.kind]}</span>}
          </a>
        </figure>
      ))}
    </div>
  );
}
