/* 0061 · Asset management requests: somebody asks for the asset register to
 * change — add one, replace one, retire one, move one — and a manager says
 * yes or no. Approving makes the change.
 *
 *   AssetRequestsTab     the queue (Assets › Requests): waiting first, oldest
 *                        first; decided ones below.
 *   AssetRequestDialog   raise one. "Add" starts from the queue; replace,
 *                        retire and move start from the asset's own page,
 *                        where the asset is already known. */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ASSET_REQUEST_STATUS_LABELS,
  ASSET_REQUEST_TYPE_LABELS,
  assetRequestProblem,
  flattenLocations,
  locationTree,
} from '@theone/shared';
import type { AssetDetail, AssetRequest, AssetRequestInput, AssetRequestType, SitesMetaResponse } from '@theone/shared';
import { createAssetRequest, decideAssetRequest, getSite, listAssetRequests, withdrawAssetRequest } from '../../api/client';
import { feedTime } from '../../lib/fields';
import { useEscape } from '../../lib/useEscape';
import { Icon } from '../Icon';
import { SitePicker, errText } from './PortfolioParts';

const what = (r: AssetRequest): string =>
  r.type === 'add' ? `Add ${r.proposed.name ?? 'an asset'}` : `${r.type === 'replace' ? 'Replace' : r.type === 'retire' ? 'Retire' : 'Move'} ${r.asset?.name ?? 'an asset no longer on file'}`;

export function AssetRequestsTab({ meta, assetId }: { meta: SitesMetaResponse | undefined; assetId?: string }) {
  const qc = useQueryClient();
  const [show, setShow] = useState<'open' | 'all'>(assetId ? 'all' : 'open');
  const key = ['asset-requests', show, assetId ?? ''];
  const q = useQuery({ queryKey: key, queryFn: () => listAssetRequests({ status: show, asset: assetId }) });
  const [adding, setAdding] = useState(false);
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    setRejecting(null);
    setError(null);
    void qc.invalidateQueries({ queryKey: ['asset-requests'] });
    void qc.invalidateQueries({ queryKey: ['assets'] });
    void qc.invalidateQueries({ queryKey: ['asset'] });
    void qc.invalidateQueries({ queryKey: ['site'] });
    void qc.invalidateQueries({ queryKey: ['sites-meta'] });
  };
  const decide = useMutation({
    mutationFn: (x: { id: string; decision: 'approve' | 'reject'; note?: string }) => decideAssetRequest(x.id, x.decision, x.note),
    onSuccess: refresh,
    onError: (e) => setError(errText(e, 'Could not decide the request.')),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => withdrawAssetRequest(id),
    onSuccess: refresh,
    onError: (e) => setError(errText(e, 'Could not withdraw the request.')),
  });
  const rows = q.data?.requests ?? [];

  return (
    <div className="vwork">
      <div className="vwork-bar">
        <div className="seg" role="group" aria-label="Which requests">
          <button type="button" className={`seg-btn${show === 'open' ? ' is-on' : ''}`} aria-pressed={show === 'open'} onClick={() => setShow('open')}>Waiting · {q.data?.open ?? 0}</button>
          <button type="button" className={`seg-btn${show === 'all' ? ' is-on' : ''}`} aria-pressed={show === 'all'} onClick={() => setShow('all')}>All</button>
        </div>
        {!assetId && <span className="hint">To replace, retire or move an asset, open the asset and choose “Request a change”.</span>}
        {!assetId && q.data?.can.create && (
          <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} /> Request a new asset
          </button>
        )}
      </div>
      {error && <span className="err"><Icon name="alert" size={12} />{error}</span>}
      {q.isLoading && <div className="empty-flat">Loading…</div>}
      {q.isError && <div className="empty-flat">{errText(q.error, 'Could not load the requests.')}</div>}
      {q.data && rows.length === 0 && <div className="empty-flat">{show === 'open' ? 'Nothing is waiting for a decision.' : 'No requests yet.'}</div>}
      <ul className="vtasks">
        {rows.map((r) => (
          <li key={r.id} className={`vtask${r.status === 'open' ? '' : ' is-done'}`}>
            <div className="vtask-main">
              <span className={`chip chip-sm${r.status === 'approved' ? ' chip-accent' : r.status === 'rejected' ? ' chip-danger' : ''}`}>{ASSET_REQUEST_STATUS_LABELS[r.status]}</span>
              <b>{what(r)}</b>
              <span className="vtask-meta">
                {r.site && <Link to={`/sites/${r.site.id}`}>{r.site.name}</Link>}
                {r.asset && <Link to={`/assets/${r.asset.id}`}>Open the asset</Link>}
                {r.wo_number && <Link to={`/work-orders/${encodeURIComponent(r.wo_number)}`}>{r.wo_number}</Link>}
                <span>Asked by {r.requested_by?.name ?? 'someone'} · {feedTime(r.created_at)}</span>
              </span>
              <span className="vtask-note">{r.reason}</span>
              {(r.type === 'add' || r.type === 'replace') && (
                <span className="vtask-note pf-muted">
                  {[r.proposed.category, r.proposed.asset_type, r.proposed.manufacturer, r.proposed.model_number, r.proposed.serial_number ? `serial ${r.proposed.serial_number}` : null].filter(Boolean).join(' · ')}
                </span>
              )}
              {r.status !== 'open' && r.status !== 'withdrawn' && (
                <span className="vtask-note">
                  {ASSET_REQUEST_STATUS_LABELS[r.status]} by {r.decided_by?.name ?? 'someone'}{r.decided_at ? ` · ${feedTime(r.decided_at)}` : ''}
                  {r.decision_note ? ` — ${r.decision_note}` : ''}
                  {r.result_asset ? <> · <Link to={`/assets/${r.result_asset.id}`}>{r.result_asset.name}</Link></> : null}
                </span>
              )}
            </div>
            {rejecting?.id === r.id ? (
              <div className="vtask-compose">
                <label className="lbl" htmlFor={`rj-${r.id}`}>Why is it rejected?</label>
                <textarea className="fld" id={`rj-${r.id}`} rows={2} autoFocus value={rejecting.note} onChange={(e) => setRejecting({ id: r.id, note: e.target.value })} />
                <span className="vtask-actions">
                  <button type="button" className="btn btn-sm is-ghost" onClick={() => setRejecting(null)}>Cancel</button>
                  <button type="button" className="btn btn-sm is-danger" disabled={rejecting.note.trim() === '' || decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'reject', note: rejecting.note.trim() })}>Reject</button>
                </span>
              </div>
            ) : (
              (r.can.decide || r.can.withdraw) && (
                <div className="vtask-actions">
                  {r.can.decide && <button type="button" className="btn btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'approve' })}>Approve — make the change</button>}
                  {r.can.decide && <button type="button" className="btn btn-sm is-danger" onClick={() => setRejecting({ id: r.id, note: '' })}>Reject</button>}
                  {r.can.withdraw && <button type="button" className="btn btn-sm is-ghost" disabled={withdraw.isPending} onClick={() => withdraw.mutate(r.id)}>Withdraw</button>}
                </div>
              )
            )}
          </li>
        ))}
      </ul>
      {adding && <AssetRequestDialog asset={null} meta={meta} onClose={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} />}
    </div>
  );
}

export function AssetRequestDialog({ asset, meta, onClose, onDone }: {
  /** Null = ask for a NEW asset. Otherwise the asset to replace, retire or move. */
  asset: AssetDetail | null;
  meta: SitesMetaResponse | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  useEscape(onClose);
  const [type, setType] = useState<AssetRequestType>(asset ? 'replace' : 'add');
  const [site, setSite] = useState<{ id: string; name: string } | null>(asset?.site ? { id: asset.site.id, name: asset.site.name } : null);
  const [reason, setReason] = useState('');
  const [wo, setWo] = useState('');
  const [p, setP] = useState({ name: '', category: asset?.category ?? '', asset_type: asset?.asset_type ?? '', manufacturer: '', model_number: '', serial_number: '', location_id: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const describes = type === 'add' || type === 'replace';
  const placeSite = type === 'add' || type === 'move' ? site : null;
  const siteQ = useQuery({ queryKey: ['site', placeSite?.id], queryFn: () => getSite(placeSite!.id), enabled: Boolean(placeSite) });
  const places = siteQ.data ? flattenLocations(locationTree(siteQ.data.site.locations)) : [];

  const send = useMutation({
    mutationFn: () => {
      const proposed = describes
        ? { name: p.name.trim() || null, category: p.category.trim() || null, asset_type: p.asset_type.trim() || null, manufacturer: p.manufacturer.trim() || null, model_number: p.model_number.trim() || null, serial_number: p.serial_number.trim() || null, location_id: type === 'add' ? p.location_id || null : null }
        : type === 'move' ? { location_id: p.location_id || null } : {};
      const input: AssetRequestInput = {
        type,
        asset_id: asset?.id ?? null,
        site_id: type === 'add' || type === 'move' ? (site?.id ?? null) : null,
        reason: reason.trim(),
        proposed,
        wo_number: wo.trim() || null,
      };
      const bad = assetRequestProblem(input);
      if (bad) throw new Error(`${bad}.`);
      return createAssetRequest(input);
    },
    onMutate: () => setProblem(null),
    onSuccess: onDone,
    onError: (e) => setProblem(errText(e, 'Could not send the request.')),
  });
  const set = (k: keyof typeof p, v: string) => setP((cur) => ({ ...cur, [k]: v }));

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="arT">
      <div className="sheet vend-sheet is-wide pf-sheet">
        <h2 className="sheet-t" id="arT"><Icon name="package" size={16} />{asset ? `Request a change to ${asset.name}` : 'Request a new asset'}</h2>
        <p className="sheet-b">A manager decides. Approving makes the change; until then nothing on the register moves.</p>
        <div className="pf-form">
          {asset && (
            <div className="pf-field is-wide">
              <span className="lbl">What should happen</span>
              <div className="seg" role="group" aria-label="What should happen">
                {(['replace', 'retire', 'move'] as AssetRequestType[]).map((t) => (
                  <button key={t} type="button" className={`seg-btn${type === t ? ' is-on' : ''}`} aria-pressed={type === t} onClick={() => { setType(t); set('location_id', ''); }}>
                    {ASSET_REQUEST_TYPE_LABELS[t].replace(' an asset', '')}
                  </button>
                ))}
              </div>
            </div>
          )}
          {(type === 'add' || type === 'move') && (
            <label className="pf-field is-wide">
              <span className="lbl">{type === 'add' ? 'Site' : 'Move it to (site)'}</span>
              <SitePicker value={site} autoFocus={!site} onPick={(s) => { setSite(s); set('location_id', ''); }} />
            </label>
          )}
          {(type === 'add' || type === 'move') && (
            <label className="pf-field is-wide">
              <span className="lbl">{type === 'add' ? 'Where it stands' : 'Where at that site'}</span>
              <select className="fld" value={p.location_id} disabled={!placeSite} onChange={(e) => set('location_id', e.target.value)}>
                <option value="">Somewhere at the site</option>
                {places.map((l) => <option key={l.id} value={l.id}>{`${'   '.repeat(l.depth)}${l.name}`}</option>)}
              </select>
            </label>
          )}
          {describes && (
            <>
              <label className="pf-field is-wide">
                <span className="lbl">{type === 'add' ? 'Name of the asset' : 'Name of the replacement'}</span>
                <input className="fld" value={p.name} onChange={(e) => set('name', e.target.value)} />
              </label>
              <label className="pf-field">
                <span className="lbl">Category</span>
                <input className="fld" list="ar-cats" value={p.category} onChange={(e) => set('category', e.target.value)} />
                <datalist id="ar-cats">{(meta?.asset_categories ?? []).map((x) => <option key={x} value={x} />)}</datalist>
              </label>
              <label className="pf-field"><span className="lbl">Type</span><input className="fld" value={p.asset_type} onChange={(e) => set('asset_type', e.target.value)} /></label>
              <label className="pf-field"><span className="lbl">Manufacturer</span><input className="fld" value={p.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} /></label>
              <label className="pf-field"><span className="lbl">Model</span><input className="fld" value={p.model_number} onChange={(e) => set('model_number', e.target.value)} /></label>
              <label className="pf-field"><span className="lbl">Serial number</span><input className="fld mono" value={p.serial_number} onChange={(e) => set('serial_number', e.target.value)} /></label>
            </>
          )}
          <label className="pf-field">
            <span className="lbl">Work order (optional)</span>
            <input className="fld mono" value={wo} placeholder="WO-39403" onChange={(e) => setWo(e.target.value)} />
          </label>
          <label className="pf-field is-wide">
            <span className="lbl">Why</span>
            <textarea className="fld" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        {type === 'replace' && <p className="hint">On approval the new asset takes this one’s place at the site and this one is marked retired — its history stays.</p>}
        {problem && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{problem}</p>}
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={send.isPending} onClick={() => send.mutate()}>{send.isPending ? 'Sending…' : 'Send the request'}</button>
        </div>
      </div>
    </div>
  );
}
