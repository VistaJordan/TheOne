import type { WorkOrderDetailV2 } from '../../api/client';
import { FIELD } from '../../lib/fields';
import { deriveSite } from '../../lib/woDerive';
import { Icon } from '../Icon';
import { InlineField } from './fieldEdit';

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
        {/* Edits the raw '17. Address' field; the two-line split is display. */}
        <InlineField wo={wo} fieldKey={`fields.${FIELD.address}`} label="Address" className="site-addr-edit">
          {hasLocation ? (
            <span className="site-addr">
              {site.addressLines.map((line, i) => (
                <span className="site-addr-line" key={i}>{line}</span>
              ))}
            </span>
          ) : (
            <span className="site-addr">No address on file.</span>
          )}
        </InlineField>
        {site.fm && (
          <div className="site-fm">
            <span>22. FM company</span>
            <InlineField wo={wo} fieldKey={`fields.${FIELD.fm}`} label="FM company">
              <span className="chip chip-sm">
                <Icon name="store" size={12} />
                {site.fm}
              </span>
            </InlineField>
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
