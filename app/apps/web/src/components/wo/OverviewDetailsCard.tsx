import type { WorkOrderDetailV2 } from '../../api/client';
import { FIELD } from '../../lib/fields';
import { InlineField, useWoCatalogue } from './fieldEdit';

interface OverviewDetailsCardProps {
  wo: WorkOrderDetailV2;
}

/** Elise, 2026-11-12 · the head of Overview: where the job is and what it is.
    Address, Store, WO Description and the Sign-Off Link, each editing in place
    under its own field permission (the same InlineField as the other cards). A
    field missing from the viewer's catalogue (no view) is not drawn. */
export const OVERVIEW_DETAIL_KEYS = [
  `fields.${FIELD.address}`,
  `fields.${FIELD.store}`,
  `fields.${FIELD.description}`,
  'fields.24. Sign-Off Link',
] as const;

export function OverviewDetailsCard({ wo }: OverviewDetailsCardProps) {
  const byKey = useWoCatalogue();
  const fields = OVERVIEW_DETAIL_KEYS.map((k) => byKey.get(k)).filter((f): f is NonNullable<typeof f> => Boolean(f));
  if (byKey.size > 0 && fields.length === 0) return null;

  return (
    <section className="card ov-details">
      <div className="card-head"><h2 className="card-title">Job details</h2></div>
      {fields.length === 0 ? (
        <div className="empty-flat">Loading…</div>
      ) : (
        <div className="ov-details-rows">
          {fields.map((f) => (
            <div className={`ov-detail${f.key === `fields.${FIELD.description}` ? ' is-long' : ''}`} key={f.key}>
              <span className="ov-detail-k">{f.label}</span>
              <span className="ov-detail-v">
                <InlineField wo={wo} fieldKey={f.key} label={f.label} />
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
