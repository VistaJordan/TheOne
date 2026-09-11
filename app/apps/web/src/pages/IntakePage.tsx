/* /intake and /intake/:draftId — the Incoming Work Order Intake (section
   14, 0040): the OP Admin's staging area.

   /intake          the staging list (14.3.1): every draft started or saved
                    that has not been submitted — what still has to be
                    typed, who it is meant for, who touched it last.
   /intake/new      handled by the list: "New work order" starts a draft on
                    the API and opens it.
   /intake/:id      the manual entry form (14.2.x): WO#, the thirteen
                    11.1.1 fields, Client, and the Assignee dropdown. Save
                    keeps a draft; Submit needs every required field AND an
                    assignee (14.3.2) and turns the draft into a real work
                    order, then opens it (14.3.3).

   The fields are drawn from the same catalogue the work-order editor uses
   (types and dropdown options), keyed `fields.<bag key>`, so a value typed
   here is exactly what the work order will carry. The API is the judge:
   Submit answers 409 with the list of what is still empty, and the form
   marks those fields. */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INTAKE_FORM_FIELDS,
  intakeDraftMissing,
  intakeValueFilled,
  type IntakeDraft,
  type IntakeDraftInput,
  type IntakeFormField,
  type WoFieldDescriptor,
} from '@theone/shared';
import {
  ApiRequestError,
  createIntakeDraft,
  discardIntakeDraft,
  getIntakeDraft,
  getPrincipals,
  listIntakeDrafts,
  submitIntakeDraft,
  updateIntakeDraft,
} from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { useWoCatalogue } from '../components/wo/fieldEdit';

const DASH = '—';

export function IntakePage() {
  const { draftId } = useParams<{ draftId: string }>();
  return draftId ? <DraftForm id={draftId} /> : <DraftsList />;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function when(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** An ISO stamp → what a datetime-local input takes, in the viewer's zone. */
function toLocalInput(raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '';
  const s = String(raw);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.length >= 16 ? s.slice(0, 16) : s;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** What a datetime-local input holds → an ISO stamp (UTC), the shape the
    work-order editor writes; blank → null. */
function fromLocalInput(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function str(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'object') return JSON.stringify(raw);
  return String(raw);
}

type Values = Record<string, string>;

/** The form's text values from a draft's bag, by the catalogue's types. */
function valuesOf(draft: IntakeDraft, catalogue: Map<string, WoFieldDescriptor>): Values {
  const out: Values = { wo_number: draft.wo_number ?? '', assignee: draft.assignee ?? '' };
  for (const f of INTAKE_FORM_FIELDS) {
    const d = catalogue.get(`fields.${f.key}`);
    const raw = draft.fields[f.key];
    out[f.key] = d?.type === 'datetime' ? toLocalInput(raw) : d?.type === 'date' ? str(raw).slice(0, 10) : str(raw);
  }
  return out;
}

/** The bag patch to send: blanks clear, dates go back to ISO, money to a number. */
function fieldsPatch(values: Values, catalogue: Map<string, WoFieldDescriptor>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of INTAKE_FORM_FIELDS) {
    const d = catalogue.get(`fields.${f.key}`);
    const v = (values[f.key] ?? '').trim();
    if (v === '') {
      out[f.key] = null;
    } else if (d?.type === 'datetime') {
      out[f.key] = fromLocalInput(v);
    } else if (d?.type === 'money' || d?.type === 'number') {
      const n = Number(v.replace(/[$,\s]/g, ''));
      out[f.key] = Number.isFinite(n) ? n : v;
    } else {
      out[f.key] = v;
    }
  }
  return out;
}

// ── The staging list (14.3.1) ────────────────────────────────────────────────

function DraftsList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const drafts = useQuery({ queryKey: ['intake-drafts'], queryFn: listIntakeDrafts });
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => createIntakeDraft({}),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['intake-drafts'] });
      navigate(`/intake/${encodeURIComponent(res.item.id)}`);
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : 'Could not start a work order'),
  });

  const items = drafts.data?.items ?? [];

  return (
    <AppShell active="WO Intake">
      <div className="page-head intake-page-head">
        <p className="page-sub">
          {drafts.isLoading
            ? 'Loading…'
            : `${items.length} draft${items.length === 1 ? '' : 's'} waiting · a work order leaves the intake once every field is filled and it is assigned`}
        </p>
        <div className="intake-head-actions">
          <button type="button" className="btn btn-primary" onClick={() => start.mutate()} disabled={start.isPending}>
            <Icon name="plus" size={14} />
            New work order
          </button>
        </div>
      </div>
      {error && <p className="payq-err" role="alert">{error}</p>}
      {drafts.isError && (
        <p className="payq-err" role="alert">
          {drafts.error instanceof ApiRequestError && drafts.error.status === 403
            ? 'You do not have access to the work order intake.'
            : 'Could not load the intake drafts.'}
        </p>
      )}
      {!drafts.isError && (
        <div className="card intake-list">
          <div className="intake-tbl">
            <table className="ct">
              <thead>
                <tr>
                  <th>WO#</th>
                  <th>Client · Store</th>
                  <th>Trade</th>
                  <th>FM</th>
                  <th>Still to fill</th>
                  <th>Assignee</th>
                  <th>Last touched</th>
                </tr>
              </thead>
              <tbody>
                {drafts.isLoading && (
                  <tr className="ct-empty"><td colSpan={7}>Loading the intake…</td></tr>
                )}
                {!drafts.isLoading && items.length === 0 && (
                  <tr className="ct-empty"><td colSpan={7}>No drafts are waiting. Start one with New work order.</td></tr>
                )}
                {items.map((d) => {
                  const need = d.missing.length + (intakeValueFilled(d.assignee) ? 0 : 1);
                  return (
                    <tr
                      key={d.id}
                      className="is-link"
                      onClick={() => navigate(`/intake/${encodeURIComponent(d.id)}`)}
                    >
                      <td className="mono">{d.wo_number?.trim() || <span className="intake-dim">No WO# yet</span>}</td>
                      <td>
                        {str(d.fields['Client']) || DASH}
                        {str(d.fields['Store']) && <span className="intake-dim"> · {str(d.fields['Store'])}</span>}
                      </td>
                      <td>{str(d.fields['Trade']) || DASH}</td>
                      <td>{str(d.fields['22. FM']) || DASH}</td>
                      <td>
                        {need === 0 ? (
                          <span className="chip chip-sm chip-accent"><Icon name="check" size={12} />Ready to submit</span>
                        ) : (
                          <span className="chip chip-sm chip-outline intake-need" title={[...d.missing, ...(intakeValueFilled(d.assignee) ? [] : ['Assignee'])].join(', ')}>
                            {need} field{need === 1 ? '' : 's'}
                          </span>
                        )}
                      </td>
                      <td>{d.assignee?.trim() || <span className="intake-dim">Not assigned</span>}</td>
                      <td>
                        {when(d.updated_at)}
                        {d.updated_by && <span className="intake-dim"> · {d.updated_by.display_name}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AppShell>
  );
}

// ── The manual entry form (14.2.x) ───────────────────────────────────────────

function DraftForm({ id }: { id: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const catalogue = useWoCatalogue();
  const draftQuery = useQuery({ queryKey: ['intake-draft', id], queryFn: () => getIntakeDraft(id) });
  const people = useQuery({ queryKey: ['principals'], queryFn: getPrincipals, staleTime: 5 * 60 * 1000 });

  const draft = draftQuery.data?.item ?? null;
  const [values, setValues] = useState<Values | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Seed the form once the draft and the catalogue are in; a later refetch
  // never overwrites what is being typed.
  useEffect(() => {
    if (draft && values === null && catalogue.size > 0) setValues(valuesOf(draft, catalogue));
  }, [draft, values, catalogue]);

  const set = (key: string, v: string) => {
    setValues((cur) => ({ ...(cur ?? {}), [key]: v }));
    setFlagged((f) => {
      if (!f.has(key)) return f;
      const next = new Set(f);
      next.delete(key);
      return next;
    });
  };

  const input = (): IntakeDraftInput => ({
    wo_number: (values?.wo_number ?? '').trim() || null,
    assignee: (values?.assignee ?? '').trim() || null,
    fields: values ? fieldsPatch(values, catalogue) : {},
  });

  /** What the form, as typed, still lacks — the same check the API runs. */
  const missingNow = useMemo(() => {
    if (!values) return { labels: [] as string[], keys: new Set<string>(), assignee: false };
    const fields = fieldsPatch(values, catalogue);
    const labels = intakeDraftMissing({ wo_number: values.wo_number.trim() || null, fields });
    const keys = new Set<string>();
    if (labels.includes('WO#')) keys.add('wo_number');
    for (const f of INTAKE_FORM_FIELDS) if (labels.includes(f.label)) keys.add(f.key);
    return { labels, keys, assignee: values.assignee.trim() === '' };
  }, [values, catalogue]);

  const dirty = useMemo(() => {
    if (!draft || !values) return false;
    const base = valuesOf(draft, catalogue);
    return Object.keys(values).some((k) => (values[k] ?? '') !== (base[k] ?? ''));
  }, [draft, values, catalogue]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['intake-drafts'] });
    void qc.invalidateQueries({ queryKey: ['intake-draft', id] });
  };
  const fail = (fallback: string) => (err: unknown) => {
    if (err instanceof ApiRequestError) {
      setError(err.message);
      const details = (err as { details?: { missing?: unknown; assignee_missing?: unknown } }).details;
      const missing = Array.isArray(details?.missing) ? (details?.missing as string[]) : [];
      const keys = new Set<string>();
      if (missing.includes('WO#')) keys.add('wo_number');
      for (const f of INTAKE_FORM_FIELDS) if (missing.includes(f.label)) keys.add(f.key);
      if (details?.assignee_missing) keys.add('assignee');
      setFlagged(keys);
    } else {
      setError(fallback);
    }
  };

  const save = useMutation({
    mutationFn: () => updateIntakeDraft(id, input()),
    onSuccess: (res) => {
      setError(null);
      setValues(valuesOf(res.item, catalogue));
      invalidate();
    },
    onError: fail('Could not save the draft'),
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (dirty) await updateIntakeDraft(id, input());
      return submitIntakeDraft(id);
    },
    onSuccess: (res) => {
      setError(null);
      invalidate();
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      navigate(`/work-orders/${encodeURIComponent(res.wo_number)}`);
    },
    onError: fail('Could not submit the work order'),
  });

  const discard = useMutation({
    mutationFn: () => discardIntakeDraft(id),
    onSuccess: () => {
      invalidate();
      navigate('/intake');
    },
    onError: fail('Could not discard the draft'),
  });

  const busy = save.isPending || submit.isPending || discard.isPending;
  const ready = missingNow.labels.length === 0 && !missingNow.assignee;

  const crumbs = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button type="button" className="crumb-back" aria-label="Back to the intake" onClick={() => navigate('/intake')}>
        <Icon name="arrow-l" size={14} />
      </button>
      <Link className="crumb" to="/intake">WO Intake</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <span className="crumb-cur" aria-current="page">
        {draft?.wo_number?.trim() ? draft.wo_number : 'New work order'}
      </span>
    </nav>
  );

  if (draftQuery.isLoading || (draft && values === null && catalogue.size === 0)) {
    return (
      <AppShell active="WO Intake" breadcrumb={crumbs}>
        <div className="wo-state"><b>Loading the draft…</b></div>
      </AppShell>
    );
  }
  if (draftQuery.isError || !draft) {
    return (
      <AppShell active="WO Intake" breadcrumb={crumbs}>
        <div className="wo-state">
          <b>This draft could not be loaded.</b>
          <Link className="btn" to="/intake">Back to the intake</Link>
        </div>
      </AppShell>
    );
  }
  if (draft.submitted_at) {
    const wo = draft.submitted_wo_number ?? draft.wo_number ?? '';
    return (
      <AppShell active="WO Intake" breadcrumb={crumbs}>
        <section className="card intake-done">
          <h1 className="pg-title">Submitted</h1>
          <p>
            This draft became work order <b className="mono">{wo}</b> on {when(draft.submitted_at)}
            {draft.assignee ? `, assigned to ${draft.assignee}` : ''}.
          </p>
          <div className="intake-actions">
            <Link className="btn btn-primary" to={`/work-orders/${encodeURIComponent(wo)}`}>Open the work order</Link>
            <Link className="btn" to="/intake">Back to the intake</Link>
          </div>
        </section>
      </AppShell>
    );
  }
  if (draft.discarded_at) {
    return (
      <AppShell active="WO Intake" breadcrumb={crumbs}>
        <section className="card intake-done">
          <h1 className="pg-title">Discarded</h1>
          <p>This draft was discarded on {when(draft.discarded_at)}. It is kept for the audit trail only.</p>
          <div className="intake-actions">
            <Link className="btn" to="/intake">Back to the intake</Link>
          </div>
        </section>
      </AppShell>
    );
  }

  const v = values ?? valuesOf(draft, catalogue);
  const humans = (people.data?.items ?? []).filter((p) => p.kind === 'human');
  const assigneeOptions =
    v.assignee && !humans.some((p) => p.name === v.assignee) ? [{ id: 'current', name: v.assignee }, ...humans] : humans;

  const isMissing = (key: string) => flagged.has(key) || (submit.isError && missingNow.keys.has(key));

  const control = (f: IntakeFormField) => {
    const d = catalogue.get(`fields.${f.key}`);
    const domId = `intake-${f.key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    const val = v[f.key] ?? '';
    const cls = 'fld';
    if (d?.type === 'select' && (d.options?.length ?? 0) > 0) {
      const opts = d.options ?? [];
      const extra = val && !opts.some((o) => o.value === val) ? [{ value: val, label: val }] : [];
      return (
        <select id={domId} className={cls} value={val} onChange={(e) => set(f.key, e.target.value)} disabled={busy}>
          <option value="">{DASH}</option>
          {[...extra, ...opts].map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    }
    if (d?.subtype === 'long_text') {
      return <textarea id={domId} className={cls} rows={4} value={val} onChange={(e) => set(f.key, e.target.value)} disabled={busy} />;
    }
    const type =
      d?.type === 'datetime' ? 'datetime-local'
      : d?.type === 'date' ? 'date'
      : d?.type === 'money' || d?.type === 'number' ? 'number'
      : d?.subtype === 'phone' ? 'tel'
      : 'text';
    return (
      <input
        id={domId}
        className={cls}
        type={type}
        step={d?.type === 'money' ? '0.01' : undefined}
        value={val}
        onChange={(e) => set(f.key, e.target.value)}
        disabled={busy}
      />
    );
  };

  return (
    <AppShell active="WO Intake" breadcrumb={crumbs}>
      <div className="canvas-inner intake">
        <section className="card">
          <div className="card-head">
            <h1 className="card-title">
              {draft.wo_number?.trim() ? `Work order ${draft.wo_number}` : 'New work order'}
              <span className="chip chip-sm chip-outline">Draft</span>
            </h1>
            <span className="card-meta">
              <span className="req" aria-hidden="true">*</span> required before submitting (rule 14.2.2)
            </span>
          </div>

          <div className="intake-grid">
            <div className={`field${isMissing('wo_number') ? ' is-missing' : ''}`}>
              <label className="lbl" htmlFor="intake-wo-number">
                WO# <span className="req" aria-hidden="true">*</span>
              </label>
              <input
                id="intake-wo-number"
                className="fld mono"
                type="text"
                placeholder="The client's work order number"
                value={v.wo_number}
                onChange={(e) => set('wo_number', e.target.value)}
                disabled={busy}
              />
            </div>
            {INTAKE_FORM_FIELDS.map((f) => (
              <div
                key={f.key}
                className={`field${isMissing(f.key) ? ' is-missing' : ''}${catalogue.get(`fields.${f.key}`)?.subtype === 'long_text' ? ' intake-wide' : ''}`}
              >
                <label className="lbl" htmlFor={`intake-${f.key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}>
                  {f.label}
                  {f.required && <span className="req" aria-hidden="true">*</span>}
                </label>
                {control(f)}
              </div>
            ))}
            <div className={`field${isMissing('assignee') ? ' is-missing' : ''}`}>
              <label className="lbl" htmlFor="intake-assignee">
                Assignee <span className="req" aria-hidden="true">*</span>
              </label>
              <select
                id="intake-assignee"
                className="fld"
                value={v.assignee}
                onChange={(e) => set('assignee', e.target.value)}
                disabled={busy}
              >
                <option value="">Pick the dispatcher it goes to</option>
                {assigneeOptions.map((p) => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>

          {error && <p className="payq-err" role="alert">{error}</p>}

          <div className="intake-foot">
            <div className="intake-status">
              {ready ? (
                <span className="chip chip-sm chip-accent"><Icon name="check" size={12} />Ready to submit</span>
              ) : (
                <span className="intake-dim">
                  <Icon name="alert-circle" size={12} />{' '}
                  Still to fill: {[...missingNow.labels, ...(missingNow.assignee ? ['Assignee'] : [])].join(', ')}
                </span>
              )}
            </div>
            <div className="intake-actions">
              {confirmDiscard ? (
                <>
                  <span className="intake-dim">Discard this draft?</span>
                  <button type="button" className="btn btn-danger" onClick={() => discard.mutate()} disabled={busy}>
                    Yes, discard
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirmDiscard(false)} disabled={busy}>
                    Keep it
                  </button>
                </>
              ) : (
                <button type="button" className="btn" onClick={() => setConfirmDiscard(true)} disabled={busy}>
                  <Icon name="trash" size={14} />
                  Discard
                </button>
              )}
              <button type="button" className="btn" onClick={() => save.mutate()} disabled={busy || !dirty}>
                <Icon name="check" size={14} />
                Save draft
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => submit.mutate()}
                disabled={busy || !ready}
                title={ready ? 'Creates the work order and assigns it' : 'Fill every required field and pick an assignee first'}
              >
                <Icon name="send" size={14} />
                Submit &amp; assign
              </button>
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
