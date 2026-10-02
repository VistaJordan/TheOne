/* /clients and /clients/:id — clients as records (0061).
 *
 * A client record is what is known about a name: who to talk to, where to
 * bill, who looks after the account. Which client a work order belongs to is
 * still the work order's own Client field; the record joins to it by name,
 * which is why a client that has work orders or sites cannot be renamed here.
 * A client named on a new work order appears in this list by itself. */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLIENT_PORTAL_TYPES } from '@theone/shared';
import type { ClientDetail, ClientInput, ClientsListResponse } from '@theone/shared';
import { ApiRequestError, createClient, deleteClient, getClient, getClientHistory, listClients, updateClient } from '../api/client';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { HistoryCard, WorkOrderList, errText } from '../components/portfolio/PortfolioParts';
import { useEscape } from '../lib/useEscape';

export function ClientsPage() {
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const params: Record<string, string> = {};
  for (const k of ['search', 'show', 'sort', 'dir']) {
    const v = sp.get(k);
    if (v) params[k] = v;
  }
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setSp(next, { replace: true });
  };
  const q = useQuery({ queryKey: ['clients', params], queryFn: () => listClients(params), placeholderData: keepPreviousData });
  const [searchText, setSearchText] = useState(sp.get('search') ?? '');
  const [adding, setAdding] = useState(false);
  const sort = sp.get('sort') ?? 'name';
  const dir = sp.get('dir') === 'desc' ? 'desc' : 'asc';
  const th = (label: string, k: string) => (
    <th aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => set({ sort: k, dir: sort === k && dir === 'asc' ? 'desc' : 'asc' })}>
        {label}
        {sort === k && <Icon name={dir === 'asc' ? 'chev-u' : 'chev-d'} size={12} />}
      </button>
    </th>
  );
  const rows = q.data?.items ?? [];

  return (
    <AppShell active="Clients">
      <div className="canvas-inner">
        <div className="vend-head">
          <div className="page-head" style={{ margin: 0 }}>
            <h1 className="page-title">Clients</h1>
          </div>
          {q.data?.can.create && (
            <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} />
              Add client
            </button>
          )}
        </div>
        <section className="card">
          <form className="vend-filters" onSubmit={(e) => { e.preventDefault(); set({ search: searchText.trim() || null }); }}>
            <input
              className="fld vend-search"
              type="search"
              placeholder="Search name, code or contact"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onBlur={() => set({ search: searchText.trim() || null })}
              aria-label="Search clients"
            />
            <select className="fld" value={sp.get('show') ?? ''} onChange={(e) => set({ show: e.target.value || null })} aria-label="Active or inactive">
              <option value="">Active clients</option>
              <option value="inactive">Inactive clients</option>
              <option value="all">Active and inactive</option>
            </select>
          </form>
          {q.isError && <div className="empty-flat">{q.error instanceof ApiRequestError ? q.error.message : 'Could not load the clients.'}</div>}
          {!q.isError && (
            <div className="vend-wrap">
              <table className="vend-table">
                <thead>
                  <tr>
                    {th('Client', 'name')}
                    <th>Contact</th>
                    {th('Account manager', 'manager')}
                    <th>Portal</th>
                    {th('Sites', 'sites')}
                    {th('Assets', 'assets')}
                    {th('Open', 'open')}
                    {th('Work orders', 'work_orders')}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td className="vend-name">
                        <Link to={`/clients/${c.id}`}>{c.name}</Link>
                        {(c.code || !c.is_active) && (
                          <span>
                            {c.code && <span className="chip chip-sm mono">{c.code}</span>}
                            {!c.is_active && <span className="chip chip-outline chip-sm">Inactive</span>}
                          </span>
                        )}
                      </td>
                      <td>{[c.contact_name, c.contact_email ?? c.contact_phone].filter(Boolean).join(' · ') || '—'}</td>
                      <td>{c.account_manager?.name ?? '—'}</td>
                      <td>{c.portal_type ?? '—'}</td>
                      <td className="num">{c.sites}</td>
                      <td className="num">{c.assets}</td>
                      <td className="num">{c.open_work_orders > 0 ? <b>{c.open_work_orders}</b> : 0}</td>
                      <td className="num">{c.work_orders}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {q.data && rows.length === 0 && <div className="empty-flat">{sp.get('search') || sp.get('show') ? 'Nothing matches.' : 'No clients yet. They appear here as work orders name them, or add one.'}</div>}
            </div>
          )}
          <div className="vend-foot"><span>{q.isFetching ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'client' : 'clients'}`}</span></div>
        </section>
      </div>
      {adding && <ClientFormDialog client={null} meta={q.data} onClose={() => setAdding(false)} onSaved={(c) => navigate(`/clients/${c.id}`)} />}
    </AppShell>
  );
}

// ── The form ─────────────────────────────────────────────────────────────────

type Draft = Record<'name' | 'code' | 'account_manager' | 'billing_entity' | 'contact_name' | 'contact_email' | 'contact_phone' | 'billing_email' | 'address' | 'portal_type' | 'payment_terms' | 'notes', string> & { is_active: boolean };

function ClientFormDialog({ client, meta, onClose, onSaved }: {
  client: ClientDetail | null;
  meta: ClientsListResponse | undefined;
  onClose: () => void;
  onSaved: (c: ClientDetail) => void;
}) {
  useEscape(onClose);
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>({
    name: client?.name ?? '', code: client?.code ?? '', account_manager: client?.account_manager?.id ?? '', billing_entity: client?.billing_entity ?? '',
    contact_name: client?.contact_name ?? '', contact_email: client?.contact_email ?? '', contact_phone: client?.contact_phone ?? '',
    billing_email: client?.billing_email ?? '', address: client?.address ?? '', portal_type: client?.portal_type ?? '',
    payment_terms: client?.payment_terms ?? '', notes: client?.notes ?? '', is_active: client?.is_active ?? true,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const set = (k: keyof Draft, v: string | boolean) => setD((cur) => ({ ...cur, [k]: v }));
  const txt = (k: keyof Draft) => (d[k] as string).trim() || null;
  const inUse = Boolean(client && (client.work_orders > 0 || client.sites > 0));
  const save = useMutation({
    mutationFn: () => {
      if (!d.name.trim()) throw new Error('The client needs a name.');
      const input: ClientInput = {
        name: d.name.trim(), code: txt('code'), account_manager: d.account_manager || null, billing_entity: txt('billing_entity'),
        contact_name: txt('contact_name'), contact_email: txt('contact_email'), contact_phone: txt('contact_phone'), billing_email: txt('billing_email'),
        address: txt('address'), portal_type: txt('portal_type'), payment_terms: txt('payment_terms'), notes: txt('notes'), is_active: d.is_active,
      };
      return client ? updateClient(client.id, input) : createClient(input);
    },
    onMutate: () => setProblem(null),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['clients'] });
      qc.setQueryData(['client', res.client.id], res);
      onSaved(res.client);
    },
    onError: (e) => setProblem(errText(e, 'Could not save the client.')),
  });
  const field = (label: string, node: ReactNode, wide = false, hint?: string) => (
    <label className={`pf-field${wide ? ' is-wide' : ''}`}>
      <span className="lbl">{label}</span>
      {node}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="clientT">
      <div className="sheet vend-sheet is-wide pf-sheet">
        <h2 className="sheet-t" id="clientT"><Icon name="briefcase" size={16} />{client ? `Edit ${client.name}` : 'Add a client'}</h2>
        <div className="pf-form">
          {field('Name', <input className="fld" autoFocus={!client} value={d.name} onChange={(e) => set('name', e.target.value)} />, true,
            inUse ? 'Work orders and sites are filed under this name: only its capitals and spacing can change.' : 'Exactly as it is written on work orders.')}
          {field('Code', <input className="fld mono" value={d.code} onChange={(e) => set('code', e.target.value)} />)}
          {field('Account manager', (
            <select className="fld" value={d.account_manager} onChange={(e) => set('account_manager', e.target.value)}>
              <option value="">Nobody</option>
              {(meta?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ))}
          {field('Contact name', <input className="fld" value={d.contact_name} onChange={(e) => set('contact_name', e.target.value)} />)}
          {field('Contact phone', <input className="fld" value={d.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} />)}
          {field('Contact email', <input className="fld" type="email" value={d.contact_email} onChange={(e) => set('contact_email', e.target.value)} />)}
          {field('Billing email', <input className="fld" type="email" value={d.billing_email} onChange={(e) => set('billing_email', e.target.value)} />)}
          {field('Billing entity', (
            <>
              <input className="fld" list="cl-entities" value={d.billing_entity} onChange={(e) => set('billing_entity', e.target.value)} />
              <datalist id="cl-entities">{(meta?.billing_entities ?? []).map((x) => <option key={x} value={x} />)}</datalist>
            </>
          ))}
          {field('Client portal', (
            <select className="fld" value={d.portal_type} onChange={(e) => set('portal_type', e.target.value)}>
              <option value="">—</option>
              {d.portal_type && !(CLIENT_PORTAL_TYPES as readonly string[]).includes(d.portal_type) && <option value={d.portal_type}>{d.portal_type}</option>}
              {CLIENT_PORTAL_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          ))}
          {field('Payment terms', <input className="fld" value={d.payment_terms} placeholder="e.g. Net 30" onChange={(e) => set('payment_terms', e.target.value)} />)}
          {field('Billing address', <textarea className="fld" rows={2} value={d.address} onChange={(e) => set('address', e.target.value)} />, true)}
          {field('Notes', <textarea className="fld" rows={3} value={d.notes} onChange={(e) => set('notes', e.target.value)} />, true)}
          {client && (
            <label className="tmap-check pf-field">
              <input type="checkbox" checked={d.is_active} onChange={(e) => set('is_active', e.target.checked)} />
              <span>Active — clear it for a client you no longer work for</span>
            </label>
          )}
        </div>
        {problem && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{problem}</p>}
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : client ? 'Save changes' : 'Add client'}</button>
        </div>
      </div>
    </div>
  );
}

// ── One client ───────────────────────────────────────────────────────────────

export function ClientDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['client', id], queryFn: () => getClient(id) });
  const meta = useQuery({ queryKey: ['clients', {}], queryFn: () => listClients({}) });
  const c = q.data?.client ?? null;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => deleteClient(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['clients'] }); navigate('/clients'); },
    onError: (e) => setProblem(errText(e, 'Could not remove the client.')),
  });

  const crumbs = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button type="button" className="crumb-back" aria-label="Back to Clients" onClick={() => navigate('/clients')}><Icon name="arrow-l" size={14} /></button>
      <Link className="crumb" to="/clients">Clients</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <span className="crumb-cur" aria-current="page">{c?.name ?? '…'}</span>
    </nav>
  );
  const shell = (children: ReactNode) => (
    <AppShell active="Clients" breadcrumb={crumbs}>
      <div className="canvas-inner">{children}</div>
    </AppShell>
  );
  if (q.isLoading) return shell(<div className="wo-state"><b>Loading the client…</b></div>);
  if (q.isError || !c) {
    return shell(
      <div className="wo-state">
        <Icon name="alert" size={22} />
        <b>Could not open this client</b>
        <span>{errText(q.error, 'It may have been removed.')}</span>
        <Link className="btn" to="/clients">Back to Clients</Link>
      </div>,
    );
  }
  const rows: [string, ReactNode][] = [
    ['Code', c.code],
    ['Account manager', c.account_manager?.name],
    ['Contact', c.contact_name],
    ['Contact phone', c.contact_phone],
    ['Contact email', c.contact_email],
    ['Billing email', c.billing_email],
    ['Billing entity', c.billing_entity],
    ['Client portal', c.portal_type],
    ['Payment terms', c.payment_terms],
    ['Billing address', c.address],
    ['Notes', c.notes],
  ];
  return shell(
    <>
      <section className="card vrec-head">
        <div className="vrec-title">
          <h1>{c.name}</h1>
          <div className="vrec-chips">
            {!c.is_active && <span className="chip chip-outline chip-sm">Inactive</span>}
            <span className="chip chip-sm">{c.sites} {c.sites === 1 ? 'site' : 'sites'}</span>
            <span className="chip chip-sm">{c.assets} {c.assets === 1 ? 'asset' : 'assets'}</span>
            <span className="chip chip-sm">{c.open_work_orders} open · {c.work_orders} work orders</span>
          </div>
        </div>
        <div className="vrec-actions">
          {c.can.edit && <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}><Icon name="pencil" size={14} />Edit</button>}
          {c.can.delete && <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}><Icon name="trash" size={14} />Remove</button>}
        </div>
      </section>
      {problem && <div className="callout" style={{ marginTop: 12 }}><Icon name="alert" size={14} /><span>{problem}</span></div>}

      <div className="vrec-grid">
        <div className="vrec-col">
          <section className="card">
            <div className="card-head"><h2 className="card-title">The client</h2></div>
            <div className="vrec-fields">
              {rows.map(([label, value]) => (
                <div className={`vrec-field${label === 'Notes' || label === 'Billing address' ? ' is-wide' : ''}`} key={label}>
                  <span className="lbl">{label}</span>
                  <span className={`vrec-val${value ? '' : ' is-none'}`}>{value || '—'}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title grow">Sites</h2>
              <span className="card-meta">{c.sites}{c.sites > c.site_list.length ? ` · first ${c.site_list.length}` : ''}</span>
              {c.sites > 0 && <Link className="btn btn-sm is-ghost" to={`/sites?client=${encodeURIComponent(c.name)}`}>Open in Sites</Link>}
            </div>
            {c.site_list.length === 0 ? (
              <div className="empty-flat">No site on file for this client.</div>
            ) : (
              <div className="vend-wrap">
                <table className="vend-table">
                  <thead><tr><th>Site</th><th>Address</th><th>City</th><th>State</th><th>Assets</th><th>Open</th><th>Work orders</th></tr></thead>
                  <tbody>
                    {c.site_list.map((s) => (
                      <tr key={s.id}>
                        <td className="vend-name"><Link to={`/sites/${s.id}`}>{s.name ?? 'Unnamed site'}</Link></td>
                        <td>{s.address1 ?? '—'}</td>
                        <td>{s.city ?? '—'}</td>
                        <td>{s.state ?? '—'}</td>
                        <td className="num">{s.assets}</td>
                        <td className="num">{s.open_work_orders > 0 ? <b>{s.open_work_orders}</b> : 0}</td>
                        <td className="num">{s.work_orders}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title grow">Work orders</h2>
              <span className="card-meta">{c.work_orders}{c.work_orders > c.recent_work_orders.length ? ` · latest ${c.recent_work_orders.length}` : ''}</span>
            </div>
            <WorkOrderList items={c.recent_work_orders} empty="No work order names this client." />
          </section>
        </div>

        <aside className="vrec-col">
          <section className="card">
            <div className="card-head"><h2 className="card-title grow">Contracts</h2><span className="card-meta">{c.contracts.length}</span></div>
            <ul className="vrec-list">
              {c.contracts.length === 0 && <li>No rate card names this client.</li>}
              {c.contracts.map((k) => (
                <li key={k.id}>
                  <Link to="/contracts">{k.name}</Link>
                  <span className="push pf-muted">{k.status}</span>
                </li>
              ))}
            </ul>
          </section>
          <HistoryCard queryKey={['client-history', id, c.updated_at]} load={() => getClientHistory(id)} />
        </aside>
      </div>

      {editing && <ClientFormDialog client={c} meta={meta.data} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {confirmDelete && (
        <ConfirmDialog
          title={`Remove ${c.name}?`}
          message={
            c.work_orders > 0 || c.sites > 0
              ? <>This client still has work orders or sites, so it cannot be removed — it would simply reappear. Mark it inactive from Edit instead.</>
              : <>The record leaves the list. Nothing else points at it.</>
          }
          confirmLabel={c.work_orders > 0 || c.sites > 0 ? 'Understood' : 'Remove'}
          danger={!(c.work_orders > 0 || c.sites > 0)}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); if (!(c.work_orders > 0 || c.sites > 0)) remove.mutate(); }}
        />
      )}
    </>,
  );
}
