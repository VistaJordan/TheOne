import type { WorkOrderAttachment, WorkOrderDetailV2 } from '../../api/client';
import { numericDate } from '../../lib/fields';
import { derivePhotos } from '../../lib/woDerive';
import { Icon } from '../Icon';

const GRADIENTS = ['g1', 'g2', 'g3'];

interface PhotosCardProps {
  wo: WorkOrderDetailV2;
}

/** Attachments when the WO has any; otherwise the comp's two empty groups —
    the card keeps its shape so the page never collapses on a sparse WO. */
export function PhotosCard({ wo }: PhotosCardProps) {
  const { before, after } = derivePhotos(wo);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Photos</h2>
        <span className="card-meta">{before.length} before · {after.length} after</span>
      </div>

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
          <PhotoGrid items={before} badge="Before" />
        ) : (
          <div className="empty">
            <Icon name="camera" />
            Before photos land here once the assessment visit is uploaded
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
          <PhotoGrid items={after} badge="After" />
        ) : (
          <div className="empty">
            <Icon name="camera" />
            After photos land here at soft close
          </div>
        )}
      </div>
    </section>
  );
}

function PhotoGrid({ items, badge }: { items: WorkOrderAttachment[]; badge: string }) {
  return (
    <div className="photo-grid">
      {items.map((a, i) => (
        <figure className="photo" key={a.id}>
          <div className={`photo-img ${GRADIENTS[i % GRADIENTS.length]}`}>
            <span className="photo-badge">{badge}</span>
          </div>
          <figcaption title={a.file_name}>
            {a.file_name}
            {numericDate(a.created_at) ? ` · ${numericDate(a.created_at)}` : ''}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
