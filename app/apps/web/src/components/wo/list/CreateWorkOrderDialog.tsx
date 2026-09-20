/* "Add work order" — raising one by hand (0041).
 *
 * The form is not written here. It is read from the API, which reads it from
 * field_def.create_mode, which an admin sets in Admin › Custom fields — so a
 * field added there appears here with no deploy. This file only decides how a
 * field is DRAWN (from the same catalogue the detail page edits with) and what
 * the duplicate check says.
 *
 * Two kinds of duplicate, deliberately different:
 *   the WO #      the work order's identity. Taken = Create is refused, trash
 *                 included, with a link to the one holding it. Matching
 *                 ignores case and punctuation, so "wo 12345" and "WO-12345"
 *                 are one number.
 *   a near match  same store, same trade, still open, inside 30 days. A
 *                 warning with links, never a block — a store can break twice.
 *
 * Creation stays lighter than assignment: rule 11.1.1's 13 fields are still
 * demanded before this work order can be assigned or accepted, so raising one
 * from a phone call with only the number is allowed and safe.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  WO_CREATE_MORE_SECTION,
  WO_CREATE_SECTIONS,
  WO_NEAR_DUPLICATE_DAYS,
  describeMissing,
  woCreateMissing,
  type WoCreateField,
  type WoDuplicateHit,
} from '@theone/shared';
import {
  ApiRequestError,
  checkWoNumber,
  createWorkOrder,
  getPrincipals,
  getWoCreateForm,
  type WoFieldDescriptor,
} from '../../../api/client';
import { Icon } from '../../Icon';
import { useWoCatalogue } from '../fieldEdit';

interface CreateWorkOrderDialogProps {
  onClose: () => void;
}

type Values = Record<string, string>;

/** The bag key of the Assignee seat — drawn as a people picker, like intake. */
const ASSIGNEE_KEY = 'Assignee';

/** A datetime-local input wants 'YYYY-MM-DDTHH:mm'; a date input wants ten
    characters. Anything else goes through as typed. */
function valueForApi(raw: string, d: WoFieldDescriptor | undefined): unknown {
  const s = raw.trim();
  if (s === '') return undefined;
  if (d?.type === 'money' || d?.type === 'number') {
    const n = Number(s.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : s;
  }
  if (d?.type === 'datetime') return new Date(s).toISOString();
  return s;
}

export function CreateWorkOrderDialog({ onClose }: CreateWorkOrderDialogProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const catalogue = useWoCatalogue();
  const numberRef = useRef<HTMLInputElement>(null);

  const formQuery = useQuery({ queryKey: ['wo-create-form'], queryFn: getWoCreateForm, staleTime: 60_000 });
  const people = useQuery({ queryKey: ['principals'], queryFn: getPrincipals, staleTime: 5 * 60 * 1000 });

  const [woNumber, setWoNumber] = useState('');
  const [values, setValues] = useState<Values>({});
  const [error, setError] = useState<string | null>(null);
  const [flagged, setFlagged] = useState<Set<string>>(new Set());

  useEffect(() => {
    numberRef.current?.focus();
  }, []);

  const form = useMemo(() => formQuery.data ?? { fields: [] as WoCreateField[] }, [formQuery.data]);

  const set = (key: string, v: string) => {
    setValues((cur) => ({ ...cur, [key]: v }));
    setFlagged((f) => {
      if (!f.has(key)) return f;
      const next = new Set(f);
      next.delete(key);
      return next;
    });
  };

  // ── The duplicate check ────────────────────────────────────────────────────
  // Debounced, and it carries the store and trade so the near-match warning
  // appears as soon as both are in.
  const [debounced, setDebounced] = useState({ wo_number: '', store: '', trade: '' });
  const store = values['Store'] ?? '';
  const trade = values['Trade'] ?? '';
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ wo_number: woNumber.trim(), store, trade }), 300);
    return () => clearTimeout(t);
  }, [woNumber, store, trade]);

  const check = useQuery({
    queryKey: ['wo-number-check', debounced],
    queryFn: () => checkWoNumber(debounced),
    enabled: debounced.wo_number.length > 0 || (debounced.store !== '' && debounced.trade !== ''),
  });

  const taken = check.data?.taken === true && debounced.wo_number === woNumber.trim();
  const near = check.data?.near ?? [];

  // ── What is still missing ──────────────────────────────────────────────────
  const bag = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const f of form.fields) {
      const v = valueForApi(values[f.key] ?? '', catalogue.get(`fields.${f.key}`));
      if (v !== undefined) out[f.key] = v;
    }
    return out;
  }, [form.fields, values, catalogue]);

  const missing = useMemo(() => woCreateMissing(form, bag, woNumber), [form, bag, woNumber]);

  const create = useMutation({
    mutationFn: () => createWorkOrder({ wo_number: woNumber.trim(), fields: bag }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      navigate(`/work-orders/${encodeURIComponent(res.wo_number)}`);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiRequestError) {
        setError(err.message);
        const details = (err as { details?: { missing?: unknown } }).details;
        const list = Array.isArray(details?.missing) ? (details?.missing as string[]) : [];
        const keys = new Set<string>();
        for (const f of form.fields) if (list.includes(f.label)) keys.add(f.key);
        setFlagged(keys);
      } else {
        setError('Could not create the work order');
      }
    },
  });

  const busy = create.isPending;
  const blocked = taken || missing.length > 0 || busy;

  // ── Drawing one field ──────────────────────────────────────────────────────
  const control = (f: WoCreateField) => {
    const d = catalogue.get(`fields.${f.key}`);
    const domId = `new-wo-${f.key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    const val = values[f.key] ?? '';

    if (f.key === ASSIGNEE_KEY) {
      const humans = (people.data?.items ?? []).filter((p) => p.kind === 'human');
      return (
        <select id={domId} className="fld" value={val} onChange={(e) => set(f.key, e.target.value)} disabled={busy}>
          <option value="">Nobody yet</option>
          {humans.map((p) => (
            <option key={p.id} value={p.name}>{p.name}</option>
          ))}
        </select>
      );
    }

    const options = d?.options ?? f.options.map((o) => ({ value: o, label: o }));
    if ((d?.type === 'select' || f.type === 'dropdown') && options.length > 0) {
      const extra = val && !options.some((o) => o.value === val) ? [{ value: val, label: val }] : [];
      return (
        <select id={domId} className="fld" value={val} onChange={(e) => set(f.key, e.target.value)} disabled={busy}>
          <option value="">—</option>
          {[...extra, ...options].map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    }

    if (d?.subtype === 'long_text' || f.type === 'long_text') {
      return (
        <textarea
          id={domId}
          className="fld"
          rows={3}
          value={val}
          onChange={(e) => set(f.key, e.target.value)}
          disabled={busy}
        />
      );
    }

    const type =
      d?.type === 'datetime' || f.type === 'datetime' ? 'datetime-local'
      : d?.type === 'date' || f.type === 'date' ? 'date'
      : d?.type === 'money' || d?.type === 'number' || f.type === 'currency' || f.type === 'number' ? 'number'
      : d?.subtype === 'phone' || f.type === 'phone' ? 'tel'
      : 'text';

    return (
      <input
        id={domId}
        className="fld"
        type={type}
        step={d?.type === 'money' || f.type === 'currency' ? '0.01' : undefined}
        value={val}
        onChange={(e) => set(f.key, e.target.value)}
        disabled={busy}
      />
    );
  };

  const sections = [...WO_CREATE_SECTIONS, WO_CREATE_MORE_SECTION].map((s) => ({
    ...s,
    fields: form.fields.filter((f) => f.section === s.id),
  }));

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div
        className="modal is-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Add work order"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Add work order</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* WO # leads, always required, and checked as it is typed. */}
          <section className="import-step">
            <h3>
              <span className="step-n">1</span> The number
            </h3>
            <div className={`field${taken ? ' is-missing' : ''}`}>
              <label className="lbl" htmlFor="new-wo-number">
                WO # <span className="req" aria-hidden="true">*</span>
              </label>
              <input
                id="new-wo-number"
                ref={numberRef}
                className="fld mono"
                type="text"
                placeholder="The number the client knows this job by"
                value={woNumber}
                onChange={(e) => {
                  setWoNumber(e.target.value);
                  setError(null);
                }}
                disabled={busy}
              />
            </div>

            {taken && check.data?.existing && <TakenNotice hit={check.data.existing} />}
            {!taken && near.length > 0 && <NearNotice hits={near} />}
          </section>

          {/* Everything else, in the order the admin arranged it. */}
          {sections
            .filter((s) => s.fields.length > 0)
            .map((s, i) => (
              <section className="import-step" key={s.id}>
                <h3>
                  <span className="step-n">{i + 2}</span> {s.title}
                </h3>
                <p className="hint">{s.hint}</p>
                <div className="intake-grid">
                  {s.fields.map((f) => (
                    <div
                      className={`field${flagged.has(f.key) ? ' is-missing' : ''}${
                        catalogue.get(`fields.${f.key}`)?.subtype === 'long_text' ? ' intake-wide' : ''
                      }`}
                      key={f.key}
                    >
                      <label className="lbl" htmlFor={`new-wo-${f.key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}>
                        {f.label}
                        {f.mode === 'required' && (
                          <span className="req" aria-hidden="true"> *</span>
                        )}
                      </label>
                      {control(f)}
                    </div>
                  ))}
                </div>
              </section>
            ))}

          {formQuery.isLoading && <p className="hint">Loading the form…</p>}
          {formQuery.isSuccess && form.fields.length === 0 && (
            <p className="hint">
              No fields are on the create form yet. An admin adds them in Admin › Custom fields.
            </p>
          )}
          {error && <p className="modal-error">{error}</p>}
        </div>

        <div className="modal-foot">
          <span className="card-meta">
            {taken ? 'That number is already taken'
            : missing.length > 0 ? `Still needs ${describeMissing(missing)}`
            : 'Ready'}
          </span>
          <button type="button" className="btn-sm is-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-sm is-primary"
            onClick={() => create.mutate()}
            disabled={blocked}
            title={taken ? 'Change the WO # first' : undefined}
          >
            {busy ? 'Creating…' : 'Create work order'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The number is taken: say by what, and link to it. */
function TakenNotice({ hit }: { hit: WoDuplicateHit }) {
  return (
    <p className="modal-error">
      <Icon name="alert" size={14} />{' '}
      <strong>{hit.wo_number}</strong> already exists{hit.deleted ? ' (in the trash)' : ''} —{' '}
      {hit.client ?? 'no client'} · {hit.status}
      {hit.deleted && <> · restoring it would clash, so the number stays taken</>}
      {!hit.deleted && (
        <>
          {' '}
          <a href={`/work-orders/${encodeURIComponent(hit.wo_number)}`}>Open it</a>
        </>
      )}
    </p>
  );
}

/** Not a block: the same store and trade already has something open. */
function NearNotice({ hits }: { hits: WoDuplicateHit[] }) {
  return (
    <div className="hint">
      <Icon name="alert" size={14} /> This store already has {hits.length === 1 ? 'an open work order' : `${hits.length} open work orders`}{' '}
      on this trade in the last {WO_NEAR_DUPLICATE_DAYS} days:
      <ul className="near-dupes">
        {hits.map((h) => (
          <li key={h.wo_number}>
            <a href={`/work-orders/${encodeURIComponent(h.wo_number)}`}>{h.wo_number}</a> · {h.status} · {h.title}
          </li>
        ))}
      </ul>
      Carry on if this is a different job.
    </div>
  );
}
