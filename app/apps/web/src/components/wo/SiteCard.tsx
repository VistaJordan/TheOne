import type { WorkOrderDetailV2 } from '../../api/client';
import { deriveSite } from '../../lib/woDerive';
import { Icon } from '../Icon';

interface SiteCardProps {
  wo: WorkOrderDetailV2;
}

export function SiteCard({ wo }: SiteCardProps) {
  const site = deriveSite(wo);
  const hasLocation = site.addressLines.length > 0;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Site</h2>
        {site.storeLabel && <span className="card-meta">{site.storeLabel}</span>}
      </div>
      <div className="site-body">
        <div className="site-name">{site.name}</div>
        {hasLocation ? (
          <div className="site-addr">
            {site.addressLines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        ) : (
          <div className="site-addr">No address on file.</div>
        )}
        {site.fm && (
          <div className="site-fm">
            <span>22. FM company</span>
            <span className="chip chip-sm">
              <Icon name="store" size={12} />
              {site.fm}
            </span>
          </div>
        )}
        {hasLocation && (
          <div className="map" role="img" aria-label={`Approximate site location, ${site.mapCaption ?? 'unknown'}`}>
            <span className="map-pin"><Icon name="pin" size={22} /></span>
            {site.mapCaption && <span className="map-cap">{site.mapCaption}</span>}
          </div>
        )}
      </div>
    </section>
  );
}
