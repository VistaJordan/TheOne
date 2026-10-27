import { useEffect, useState } from 'react';
import type { WorkOrderDetailV2 } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DASH } from '../../lib/fields';
import { InlineField, useCanEditField, useWoCatalogue, useWoFieldSave } from './fieldEdit';
import { PENALTY_FIELDS, fieldPermKey } from '@theone/shared';

/** A manager's note (0094: Manager notes on Finances, Manager description on
    Penalties) as an open text box, not a pencil: whoever may edit the field
    types straight into it and it saves when they leave it. Read-only for
    everyone else (the dispatcher tiers, VR Officer, OP Admin). */
export function NoteField({ wo, fieldKey, label, placeholder }: {
  wo: WorkOrderDetailV2;
  fieldKey: string;
  label: string;
  placeholder?: string;
}) {
  const byKey = useWoCatalogue();
  const canEdit = useCanEditField(fieldKey);
  const save = useWoFieldSave(wo.id);
  const jsonKey = fieldKey.slice('fields.'.length);
  const raw = (wo.fields ?? {})[jsonKey];
  const stored = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  const [draft, setDraft] = useState(stored);
  // A save elsewhere (or another person's) refreshes the box.
  useEffect(() => setDraft(stored), [stored]);

  if (!byKey.get(fieldKey) || !canEdit) {
    return <span className="mf-note-ro">{stored.trim() ? stored : DASH}</span>;
  }
  const commit = () => {
    const next = draft.trim();
    if (next === stored.trim()) return;
    save.mutate({ key: fieldKey, value: next === '' ? null : next });
  };
  return (
    <span className="mf-note">
      <textarea
        className="fld mf-note-box"
        rows={2}
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        disabled={save.isPending}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
      {save.error && <span className="ife-err" role="alert">{save.error}</span>}
    </span>
  );
}

/** Labels as the team says them (the field_def labels are title case). */
const PENALTY_LABEL: Record<string, string> = {
  '12. Bad quote': 'Bad quote',
  Penalty: 'Penalty',
  'Late Quote': 'Late quote',
  'Missed ETA': 'Missed ETA',
  Recall: 'Recall',
  'Penalty Description': 'Manager description',
};

/** 2026-10-27 · the Penalties section (0094) as the card of the Penalties tab: the five
    flags as checkboxes, then the manager's description as an open text box.
    Shown to anyone who may see the section; editing follows each field's own
    grant (managers edit, the dispatcher tiers only read). */
export function PenaltiesCard({ wo }: { wo: WorkOrderDetailV2 }) {
  const { can } = useAuth();
  if (!can('work_orders/fields/penalties', 'view')) return null;
  const flags = PENALTY_FIELDS.filter((f) => f.type === 'checkbox' && can(fieldPermKey(`fields.${f.key}`), 'view'));
  const notes = PENALTY_FIELDS.filter((f) => f.type === 'long_text' && can(fieldPermKey(`fields.${f.key}`), 'view'));
  if (flags.length + notes.length === 0) return null;
  return (
    <section className="card card-fin card-penalties">
      <div className="card-head">
        <h2 className="card-title">Penalties</h2>
      </div>
      <dl className="kvlist">
        {flags.map((f) => (
          <div className="kvrow" key={f.key}>
            <dt>{PENALTY_LABEL[f.key] ?? f.label}</dt>
            <dd>
              <InlineField wo={wo} fieldKey={`fields.${f.key}`} label={PENALTY_LABEL[f.key] ?? f.label} />
            </dd>
          </div>
        ))}
        {notes.map((f) => (
          <div className="kvrow is-note" key={f.key}>
            <dt>{PENALTY_LABEL[f.key] ?? f.label}</dt>
            <dd>
              <NoteField
                wo={wo}
                fieldKey={`fields.${f.key}`}
                label={PENALTY_LABEL[f.key] ?? f.label}
                placeholder="What happened, and what it cost us"
              />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
