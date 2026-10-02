/* /sites/:id — one site (0060): what it is and where, its buildings, floors
 * and spaces, the assets standing in them, the work orders raised there, and
 * every change made to the record. */

import { Suspense, lazy, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SITE_LOCATION_KIND_LABELS,
  SITE_SOURCE_LABELS,
  SPACE_TYPE_SUGGESTIONS,
  allowedParentKinds,
  flattenLocations,
  locationTree,
} from '@theone/shared';
import type { LocationNode, SiteDetail, SiteLocationKind } from '@theone/shared';
import { addSiteLocation, deleteSite, getSite, getSiteHistory, getSitesMeta, removeSiteLocation, updateSiteLocation } from '../api/client';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import {
  AssetFormDialog,
  AssetStatusChip,
  ConditionChip,
  HistoryCard,
  SiteFormDialog,
  WarrantyChip,
  WorkOrderList,
  errText,
} from '../components/portfolio/PortfolioParts';
import { SiteEventsCard, SpaceViewer } from '../components/portfolio/SiteExtras';
import { useTheme } from '../theme/ThemeProvider';

const VendorMap = lazy(() => import('../components/map/VendorMap'));

export function SiteDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { theme } = useTheme();
  const key = ['site', id];
  const q = useQuery({ queryKey: key, queryFn: () => getSite(id) });
  const meta = useQuery({ queryKey: ['sites-meta'], queryFn: getSitesMeta });
  const s = q.data?.site ?? null;
  const [editing, setEditing] = useState(false);
  const [addingAsset, setAddingAsset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => deleteSite(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sites'] });
      void qc.invalidateQueries({ queryKey: ['sites-meta'] });
      navigate('/sites');
    },
    onError: (e) => setProblem(errText(e, 'Could not remove the site.')),
  });

  const crumbs = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button type="button" className="crumb-back" aria-label="Back to Sites" onClick={() => navigate('/sites')}><Icon name="arrow-l" size={14} /></button>
      <Link className="crumb" to="/sites">Sites</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <span className="crumb-cur" aria-current="page">{s?.name ?? '…'}</span>
    </nav>
  );
  const shell = (children: ReactNode) => (
    <AppShell active="Sites" breadcrumb={crumbs}>
      <div className="canvas-inner">{children}</div>
    </AppShell>
  );
  if (q.isLoading) return shell(<div className="wo-state"><b>Loading the site…</b></div>);
  if (q.isError || !s) {
    return shell(
      <div className="wo-state">
        <Icon name="alert" size={22} />
        <b>Could not open this site</b>
        <span>{errText(q.error, 'It may have been removed.')}</span>
        <Link className="btn" to="/sites">Back to Sites</Link>
      </div>,
    );
  }

  const addressLine = [s.address1, s.address2].filter(Boolean).join(', ');
  const cityLine = [[s.city, s.state].filter(Boolean).join(', '), s.zip].filter(Boolean).join(' ');
  const rows: [string, ReactNode][] = [
    ['Client', s.client],
    ['Store number', s.store_number],
    ['Address', addressLine || cityLine ? <>{addressLine}{addressLine && cityLine ? <br /> : null}{cityLine}</> : null],
    ['Site type', s.site_type],
    ['Ownership', s.ownership_status],
    ['Managed by', s.managed_by?.name],
    ['Billing entity', s.billing_entity],
    ['Site phone', [s.phone_1, s.phone_2].filter(Boolean).join(' · ') || null],
    ['Site contact', [s.contact_name, s.contact_email].filter(Boolean).join(' · ') || null],
    ['Opening hours', s.hours],
    ['Getting in', s.access_notes],
    ['Notes', s.notes],
  ];

  return shell(
    <>
      <section className="card vrec-head">
        <div className="vrec-title">
          <h1>{s.name ?? s.client ?? 'Unnamed site'}</h1>
          <div className="vrec-chips">
            <span className="chip chip-sm">{SITE_SOURCE_LABELS[s.source] ?? s.source}</span>
            {s.site_type && <span className="chip chip-sm">{s.site_type}</span>}
            {!s.is_active && <span className="chip chip-outline chip-sm">Closed</span>}
            {!s.on_map && <span className="chip chip-outline chip-sm">Not on the map</span>}
            <span className="chip chip-sm">{s.open_work_orders} open · {s.work_orders} work orders</span>
          </div>
        </div>
        <div className="vrec-actions">
          {s.can.edit && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
              <Icon name="pencil" size={14} />
              Edit
            </button>
          )}
          {s.can.delete && (
            <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={14} />
              Remove
            </button>
          )}
        </div>
      </section>
      {problem && <div className="callout" style={{ marginTop: 12 }}><Icon name="alert" size={14} /><span>{problem}</span></div>}

      <div className="vrec-grid">
        <div className="vrec-col">
          <section className="card">
            <div className="card-head"><h2 className="card-title">The site</h2></div>
            <div className="vrec-fields">
              {rows.map(([label, value]) => (
                <div className={`vrec-field${label === 'Getting in' || label === 'Notes' ? ' is-wide' : ''}`} key={label}>
                  <span className="lbl">{label}</span>
                  <span className={`vrec-val${value ? '' : ' is-none'}`}>{value || '—'}</span>
                </div>
              ))}
            </div>
          </section>

          <LocationsCard site={s} siteKey={key} spaceTypes={[...new Set([...SPACE_TYPE_SUGGESTIONS, ...(meta.data?.space_types ?? [])])]} />

          {/* 0064 · pick a place, see what stands in it and what is open against it. */}
          {(s.locations.length > 0 || s.assets > 0) && (
            <section className="card">
              <div className="card-head"><h2 className="card-title">Space viewer</h2></div>
              <SpaceViewer siteId={s.id} />
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2 className="card-title grow">Assets</h2>
              <span className="card-meta">{s.assets}</span>
              {s.can.add_asset && (
                <button type="button" className="btn btn-sm is-ghost" onClick={() => setAddingAsset(true)}>
                  <Icon name="plus" size={12} /> Add asset
                </button>
              )}
            </div>
            {s.asset_list.length === 0 ? (
              <div className="empty-flat">{meta.data && !meta.data.can.assets.view ? 'Your role does not show assets.' : 'No assets on file for this site.'}</div>
            ) : (
              <div className="vend-wrap">
                <table className="vend-table">
                  <thead><tr><th>Asset</th><th>Type</th><th>Where</th><th>Status</th><th>Condition</th><th>Warranty</th><th>Work orders</th></tr></thead>
                  <tbody>
                    {s.asset_list.map((a) => (
                      <tr key={a.id}>
                        <td className="vend-name"><Link to={`/assets/${a.id}`}>{a.name}</Link></td>
                        <td>{a.asset_type ?? a.category ?? '—'}</td>
                        <td>{a.location ?? '—'}</td>
                        <td><AssetStatusChip status={a.status} /></td>
                        <td><ConditionChip condition={a.condition} /></td>
                        <td><WarrantyChip state={a.warranty} expiresOn={a.warranty_expires_on} /></td>
                        <td className="num">{a.work_orders}</td>
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
              <span className="card-meta">{s.work_orders}{s.work_orders > s.recent_work_orders.length ? ` · latest ${s.recent_work_orders.length}` : ''}</span>
            </div>
            <WorkOrderList items={s.recent_work_orders} empty="No work order is linked to this site yet." showAsset />
          </section>
        </div>

        <aside className="vrec-col">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title grow">On the map</h2>
              {s.boundary_radius_ft != null && <span className="card-meta">Boundary {s.boundary_radius_ft.toLocaleString()} ft</span>}
            </div>
            {s.lat != null && s.lng != null ? (
              <>
                <div className="pf-map">
                  <Suspense fallback={<div className="tmap-loading">Loading the map…</div>}>
                    <VendorMap
                      key={theme}
                      theme={theme}
                      points={[]}
                      center={{ lat: s.lat, lng: s.lng }}
                      radiusMiles={s.boundary_radius_ft != null ? s.boundary_radius_ft / 5280 : undefined}
                      fitKey={`${s.lat}|${s.lng}|${s.boundary_radius_ft ?? ''}`}
                    />
                  </Suspense>
                </div>
                <p className="vrec-note" style={{ paddingTop: 8 }}>
                  {s.geo_source === 'manual' ? 'Pinned by hand.' : s.geo_source === 'zip' ? 'Placed at the centre of its ZIP code.' : 'Placed at the centre of its city.'}
                  {s.geo_source !== 'manual' && s.can.edit ? ' Edit the site to pin the exact spot.' : ''}
                </p>
              </>
            ) : (
              <div className="empty-flat">Not on the map — the ZIP and city could not be placed. Correct the address, or give coordinates.</div>
            )}
          </section>
          {/* 0064 · what is happening at the site that the people working it should know. */}
          <SiteEventsCard siteId={s.id} canEdit={s.can.edit} />
          <HistoryCard queryKey={['site-history', id, s.updated_at, s.locations.length]} load={() => getSiteHistory(id)} />
        </aside>
      </div>

      {editing && <SiteFormDialog site={s} meta={meta.data} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {addingAsset && (
        <AssetFormDialog
          asset={null}
          site={{ id: s.id, name: s.name ?? 'Site' }}
          meta={meta.data}
          onClose={() => setAddingAsset(false)}
          onSaved={() => { setAddingAsset(false); void qc.invalidateQueries({ queryKey: key }); }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`Remove ${s.name ?? 'this site'}?`}
          message={<>It leaves the list and the map. Its {s.work_orders} work {s.work_orders === 1 ? 'order keeps' : 'orders keep'} pointing at it and the change history stays.</>}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); remove.mutate(); }}
        />
      )}
    </>,
  );
}

// ── Buildings, floors, spaces ────────────────────────────────────────────────

type LocDraft = { id: string | null; kind: SiteLocationKind; parent_id: string; name: string; level: string; space_type: string; area_sqft: string };

function LocationsCard({ site, siteKey, spaceTypes }: { site: SiteDetail; siteKey: string[]; spaceTypes: string[] }) {
  const qc = useQueryClient();
  const tree = useMemo(() => locationTree(site.locations), [site.locations]);
  const flat = useMemo(() => flattenLocations(tree), [tree]);
  const [draft, setDraft] = useState<LocDraft | null>(null);
  const [removing, setRemoving] = useState<LocationNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const landed = (res: { site: SiteDetail }) => {
    qc.setQueryData(siteKey, res);
    void qc.invalidateQueries({ queryKey: ['sites-meta'] });
    setDraft(null);
    setError(null);
  };

  const save = useMutation({
    mutationFn: () => {
      const d = draft!;
      const body = {
        name: d.name.trim(),
        level: d.kind === 'floor' && d.level.trim() !== '' ? Number(d.level) : null,
        space_type: d.kind === 'space' ? d.space_type.trim() || null : null,
        area_sqft: d.area_sqft.trim() !== '' ? Number(d.area_sqft) : null,
      };
      if (body.level !== null && !Number.isInteger(body.level)) throw new Error('The level is a whole number: 0 for ground, -1 for a basement.');
      if (body.area_sqft !== null && !(body.area_sqft >= 0)) throw new Error('The area must be a number.');
      return d.id ? updateSiteLocation(site.id, d.id, body) : addSiteLocation(site.id, { ...body, kind: d.kind, parent_id: d.parent_id || null });
    },
    onSuccess: landed,
    onError: (e) => setError(errText(e, 'Could not save.')),
  });
  const remove = useMutation({
    mutationFn: (locId: string) => removeSiteLocation(site.id, locId),
    onSuccess: (res) => { setRemoving(null); landed(res); },
    onError: (e) => { setRemoving(null); setError(errText(e, 'Could not remove it.')); },
  });

  const start = (kind: SiteLocationKind, parent: LocationNode | null) => {
    setError(null);
    setDraft({ id: null, kind, parent_id: parent?.id ?? '', name: '', level: '', space_type: '', area_sqft: '' });
  };
  const edit = (n: LocationNode) => {
    setError(null);
    setDraft({ id: n.id, kind: n.kind, parent_id: n.parent_id ?? '', name: n.name, level: n.level != null ? String(n.level) : '', space_type: n.space_type ?? '', area_sqft: n.area_sqft != null ? String(n.area_sqft) : '' });
  };
  /** What may be added inside a row of this kind. */
  const childKinds = (kind: SiteLocationKind): SiteLocationKind[] => (['floor', 'space'] as SiteLocationKind[]).filter((k) => allowedParentKinds(k).includes(kind));
  const counts = { building: 0, floor: 0, space: 0 };
  for (const l of site.locations) counts[l.kind] += 1;
  const parentsFor = (kind: SiteLocationKind) => flat.filter((n) => allowedParentKinds(kind).includes(n.kind));
  const below = (n: LocationNode): number => n.children.reduce((sum, c) => sum + 1 + below(c), 0);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Buildings, floors and spaces</h2>
        <span className="card-meta">{counts.building} · {counts.floor} · {counts.space}</span>
        {site.can.edit && (
          <>
            <button type="button" className="btn btn-sm is-ghost" onClick={() => start('building', null)}><Icon name="plus" size={12} /> Building</button>
            <button type="button" className="btn btn-sm is-ghost" onClick={() => start('space', null)}><Icon name="plus" size={12} /> Space</button>
          </>
        )}
      </div>
      {error && <div className="callout" style={{ margin: '0 14px 10px' }}><Icon name="alert" size={14} /><span>{error}</span></div>}

      {draft && (
        <form className="pf-loc-form" onSubmit={(e) => { e.preventDefault(); if (draft.name.trim()) save.mutate(); }}>
          <b>{draft.id ? `Edit ${SITE_LOCATION_KIND_LABELS[draft.kind].toLowerCase()}` : `New ${SITE_LOCATION_KIND_LABELS[draft.kind].toLowerCase()}`}</b>
          <input className="fld" autoFocus placeholder={draft.kind === 'building' ? 'Main building' : draft.kind === 'floor' ? 'Ground floor' : 'Kitchen'} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Name" />
          {!draft.id && draft.kind !== 'building' && (
            <select className="fld" value={draft.parent_id} onChange={(e) => setDraft({ ...draft, parent_id: e.target.value })} aria-label="Inside">
              {draft.kind === 'space' && <option value="">On the site itself</option>}
              {draft.kind === 'floor' && draft.parent_id === '' && <option value="">Choose the building…</option>}
              {parentsFor(draft.kind).map((n) => <option key={n.id} value={n.id}>{`${'   '.repeat(n.depth)}${n.name}`}</option>)}
            </select>
          )}
          {draft.kind === 'floor' && <input className="fld mono" inputMode="numeric" placeholder="Level (0 = ground)" value={draft.level} onChange={(e) => setDraft({ ...draft, level: e.target.value })} aria-label="Level" />}
          {draft.kind === 'space' && (
            <>
              <input className="fld" list="pf-space-types" placeholder="What it is" value={draft.space_type} onChange={(e) => setDraft({ ...draft, space_type: e.target.value })} aria-label="Space type" />
              <datalist id="pf-space-types">{spaceTypes.map((t) => <option key={t} value={t} />)}</datalist>
            </>
          )}
          <input className="fld mono" inputMode="decimal" placeholder="Area (sq ft)" value={draft.area_sqft} onChange={(e) => setDraft({ ...draft, area_sqft: e.target.value })} aria-label="Area in square feet" />
          <button type="submit" className="btn btn-sm" disabled={draft.name.trim() === '' || (draft.kind === 'floor' && !draft.id && draft.parent_id === '') || save.isPending}>{draft.id ? 'Save' : 'Add'}</button>
          <button type="button" className="btn btn-sm is-ghost" onClick={() => setDraft(null)}>Cancel</button>
        </form>
      )}

      {flat.length === 0 ? (
        <div className="empty-flat">
          Nothing mapped out yet. Add a building, then its floors and the spaces on them — or a space straight on the site (a parking lot, a drive-through).
        </div>
      ) : (
        <ul className="pf-tree">
          {flat.map((n) => (
            <li key={n.id} className={`is-${n.kind}`} style={{ paddingLeft: 14 + n.depth * 22 }}>
              <Icon name={n.kind === 'building' ? 'home' : n.kind === 'floor' ? 'layers' : 'grid'} size={12} />
              <span className="pf-tree-name">{n.name}</span>
              <span className="pf-muted">
                {[
                  n.kind === 'floor' && n.level != null ? `level ${n.level}` : null,
                  n.kind === 'space' ? n.space_type : null,
                  n.area_sqft != null ? `${n.area_sqft.toLocaleString()} sq ft` : null,
                  n.assets > 0 ? `${n.assets} ${n.assets === 1 ? 'asset' : 'assets'}` : null,
                ].filter(Boolean).join(' · ')}
              </span>
              {site.can.edit && (
                <span className="pf-tree-acts">
                  {childKinds(n.kind).map((k) => (
                    <button key={k} type="button" className="link-btn" onClick={() => start(k, n)}>+ {SITE_LOCATION_KIND_LABELS[k]}</button>
                  ))}
                  <button type="button" className="icon-btn" aria-label={`Edit ${n.name}`} onClick={() => edit(n)}><Icon name="pencil" size={12} /></button>
                  <button type="button" className="icon-btn" aria-label={`Remove ${n.name}`} onClick={() => setRemoving(n)}><Icon name="trash" size={12} /></button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message={
            <>
              {below(removing) > 0 ? <>Everything inside it goes too ({below(removing)} {below(removing) === 1 ? 'place' : 'places'}). </> : null}
              Assets standing there stay at the site and lose their place.
            </>
          }
          confirmLabel="Remove"
          danger
          busy={remove.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.id)}
        />
      )}
    </section>
  );
}
