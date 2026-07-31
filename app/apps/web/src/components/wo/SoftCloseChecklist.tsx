import type { WorkOrderDetailV2 } from '../../api/client';
import { deriveChecklist } from '../../lib/woDerive';
import { Icon } from '../Icon';

interface SoftCloseChecklistProps {
  wo: WorkOrderDetailV2;
}

/** Five gates derived from the fields bag: 'Quote Check', 'Admin Check', 'GTG'
    plus the quote-created and before-photos heuristics. n/5 meter in the head. */
export function SoftCloseChecklist({ wo }: SoftCloseChecklistProps) {
  const items = deriveChecklist(wo);
  const done = items.filter((i) => i.done).length;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Soft-close checklist</h2>
        <span className="meter">
          <span className="meter-cells" aria-hidden="true">
            {items.map((item, i) => (
              <span key={item.label} className={`meter-cell${i < done ? ' is-on' : ''}`} />
            ))}
          </span>
          <span className="meter-txt">{done}/{items.length}</span>
        </span>
      </div>
      <ul className="checks">
        {items.map((item) => (
          <li key={item.label} className={`check${item.done ? ' is-done' : ''}`}>
            <Icon name={item.done ? 'check-circle' : 'circle'} size={14} />
            {item.label}
            <span className="check-note">{item.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
