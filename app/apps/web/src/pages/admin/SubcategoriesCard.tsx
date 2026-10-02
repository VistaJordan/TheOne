/* Admin › Settings · Sub-categories (0063).
 *
 * What each trade can be narrowed to on "Add work order". A trade is our
 * category; these are the suggestions under it. Switched off = no longer
 * suggested; work orders that hold the value keep it. Grant: admin/settings
 * edit, the same as the holiday table beside it. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminPermKey } from '@theone/shared';
import type { WoSubcategoryRow } from '@theone/shared';
import { ApiRequestError, addWoSubcategory, getWoSubcategories, updateWoSubcategory } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../../components/Icon';

const KEY = ['admin-wo-subcategories'];
const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

export function SubcategoriesCard() {
  const { can } = useAuth();
  const canEdit = can(adminPermKey('settings'), 'edit');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: getWoSubcategories, retry: 0 });
  const [trade, setTrade] = useState('');
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = (res: { items: WoSubcategoryRow[]; trades: string[] }) => {
    qc.setQueryData(KEY, res);
    setError(null);
    setRenaming(null);
    void qc.invalidateQueries({ queryKey: ['wo-create-form'] });
  };
  const add = useMutation({
    mutationFn: () => addWoSubcategory({ trade, name: name.trim() }),
    onSuccess: (res) => { done(res); setName(''); },
    onError: (e) => setError(errText(e, 'Could not add it.')),
  });
  const patch = useMutation({
    mutationFn: (x: { id: string; patch: { name?: string; is_active?: boolean } }) => updateWoSubcategory(x.id, x.patch),
    onSuccess: done,
    onError: (e) => setError(errText(e, 'Could not change it.')),
  });
  if (!q.data) return null;

  // Trades from the Trade field's own options, plus any trade that only has
  // sub-categories (an option since renamed keeps its list visible).
  const trades = [...q.data.trades];
  for (const r of q.data.items) if (!trades.some((t) => t.toLowerCase() === r.trade.toLowerCase())) trades.push(r.trade);
  const shown = trade || trades[0] || '';
  const rows = q.data.items.filter((r) => r.trade.toLowerCase() === shown.toLowerCase());
  const count = (t: string) => q.data!.items.filter((r) => r.is_active && r.trade.toLowerCase() === t.toLowerCase()).length;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Sub-categories</h2>
        <span className="card-meta">{q.data.items.filter((r) => r.is_active).length} in use</span>
      </div>
      <p className="adm-sub" style={{ padding: '0 14px 8px' }}>
        What each trade can be narrowed to on “Add work order”. They are suggestions: a dispatcher can still type something that is not on the list.
      </p>
      {error && <p className="snooze-err" role="alert" style={{ margin: '0 14px 8px' }}><Icon name="alert-circle" size={12} />{error}</p>}
      <div className="vadm-add" style={{ paddingBottom: 6 }}>
        <select className="fld" value={shown} onChange={(e) => { setTrade(e.target.value); setRenaming(null); }} aria-label="Trade">
          {trades.map((t) => <option key={t} value={t}>{t} · {count(t)}</option>)}
        </select>
      </div>
      <ul className="vadm-list">
        {rows.length === 0 && <li>No sub-categories for {shown || 'this trade'} yet.</li>}
        {rows.map((r) => (
          <li key={r.id} className={r.is_active ? undefined : 'is-off'}>
            {renaming?.id === r.id ? (
              <>
                <input className="fld" style={{ flex: 1, height: 28 }} autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: r.id, name: e.target.value })} aria-label="New name" />
                <button type="button" className="btn btn-sm" disabled={renaming.name.trim() === '' || patch.isPending} onClick={() => patch.mutate({ id: r.id, patch: { name: renaming.name.trim() } })}>Save</button>
                <button type="button" className="btn btn-sm is-ghost" onClick={() => setRenaming(null)}>Cancel</button>
              </>
            ) : (
              <>
                <span>{r.name}</span>
                {canEdit && (
                  <span className="push" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button type="button" className="link-btn" onClick={() => setRenaming({ id: r.id, name: r.name })}>Rename</button>
                    <button type="button" className="link-btn" disabled={patch.isPending} onClick={() => patch.mutate({ id: r.id, patch: { is_active: !r.is_active } })}>
                      {r.is_active ? 'Switch off' : 'Switch on'}
                    </button>
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {canEdit && shown && (
        <form className="vadm-add" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { if (!trade) setTrade(shown); add.mutate(); } }}>
          <input className="fld" placeholder={`Add a sub-category of ${shown}…`} value={name} maxLength={80} onChange={(e) => { setName(e.target.value); if (!trade) setTrade(shown); }} aria-label="New sub-category" />
          <button type="submit" className="btn btn-sm" disabled={name.trim() === '' || add.isPending}>Add</button>
        </form>
      )}
    </section>
  );
}
