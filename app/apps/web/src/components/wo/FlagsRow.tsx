import type { WorkOrderDetailV2 } from '../../api/client';
import { deriveFlags } from '../../lib/woDerive';

interface FlagsRowProps {
  wo: WorkOrderDetailV2;
}

/** The four penalty-exposure checkboxes. Unset reads as "All clear" — the
    fields are absent on most archived WOs, which is the same as false here. */
export function FlagsRow({ wo }: FlagsRowProps) {
  const flags = deriveFlags(wo);
  const on = flags.filter((f) => f.on);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Flags</h2>
        <span className="card-meta">{on.length === 0 ? 'All clear' : `${on.length} raised`}</span>
      </div>
      <div className="flags">
        {flags.map((f) => (
          <span className={`flag${f.on ? ' is-on' : ''}`} key={f.key}>
            <i className="flag-dot" aria-hidden="true" />
            {f.key}
          </span>
        ))}
      </div>
      <div className="flags-cap">
        {on.length === 0
          ? 'No penalty exposure on this work order.'
          : `Raised: ${on.map((f) => f.key).join(' · ')}`}
      </div>
    </section>
  );
}
