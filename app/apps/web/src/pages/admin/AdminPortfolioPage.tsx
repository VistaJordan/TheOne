/* Admin › Sites & assets (0061).
 *
 *   Site types · Asset categories   the two lists the forms suggest from. Add
 *                                   a value, rename it (every record that
 *                                   holds it is renamed with it), or switch
 *                                   it off so it is no longer suggested.
 *   Site access                     who is restricted to a list of sites.
 *                                   Nobody listed = no restriction. Super
 *                                   admins only, like per-person permissions. */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminPermKey } from '@theone/shared';
import type { AdminPortfolioResponse, PortfolioListItem, PortfolioListName, SiteAccessPerson } from '@theone/shared';
import { ApiRequestError, addPortfolioListValue, getAdminPortfolio, setSiteAccess, updatePortfolioListValue } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../../components/Icon';
import { SitePicker } from '../../components/portfolio/PortfolioParts';
import { AdminEmpty, AdminShell } from './AdminShell';

const KEY = ['admin-portfolio'];
const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

export function AdminPortfolioPage() {
  const { can, actingAs } = useAuth();
  const canEdit = can(adminPermKey('portfolio'), 'edit');
  const q = useQuery({ queryKey: KEY, queryFn: getAdminPortfolio, retry: 0 });
  const d = q.data;
  return (
    <AdminShell
      title="Sites & assets"
      subtitle={<>The lists behind <Link to="/sites">Sites</Link> and <Link to="/assets">Assets</Link>, and who is restricted to which sites.</>}
    >
      {q.isLoading && <AdminEmpty icon="store" title="Loading…" />}
      {q.isError && <AdminEmpty icon="alert" title="Could not load these settings" />}
      {d && (
        <div className="vadm">
          <div className="vadm-lists">
            <ListCard list="site-types" title="Site types" note="What a site can be filed as. A value switched off is no longer suggested; sites that hold it keep it." items={d.site_types} canEdit={canEdit} />
            <ListCard list="asset-categories" title="Asset categories" note="The broad kinds of equipment. A value switched off is no longer suggested; assets that hold it keep it." items={d.asset_categories} canEdit={canEdit} />
          </div>
          {d.site_access !== null ? (
            <SiteAccessCard data={d} />
          ) : (
            <section className="card">
              <div className="card-head"><h2 className="card-title">Site access</h2></div>
              <p className="adm-sub" style={{ padding: '0 14px 14px' }}>
                Restricting a person to a list of sites is done by a super admin{actingAs?.is_super_admin ? '' : ' — ask one of them'}.
              </p>
            </section>
          )}
        </div>
      )}
    </AdminShell>
  );
}

function ListCard({ list, title, note, items, canEdit }: { list: PortfolioListName; title: string; note: string; items: PortfolioListItem[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ value: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = (res: AdminPortfolioResponse) => {
    qc.setQueryData(KEY, res);
    setError(null);
    setRenaming(null);
    void qc.invalidateQueries({ queryKey: ['sites-meta'] });
  };
  const add = useMutation({
    mutationFn: () => addPortfolioListValue(list, name.trim()),
    onSuccess: (res) => { done(res); setName(''); },
    onError: (e) => setError(errText(e, 'Could not add it.')),
  });
  const patch = useMutation({
    mutationFn: (x: { value: string; patch: { name?: string; is_active?: boolean } }) => updatePortfolioListValue(list, x.value, x.patch),
    onSuccess: done,
    onError: (e) => setError(errText(e, 'Could not change it.')),
  });
  return (
    <section className="card">
      <div className="card-head"><h2 className="card-title">{title}</h2></div>
      <p className="hint" style={{ padding: '0 14px 6px', margin: 0 }}>{note}</p>
      {error && <p className="snooze-err" role="alert" style={{ margin: '0 14px 6px' }}><Icon name="alert-circle" size={12} />{error}</p>}
      <ul className="vadm-list">
        {items.map((it) => (
          <li key={it.name} className={it.is_active ? undefined : 'is-off'}>
            {renaming?.value === it.name ? (
              <>
                <input className="fld" style={{ flex: 1, height: 28 }} autoFocus value={renaming.name} onChange={(e) => setRenaming({ value: it.name, name: e.target.value })} aria-label="New name" />
                <button type="button" className="btn btn-sm" disabled={renaming.name.trim() === '' || patch.isPending} onClick={() => patch.mutate({ value: it.name, patch: { name: renaming.name.trim() } })}>Save</button>
                <button type="button" className="btn btn-sm is-ghost" onClick={() => setRenaming(null)}>Cancel</button>
              </>
            ) : (
              <>
                <span>{it.name}</span>
                {it.in_use > 0 && <span className="chip chip-sm" title="Records that hold this value">{it.in_use}</span>}
                {canEdit && (
                  <span className="push" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button type="button" className="link-btn" onClick={() => setRenaming({ value: it.name, name: it.name })}>Rename</button>
                    <button type="button" className="link-btn" disabled={patch.isPending} onClick={() => patch.mutate({ value: it.name, patch: { is_active: !it.is_active } })}>
                      {it.is_active ? 'Switch off' : 'Switch on'}
                    </button>
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form className="vadm-add" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(); }}>
          <input className="fld" placeholder="Add a value…" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label={`New ${title.toLowerCase()} value`} />
          <button type="submit" className="btn btn-sm" disabled={name.trim() === '' || add.isPending}>Add</button>
        </form>
      )}
    </section>
  );
}

function SiteAccessCard({ data }: { data: AdminPortfolioResponse }) {
  const qc = useQueryClient();
  const [who, setWho] = useState('');
  const [error, setError] = useState<string | null>(null);
  const restricted = data.site_access ?? [];
  const save = useMutation({
    mutationFn: (x: { id: string; sites: string[] }) => setSiteAccess(x.id, x.sites),
    onSuccess: (res) => { qc.setQueryData(KEY, res); setError(null); },
    onError: (e) => setError(errText(e, 'Could not save.')),
  });
  // People who can be restricted: not super admins, not already listed.
  const free = data.people.filter((p) => !p.is_super_admin && !restricted.some((r) => r.principal.id === p.id));
  const picked = data.people.find((p) => p.id === who) ?? null;
  const row = (r: SiteAccessPerson) => (
    <li key={r.principal.id} className="pfa-person">
      <div className="pfa-head">
        <b>{r.principal.name}</b>
        <span className="pf-muted">{r.role_label ?? ''}</span>
        <button type="button" className="link-btn push" disabled={save.isPending} onClick={() => save.mutate({ id: r.principal.id, sites: [] })}>Lift the restriction</button>
      </div>
      <div className="pfa-sites">
        {r.sites.map((s) => (
          <span className="pf-picked" key={s.id}>
            <Icon name="store" size={12} /> {s.name}
            <span className="pf-muted">{[s.city, s.state].filter(Boolean).join(', ')}</span>
            <button type="button" className="icon-btn" aria-label={`Remove ${s.name} from ${r.principal.name}`} disabled={save.isPending} onClick={() => save.mutate({ id: r.principal.id, sites: r.sites.filter((x) => x.id !== s.id).map((x) => x.id) })}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
      </div>
      <SitePicker value={null} onPick={(s) => { if (s && !r.sites.some((x) => x.id === s.id)) save.mutate({ id: r.principal.id, sites: [...r.sites.map((x) => x.id), s.id] }); }} />
    </li>
  );
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Site access</h2>
        <span className="card-meta">{restricted.length} restricted</span>
      </div>
      <p className="adm-sub" style={{ padding: '0 14px 8px' }}>
        A person listed here sees only these sites, the assets in them, and the work orders at them — on top of what their role already limits.
        A work order with no site record is at none of them. Nobody listed means nobody is restricted. Super admins cannot be restricted.
      </p>
      {error && <p className="snooze-err" role="alert" style={{ margin: '0 14px 8px' }}><Icon name="alert-circle" size={12} />{error}</p>}
      <ul className="pfa-list">{restricted.map(row)}</ul>
      <div className="pfa-add">
        <span className="lbl">Restrict another person</span>
        <select className="fld" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
          <option value="">Choose a person…</option>
          {free.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role_label ? ` · ${p.role_label}` : ''}</option>)}
        </select>
        {picked && (
          <>
            <span className="pf-muted">Pick the first site {picked.name} may see:</span>
            <SitePicker value={null} autoFocus onPick={(s) => { if (s) { save.mutate({ id: picked.id, sites: [s.id] }); setWho(''); } }} />
          </>
        )}
      </div>
    </section>
  );
}
