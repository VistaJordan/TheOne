/* /vendors — the Vendors section (0057, 0058, 0059): every vendor the VR team
   recruited and every technician a dispatcher has worked with.

   Six views over the same records, picked by ?view=:
     list     the table — filters, sort and pages are query parameters, kept
              in the URL so a filtered view can be shared or saved as a list.
              Tick rows to edit or remove them together; export what the
              filters match; paste a column to see what is on file; choose
              the columns.
     board    the same rows as cards under their status; drag to move one
     tasks    what waits on you, and the review queue
     alerts   insurance dates, soonest first
     quality  duplicates, missing information, records not on the map
     map      every placed location, coloured by trade — for deciding where to
              recruit. NOT the work-order map, which opens from a work order.

   The dropdowns and the advanced filter (`filter`, rules joined by AND / OR)
   narrow the list and the board alike. */

import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMPLIANCE_STATUS_LABELS,
  TRI_STATE_LABELS,
  US_STATE_CODES,
  VENDOR_COLUMNS,
  VENDOR_COLUMNS_PREF,
  VENDOR_KIND_LABELS,
  parseVendorFilter,
  resolveVendorColumns,
  serializeVendorFilter,
} from '@theone/shared';
import type { VendorRow, VendorStatusDef, VendorsMetaResponse } from '@theone/shared';
import {
  ApiRequestError,
  deleteVendorView,
  getUserPref,
  getVendorCoverage,
  getVendorIds,
  getVendorViews,
  getVendorsMeta,
  listVendors,
  setUserPref,
  vendorExportUrl,
} from '../api/client';
import type { CoveragePoint, VendorListParams } from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import type { MapPoint } from '../components/map/VendorMap';
import { AdvancedFilterDialog, ColumnsDialog, VendorBoard, describeVendorFilter } from '../components/vendors/VendorListExtras';
import { BulkBar, BulkSearchDialog, SaveViewDialog } from '../components/vendors/VendorListTools';
import { VendorAlertsTab, VendorDataQualityTab, VendorTasksTab } from '../components/vendors/VendorWorkTabs';
import { useAuth } from '../auth/AuthProvider';
import { tradeSlot } from '../lib/mapPoints';
import { useTheme } from '../theme/ThemeProvider';

const VendorMap = lazy(() => import('../components/map/VendorMap'));

const FILTER_KEYS = ['search', 'kind', 'status', 'trade', 'state', 'owner', 'compliance', 'flag', 'filter', 'ids', 'sort', 'dir'] as const;
type View = 'list' | 'board' | 'tasks' | 'alerts' | 'quality' | 'map';
const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: 'list', label: 'List', icon: 'list' },
  { id: 'board', label: 'Board', icon: 'layers' },
  { id: 'tasks', label: 'Tasks', icon: 'check-circle' },
  { id: 'alerts', label: 'Alerts', icon: 'bell' },
  { id: 'quality', label: 'Data quality', icon: 'alert' },
  { id: 'map', label: 'Coverage map', icon: 'pin' },
];
const COLUMNS_KEY = ['pref', VENDOR_COLUMNS_PREF];

export function StatusDot({ status, defs }: { status: string; defs: VendorStatusDef[] }) {
  const d = defs.find((s) => s.key === status);
  return <span className={`vstatus is-${d?.color ?? 'slate'}`}>{d?.label ?? status}</span>;
}

const day = (iso: string | null) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const money = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export function VendorsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const rawView = sp.get('view');
  const view: View = VIEWS.some((v) => v.id === rawView) ? (rawView as View) : 'list';
  /** The list and the board draw the same rows, so they share every filter. */
  const rowsView = view === 'list' || view === 'board';
  const keepView: Record<string, string> = view === 'list' ? {} : { view };
  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);

  const params = useMemo<VendorListParams>(() => {
    const out: VendorListParams = { page, page_size: 50 };
    for (const k of FILTER_KEYS) {
      const v = sp.get(k);
      if (v) out[k] = v;
    }
    return out;
  }, [sp, page]);
  /** The filters without the paging — what a saved list, an export, the board
      and "select all that match" mean. */
  const filterParams = useMemo(() => {
    const out: Record<string, string> = {};
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

  const meta = useQuery({ queryKey: ['vendors-meta'], queryFn: getVendorsMeta });
  const list = useQuery({
    queryKey: ['vendors', params],
    queryFn: () => listVendors(params),
    placeholderData: keepPreviousData,
    enabled: view === 'list',
  });
  const views = useQuery({ queryKey: ['vendor-views'], queryFn: getVendorViews, enabled: rowsView });
  const colPref = useQuery({ queryKey: COLUMNS_KEY, queryFn: () => getUserPref<string[]>(VENDOR_COLUMNS_PREF), enabled: view === 'list', staleTime: Infinity });
  const cols = useMemo(() => resolveVendorColumns(colPref.data?.value), [colPref.data]);
  const saveCols = useMutation({
    mutationFn: (next: string[]) => setUserPref(VENDOR_COLUMNS_PREF, next),
    onMutate: (next) => qc.setQueryData(COLUMNS_KEY, { key: VENDOR_COLUMNS_PREF, value: next }),
  });

  const [searchText, setSearchText] = useState(sp.get('search') ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [bulkSearch, setBulkSearch] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);

  // A selection belongs to the rows it was made over: new filters, new start.
  const filterSig = JSON.stringify(filterParams);
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [filterSig]);

  const m = meta.data;
  const statuses = m?.statuses ?? [];
  const flag = sp.get('flag');
  const sort = sp.get('sort') ?? 'name';
  const dir = sp.get('dir') === 'desc' ? 'desc' : 'asc';
  const sortBy = (key: string) => set({ sort: key, dir: sort === key && dir === 'asc' ? 'desc' : 'asc' });
  const advanced = useMemo(() => parseVendorFilter(sp.get('filter')), [sp]);

  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const pageIds = rows.map((r) => r.id);
  const pageAllOn = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggle = (id: string) => {
    setAllMatching(false);
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const togglePage = () => {
    setAllMatching(false);
    setSelected((cur) => {
      const next = new Set(cur);
      if (pageAllOn) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const selectAll = useMutation({
    mutationFn: () => getVendorIds(filterParams),
    onSuccess: (r) => {
      setSelected(new Set(r.ids));
      setAllMatching(true);
    },
  });

  const activeViewId = sp.get('list');
  const activeView = views.data?.views.find((v) => v.id === activeViewId) ?? null;
  const applyView = (id: string) => {
    const v = views.data?.views.find((x) => x.id === id);
    setSearchText(v?.params.search ?? '');
    setSp(v ? { ...v.params, list: v.id, ...keepView } : keepView, { replace: true });
  };
  const dropView = useMutation({
    mutationFn: (id: string) => deleteVendorView(id),
    onSuccess: (r) => {
      qc.setQueryData(['vendor-views'], r);
      setSp(keepView, { replace: true });
    },
  });

  const canManage = Boolean(m?.can.edit || m?.can.delete);
  const anyFilter = FILTER_KEYS.some((k) => k !== 'sort' && k !== 'dir' && sp.get(k));

  return (
    <AppShell active="Vendors">
      <div className="canvas-inner">
        <div className="vend-head">
          <div className="page-head" style={{ margin: 0 }}>
            <h1 className="page-title">Vendors</h1>
          </div>
          {m && rowsView && (
            <div className="vend-counts">
              <button type="button" className={`chip${sp.get('kind') === 'vendor' ? ' chip-accent' : ''}`} onClick={() => set({ kind: sp.get('kind') === 'vendor' ? null : 'vendor' })}>
                VR vendors · {m.counts.vendors}
              </button>
              <button type="button" className={`chip${sp.get('kind') === 'tech' ? ' chip-accent' : ''}`} onClick={() => set({ kind: sp.get('kind') === 'tech' ? null : 'tech' })}>
                Technicians · {m.counts.techs}
              </button>
              {m.counts.blacklisted > 0 && (
                <button type="button" className={`chip${flag === 'blacklisted' ? ' chip-danger' : ''}`} onClick={() => set({ flag: flag === 'blacklisted' ? null : 'blacklisted' })}>
                  Blacklisted · {m.counts.blacklisted}
                </button>
              )}
              {!m.can.all && <span className="chip chip-outline" title="Your role shows the vendors you own and the technicians you have worked with">Yours only</span>}
            </div>
          )}
          <div className="seg vend-views" role="group" aria-label="View" style={{ marginLeft: 'auto' }}>
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`seg-btn${view === v.id ? ' is-on' : ''}`}
                aria-pressed={view === v.id}
                onClick={() => {
                  // List ↔ board keep the filters; the other views start clean.
                  const carry = rowsView && (v.id === 'list' || v.id === 'board') ? filterParams : {};
                  setSp(v.id === 'list' ? carry : { ...carry, view: v.id }, { replace: true });
                }}
              >
                <Icon name={v.icon} size={12} /> {v.label}
              </button>
            ))}
          </div>
          {can('vendors/import', 'create') && (
            <Link className="btn" to="/vendors/import">
              <Icon name="upload" size={14} />
              Import
            </Link>
          )}
          {m?.can.create && (
            <Link className="btn btn-primary" to="/vendors/new">
              <Icon name="plus" size={14} />
              Add vendor
            </Link>
          )}
        </div>

        {view === 'tasks' && <section className="card"><VendorTasksTab brands={m?.brand_sources ?? []} /></section>}
        {view === 'alerts' && <section className="card"><VendorAlertsTab brands={m?.brand_sources ?? []} statuses={statuses} /></section>}
        {view === 'quality' && <section className="card"><VendorDataQualityTab canDelete={Boolean(m?.can.delete)} /></section>}

        {(rowsView || view === 'map') && (
          <section className="card">
            <form
              className="vend-filters"
              onSubmit={(e) => {
                e.preventDefault();
                set({ search: searchText.trim() || null });
              }}
            >
              {rowsView && (
                <input
                  className="fld vend-search"
                  type="search"
                  placeholder="Search name, email or phone"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  onBlur={() => set({ search: searchText.trim() || null })}
                  aria-label="Search vendors"
                />
              )}
              <select className="fld" value={sp.get('trade') ?? ''} onChange={(e) => set({ trade: e.target.value || null })} aria-label="Trade">
                <option value="">All trades</option>
                {(m?.trades ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select className="fld" value={sp.get('state') ?? ''} onChange={(e) => set({ state: e.target.value || null })} aria-label="State">
                <option value="">All states</option>
                {US_STATE_CODES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className="fld" value={sp.get('status') ?? ''} onChange={(e) => set({ status: e.target.value || null })} aria-label="Status">
                <option value="">All statuses</option>
                {statuses.filter((s) => s.is_active).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              {rowsView && (
                <>
                  <select className="fld" value={sp.get('owner') ?? ''} onChange={(e) => set({ owner: e.target.value || null })} aria-label="Owner">
                    <option value="">All owners</option>
                    <option value="unassigned">No owner</option>
                    {(m?.owners ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  <select className="fld" value={sp.get('compliance') ?? ''} onChange={(e) => set({ compliance: e.target.value || null })} aria-label="Paperwork">
                    <option value="">Any paperwork</option>
                    {Object.entries(COMPLIANCE_STATUS_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                  <select className="fld" value={flag ?? ''} onChange={(e) => set({ flag: e.target.value || null })} aria-label="Flag">
                    <option value="">Any flag</option>
                    <option value="duplicate">Possible duplicates</option>
                    <option value="missing">Missing information</option>
                    <option value="not_on_map">Not on the map</option>
                    <option value="blacklisted">Blacklisted</option>
                  </select>
                </>
              )}
              {anyFilter && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setSearchText('');
                    setSp(keepView, { replace: true });
                  }}
                >
                  Clear filters
                </button>
              )}
            </form>

            {rowsView && (
              <div className="vend-tools">
                <select className="fld" value={activeView?.id ?? ''} onChange={(e) => applyView(e.target.value)} aria-label="Saved lists">
                  <option value="">Saved lists…</option>
                  {(views.data?.views ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}{v.mine ? '' : ` · ${v.owner.name}`}
                    </option>
                  ))}
                </select>
                {can('vendors/lists', 'create') && (
                  <button type="button" className="btn btn-sm is-ghost" onClick={() => setSaving(true)}>
                    <Icon name="plus" size={12} />
                    Save as a list
                  </button>
                )}
                {activeView && (activeView.mine || can('vendors/review', 'approve')) && (
                  <button type="button" className="link-btn" disabled={dropView.isPending} onClick={() => dropView.mutate(activeView.id)}>
                    Delete “{activeView.name}”
                  </button>
                )}
                <button type="button" className={`btn btn-sm${advanced ? '' : ' is-ghost'}`} onClick={() => setAdvOpen(true)}>
                  <Icon name="filter" size={12} />
                  {advanced ? `Filters · ${advanced.rules.length}` : 'Filters'}
                </button>
                <span className="push" />
                {sp.get('ids') && <span className="chip chip-accent chip-sm">Showing a looked-up list</span>}
                <button type="button" className="btn btn-sm is-ghost" onClick={() => setBulkSearch(true)}>
                  <Icon name="search" size={12} />
                  Look up a list
                </button>
                {view === 'list' && (
                  <button type="button" className="btn btn-sm is-ghost" onClick={() => setColsOpen(true)}>
                    <Icon name="columns" size={12} />
                    Columns
                  </button>
                )}
                {can('vendors/export', 'view') && (
                  <a className="btn btn-sm is-ghost" href={vendorExportUrl(filterParams)} download>
                    <Icon name="download" size={12} />
                    Export CSV
                  </a>
                )}
              </div>
            )}

            {rowsView && advanced && (
              <div className="vend-adv">
                <Icon name="filter" size={12} />
                <span>{describeVendorFilter(advanced, m)}</span>
                <button type="button" className="link-btn" onClick={() => setAdvOpen(true)}>Edit</button>
                <button type="button" className="link-btn" onClick={() => set({ filter: null })}>Remove</button>
              </div>
            )}

            {notice && (
              <div className="tmap-banner is-ok" role="status">
                <Icon name="check-circle" size={14} />
                <span>{notice}</span>
                <button type="button" className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss"><Icon name="x" size={12} /></button>
              </div>
            )}

            {view === 'board' ? (
              <VendorBoard
                params={filterParams}
                statuses={statuses}
                canEdit={Boolean(m?.can.edit)}
                onSeeAll={(status) => setSp({ ...filterParams, status }, { replace: true })}
              />
            ) : view === 'list' ? (
              <>
                {selected.size > 0 && (
                  <BulkBar
                    ids={[...selected]}
                    meta={m}
                    total={total}
                    allMatching={allMatching}
                    onSelectAll={() => selectAll.mutate()}
                    onClear={() => { setSelected(new Set()); setAllMatching(false); }}
                    onDone={(msg) => { setSelected(new Set()); setAllMatching(false); setNotice(msg); }}
                  />
                )}
                {list.isError && (
                  <div className="empty-flat">
                    {list.error instanceof ApiRequestError ? list.error.message : 'Could not load the vendors.'}
                  </div>
                )}
                {!list.isError && (
                  <div className="vend-wrap">
                    <table className="vend-table">
                      <thead>
                        <tr>
                          {canManage && (
                            <th className="vend-check">
                              <input type="checkbox" checked={pageAllOn} onChange={togglePage} aria-label="Select every vendor on this page" />
                            </th>
                          )}
                          <Th label="Name" k="name" sort={sort} dir={dir} onSort={sortBy} />
                          {cols.map((k) => {
                            const c = VENDOR_COLUMNS.find((x) => x.key === k)!;
                            return c.sort ? <Th key={k} label={c.label} k={c.sort} sort={sort} dir={dir} onSort={sortBy} /> : <th key={k}>{c.label}</th>;
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((v) => (
                          <Row key={v.id} v={v} cols={cols} meta={m} selectable={canManage} selected={selected.has(v.id)} onToggle={() => toggle(v.id)} />
                        ))}
                      </tbody>
                    </table>
                    {list.data && rows.length === 0 && (
                      <div className="empty-flat">
                        {total === 0 && !anyFilter
                          ? 'No vendors yet. Add the first one, import a CSV, or add technicians from the map on a work order.'
                          : 'Nothing matches these filters.'}
                      </div>
                    )}
                  </div>
                )}
                <div className="vend-foot">
                  <span>{list.isFetching ? 'Loading…' : `${total} ${total === 1 ? 'record' : 'records'}`}</span>
                  {pages > 1 && (
                    <span className="push">
                      <button type="button" className="btn btn-sm is-ghost" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>
                        <Icon name="chev-l" size={12} /> Previous
                      </button>
                      Page {page} of {pages}
                      <button type="button" className="btn btn-sm is-ghost" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>
                        Next <Icon name="chev-r" size={12} />
                      </button>
                    </span>
                  )}
                </div>
              </>
            ) : (
              <CoverageMap
                trade={sp.get('trade') ?? ''}
                state={sp.get('state') ?? ''}
                status={sp.get('status') ?? ''}
                kind={sp.get('kind') ?? ''}
                trades={m?.trades ?? []}
                statuses={statuses}
              />
            )}
          </section>
        )}
      </div>

      {bulkSearch && (
        <BulkSearchDialog
          onClose={() => setBulkSearch(false)}
          onShow={(ids) => {
            setBulkSearch(false);
            setSearchText('');
            setSp({ ids: ids.join(','), ...keepView }, { replace: true });
          }}
        />
      )}
      {saving && <SaveViewDialog params={filterParams} canShare={can('vendors/review', 'approve')} onClose={() => setSaving(false)} />}
      {advOpen && (
        <AdvancedFilterDialog
          initial={advanced}
          meta={m}
          onClose={() => setAdvOpen(false)}
          onApply={(f) => {
            setAdvOpen(false);
            set({ filter: serializeVendorFilter(f) });
          }}
        />
      )}
      {colsOpen && (
        <ColumnsDialog
          shown={cols}
          onClose={() => setColsOpen(false)}
          onSave={(next) => {
            setColsOpen(false);
            saveCols.mutate(next);
          }}
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

/** One cell of a pickable column (shared/vendorFilters.ts · VENDOR_COLUMNS). */
function cell(k: string, v: VendorRow, meta: VendorsMetaResponse | undefined): { node: ReactNode; className?: string } {
  switch (k) {
    case 'status': return { node: <StatusDot status={v.status} defs={meta?.statuses ?? []} /> };
    case 'trade': return { node: [v.primary_trade, ...v.secondary_trades].filter(Boolean).join(', ') || '—' };
    case 'city': return { node: v.city ?? '—' };
    case 'state': return { node: v.state ?? '—' };
    case 'zip': return { node: v.zip ?? '—', className: 'mono' };
    case 'coverage': return { node: v.nationwide ? 'Nationwide' : v.statewide ? 'Statewide' : 'Local' };
    case 'phone': return { node: v.phone ?? '—', className: 'mono' };
    case 'email': return { node: v.email ?? '—' };
    case 'contact': return { node: v.primary_contact_name ?? '—' };
    case 'owner': return { node: v.owner?.name ?? '—' };
    case 'brand_source': return { node: meta?.brand_sources.find((b) => b.key === v.brand_source)?.label ?? v.brand_source ?? '—' };
    case 'priority': return { node: v.priority ? v.priority.charAt(0) + v.priority.slice(1).toLowerCase() : '—' };
    case 'compliance': return { node: v.kind === 'vendor' ? COMPLIANCE_STATUS_LABELS[v.compliance_status] : '—' };
    case 'w9': return { node: v.kind === 'vendor' ? TRI_STATE_LABELS[v.w9_received] : '—' };
    case 'msa': return { node: v.kind === 'vendor' ? TRI_STATE_LABELS[v.msa_signed] : '—' };
    case 'coi':
      return { node: v.kind !== 'vendor' ? '—' : v.coi_approved === 'YES' ? 'Approved' : v.coi_approved === 'NO' ? 'Sent back' : v.coi_received === 'YES' ? 'Received' : TRI_STATE_LABELS[v.coi_received] };
    case 'rate': return { node: money(v.regular_hourly_rate), className: 'num' };
    case 'trip_charge': return { node: money(v.trip_charge), className: 'num' };
    case 'jobs': return { node: v.work_orders_count, className: 'num' };
    case 'last_contact': return { node: day(v.last_contact) };
    case 'added': return { node: day(v.created_at) };
    case 'updated': return { node: day(v.updated_at) };
    default: return { node: '—' };
  }
}

function Row({ v, cols, meta, selectable, selected, onToggle }: {
  v: VendorRow;
  cols: string[];
  meta: VendorsMetaResponse | undefined;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className={selected ? 'is-selected' : undefined}>
      {selectable && (
        <td className="vend-check">
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${v.name}`} />
        </td>
      )}
      <td className="vend-name">
        <Link to={`/vendors/${v.id}`}>{v.name}</Link>
        <span>
          <span className="chip chip-sm">{VENDOR_KIND_LABELS[v.kind]}</span>
          {v.blacklisted && <span className="chip chip-danger chip-sm">Blacklisted</span>}
          {v.flagged_duplicate && <span className="chip chip-sm" title="Saved although the name or a phone matched another record">Possible duplicate</span>}
          {v.flagged_missing && <span className="chip chip-sm" title="Saved without a required field">Missing information</span>}
          {!v.on_map && <span className="chip chip-outline chip-sm" title="The city could not be placed — correct the city, state or ZIP">Not on the map</span>}
          {v.is_subcontractor && <span className="chip chip-sm">Subcontractor</span>}
        </span>
      </td>
      {cols.map((k) => {
        const c = cell(k, v, meta);
        return <td key={k} className={c.className}>{c.node}</td>;
      })}
    </tr>
  );
}

// ── The coverage map ─────────────────────────────────────────────────────────

function CoverageMap({ trade, state, status, kind, trades, statuses }: {
  trade: string;
  state: string;
  status: string;
  kind: string;
  trades: string[];
  statuses: VendorStatusDef[];
}) {
  const { theme } = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['vendor-coverage', trade, state, status, kind],
    queryFn: () => getVendorCoverage({ trade: trade || undefined, state: state || undefined, status: status || undefined, kind: kind || undefined }),
    placeholderData: keepPreviousData,
  });
  const pts = q.data?.points ?? [];
  // A technician with three cities is three dots; the id on the map is the
  // dot's, and it resolves back to the record.
  const dots = useMemo(() => pts.map((p, i) => ({ ...p, dot: `${p.id}:${i}` })), [pts]);
  const points = useMemo<MapPoint[]>(
    () =>
      dots.map((p) => ({
        id: p.dot,
        lat: p.lat,
        lng: p.lng,
        slot: tradeSlot(p.primary_trade, trades),
        kind: p.kind,
        blacklisted: p.blacklisted,
      })),
    [dots, trades],
  );
  const picked: (CoveragePoint & { dot: string }) | null = dots.find((d) => d.dot === selectedId) ?? null;
  const shownTrades = useMemo(() => {
    const seen = new Set(pts.map((p) => (p.primary_trade ?? '').toLowerCase()));
    return trades.filter((t) => seen.has(t.toLowerCase()));
  }, [pts, trades]);
  const vendors = new Set(pts.map((p) => p.id)).size;

  return (
    <>
      <div className="vend-map">
        <Suspense fallback={<div className="tmap-loading">Loading the map…</div>}>
          <VendorMap
            key={theme}
            theme={theme}
            points={points}
            selectedId={selectedId}
            onSelect={setSelectedId}
            fitKey={`${trade}|${state}|${status}|${kind}|${pts.length > 0}`}
          />
        </Suspense>
        {picked && (
          <div className="vend-map-pick">
            <b>{picked.name}</b>
            <span>{[picked.primary_trade, [picked.city, picked.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span>
            <span>
              <StatusDot status={picked.status} defs={statuses} />
              {picked.nationwide ? ' · Nationwide' : picked.statewide ? ' · Statewide' : ''}
              {picked.blacklisted ? ' · Blacklisted' : ''}
            </span>
            <span style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <Link className="btn btn-sm" to={`/vendors/${picked.id}`}>Open the record</Link>
              <button type="button" className="btn btn-sm is-ghost" onClick={() => setSelectedId(null)}>Close</button>
            </span>
          </div>
        )}
        {shownTrades.length > 0 && (
          <div className="vend-map-legend">
            {shownTrades.map((t) => (
              <span key={t}>
                <i style={{ background: `var(--map-${tradeSlot(t, trades) || 'other'})` }} />
                {t}
              </span>
            ))}
            <span><i className="tmap-key is-vendor" style={{ margin: '0 6px 0 0' }} />VR vendor</span>
            <span><i className="tmap-key is-tech" style={{ margin: '0 6px 0 0' }} />Technician</span>
          </div>
        )}
      </div>
      <div className="vend-foot">
        <span>
          {q.isFetching
            ? 'Loading…'
            : q.isError
              ? 'Could not load the map.'
              : `${vendors} ${vendors === 1 ? 'record' : 'records'} on the map${pts.length !== vendors ? ` · ${pts.length} locations` : ''}`}
        </span>
      </div>
    </>
  );
}
