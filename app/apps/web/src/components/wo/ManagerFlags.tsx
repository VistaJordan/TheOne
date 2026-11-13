import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, patchWorkOrderFields, type WorkOrderDetailV2 } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DASH } from '../../lib/fields';
import { useCanEditField, useWoCatalogue, useWoFieldSave } from './fieldEdit';
import { PENALTY_FIELDS, fieldPermKey, flagTicked, penaltyDescriptionProblem } from '@theone/shared';

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
    flags as checkboxes, then the manager's description. Shown to anyone who
    may see the section; editing follows each field's own grant (managers
    edit, the dispatcher tiers only read).
    2026-11-13 (Elise): a ticked penalty needs its explanation, so the ticks
    and the description are drafted together and saved with one Save — the
    API refuses a tick with no description (`penaltyDescriptionProblem`). */
export function PenaltiesCard({ wo }: { wo: WorkOrderDetailV2 }) {
  const { can } = useAuth();
  const visible = can('work_orders/fields/penalties', 'view');
  const flags = PENALTY_FIELDS.filter((f) => f.type === 'checkbox' && can(fieldPermKey(`fields.${f.key}`), 'view'));
  const notes = PENALTY_FIELDS.filter((f) => f.type === 'long_text' && can(fieldPermKey(`fields.${f.key}`), 'view'));
  const editable = (k: string) => can(fieldPermKey(`fields.${k}`), 'edit');
  const bag = wo.fields ?? {};
  const stored = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of PENALTY_FIELDS) {
      const v = bag[f.key];
      out[f.key] = f.type === 'checkbox' ? (flagTicked(v) ? 'true' : '') : typeof v === 'string' ? v : v == null ? '' : String(v);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(PENALTY_FIELDS.map((f) => bag[f.key]))]);
  const [draft, setDraft] = useState(stored);
  const [tried, setTried] = useState(false);
  useEffect(() => setDraft(stored), [stored]);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) => patchWorkOrderFields(wo.id, values),
    onSuccess: () => {
      setTried(false);
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      void qc.invalidateQueries({ queryKey: ['wo-activity'] });
      void qc.invalidateQueries({ queryKey: ['wo-feed'] });
      void qc.invalidateQueries({ queryKey: ['wo-field-history', wo.id] });
    },
  });

  if (!visible || flags.length + notes.length === 0) return null;
  const anyEditable = [...flags, ...notes].some((f) => editable(f.key));
  const dirtyKeys = PENALTY_FIELDS.filter((f) => editable(f.key) && (draft[f.key] ?? '').trim() !== (stored[f.key] ?? '').trim()).map((f) => f.key);
  const problem = penaltyDescriptionProblem(draft, dirtyKeys);
  const submit = () => {
    setTried(true);
    if (problem || dirtyKeys.length === 0) return;
    const values: Record<string, unknown> = {};
    for (const k of dirtyKeys) {
      const f = PENALTY_FIELDS.find((x) => x.key === k)!;
      const v = (draft[k] ?? '').trim();
      values[`fields.${k}`] = f.type === 'checkbox' ? v === 'true' : v === '' ? null : v;
    }
    save.mutate(values);
  };
  const saveError = save.error ? (save.error instanceof ApiRequestError ? save.error.message : 'Could not save the penalties') : null;

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
              <label className="tmap-check">
                <input
                  type="checkbox"
                  checked={draft[f.key] === 'true'}
                  disabled={!editable(f.key) || save.isPending}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.checked ? 'true' : '' }))}
                  aria-label={PENALTY_LABEL[f.key] ?? f.label}
                />
                <span>Yes</span>
              </label>
            </dd>
          </div>
        ))}
        {notes.map((f) => (
          <div className="kvrow is-note" key={f.key}>
            <dt>{PENALTY_LABEL[f.key] ?? f.label}{flags.some((x) => draft[x.key] === 'true') && <span className="req"> *</span>}</dt>
            <dd>
              {editable(f.key) ? (
                <span className="mf-note">
                  <textarea
                    className={`fld mf-note-box${tried && problem ? ' is-err' : ''}`}
                    rows={2}
                    aria-label={PENALTY_LABEL[f.key] ?? f.label}
                    placeholder="What happened, and what it cost us"
                    value={draft[f.key] ?? ''}
                    disabled={save.isPending}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  />
                </span>
              ) : (
                <span className="mf-note-ro">{(stored[f.key] ?? '').trim() ? stored[f.key] : DASH}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {anyEditable && (
        <div className="mf-actions">
          {tried && problem && <span className="ife-err" role="alert">{problem}</span>}
          {saveError && <span className="ife-err" role="alert">{saveError}</span>}
          <button type="button" className="btn btn-sm" disabled={dirtyKeys.length === 0 || save.isPending} onClick={() => { setDraft(stored); setTried(false); save.reset(); }}>
            Undo
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={dirtyKeys.length === 0 || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save penalties'}
          </button>
        </div>
      )}
    </section>
  );
}
