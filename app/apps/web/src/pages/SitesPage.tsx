/* /sites — the portfolio (0060): every site work is done at.
 *
 * A counts strip (sites · buildings · floors · spaces · assets), the list with
 * its filters in the URL, and the same sites on a map. Sites arrive three
 * ways: the Ecotrak sync, by hand here, or made from the work orders that
 * only carry their site as text ("Create sites from work orders"). */

import { Suspense, lazy, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SITE_SOURCE_LABELS } from '@theone/shared';
import type { SiteRow } from '@theone/shared';
import { ApiRequestError, createSitesFromWorkOrders, getSitesMap, getSitesMeta, listSites, previewSitesFromWorkOrders } from '../api/client';
import type { SiteListParams } from '../api/client';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import type { MapPoint } from '../components/map/VendorMap';
import { SiteFormDialog, errText } from '../components/portfolio/PortfolioParts';
import { useTheme } from '../theme/ThemeProvider';

const VendorMap = lazy(() => import('../components/map/VendorMap'));

const FILTER_KEYS = ['search', 'client', 'state', 'site_type', 'managed_by', 'show', 'flag', 'sort', 'dir'] as const;

export function SitesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') === 'map' ? 'map' : 'list';
  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);

  const filters = useMemo(() => {
    const out: SiteListParams = {};
    for (const k of FILTER_KEYS) {
      const v = sp.get(k);
      if (v) out[k] = v;
    }
    return out;
  }, [sp]);
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setSp(next, { replace: true });
  };

  const meta = useQuery({ queryKey: ['sites-meta'], queryFn: getSitesMeta });
  const list = useQuery({
    queryKey: ['sites', filters, page],
    queryFn: () => listSites({ ...filters, page, page_size: 50 }),
    placeholderData: keepPreviousData,
    enabled: view === 'list',
  });
  const m = meta.data;
  const [searchText, setSearchText] = useState(sp.get('search') ?? '');
  const [adding, setAdding] = useState(false);
  const [fromWo, setFromWo] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const preview = useQuery({ queryKey: ['sites-from-wo'], queryFn: previewSitesFromWorkOrders, enabled: fromWo });
  const make = useMutation({
    mutationFn: createSitesFromWorkOrders,
    onSuccess: (r) => {
      setFromWo(false);
      setNotice(`${r.created ?? 0} ${r.created === 1 ? 'site' : 'sites'} added and ${r.linked ?? 0} work ${r.linked === 1 ? 'order' : 'orders'} linked.`);
      void qc.invalidateQueries({ queryKey: ['sites'] });
      void qc.invalidateQueries({ queryKey: ['sites-meta'] });
      void qc.invalidateQueries({ queryKey: ['sites-map'] });
      void qc.invalidateQueries({ queryKey: ['sites-from-wo'] });
    },
  });

  const sort = sp.get('sort') ?? 'name';
  const dir = sp.get('dir') === 'desc' ? 'desc' : 'asc';
  const sortBy = (key: string) => set({ sort: key, dir: sort === key && dir === 'asc' ? 'desc' : 'asc' });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const anyFilter = FILTER_KEYS.some((k) => k !== 'sort' && k !== 'dir' && sp.get(k));
  const c = m?.counts;

  return (
    <AppShell active="Sites">
      <div className="canvas-inner">
        <div className="vend-head">
          <div className="page-head" style={{ margin: 0 }}>
            <h1 className="page-title">Sites</h1>
          </div>
          <div className="seg" role="group" aria-label="View" style={{ marginLeft: 'auto' }}>
            <button type="button" className={`seg-btn${view === 'list' ? ' is-on' : ''}`} aria-pressed={view === 'list'} onClick={() => set({ view: null })}>
              <Icon name="list" size={12} /> List
            </button>
            <button type="button" className={`seg-btn${view === 'map' ? ' is-on' : ''}`} aria-pressed={view === 'map'} onClick={() => set({ view: 'map' })}>
              <Icon name="pin" size={12} /> Map
            </button>
          </div>
          {m?.can.sites.create && (
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} />
              Add site
            </button>
          )}
        </div>

        {c && (
          <div className="pf-counts" aria-label="Portfolio counts">
            <div><b>{c.sites.toLocaleString()}</b><span>Sites</span></div>
            <div><b>{c.buildings.toLocaleString()}</b><span>Buildings</span></div>
            <div><b>{c.floors.toLocaleString()}</b><span>Floors</span></div>
            <div><b>{c.spaces.toLocaleString()}</b><span>Spaces</span></div>
            {m.can.assets.view ? (
              <Link to="/assets"><b>{c.assets.toLocaleString()}</b><span>Assets</span></Link>
            ) : (
              <div><b>{c.assets.toLocaleString()}</b><span>Assets</span></div>
            )}
          </div>
        )}

        {c && c.linkable_work_orders > 0 && m.can.sites.create && (
          <div className="callout pf-callout">
            <Icon name="info" size={14} />
            <span>
              <b>{c.linkable_work_orders.toLocaleString()} work {c.linkable_work_orders === 1 ? 'order names' : 'orders name'} a site that is not on file as a record.</b>{' '}
              They carry it as text — a client, a store, an address.
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setFromWo(true)}>Create sites from work orders</button>
          </div>
        )}
        {notice && (
          <div className="tmap-banner is-ok pf-notice" role="status">
            <Icon name="check-circle" size={14} />
            <span>{notice}</span>
            <button type="button" className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss"><Icon name="x" size={12} /></button>
          </div>
        )}

        <section className="card">
          <form className="vend-filters" onSubmit={(e) => { e.preventDefault(); set({ search: searchText.trim() || null }); }}>
            <input
              className="fld vend-search"
              type="search"
              placeholder="Search name, store number, address or city"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onBlur={() => set({ search: searchText.trim() || null })}
              aria-label="Search sites"
            />
            <select className="fld" value={sp.get('client') ?? ''} onChange={(e) => set({ client: e.target.value || null })} aria-label="Client">
              <option value="">All clients</option>
              {(m?.clients ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select className="fld" value={sp.get('state') ?? ''} onChange={(e) => set({ state: e.target.value || null })} aria-label="State">
              <option value="">All states</option>
              {(m?.states ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select className="fld" value={sp.get('site_type') ?? ''} onChange={(e) => set({ site_type: e.target.value || null })} aria-label="Site type">
              <option value="">All types</option>
              {(m?.site_types ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select className="fld" value={sp.get('managed_by') ?? ''} onChange={(e) => set({ managed_by: e.target.value || null })} aria-label="Managed by">
              <option value="">Managed by anyone</option>
              <option value="none">Nobody</option>
              {(m?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="fld" value={sp.get('flag') ?? ''} onChange={(e) => set({ flag: e.target.value || null })} aria-label="Flag">
              <option value="">Any</option>
              <option value="open_work">With open work orders</option>
              <option value="no_assets">No assets on file</option>
              <option value="not_on_map">Not on the map</option>
            </select>
            <select className="fld" value={sp.get('show') ?? ''} onChange={(e) => set({ show: e.target.value || null })} aria-label="Active or closed">
              <option value="">Active sites</option>
              <option value="inactive">Closed sites</option>
              <option value="all">Active and closed</option>
            </select>
            {anyFilter && (
              <button type="button" className="link-btn" onClick={() => { setSearchText(''); setSp(view === 'map' ? { view: 'map' } : {}, { replace: true }); }}>
                Clear filters
              </button>
            )}
          </form>

          {view === 'map' ? (
            <SitesMap filters={filters} />
          ) : (
            <>
              {list.isError && <div className="empty-flat">{list.error instanceof ApiRequestError ? list.error.message : 'Could not load the sites.'}</div>}
              {!list.isError && (
                <div className="vend-wrap">
                  <table className="vend-table">
                    <thead>
                      <tr>
                        <Th label="Site" k="name" sort={sort} dir={dir} onSort={sortBy} />
                        <Th label="Client" k="client" sort={sort} dir={dir} onSort={sortBy} />
                        <Th label="Store" k="store" sort={sort} dir={dir} onSort={sortBy} />
                        <th>Address</th>
                        <Th label="City" k="city" sort={sort} dir={dir} onSort={sortBy} />
                        <Th label="State" k="state" sort={sort} dir={dir} onSort={sortBy} />
                        <Th label="Type" k="type" sort={sort} dir={dir} onSort={sortBy} />
                        <th>Managed by</th>
                        <Th label="Assets" k="assets" sort={sort} dir={dir} onSort={sortBy} />
                        <Th label="Open" k="open" sort={sort} dir={dir} onSort={sortBy} />
                        <Th label="Work orders" k="work_orders" sort={sort} dir={dir} onSort={sortBy} />
                      </tr>
                    </thead>
                    <tbody>{rows.map((s) => <Row key={s.id} s={s} />)}</tbody>
                  </table>
                  {list.data && rows.length === 0 && (
                    <div className="empty-flat">
                      {total === 0 && !anyFilter ? 'No sites yet. Add one, or create them from the work orders already on file.' : 'Nothing matches these filters.'}
                    </div>
                  )}
                </div>
              )}
              <div className="vend-foot">
                <span>{list.isFetching ? 'Loading…' : `${total.toLocaleString()} ${total === 1 ? 'site' : 'sites'}`}</span>
                {pages > 1 && (
                  <span className="push">
                    <button type="button" className="btn btn-sm is-ghost" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}><Icon name="chev-l" size={12} /> Previous</button>
                    Page {page} of {pages}
                    <button type="button" className="btn btn-sm is-ghost" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next <Icon name="chev-r" size={12} /></button>
                  </span>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {adding && <SiteFormDialog site={null} meta={m} onClose={() => setAdding(false)} onSaved={(s) => navigate(`/sites/${s.id}`)} />}
      {fromWo && (
        <ConfirmDialog
          title="Create sites from work orders"
          icon="store"
          message={
            preview.isLoading || !preview.data ? (
              <>Checking the work orders…</>
            ) : preview.data.candidates === 0 ? (
              <>None of the unlinked work orders name both a client and a place, so there is nothing to create.</>
            ) : (
              <>
                <b>{preview.data.would_create}</b> new {preview.data.would_create === 1 ? 'site' : 'sites'} will be added and{' '}
                <b>{preview.data.candidates}</b> work {preview.data.candidates === 1 ? 'order' : 'orders'} linked
                {preview.data.would_link > 0 ? <> ({preview.data.would_link} to sites already on file)</> : null}. A site is one client at one store number — or,
                with no store number, one street address or city.
              </>
            )
          }
          note={
            make.isError
              ? errText(make.error, 'Could not create the sites.')
              : preview.data && preview.data.skipped > 0
                ? `${preview.data.skipped} work ${preview.data.skipped === 1 ? 'order names' : 'orders name'} no client or no place and will be left as they are.`
                : undefined
          }
          confirmLabel="Create and link"
          busy={make.isPending}
          busyLabel="Working…"
          onCancel={() => setFromWo(false)}
          onConfirm={() => { if (preview.data && preview.data.candidates > 0) make.mutate(); else setFromWo(false); }}
        />
      )}
    </AppShell>
  );
}

function Th({ label, k, sort, dir, onSort }: { label: string; k: string; sort: string; dir: string; onSort: (k: string) => void }) {
  const on = sort === k;
  return (
    <th aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => onSort(k)}>
        {label}
        {on && <Icon name={dir === 'asc' ? 'chev-u' : 'chev-d'} size={12} />}
      </button>
    </th>
  );
}

function Row({ s }: { s: SiteRow }) {
  return (
    <tr>
      <td className="vend-name">
        <Link to={`/sites/${s.id}`}>{s.name ?? s.client ?? 'Unnamed site'}</Link>
        <span>
          {s.source !== 'manual' && <span className="chip chip-sm">{SITE_SOURCE_LABELS[s.source] ?? s.source}</span>}
          {!s.is_active && <span className="chip chip-outline chip-sm">Closed</span>}
          {!s.on_map && <span className="chip chip-outline chip-sm" title="The ZIP or city could not be placed — correct the address, or pin it by hand">Not on the map</span>}
        </span>
      </td>
      <td>{s.client ?? '—'}</td>
      <td className="mono">{s.store_number ?? '—'}</td>
      <td>{s.address1 ?? '—'}</td>
      <td>{s.city ?? '—'}</td>
      <td>{s.state ?? '—'}</td>
      <td>{s.site_type ?? '—'}</td>
      <td>{s.managed_by?.name ?? '—'}</td>
      <td className="num">{s.assets}</td>
      <td className="num">{s.open_work_orders > 0 ? <b>{s.open_work_orders}</b> : 0}</td>
      <td className="num">{s.work_orders}</td>
    </tr>
  );
}

function SitesMap({ filters }: { filters: SiteListParams }) {
  const { theme } = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['sites-map', filters], queryFn: () => getSitesMap(filters), placeholderData: keepPreviousData });
  const pts = q.data?.points ?? [];
  // A site with open work stands out (slot 1, filled); a quiet one is a ring.
  const points = useMemo<MapPoint[]>(
    () => pts.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, slot: p.open_work_orders > 0 ? 1 : 0, kind: p.open_work_orders > 0 ? 'vendor' : 'tech' })),
    [pts],
  );
  const picked = pts.find((p) => p.id === selectedId) ?? null;
  return (
    <>
      <div className="vend-map">
        <Suspense fallback={<div className="tmap-loading">Loading the map…</div>}>
          <VendorMap key={theme} theme={theme} points={points} selectedId={selectedId} onSelect={setSelectedId} fitKey={`${JSON.stringify(filters)}|${pts.length > 0}`} />
        </Suspense>
        {picked && (
          <div className="vend-map-pick">
            <b>{picked.name}</b>
            <span>{[picked.client, [picked.city, picked.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span>
            <span>{picked.open_work_orders} open work {picked.open_work_orders === 1 ? 'order' : 'orders'}</span>
            <span style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <Link className="btn btn-sm" to={`/sites/${picked.id}`}>Open the site</Link>
              <button type="button" className="btn btn-sm is-ghost" onClick={() => setSelectedId(null)}>Close</button>
            </span>
          </div>
        )}
        <div className="vend-map-legend">
          <span><i className="tmap-key is-vendor" style={{ margin: '0 6px 0 0' }} />Open work orders</span>
          <span><i className="tmap-key is-tech" style={{ margin: '0 6px 0 0' }} />Nothing open</span>
        </div>
      </div>
      <div className="vend-foot">
        <span>{q.isFetching ? 'Loading…' : q.isError ? 'Could not load the map.' : `${pts.length.toLocaleString()} ${pts.length === 1 ? 'site' : 'sites'} on the map`}</span>
      </div>
    </>
  );
}
