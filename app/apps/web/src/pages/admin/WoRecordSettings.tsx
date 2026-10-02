/* Admin › Settings · two cards for the work-order record (0064).
 *
 *   CodesCard        fault codes (what was wrong) and action codes (what was
 *                    done), picked on "Complete service". A code's letters
 *                    never change once made — work orders carry them — but
 *                    its meaning can be reworded, and it can be switched off.
 *   FormLayoutsCard  layouts for "Add work order": for one client and / or
 *                    one trade, which fields are hidden, optional or required,
 *                    over the form's own setting (Admin › Custom fields).
 *
 * Grant: admin/settings edit, like the holiday table beside them. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminPermKey } from '@theone/shared';
import type { WoCode, WoCreateMode, WoFormLayout } from '@theone/shared';
import {
  ApiRequestError,
  addWoCode,
  deleteWoFormLayout,
  getWoCodes,
  getWoFormLayouts,
  saveWoFormLayout,
  updateWoCode,
} from '../../api/client';
import type { WoCodesResponse, WoFormLayoutsResponse } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../../components/Icon';

const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

// ═══ Fault and action codes ══════════════════════════════════════════════════

export function CodesCard() {
  const { can } = useAuth();
  const canEdit = can(adminPermKey('settings'), 'edit');
  const qc = useQueryClient();
  const key = ['admin-wo-codes'];
  const q = useQuery({ queryKey: key, queryFn: getWoCodes, retry: 0 });
  const [kind, setKind] = useState<'fault' | 'action'>('fault');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = (res: WoCodesResponse) => { qc.setQueryData(key, res); setError(null); setRenaming(null); void qc.invalidateQueries({ queryKey: ['wo-record'] }); };
  const add = useMutation({ mutationFn: () => addWoCode({ kind, code: code.trim(), label: label.trim() }), onSuccess: (res) => { done(res); setCode(''); setLabel(''); }, onError: (e) => setError(errText(e, 'Could not add the code.')) });
  const patch = useMutation({ mutationFn: (x: { id: string; patch: { label?: string; is_active?: boolean } }) => updateWoCode(x.id, x.patch), onSuccess: done, onError: (e) => setError(errText(e, 'Could not change the code.')) });
  if (!q.data) return null;
  const rows: WoCode[] = q.data[kind];
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Fault and action codes</h2>
        <div className="seg" role="group" aria-label="Which codes">
          <button type="button" className={`seg-btn${kind === 'fault' ? ' is-on' : ''}`} aria-pressed={kind === 'fault'} onClick={() => setKind('fault')}>Fault · {q.data.fault.filter((c) => c.is_active).length}</button>
          <button type="button" className={`seg-btn${kind === 'action' ? ' is-on' : ''}`} aria-pressed={kind === 'action'} onClick={() => setKind('action')}>Action · {q.data.action.filter((c) => c.is_active).length}</button>
        </div>
      </div>
      <p className="adm-sub" style={{ padding: '0 14px 8px' }}>
        Picked on “Complete service”: {kind === 'fault' ? 'what was wrong' : 'what was done about it'}. A code’s letters never change once made; its meaning can be reworded.
      </p>
      {error && <p className="snooze-err" role="alert" style={{ margin: '0 14px 8px' }}><Icon name="alert-circle" size={12} />{error}</p>}
      <ul className="vadm-list">
        {rows.map((r) => (
          <li key={r.id} className={r.is_active ? undefined : 'is-off'}>
            <span className="chip chip-sm mono">{r.code}</span>
            {renaming?.id === r.id ? (
              <>
                <input className="fld" style={{ flex: 1, height: 28 }} autoFocus value={renaming.label} onChange={(e) => setRenaming({ id: r.id, label: e.target.value })} aria-label="Meaning" />
                <button type="button" className="btn btn-sm" disabled={renaming.label.trim() === '' || patch.isPending} onClick={() => patch.mutate({ id: r.id, patch: { label: renaming.label.trim() } })}>Save</button>
                <button type="button" className="btn btn-sm is-ghost" onClick={() => setRenaming(null)}>Cancel</button>
              </>
            ) : (
              <>
                <span>{r.label}</span>
                {canEdit && (
                  <span className="push" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button type="button" className="link-btn" onClick={() => setRenaming({ id: r.id, label: r.label })}>Reword</button>
                    <button type="button" className="link-btn" disabled={patch.isPending} onClick={() => patch.mutate({ id: r.id, patch: { is_active: !r.is_active } })}>{r.is_active ? 'Switch off' : 'Switch on'}</button>
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form className="vadm-add" onSubmit={(e) => { e.preventDefault(); if (code.trim() && label.trim()) add.mutate(); }}>
          <input className="fld mono" style={{ flex: '0 0 120px' }} placeholder="CODE" value={code} maxLength={20} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-label="Code" />
          <input className="fld" placeholder="What it means" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} aria-label="Meaning" />
          <button type="submit" className="btn btn-sm" disabled={code.trim() === '' || label.trim() === '' || add.isPending}>Add</button>
        </form>
      )}
    </section>
  );
}

// ═══ Create-form layouts ═════════════════════════════════════════════════════

type Draft = { id: string | null; name: string; client: string; trade: string; fields: Record<string, WoCreateMode> };

export function FormLayoutsCard() {
  const { can } = useAuth();
  const canEdit = can(adminPermKey('settings'), 'edit');
  const qc = useQueryClient();
  const key = ['admin-wo-form-layouts'];
  const q = useQuery({ queryKey: key, queryFn: getWoFormLayouts, retry: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = (res: WoFormLayoutsResponse) => { qc.setQueryData(key, res); setDraft(null); setError(null); void qc.invalidateQueries({ queryKey: ['wo-create-form'] }); };
  const save = useMutation({
    mutationFn: () => saveWoFormLayout(draft!.id, { name: draft!.name.trim(), client: draft!.client.trim() || null, trade: draft!.trade.trim() || null, fields: draft!.fields }),
    onSuccess: done,
    onError: (e) => setError(errText(e, 'Could not save the layout.')),
  });
  const toggle = useMutation({
    mutationFn: (l: WoFormLayout) => saveWoFormLayout(l.id, { name: l.name, client: l.client, trade: l.trade, fields: l.fields, is_active: !l.is_active }),
    onSuccess: done,
    onError: (e) => setError(errText(e, 'Could not change the layout.')),
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteWoFormLayout(id), onSuccess: done, onError: (e) => setError(errText(e, 'Could not delete the layout.')) });
  if (!q.data) return null;
  const { layouts, form, clients } = q.data;
  const trades = form.fields.find((f) => f.key === 'Trade')?.options ?? [];
  // Client and Trade decide which layout applies, so a layout cannot touch them.
  const fields = form.fields.filter((f) => f.key !== 'Client' && f.key !== 'Trade');
  const describe = (l: WoFormLayout) => {
    const off = Object.values(l.fields).filter((v) => v === 'off').length;
    const req = Object.values(l.fields).filter((v) => v === 'required').length;
    return [off ? `${off} hidden` : null, req ? `${req} required` : null].filter(Boolean).join(' · ') || 'no changes';
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">“Add work order” layouts</h2>
        {canEdit && draft === null && (
          <button type="button" className="btn btn-sm is-ghost" onClick={() => setDraft({ id: null, name: '', client: '', trade: '', fields: {} })}>
            <Icon name="plus" size={12} /> New layout
          </button>
        )}
      </div>
      <p className="adm-sub" style={{ padding: '0 14px 8px' }}>
        A layout changes the form for one client, one trade, or the two together: fields it hides are gone, fields it requires must be filled.
        Everything else stays as set in Admin › Custom fields. The most specific layout wins (client and trade, then client, then trade).
      </p>
      {error && <p className="snooze-err" role="alert" style={{ margin: '0 14px 8px' }}><Icon name="alert-circle" size={12} />{error}</p>}

      {draft === null ? (
        <ul className="vadm-list">
          {layouts.length === 0 && <li>No layouts — every client and trade sees the same form.</li>}
          {layouts.map((l) => (
            <li key={l.id} className={l.is_active ? undefined : 'is-off'}>
              <span><b>{l.name}</b></span>
              <span className="chip chip-sm">{[l.client, l.trade].filter(Boolean).join(' · ')}</span>
              <span className="pf-muted">{describe(l)}</span>
              {canEdit && (
                <span className="push" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button type="button" className="link-btn" onClick={() => setDraft({ id: l.id, name: l.name, client: l.client ?? '', trade: l.trade ?? '', fields: { ...l.fields } })}>Edit</button>
                  <button type="button" className="link-btn" disabled={toggle.isPending} onClick={() => toggle.mutate(l)}>{l.is_active ? 'Switch off' : 'Switch on'}</button>
                  <button type="button" className="icon-btn" aria-label={`Delete ${l.name}`} disabled={remove.isPending} onClick={() => remove.mutate(l.id)}><Icon name="trash" size={12} /></button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <div className="lay-head">
            <label>Name<input className="fld" autoFocus value={draft.name} maxLength={120} placeholder="e.g. 7-Eleven refrigeration" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label>For the client
              <input className="fld" list="lay-clients" value={draft.client} placeholder="Any client" onChange={(e) => setDraft({ ...draft, client: e.target.value })} />
              <datalist id="lay-clients">{clients.map((c) => <option key={c} value={c} />)}</datalist>
            </label>
            <label>For the trade
              <select className="fld" value={draft.trade} onChange={(e) => setDraft({ ...draft, trade: e.target.value })}>
                <option value="">Any trade</option>
                {draft.trade && !trades.includes(draft.trade) && <option value={draft.trade}>{draft.trade}</option>}
                {trades.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          </div>
          <div className="lay-grid">
            {fields.map((f) => (
              <label key={f.key}>
                <span>{f.label}</span>
                <select
                  className="fld"
                  value={draft.fields[f.key] ?? ''}
                  onChange={(e) => {
                    const next = { ...draft.fields };
                    if (e.target.value === '') delete next[f.key];
                    else next[f.key] = e.target.value as WoCreateMode;
                    setDraft({ ...draft, fields: next });
                  }}
                >
                  <option value="">As set ({f.mode})</option>
                  <option value="off">Hidden</option>
                  <option value="optional">Optional</option>
                  <option value="required">Required</option>
                </select>
              </label>
            ))}
          </div>
          <div className="vadm-add">
            <button type="button" className="btn btn-sm" disabled={draft.name.trim() === '' || (!draft.client.trim() && !draft.trade) || save.isPending} onClick={() => save.mutate()}>
              {draft.id ? 'Save the layout' : 'Add the layout'}
            </button>
            <button type="button" className="btn btn-sm is-ghost" onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
            {!draft.client.trim() && !draft.trade && <span className="pf-muted" style={{ alignSelf: 'center' }}>Pick a client, a trade, or both.</span>}
          </div>
        </>
      )}
    </section>
  );
}
