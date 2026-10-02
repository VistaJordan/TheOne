/* 0066 · Two vendor-side cards on a work order.
 *
 *   DispatchCard      People tab: offer the job to the preferred vendors in
 *                     turn, see who answered what, record an answer, stop.
 *                     Renders nothing while the cascade is switched off and
 *                     has no history on this work order.
 *   ConsumablesCard   Checklist tab: the small stock the job used up.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DISPATCH_STATUS_LABELS, type DispatchOfferStatus, type WoConsumablesResponse, type WoDispatch } from '@theone/shared';
import { addWoConsumable, answerWoDispatch, getWoConsumables, getWoDispatch, removeWoConsumable, startWoDispatch, stopWoDispatch } from '../../../api/client';
import { Icon } from '../../Icon';
import { errText, stampText, usd } from '../../ui/Sheet';

const OFFER_TONE: Record<DispatchOfferStatus, string> = { offered: ' chip-warn', accepted: ' chip-ok', declined: ' chip-danger', expired: ' chip-outline', cancelled: ' chip-outline' };

export function DispatchCard({ woId }: { woId: string }) {
  const qc = useQueryClient();
  const key = ['wo-dispatch', woId];
  const q = useQuery({ queryKey: key, queryFn: () => getWoDispatch(woId), refetchInterval: (x) => (x.state.data?.live ? 60_000 : false) });
  const [error, setError] = useState<string | null>(null);
  const done = (res: WoDispatch) => {
    qc.setQueryData(key, res);
    setError(null);
    void qc.invalidateQueries({ queryKey: ['wo-record', woId] });
    void qc.invalidateQueries({ queryKey: ['activity'] });
  };
  const fail = (fallback: string) => (e: unknown) => setError(errText(e, fallback));
  const start = useMutation({ mutationFn: () => startWoDispatch(woId), onSuccess: done, onError: fail('Could not start the offers.') });
  const stop = useMutation({ mutationFn: () => stopWoDispatch(woId), onSuccess: done, onError: fail('Could not stop the offers.') });
  const answer = useMutation({ mutationFn: (x: { id: string; answer: 'accept' | 'decline' }) => answerWoDispatch(woId, x.id, x.answer), onSuccess: done, onError: fail('Could not record the answer.') });
  const d = q.data;
  if (!d || !d.can.view) return null;
  // Switched off and never used here: there is nothing to show.
  if (!d.settings.enabled && d.offers.length === 0) return null;
  const busy = start.isPending || stop.isPending || answer.isPending;
  const left = d.candidates.filter((c) => !c.offered && !c.blacklisted);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Dispatch offers</h2>
        {!d.settings.enabled && <span className="chip chip-sm chip-outline">Switched off</span>}
        {d.can.edit && !d.live && left.length > 0 && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => start.mutate()}><Icon name="send" size={12} /> {d.offers.length ? 'Offer to the next vendor' : 'Offer to preferred vendors'}</button>}
        {d.can.edit && d.live && <button type="button" className="btn btn-sm is-ghost" disabled={busy} onClick={() => stop.mutate()}>Stop</button>}
      </div>
      {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
      {d.live && (
        <p className="mt-banner">
          <Icon name="clock" size={14} />
          <span>
            Offered to <Link to={`/vendors/${d.live.vendor.id}`}>{d.live.vendor.name}</Link>{d.live.vendor.phone ? ` · ${d.live.vendor.phone}` : ''}.
            {d.live.expires_at ? ` If there is no answer by ${stampText(d.live.expires_at)}, it goes to the next vendor.` : ''}
          </span>
          {d.can.edit && (
            <span className="mt-acts">
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => answer.mutate({ id: d.live!.id, answer: 'accept' })}>They accepted</button>
              <button type="button" className="btn btn-sm is-ghost" disabled={busy} onClick={() => answer.mutate({ id: d.live!.id, answer: 'decline' })}>They declined</button>
            </span>
          )}
        </p>
      )}
      {d.offers.length > 0 && (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th className="num">#</th><th>Vendor</th><th>Offered</th><th>Answer</th><th>Answered</th></tr></thead>
            <tbody>
              {d.offers.map((o) => (
                <tr key={o.id}>
                  <td className="num">{o.rank}</td>
                  <td><Link to={`/vendors/${o.vendor.id}`}>{o.vendor.name}</Link>{o.note && <small className="mt-sub">{o.note}</small>}</td>
                  <td>{stampText(o.offered_at)}</td>
                  <td><span className={`chip chip-sm${OFFER_TONE[o.status]}`}>{DISPATCH_STATUS_LABELS[o.status]}</span></td>
                  <td>{o.responded_at ? `${stampText(o.responded_at)}${o.responded_via === 'portal' ? ' · on the portal' : o.responded_via === 'system' ? ' · by the clock' : ''}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.offers.length === 0 && (
        <div className="empty-flat">
          {d.candidates.length === 0
            ? 'No preferred vendors are listed for this client and trade (Admin › Vendors & map), so there is nobody to offer it to.'
            : `${left.length} preferred ${left.length === 1 ? 'vendor' : 'vendors'} in line: ${d.candidates.map((c) => c.name).join(', ')}. Each has ${d.settings.hours}h to answer.`}
        </div>
      )}
    </section>
  );
}

export function ConsumablesCard({ woId }: { woId: string }) {
  const qc = useQueryClient();
  const key = ['wo-consumables', woId];
  const q = useQuery({ queryKey: key, queryFn: () => getWoConsumables(woId) });
  const [pick, setPick] = useState('');
  const [typed, setTyped] = useState('');
  const [qty, setQty] = useState('1');
  const [who, setWho] = useState('');
  const [error, setError] = useState<string | null>(null);
  const done = (res: WoConsumablesResponse) => { qc.setQueryData(key, res); setError(null); void qc.invalidateQueries({ queryKey: ['activity'] }); };
  const add = useMutation({
    mutationFn: () => {
      const n = Number(qty);
      if (!(Number.isFinite(n) && n > 0)) throw new Error('The quantity must be more than zero.');
      return addWoConsumable(woId, { ...(pick ? { consumable_id: pick } : { name: typed.trim() }), qty: n, vendor_id: who || null });
    },
    onSuccess: (res) => { done(res); setPick(''); setTyped(''); setQty('1'); },
    onError: (e) => setError(errText(e, 'Could not add it.')),
  });
  const remove = useMutation({ mutationFn: (id: string) => removeWoConsumable(woId, id), onSuccess: done, onError: (e) => setError(errText(e, 'Could not remove it.')) });
  const d = q.data;
  if (!d) return null;
  if (d.items.length === 0 && !d.can.edit) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Consumables</h2>
        {d.total_cost > 0 && <span className="card-meta">{usd(d.total_cost)}</span>}
      </div>
      {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
      {d.items.length === 0 ? (
        <div className="empty-flat">Nothing logged. Note the refrigerant, filters or parts from stock this job used up.</div>
      ) : (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th>Item</th><th className="num">Qty</th><th>Unit</th><th>Used by</th><th className="num">Cost</th><th /></tr></thead>
            <tbody>
              {d.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}{i.note && <small className="mt-sub">{i.note}</small>}</td>
                  <td className="num">{i.qty}</td>
                  <td>{i.unit}</td>
                  <td>{i.vendor ? <Link to={`/vendors/${i.vendor.id}`}>{i.vendor.name}</Link> : '—'}</td>
                  <td className="num">{i.unit_cost === null ? '—' : usd(i.qty * i.unit_cost)}</td>
                  <td className="mt-acts">{d.can.edit && <button type="button" className="icon-btn" aria-label={`Remove ${i.name}`} disabled={remove.isPending} onClick={() => remove.mutate(i.id)}><Icon name="x" size={12} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.can.edit && (
        <form className="rec-add mt-add" onSubmit={(e) => { e.preventDefault(); if (pick || typed.trim()) add.mutate(); }}>
          <select className="fld" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Consumable from the list">
            <option value="">{d.catalogue.length ? 'From the list…' : 'The list is empty'}</option>
            {d.catalogue.map((c) => <option key={c.id} value={c.id}>{c.name}{c.unit_cost !== null ? ` — ${usd(c.unit_cost)} / ${c.unit}` : ''}</option>)}
          </select>
          {!pick && <input className="fld" placeholder="…or type one" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Consumable name" />}
          <input className="fld mt-qty" type="number" min="0.01" step="any" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity" />
          {d.technicians.length > 0 && (
            <select className="fld" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Used by">
              <option value="">Used by…</option>
              {d.technicians.map((t) => <option key={t.vendor_id} value={t.vendor_id}>{t.name}</option>)}
            </select>
          )}
          <button type="submit" className="btn btn-sm" disabled={(!pick && !typed.trim()) || add.isPending}>Add</button>
        </form>
      )}
    </section>
  );
}
