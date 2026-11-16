import type { WorkOrderDetailV2 } from '../../api/client';
import { FIELD } from '../../lib/fields';
import { deriveParts } from '../../lib/woDerive';
import { Icon } from '../Icon';
import { InlineField } from './fieldEdit';
import { PopRequestBlock } from './PopRequestBlock';

interface PartsCardProps {
  wo: WorkOrderDetailV2;
}

/** Parts tracking from the '👣 Order/Tracking Details' template + parts order
    date. The pencil edits the raw template ("ETA:\nOrder #:\n…") — the summary
    is display. The seeded WOs all carry the blank template, so the honest
    render is the empty state — not a fabricated tag.

    Above it sits rule 11.2.2's Parts Required list (0035): what the job
    needs, one part per line. Waiting for Parts and Please Order Parts are
    refused while it is empty, so the empty state says so. */
export function PartsCard({ wo }: PartsCardProps) {
  const parts = deriveParts(wo);

  return (
    <section className="card">
      <div className="card-head"><h2 className="card-title">Parts</h2></div>
      <div className="parts">
        <span className="parts-ic" aria-hidden="true"><Icon name="list" /></span>
        {/* 2026-11-16 (UAT #44): the list is the team's POP request. */}
        <PopRequestBlock wo={wo} />
      </div>
      <div className="parts">
        <span className="parts-ic" aria-hidden="true"><Icon name="package" /></span>
        <InlineField wo={wo} fieldKey={`fields.${FIELD.orderTracking}`} label="Order and tracking details">
          {parts ? (
            <span>
              <span className="parts-main">
                {parts.tags[0] ?? 'Parts ordered'}
                {parts.orderedOn && (
                  <>
                    <span className="sep-dot">·</span>
                    <span className="num">{parts.orderedOn}</span>
                  </>
                )}
              </span>
              {parts.detail && <span className="parts-sub">{parts.detail}</span>}
            </span>
          ) : (
            <span>
              <span className="parts-main">No parts tracked</span>
              <span className="parts-sub">Order and tracking details are empty on this WO.</span>
            </span>
          )}
        </InlineField>
      </div>
    </section>
  );
}
