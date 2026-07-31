import type { WorkOrderDetailV2 } from '../../api/client';
import { DASH } from '../../lib/fields';
import { deriveDates } from '../../lib/woDerive';
import { Icon } from '../Icon';

interface DatesCardProps {
  wo: WorkOrderDetailV2;
}

/** Fixed row set so the card keeps one shape across all 28 seeded WOs —
    missing dates render as a muted em-dash rather than disappearing. */
export function DatesCard({ wo }: DatesCardProps) {
  const rows = deriveDates(wo);

  return (
    <section className="card">
      <div className="card-head"><h2 className="card-title">Dates</h2></div>
      <div className="dates">
        {rows.map((r) => (
          <div className="date-row" key={r.key}>
            <span className="date-k">{r.key}</span>
            <span className={`date-v${r.value == null ? ' is-none' : r.warn ? ' is-warn' : ''}`}>
              {r.warn && r.value != null && <Icon name="alert" size={12} />}
              {r.value ?? DASH}
              {r.warn && r.value != null ? ' · overdue' : ''}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
