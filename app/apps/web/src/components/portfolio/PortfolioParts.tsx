/* 0060 · The pieces the Sites and Assets pages share: the two record forms
 * (add and edit are the same sheet), the site search box, the chips that say
 * how a warranty and a condition stand, the work-order list and the change
 * history. */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ASSET_CONDITION_LABELS,
  ASSET_STATUSES,
  ASSET_STATUS_LABELS,
  SITE_OWNERSHIP,
  SITE_RADIUS_MAX_FT,
  SITE_RADIUS_MIN_FT,
  SITE_SYNCED_FIELDS,
  US_STATE_CODES,
  WARRANTY_STATE_LABELS,
  flattenLocations,
  locationTree,
} from '@theone/shared';
import type {
  AssetCondition,
  AssetDetail,
  AssetInput,
  AssetStatus,
  PortfolioHistoryEntry,
  SiteDetail,
  SiteInput,
  SiteWorkOrder,
  SitesMetaResponse,
  WarrantyState,
} from '@theone/shared';
import { ApiRequestError, createAsset, createSite, getSite, listAssets, listSites, updateAsset, updateSite } from '../../api/client';
import { feedTime } from '../../lib/fields';
import { useEscape } from '../../lib/useEscape';
import { Icon } from '../Icon';

export const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : fallback);

export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

// ── Chips ────────────────────────────────────────────────────────────────────

export function WarrantyChip({ state, expiresOn }: { state: WarrantyState; expiresOn: string | null }) {
  if (state === 'none') return <span className="pf-muted">—</span>;
  const tone = state === 'expired' ? ' chip-danger' : state === 'expiring' ? ' chip-warn' : ' chip-accent';
  return (
    <span className={`chip chip-sm${tone}`} title={`${WARRANTY_STATE_LABELS[state]} · ${day(expiresOn)}`}>
      {state === 'expired' ? 'Expired' : state === 'expiring' ? 'Ends' : 'Until'} {day(expiresOn)}
    </span>
  );
}

export function ConditionChip({ condition }: { condition: AssetCondition | null }) {
  if (!condition) return <span className="pf-muted">Not recorded</span>;
  return <span className={`pf-cond is-${condition}`}>{ASSET_CONDITION_LABELS[condition]}</span>;
}

export function AssetStatusChip({ status }: { status: AssetStatus }) {
  return <span className={`chip chip-sm${status === 'in_service' ? '' : status === 'retired' ? ' chip-outline' : ' chip-warn'}`}>{ASSET_STATUS_LABELS[status]}</span>;
}

// ── Work orders and history ──────────────────────────────────────────────────

export function WorkOrderList({ items, empty, showAsset }: { items: SiteWorkOrder[]; empty: string; showAsset?: boolean }) {
  if (items.length === 0) return <div className="empty-flat">{empty}</div>;
  return (
    <div className="vend-wrap">
      <table className="vend-table">
        <thead>
          <tr><th>Work order</th><th>Status</th><th>Trade</th>{showAsset && <th>Asset</th>}<th>Received</th></tr>
        </thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.wo_number}>
              <td className="vend-name">
                <Link to={`/work-orders/${encodeURIComponent(w.wo_number)}`}>{w.wo_number}</Link>
                <span className="pf-wo-title">{w.title}</span>
              </td>
              <td><span className={`chip chip-sm${w.status_group === 'done' || w.status_group === 'closed' ? ' chip-outline' : ''}`}>{w.status}</span></td>
              <td>{w.trade ?? '—'}</td>
              {showAsset && <td>{w.asset ? <Link to={`/assets/${w.asset.id}`}>{w.asset.name}</Link> : '—'}</td>}
              <td>{day(w.date_received ?? w.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const HISTORY_LABELS: Record<string, string> = {
  site_created: 'Site added',
  site_updated: 'Site edited',
  site_deleted: 'Site removed',
  site_location_added: 'Place added',
  site_location_updated: 'Place renamed',
  site_location_removed: 'Place removed',
  asset_created: 'Asset added',
  asset_updated: 'Asset edited',
  asset_deleted: 'Asset removed',
  asset_condition_recorded: 'Condition recorded',
};

const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

export function HistoryCard({ queryKey, load }: { queryKey: unknown[]; load: () => Promise<{ history: PortfolioHistoryEntry[] }> }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey, queryFn: load, enabled: open });
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Change history</h2>
        <button type="button" className="link-btn" onClick={() => setOpen((s) => !s)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open && (
        <ul className="vrec-hist">
          {q.isLoading && <li>Loading…</li>}
          {q.data && q.data.history.length === 0 && <li>Nothing recorded yet.</li>}
          {(q.data?.history ?? []).map((h) => (
            <li key={h.id}>
              <b>
                {HISTORY_LABELS[h.action] ?? h.action.replace(/_/g, ' ')}
                {h.action.startsWith('site_location') && (h.after?.location || h.before?.location) ? ` · ${fmt(h.after?.location ?? h.before?.location)}` : ''}
                {h.action === 'asset_condition_recorded' ? ` · ${fmt(h.after?.condition)}` : ''}
              </b>
              <small>{h.actor?.name ?? 'System'} · {feedTime(h.created_at)}</small>
              {(h.action === 'site_updated' || h.action === 'asset_updated') && h.after && (
                <span>
                  {Object.keys(h.after).filter((k) => k !== 'name' || h.before?.name !== h.after?.name).map((k) => (
                    <span key={k} style={{ display: 'block' }}>{k.replace(/_/g, ' ')}: {fmt(h.before?.[k])} → {fmt(h.after?.[k])}</span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Form plumbing ────────────────────────────────────────────────────────────

function Field({ label, wide, hint, children }: { label: string; wide?: boolean; hint?: string; children: ReactNode }) {
  return (
    <label className={`pf-field${wide ? ' is-wide' : ''}`}>
      <span className="lbl">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** A free-text input that suggests the values already in use. */
function Suggest({ id, value, onChange, options, disabled }: { id: string; value: string; onChange: (v: string) => void; options: string[]; disabled?: boolean }) {
  return (
    <>
      <input className="fld" list={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      <datalist id={id}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}

// ── The site form ────────────────────────────────────────────────────────────

type SiteDraft = Record<
  'name' | 'client' | 'store_number' | 'address1' | 'address2' | 'city' | 'state' | 'zip' | 'phone_1' | 'phone_2' | 'site_type' |
  'ownership_status' | 'managed_by' | 'billing_entity' | 'contact_name' | 'contact_email' | 'hours' | 'access_notes' | 'notes' |
  'boundary_radius_ft' | 'lat' | 'lng',
  string
> & { is_active: boolean };

const siteDraft = (s: SiteDetail | null): SiteDraft => ({
  name: s?.name ?? '',
  client: s?.client ?? '',
  store_number: s?.store_number ?? '',
  address1: s?.address1 ?? '',
  address2: s?.address2 ?? '',
  city: s?.city ?? '',
  state: s?.state ?? '',
  zip: s?.zip ?? '',
  phone_1: s?.phone_1 ?? '',
  phone_2: s?.phone_2 ?? '',
  site_type: s?.site_type ?? '',
  ownership_status: s?.ownership_status ?? '',
  managed_by: s?.managed_by?.id ?? '',
  billing_entity: s?.billing_entity ?? '',
  contact_name: s?.contact_name ?? '',
  contact_email: s?.contact_email ?? '',
  hours: s?.hours ?? '',
  access_notes: s?.access_notes ?? '',
  notes: s?.notes ?? '',
  boundary_radius_ft: s?.boundary_radius_ft != null ? String(s.boundary_radius_ft) : '',
  lat: s?.geo_source === 'manual' && s.lat != null ? String(s.lat) : '',
  lng: s?.geo_source === 'manual' && s.lng != null ? String(s.lng) : '',
  is_active: s?.is_active ?? true,
});

export function SiteFormDialog({ site, meta, onClose, onSaved }: {
  site: SiteDetail | null;
  meta: SitesMetaResponse | undefined;
  onClose: () => void;
  onSaved: (s: SiteDetail) => void;
}) {
  useEscape(onClose);
  const qc = useQueryClient();
  const [d, setD] = useState<SiteDraft>(() => siteDraft(site));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (k: keyof SiteDraft, v: string | boolean) => setD((cur) => ({ ...cur, [k]: v }));
  const synced = site?.source === 'ecotrak';
  const locked = (k: string) => synced && SITE_SYNCED_FIELDS.includes(k);
  const txt = (k: keyof SiteDraft) => (d[k] as string).trim() || null;

  const save = useMutation({
    mutationFn: () => {
      const radius = d.boundary_radius_ft.trim();
      const lat = d.lat.trim();
      const lng = d.lng.trim();
      if (radius !== '' && (!/^\d+$/.test(radius) || Number(radius) < SITE_RADIUS_MIN_FT || Number(radius) > SITE_RADIUS_MAX_FT)) {
        throw new Error(`The boundary must be a whole number of feet between ${SITE_RADIUS_MIN_FT} and ${SITE_RADIUS_MAX_FT.toLocaleString()}.`);
      }
      if ((lat === '') !== (lng === '')) throw new Error('Give both the latitude and the longitude, or leave both empty.');
      if (lat !== '' && (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)))) throw new Error('The coordinates must be numbers.');
      const input: SiteInput = {
        phone_1: txt('phone_1'), phone_2: txt('phone_2'), site_type: txt('site_type'), ownership_status: txt('ownership_status'),
        managed_by: d.managed_by || null, billing_entity: txt('billing_entity'), contact_name: txt('contact_name'),
        contact_email: txt('contact_email'), hours: txt('hours'), access_notes: txt('access_notes'), notes: txt('notes'),
        boundary_radius_ft: radius === '' ? null : Number(radius),
        is_active: d.is_active,
      };
      // What Ecotrak owns on its own sites is not sent back at all.
      if (!synced) Object.assign(input, { name: txt('name'), client: txt('client'), store_number: txt('store_number'), address1: txt('address1'), address2: txt('address2'), city: txt('city'), state: txt('state'), zip: txt('zip') });
      if (lat !== '') Object.assign(input, { lat: Number(lat), lng: Number(lng) });
      else if (site?.geo_source === 'manual') Object.assign(input, { lat: null, lng: null });
      return site ? updateSite(site.id, input) : createSite(input);
    },
    onMutate: () => setProblem(null),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['sites'] });
      void qc.invalidateQueries({ queryKey: ['sites-meta'] });
      void qc.invalidateQueries({ queryKey: ['sites-map'] });
      qc.setQueryData(['site', res.site.id], res);
      onSaved(res.site);
    },
    onError: (e) => setProblem(errText(e, 'Could not save the site.')),
  });

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="siteT">
      <div className="sheet vend-sheet is-wide pf-sheet">
        <h2 className="sheet-t" id="siteT">
          <Icon name="store" size={16} />
          {site ? `Edit ${site.name ?? 'site'}` : 'Add a site'}
        </h2>
        {synced && <p className="sheet-b">This site comes from Ecotrak, which keeps its name, client, store number and address up to date. Everything else is yours to fill in.</p>}
        <div className="pf-form">
          <Field label="Client"><Suggest id="pf-clients" value={d.client} onChange={(v) => set('client', v)} options={meta?.clients ?? []} disabled={locked('client')} /></Field>
          <Field label="Store number"><input className="fld" value={d.store_number} disabled={locked('store_number')} onChange={(e) => set('store_number', e.target.value)} /></Field>
          <Field label="Site name" wide hint={site ? undefined : 'Left empty, it is the client and the store number.'}>
            <input className="fld" value={d.name} disabled={locked('name')} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Street address" wide><input className="fld" value={d.address1} disabled={locked('address1')} onChange={(e) => set('address1', e.target.value)} /></Field>
          <Field label="Suite / unit"><input className="fld" value={d.address2} disabled={locked('address2')} onChange={(e) => set('address2', e.target.value)} /></Field>
          <Field label="City"><input className="fld" value={d.city} disabled={locked('city')} onChange={(e) => set('city', e.target.value)} /></Field>
          <Field label="State">
            <select className="fld" value={d.state.toUpperCase()} disabled={locked('state')} onChange={(e) => set('state', e.target.value)}>
              <option value="">—</option>
              {d.state && !(US_STATE_CODES as readonly string[]).includes(d.state.toUpperCase()) && <option value={d.state.toUpperCase()}>{d.state}</option>}
              {US_STATE_CODES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="ZIP"><input className="fld" value={d.zip} disabled={locked('zip')} onChange={(e) => set('zip', e.target.value)} /></Field>

          <Field label="Site type"><Suggest id="pf-types" value={d.site_type} onChange={(v) => set('site_type', v)} options={meta?.site_types ?? []} /></Field>
          <Field label="Ownership">
            <select className="fld" value={d.ownership_status} onChange={(e) => set('ownership_status', e.target.value)}>
              <option value="">—</option>
              {d.ownership_status && !(SITE_OWNERSHIP as readonly string[]).includes(d.ownership_status) && <option value={d.ownership_status}>{d.ownership_status}</option>}
              {SITE_OWNERSHIP.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Managed by">
            <select className="fld" value={d.managed_by} onChange={(e) => set('managed_by', e.target.value)}>
              <option value="">Nobody</option>
              {(meta?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Billing entity"><Suggest id="pf-entities" value={d.billing_entity} onChange={(v) => set('billing_entity', v)} options={meta?.billing_entities ?? []} /></Field>

          <Field label="Site phone"><input className="fld" value={d.phone_1} onChange={(e) => set('phone_1', e.target.value)} /></Field>
          <Field label="Second phone"><input className="fld" value={d.phone_2} onChange={(e) => set('phone_2', e.target.value)} /></Field>
          <Field label="Site contact"><input className="fld" value={d.contact_name} onChange={(e) => set('contact_name', e.target.value)} /></Field>
          <Field label="Contact email"><input className="fld" type="email" value={d.contact_email} onChange={(e) => set('contact_email', e.target.value)} /></Field>
          <Field label="Opening hours" wide><input className="fld" value={d.hours} placeholder="Mon–Sun 6am–11pm" onChange={(e) => set('hours', e.target.value)} /></Field>
          <Field label="Getting in" wide hint="Gate codes, where to park, who to ask for — what a technician needs on arrival.">
            <textarea className="fld" rows={2} value={d.access_notes} onChange={(e) => set('access_notes', e.target.value)} />
          </Field>
          <Field label="Notes" wide><textarea className="fld" rows={2} value={d.notes} onChange={(e) => set('notes', e.target.value)} /></Field>

          <Field label="Boundary (feet)" hint="How far from the pin still counts as on site.">
            <input className="fld mono" inputMode="numeric" value={d.boundary_radius_ft} placeholder="e.g. 500" onChange={(e) => set('boundary_radius_ft', e.target.value)} />
          </Field>
          <Field label="Latitude" hint="Only to place the pin by hand."><input className="fld mono" value={d.lat} placeholder="from the address" onChange={(e) => set('lat', e.target.value)} /></Field>
          <Field label="Longitude"><input className="fld mono" value={d.lng} placeholder="from the address" onChange={(e) => set('lng', e.target.value)} /></Field>
          {site && (
            <label className="tmap-check pf-field">
              <input type="checkbox" checked={d.is_active} onChange={(e) => set('is_active', e.target.checked)} />
              <span>Active — clear it for a site that closed</span>
            </label>
          )}
        </div>
        {problem && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{problem}</p>}
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : site ? 'Save changes' : 'Add site'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Finding a site ───────────────────────────────────────────────────────────

export function SitePicker({ value, onPick, autoFocus }: {
  value: { id: string; name: string } | null;
  onPick: (s: { id: string; name: string } | null) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const term = text.trim();
  const hits = useQuery({
    queryKey: ['site-pick', term],
    queryFn: () => listSites({ search: term, page_size: 8, show: 'all' }),
    enabled: term.length >= 2 && !value,
  });
  if (value) {
    return (
      <span className="pf-picked">
        <Icon name="store" size={12} /> {value.name}
        <button type="button" className="icon-btn" aria-label="Choose another site" onClick={() => onPick(null)}><Icon name="x" size={12} /></button>
      </span>
    );
  }
  return (
    <span className="pf-pick">
      <input className="fld" autoFocus={autoFocus} value={text} placeholder="Search by name, store number, address or city" onChange={(e) => setText(e.target.value)} aria-label="Find a site" />
      {term.length >= 2 && (
        <span className="pf-pick-list">
          {hits.isLoading && <span className="pf-muted">Searching…</span>}
          {hits.data && hits.data.items.length === 0 && <span className="pf-muted">No site matches.</span>}
          {(hits.data?.items ?? []).map((s) => (
            <button type="button" key={s.id} onClick={() => onPick({ id: s.id, name: s.name ?? s.client ?? 'Site' })}>
              <b>{s.name ?? s.client ?? 'Site'}</b>
              <span>{[s.address1, s.city, s.state].filter(Boolean).join(', ')}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// ── The asset form ───────────────────────────────────────────────────────────

type AssetDraft = Record<
  'name' | 'asset_type' | 'category' | 'manufacturer' | 'model_number' | 'serial_number' | 'asset_tag' | 'description' |
  'install_date' | 'warranty_expires_on' | 'warranty_provider' | 'warranty_notes' | 'parent_asset_id' | 'location_id' | 'notes',
  string
> & { status: AssetStatus };

const assetDraft = (a: AssetDetail | null): AssetDraft => ({
  name: a?.name ?? '',
  asset_type: a?.asset_type ?? '',
  category: a?.category ?? '',
  manufacturer: a?.manufacturer ?? '',
  model_number: a?.model_number ?? '',
  serial_number: a?.serial_number ?? '',
  asset_tag: a?.asset_tag ?? '',
  description: a?.description ?? '',
  install_date: a?.install_date ?? '',
  warranty_expires_on: a?.warranty_expires_on ?? '',
  warranty_provider: a?.warranty_provider ?? '',
  warranty_notes: a?.warranty_notes ?? '',
  parent_asset_id: a?.parent?.id ?? '',
  location_id: a?.location_id ?? '',
  notes: a?.notes ?? '',
  status: a?.status ?? 'in_service',
});

export function AssetFormDialog({ asset, site: fixedSite, meta, onClose, onSaved }: {
  asset: AssetDetail | null;
  /** Adding from a site's page: the site is already known. */
  site?: { id: string; name: string } | null;
  meta: SitesMetaResponse | undefined;
  onClose: () => void;
  onSaved: (a: AssetDetail) => void;
}) {
  useEscape(onClose);
  const qc = useQueryClient();
  const [d, setD] = useState<AssetDraft>(() => assetDraft(asset));
  const [site, setSite] = useState<{ id: string; name: string } | null>(asset?.site ? { id: asset.site.id, name: asset.site.name } : (fixedSite ?? null));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (k: keyof AssetDraft, v: string) => setD((cur) => ({ ...cur, [k]: v }));
  const txt = (k: keyof AssetDraft) => (d[k] as string).trim() || null;

  // The chosen site's places and the assets this one could be part of.
  const siteQ = useQuery({ queryKey: ['site', site?.id], queryFn: () => getSite(site!.id), enabled: Boolean(site) });
  const places = siteQ.data ? flattenLocations(locationTree(siteQ.data.site.locations)) : [];
  const siblings = useQuery({ queryKey: ['assets', { site: site?.id, page_size: 100 }], queryFn: () => listAssets({ site: site!.id, page_size: 100 }), enabled: Boolean(site) });

  const save = useMutation({
    mutationFn: () => {
      if (!d.name.trim()) throw new Error('The asset needs a name.');
      if (!site) throw new Error('Say which site the asset is at.');
      const input: AssetInput = {
        name: d.name.trim(),
        site_id: site.id,
        asset_type: txt('asset_type'), category: txt('category'), manufacturer: txt('manufacturer'), model_number: txt('model_number'),
        serial_number: txt('serial_number'), asset_tag: txt('asset_tag'), description: txt('description'),
        install_date: txt('install_date'), warranty_expires_on: txt('warranty_expires_on'), warranty_provider: txt('warranty_provider'),
        warranty_notes: txt('warranty_notes'), notes: txt('notes'),
        parent_asset_id: d.parent_asset_id || null,
        location_id: d.location_id || null,
        status: d.status,
      };
      return asset ? updateAsset(asset.id, input) : createAsset(input);
    },
    onMutate: () => setProblem(null),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['assets'] });
      void qc.invalidateQueries({ queryKey: ['site'] });
      void qc.invalidateQueries({ queryKey: ['sites'] });
      void qc.invalidateQueries({ queryKey: ['sites-meta'] });
      qc.setQueryData(['asset', res.asset.id], res);
      onSaved(res.asset);
    },
    onError: (e) => setProblem(errText(e, 'Could not save the asset.')),
  });

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="assetT">
      <div className="sheet vend-sheet is-wide pf-sheet">
        <h2 className="sheet-t" id="assetT">
          <Icon name="package" size={16} />
          {asset ? `Edit ${asset.name}` : 'Add an asset'}
        </h2>
        <div className="pf-form">
          <Field label="Site" wide>
            <SitePicker
              value={site}
              autoFocus={!site}
              onPick={(s) => {
                setSite(s);
                // A different site has different places and different assets.
                setD((cur) => ({ ...cur, location_id: '', parent_asset_id: '' }));
              }}
            />
          </Field>
          <Field label="Name" wide><input className="fld" value={d.name} placeholder="e.g. Walk-in cooler" onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Category"><Suggest id="pf-cats" value={d.category} onChange={(v) => set('category', v)} options={meta?.asset_categories ?? []} /></Field>
          <Field label="Type"><Suggest id="pf-atypes" value={d.asset_type} onChange={(v) => set('asset_type', v)} options={meta?.asset_types ?? []} /></Field>
          <Field label="Manufacturer"><input className="fld" value={d.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} /></Field>
          <Field label="Model"><input className="fld" value={d.model_number} onChange={(e) => set('model_number', e.target.value)} /></Field>
          <Field label="Serial number"><input className="fld mono" value={d.serial_number} onChange={(e) => set('serial_number', e.target.value)} /></Field>
          <Field label="Asset tag"><input className="fld mono" value={d.asset_tag} onChange={(e) => set('asset_tag', e.target.value)} /></Field>
          <Field label="Where it stands" hint={site && places.length === 0 ? 'Add buildings, floors and spaces on the site first.' : undefined}>
            <select className="fld" value={d.location_id} disabled={!site} onChange={(e) => set('location_id', e.target.value)}>
              <option value="">Somewhere at the site</option>
              {places.map((p) => <option key={p.id} value={p.id}>{`${'   '.repeat(p.depth)}${p.name}`}</option>)}
            </select>
          </Field>
          <Field label="Part of">
            <select className="fld" value={d.parent_asset_id} disabled={!site} onChange={(e) => set('parent_asset_id', e.target.value)}>
              <option value="">Nothing — it stands alone</option>
              {(siblings.data?.items ?? []).filter((x) => x.id !== asset?.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select className="fld" value={d.status} onChange={(e) => set('status', e.target.value)}>
              {ASSET_STATUSES.map((s) => <option key={s} value={s}>{ASSET_STATUS_LABELS[s]}</option>)}
            </select>
          </Field>
          <Field label="Installed on"><input className="fld" type="date" value={d.install_date} onChange={(e) => set('install_date', e.target.value)} /></Field>
          <Field label="Warranty ends"><input className="fld" type="date" value={d.warranty_expires_on} onChange={(e) => set('warranty_expires_on', e.target.value)} /></Field>
          <Field label="Warranty with"><input className="fld" value={d.warranty_provider} placeholder="Manufacturer or contract" onChange={(e) => set('warranty_provider', e.target.value)} /></Field>
          <Field label="What the warranty covers" wide><textarea className="fld" rows={2} value={d.warranty_notes} onChange={(e) => set('warranty_notes', e.target.value)} /></Field>
          <Field label="Description" wide><textarea className="fld" rows={2} value={d.description} onChange={(e) => set('description', e.target.value)} /></Field>
          <Field label="Notes" wide><textarea className="fld" rows={2} value={d.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        </div>
        {problem && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{problem}</p>}
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : asset ? 'Save changes' : 'Add asset'}
          </button>
        </div>
      </div>
    </div>
  );
}
