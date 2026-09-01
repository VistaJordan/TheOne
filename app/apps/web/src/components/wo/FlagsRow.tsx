import type { WorkOrderDetailV2 } from '../../api/client';
import { deriveFlags } from '../../lib/woDerive';
import { useCanEditFields, useWoCatalogue, useWoFieldSave } from './fieldEdit';

interface FlagsRowProps {
  wo: WorkOrderDetailV2;
}

/** The four penalty-exposure checkboxes. Unset reads as "All clear" — the
    fields are absent on most archived WOs, which is the same as false here.
    For editors each flag is a toggle (the same boolean save the All-fields
    checkboxes use); for everyone else it stays a plain indicator. */
export function FlagsRow({ wo }: FlagsRowProps) {
  const flags = deriveFlags(wo);
  const on = flags.filter((f) => f.on);
  const canEdit = useCanEditFields();
  const byKey = useWoCatalogue();
  const save = useWoFieldSave(wo.id);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Flags</h2>
        <span className="card-meta">{on.length === 0 ? 'All clear' : `${on.length} raised`}</span>
      </div>
      <div className="flags">
        {flags.map((f) => {
          const fieldKey = `fields.${f.key}`;
          const editable = canEdit && byKey.has(fieldKey);
          return editable ? (
            <button
              type="button"
              className={`flag flag-btn${f.on ? ' is-on' : ''}`}
              key={f.key}
              disabled={save.isPending}
              aria-pressed={f.on}
              title={`${f.on ? 'Clear' : 'Raise'} ${f.key}`}
              onClick={() => save.mutate({ key: fieldKey, value: !f.on })}
            >
              <i className="flag-dot" aria-hidden="true" />
              {f.key}
            </button>
          ) : (
            <span className={`flag${f.on ? ' is-on' : ''}`} key={f.key}>
              <i className="flag-dot" aria-hidden="true" />
              {f.key}
            </span>
          );
        })}
      </div>
      <div className="flags-cap">
        {save.error
          ? save.error
          : on.length === 0
            ? 'No penalty exposure on this work order.'
            : `Raised: ${on.map((f) => f.key).join(' · ')}`}
      </div>
    </section>
  );
}
