/* /assets — every asset across the portfolio (0060): the equipment work
 * orders are raised against. Filters live in the URL. The warranty and
 * condition filters are the two worth bookmarking: "warranty ends soon" is
 * what to chase before it lapses, "critical" is what to replace. */

import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ASSET_CONDITIONS, ASSET_CONDITION_LABELS, ASSET_STATUSES, ASSET_STATUS_LABELS } from '@theone/shared';
import type { AssetRow } from '@theone/shared';
import { ApiRequestError, getSitesMeta, listAssets } from '../api/client';
import type { AssetListParams } from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { AssetRequestsTab } from '../components/portfolio/AssetRequests';
import { AssetFormDialog, AssetStatusChip, ConditionChip, WarrantyChip } from '../components/portfolio/PortfolioParts';
import { listAssetRequests } from '../api/client';

const FILTER_KEYS = ['search', 'site', 'client', 'category', 'asset_type', 'status', 'condition', 'warranty', 'sort', 'dir'] as const;

export function AssetsPage() {
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
  // 0062 — ?view=requests is the asset management request queue.
  const view = sp.get('view') === 'requests' ? 'requests' : 'list';
  const waiting = useQuery({ queryKey: ['asset-requests', 'open', ''], queryFn: () => listAssetRequests({ status: 'open' }) });
  const filters = useMemo(() => {
    const out: AssetListParams = {};
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
    queryKey: ['assets', filters, page],
    queryFn: () => listAssets({ ...filters, page, page_size: 50 }),
    placeholderData: keepPreviousData,
    enabled: view === 'list',
  });
  const m = meta.data;
  const [searchText, setSearchText] = useState(sp.get('search') ?? '');
  const [adding, setAdding] = useState(false);

  const sort = sp.get('sort') ?? 'name';
  const dir = sp.get('dir') === 'desc' ? 'desc' : 'asc';
  const sortBy = (key: string) => set({ sort: key, dir: sort === key && dir === 'asc' ? 'desc' : 'asc' });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const anyFilter = FILTER_KEYS.some((k) => k !== 'sort' && k !== 'dir' && sp.get(k));
  const quick = (key: 'warranty' | 'condition', value: string, label: string) => (
    <button type="button" className={`chip${sp.get(key) === value ? ' chip-accent' : ''}`} onClick={() => set({ [key]: sp.get(key) === value ? null : value })}>
      {label}
    </button>
  );

  return (
    <AppShell active="Assets">
      <div className="canvas-inner">
        <div className="vend-head">
          <div className="page-head" style={{ margin: 0 }}>
            <h1 className="page-title">Assets</h1>
          </div>
          {view === 'list' && (
            <div className="vend-counts">
              {quick('warranty', 'expiring', 'Warranty ends soon')}
              {quick('warranty', 'expired', 'Warranty expired')}
              {quick('condition', 'critical', 'Critical condition')}
              {quick('condition', 'poor', 'Poor condition')}
            </div>
          )}
          <div className="seg" role="group" aria-label="View" style={{ marginLeft: 'auto' }}>
            <button type="button" className={`seg-btn${view === 'list' ? ' is-on' : ''}`} aria-pressed={view === 'list'} onClick={() => setSp({}, { replace: true })}>
              <Icon name="list" size={12} /> List
            </button>
            <button type="button" className={`seg-btn${view === 'requests' ? ' is-on' : ''}`} aria-pressed={view === 'requests'} onClick={() => setSp({ view: 'requests' }, { replace: true })}>
              <Icon name="inbox" size={12} /> Requests{waiting.data && waiting.data.open > 0 ? ` · ${waiting.data.open}` : ''}
            </button>
          </div>
          {m?.can.assets.create && (
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} />
              Add asset
            </button>
          )}
        </div>

        {view === 'requests' && <section className="card"><AssetRequestsTab meta={m} /></section>}
        {view === 'list' && (
        <section className="card">
          <form className="vend-filters" onSubmit={(e) => { e.preventDefault(); set({ search: searchText.trim() || null }); }}>
            <input
              className="fld vend-search"
              type="search"
              placeholder="Search name, model, serial, tag or site"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onBlur={() => set({ search: searchText.trim() || null })}
              aria-label="Search assets"
            />
            <select className="fld" value={sp.get('client') ?? ''} onChange={(e) => set({ client: e.target.value || null })} aria-label="Client">
              <option value="">All clients</option>
              {(m?.clients ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select className="fld" value={sp.get('category') ?? ''} onChange={(e) => set({ category: e.target.value || null })} aria-label="Category">
              <option value="">All categories</option>
              {(m?.asset_categories ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select className="fld" value={sp.get('asset_type') ?? ''} onChange={(e) => set({ asset_type: e.target.value || null })} aria-label="Type">
              <option value="">All types</option>
              {(m?.asset_types ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select className="fld" value={sp.get('status') ?? ''} onChange={(e) => set({ status: e.target.value || null })} aria-label="Status">
              <option value="">Any status</option>
              {ASSET_STATUSES.map((x) => <option key={x} value={x}>{ASSET_STATUS_LABELS[x]}</option>)}
            </select>
            <select className="fld" value={sp.get('condition') ?? ''} onChange={(e) => set({ condition: e.target.value || null })} aria-label="Condition">
              <option value="">Any condition</option>
              {ASSET_CONDITIONS.map((x) => <option key={x} value={x}>{ASSET_CONDITION_LABELS[x]}</option>)}
              <option value="none">Not recorded</option>
            </select>
            <select className="fld" value={sp.get('warranty') ?? ''} onChange={(e) => set({ warranty: e.target.value || null })} aria-label="Warranty">
              <option value="">Any warranty</option>
              <option value="active">Under warranty</option>
              <option value="expiring">Ends within 60 days</option>
              <option value="expired">Expired</option>
              <option value="none">None on file</option>
            </select>
            {anyFilter && (
              <button type="button" className="link-btn" onClick={() => { setSearchText(''); setSp({}, { replace: true }); }}>Clear filters</button>
            )}
          </form>

          {list.isError && <div className="empty-flat">{list.error instanceof ApiRequestError ? list.error.message : 'Could not load the assets.'}</div>}
          {!list.isError && (
            <div className="vend-wrap">
              <table className="vend-table">
                <thead>
                  <tr>
                    <Th label="Asset" k="name" sort={sort} dir={dir} onSort={sortBy} />
                    <Th label="Category" k="category" sort={sort} dir={dir} onSort={sortBy} />
                    <Th label="Type" k="type" sort={sort} dir={dir} onSort={sortBy} />
                    <Th label="Site" k="site" sort={sort} dir={dir} onSort={sortBy} />
                    <th>Where</th>
                    <th>Model</th>
                    <Th label="Status" k="status" sort={sort} dir={dir} onSort={sortBy} />
                    <Th label="Condition" k="condition" sort={sort} dir={dir} onSort={sortBy} />
                    <Th label="Warranty" k="warranty" sort={sort} dir={dir} onSort={sortBy} />
                    <Th label="Work orders" k="work_orders" sort={sort} dir={dir} onSort={sortBy} />
                  </tr>
                </thead>
                <tbody>{rows.map((a) => <Row key={a.id} a={a} />)}</tbody>
              </table>
              {list.data && rows.length === 0 && (
                <div className="empty-flat">
                  {total === 0 && !anyFilter ? 'No assets yet. Add one here or from a site’s page; assets also arrive with work orders from Ecotrak.' : 'Nothing matches these filters.'}
                </div>
              )}
            </div>
          )}
          <div className="vend-foot">
            <span>{list.isFetching ? 'Loading…' : `${total.toLocaleString()} ${total === 1 ? 'asset' : 'assets'}`}</span>
            {pages > 1 && (
              <span className="push">
                <button type="button" className="btn btn-sm is-ghost" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}><Icon name="chev-l" size={12} /> Previous</button>
                Page {page} of {pages}
                <button type="button" className="btn btn-sm is-ghost" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next <Icon name="chev-r" size={12} /></button>
              </span>
            )}
          </div>
        </section>
        )}
      </div>
      {adding && <AssetFormDialog asset={null} meta={m} onClose={() => setAdding(false)} onSaved={(a) => navigate(`/assets/${a.id}`)} />}
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

function Row({ a }: { a: AssetRow }) {
  return (
    <tr>
      <td className="vend-name">
        <Link to={`/assets/${a.id}`}>{a.name}</Link>
        {(a.serial_number || a.asset_tag) && <span className="pf-wo-title mono">{[a.asset_tag, a.serial_number].filter(Boolean).join(' · ')}</span>}
      </td>
      <td>{a.category ?? '—'}</td>
      <td>{a.asset_type ?? '—'}</td>
      <td>{a.site ? <Link to={`/sites/${a.site.id}`}>{a.site.name}</Link> : '—'}</td>
      <td>{a.location ?? '—'}</td>
      <td>{[a.manufacturer, a.model_number].filter(Boolean).join(' ') || '—'}</td>
      <td><AssetStatusChip status={a.status} /></td>
      <td><ConditionChip condition={a.condition} /></td>
      <td><WarrantyChip state={a.warranty} expiresOn={a.warranty_expires_on} /></td>
      <td className="num">{a.open_work_orders > 0 ? <><b>{a.open_work_orders}</b> / {a.work_orders}</> : a.work_orders}</td>
    </tr>
  );
}
