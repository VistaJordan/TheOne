/* Admin › Vendors & map (0057).
 *
 * What the map and the Vendors section are run with: how far the map looks,
 * when a busy day raises an alert, whether hiring warns about paperwork; the
 * preferred vendors per client, trade and place, and how the suggested-vendors
 * list on a work order is filled and ordered (0069); the lists a vendor record picks
 * from (statuses, brand sources, trades — every dropdown reads them); and who
 * has been opening the map. WHO SEES WHAT on the map is not here: that is a
 * role's "Technician map" rows in Admin › Roles (and per person from Adjust). */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SUGGEST_MAX_SIZE, SUGGEST_SIGNALS, US_STATE_CODES, adminPermKey } from '@theone/shared';
import type { AdminVendorsResponse, PreferredVendorRule, SuggestSettings, SuggestSignal } from '@theone/shared';
import {
  ApiRequestError,
  addVendorListValue,
  createPreferredVendor,
  deletePreferredVendor,
  getAdminVendors,
  getVendorRequiredFields,
  saveSuggestSettings,
  saveVendorSettings,
  searchVendorsForRule,
  setVendorRequiredField,
  updatePreferredVendor,
  updateVendorListValue,
} from '../../api/client';
import type { VendorListName, VendorPickHit } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../../components/Icon';
import { VendorCataloguesCards } from '../../components/vendors/VendorExtras';
import { AdminEmpty, AdminShell } from './AdminShell';

const KEY = ['admin-vendors'];
const STATUS_COLORS = ['slate', 'blue', 'teal', 'green', 'amber', 'red', 'violet', 'pink', 'gray'];
const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

export function AdminVendorsPage() {
  const { can } = useAuth();
  const canEdit = can(adminPermKey('vendors'), 'edit');
  const q = useQuery({ queryKey: KEY, queryFn: getAdminVendors, retry: 0 });
  const d = q.data;

  return (
    <AdminShell
      title="Vendors & map"
      subtitle={
        <>
          How the technician map and the Vendors section behave. Who sees which technicians is set per role under{' '}
          <Link to="/admin/roles">Roles › Technician map</Link>.
        </>
      }
    >
      {q.isLoading && <AdminEmpty icon="pin" title="Loading…" />}
      {q.isError && <AdminEmpty icon="alert" title="Could not load the vendor settings" />}
      {d && (
        <div className="vadm">
          <SettingsCard data={d} canEdit={canEdit} />
          <PreferredCard data={d} canEdit={canEdit} />
          <SuggestCard data={d} canEdit={canEdit} />
          <RequiredFieldsCard canEdit={canEdit} />
          {/* 0066 · dispatch offers, invoicing rules, skills, consumables. */}
          <VendorCataloguesCards canEdit={canEdit} />
          <div className="vadm-lists">
            <ListCard list="statuses" title="Vendor statuses" note="The steps a vendor moves through. Turning one off hides it from the dropdowns; records that hold it keep it." items={d.statuses.map((s) => ({ key: s.key, label: s.label, active: s.is_active, color: s.color, locked: s.is_system }))} canEdit={canEdit} withColor />
            <ListCard list="brand-sources" title="Brand sources" note="Which company the vendor was recruited for." items={d.brand_sources.map((s) => ({ key: s.key, label: s.label, active: s.is_active }))} canEdit={canEdit} />
            <ListCard list="trades" title="Vendor trades" note="The trades a vendor can be filed under. The map matches them to a work order’s Trade by name." items={d.trades.map((t) => ({ key: t.name, label: t.name, active: t.is_active }))} canEdit={canEdit} noRename />
          </div>
          <UsageCard data={d} />
        </div>
      )}
    </AdminShell>
  );
}

// ── Required fields (0058) ───────────────────────────────────────────────────

function RequiredFieldsCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ['admin-vendor-required'];
  const q = useQuery({ queryKey: key, queryFn: getVendorRequiredFields, retry: 0 });
  const set = useMutation({
    mutationFn: (x: { key: string; required: boolean }) => setVendorRequiredField(x.key, x.required),
    onSuccess: (res) => qc.setQueryData(key, res),
  });
  if (!q.data) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Required fields</h2>
        {set.isError && <span className="card-meta">{errText(set.error, 'Could not save.')}</span>}
      </div>
      <p className="adm-sub" style={{ padding: '0 14px' }}>
        What a VR vendor must carry. A new vendor without one is refused unless it is added anyway — it is then flagged
        “Missing information” and waits in the review queue until the field is filled in. Technicians added from a work order are not held to this.
      </p>
      <div className="vadm-req">
        {q.data.fields.map((f) => (
          <label key={f.key} className="tmap-check">
            <input type="checkbox" checked={f.required} disabled={!canEdit || set.isPending} onChange={(e) => set.mutate({ key: f.key, required: e.target.checked })} />
            <span>{f.label}</span>
          </label>
        ))}
      </div>
      {!q.data.storage_ready && (
        <p className="adm-sub" style={{ padding: '0 14px 12px' }}>
          File storage is not connected on this server: document uploads on a vendor record are off until it is.
        </p>
      )}
    </section>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

function SettingsCard({ data, canEdit }: { data: AdminVendorsResponse; canEdit: boolean }) {
  const qc = useQueryClient();
  const [radius, setRadius] = useState(String(data.settings.map_radius_miles));
  const [alert, setAlert] = useState(String(data.settings.map_daily_alert));
  const [warn, setWarn] = useState(data.settings.hire_warn_compliance);
  useEffect(() => {
    setRadius(String(data.settings.map_radius_miles));
    setAlert(String(data.settings.map_daily_alert));
    setWarn(data.settings.hire_warn_compliance);
  }, [data.settings]);

  const save = useMutation({
    mutationFn: () => saveVendorSettings({ map_radius_miles: Number(radius), map_daily_alert: Number(alert), hire_warn_compliance: warn }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
  const dirty =
    Number(radius) !== data.settings.map_radius_miles || Number(alert) !== data.settings.map_daily_alert || warn !== data.settings.hire_warn_compliance;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">The map</h2>
        {canEdit && (
          <button type="button" className="btn btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
      <div className="vadm-settings">
        <div className="field">
          <label className="lbl" htmlFor="va-radius">Search radius (miles)</label>
          <input className="fld mono" id="va-radius" inputMode="numeric" value={radius} disabled={!canEdit} onChange={(e) => setRadius(e.target.value)} />
          <span className="hint">How far from the work order the map looks. Statewide and nationwide vendors are shown beyond it to the roles allowed to see them.</span>
        </div>
        <div className="field">
          <label className="lbl" htmlFor="va-alert">Daily alert at</label>
          <input className="fld mono" id="va-alert" inputMode="numeric" value={alert} disabled={!canEdit} onChange={(e) => setAlert(e.target.value)} />
          <span className="hint">Map opens by one person in one day before they are flagged below. An alert only — nobody is blocked.</span>
        </div>
        <div className="field">
          <span className="lbl">Hiring</span>
          <label className="tmap-check">
            <input type="checkbox" checked={warn} disabled={!canEdit} onChange={() => setWarn((w) => !w)} />
            <span>Warn when a vendor’s COI is missing or expired</span>
          </label>
          <span className="hint">A warning on the map and after Hire. It never stops the hire.</span>
        </div>
      </div>
      {save.isError && <p className="snooze-err" role="alert" style={{ margin: '0 14px 12px' }}><Icon name="alert-circle" size={12} />{errText(save.error, 'Could not save.')}</p>}
    </section>
  );
}

// ── Preferred vendors ────────────────────────────────────────────────────────

function PreferredCard({ data, canEdit }: { data: AdminVendorsResponse; canEdit: boolean }) {
  const qc = useQueryClient();
  const [client, setClient] = useState('');
  const [trade, setTrade] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [rank, setRank] = useState('1');
  const [note, setNote] = useState('');
  const [term, setTerm] = useState('');
  const [vendor, setVendor] = useState<VendorPickHit | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hits = useQuery({
    queryKey: ['admin-vendor-search', term.trim()],
    queryFn: () => searchVendorsForRule(term.trim()),
    enabled: term.trim().length >= 2 && !vendor,
    staleTime: 20_000,
  });
  const apply = (res: { preferred: PreferredVendorRule[] }) => {
    qc.setQueryData<AdminVendorsResponse>(KEY, (old) => (old ? { ...old, preferred: res.preferred } : old));
    setError(null);
  };
  const add = useMutation({
    mutationFn: () => createPreferredVendor({ client: client || null, trade: trade || null, state: state || null, city: (state && city.trim()) || null, vendor_id: vendor!.id, rank: Number(rank) || 1, note: note || null }),
    onSuccess: (res) => { apply(res); setVendor(null); setTerm(''); setNote(''); },
    onError: (e) => setError(errText(e, 'Could not add the rule.')),
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; rank: number }) => updatePreferredVendor(v.id, { rank: v.rank }),
    onSuccess: apply,
    onError: (e) => setError(errText(e, 'Could not change the rank.')),
  });
  const del = useMutation({
    mutationFn: (id: string) => deletePreferredVendor(id),
    onSuccess: apply,
    onError: (e) => setError(errText(e, 'Could not remove the rule.')),
  });

  const trades = [...new Set([...data.wo_trades, ...data.trades.filter((t) => t.is_active).map((t) => t.name)])].sort((a, b) => a.localeCompare(b));
  const ready = vendor !== null && (client !== '' || trade !== '');

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Preferred vendors</h2>
        <span className="card-meta">{data.preferred.length} rule{data.preferred.length === 1 ? '' : 's'}</span>
      </div>
      <p className="hint" style={{ padding: '0 14px 8px', margin: 0 }}>
        For a client, a trade, or the pair: the vendors we would rather use, in order. On a work order’s map they are marked
        “Preferred” and listed first, and they head the suggested vendors on the work order. The most specific rule wins
        (client + trade over client alone over trade alone; a city over its state over anywhere).
      </p>
      {canEdit && (
        <div className="vadm-rule-form">
          <div className="field">
            <label className="lbl" htmlFor="pv-client">Client</label>
            <select className="fld" id="pv-client" value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">Any client</option>
              {data.clients.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="lbl" htmlFor="pv-trade">Trade</label>
            <select className="fld" id="pv-trade" value={trade} onChange={(e) => setTrade(e.target.value)}>
              <option value="">Any trade</option>
              {trades.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: '0 1 110px', minWidth: 100 }}>
            <label className="lbl" htmlFor="pv-state">State</label>
            <select className="fld" id="pv-state" value={state} onChange={(e) => { setState(e.target.value); if (!e.target.value) setCity(''); }}>
              <option value="">Any</option>
              {US_STATE_CODES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 130px', minWidth: 120 }}>
            <label className="lbl" htmlFor="pv-city">City</label>
            <input
              className="fld"
              id="pv-city"
              value={city}
              maxLength={120}
              disabled={!state}
              placeholder={state ? 'Any city' : 'Pick a state first'}
              title="Only for work orders in this city. Leave empty for the whole state."
              onChange={(e) => setCity(e.target.value)}
            />
          </div>
          <div className="field techpick" style={{ flex: '2 1 220px' }}>
            <label className="lbl" htmlFor="pv-vendor">Vendor</label>
            <input
              className="fld"
              id="pv-vendor"
              placeholder="Type a name"
              autoComplete="off"
              value={vendor ? vendor.name : term}
              onChange={(e) => { setVendor(null); setTerm(e.target.value); }}
            />
            {!vendor && (hits.data?.hits.length ?? 0) > 0 && (
              <ul className="techpick-menu" role="listbox">
                {hits.data!.hits.map((h) => (
                  <li key={h.id} role="option" aria-selected="false">
                    <button type="button" className="techpick-opt" onMouseDown={(e) => { e.preventDefault(); setVendor(h); }}>
                      <b>{h.name}</b>
                      <span>{[h.primary_trade, [h.city, h.state].filter(Boolean).join(', '), h.phone].filter(Boolean).join(' · ')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="field" style={{ flex: '0 0 70px', minWidth: 70 }}>
            <label className="lbl" htmlFor="pv-rank">Rank</label>
            <input className="fld mono" id="pv-rank" inputMode="numeric" value={rank} onChange={(e) => setRank(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '2 1 180px' }}>
            <label className="lbl" htmlFor="pv-note">Note</label>
            <input className="fld" id="pv-note" value={note} maxLength={1000} placeholder="Why — contract, pricing…" onChange={(e) => setNote(e.target.value)} />
          </div>
          <button type="button" className="btn btn-primary" disabled={!ready || add.isPending} title={!ready ? 'Pick a client or a trade, and a vendor' : undefined} onClick={() => add.mutate()}>
            <Icon name="plus" size={14} />
            Add
          </button>
        </div>
      )}
      {error && <p className="snooze-err" role="alert" style={{ margin: '8px 14px' }}><Icon name="alert-circle" size={12} />{error}</p>}
      {data.preferred.length === 0 ? (
        <div className="empty-flat">No preferred vendors yet.</div>
      ) : (
        <div className="vend-wrap">
          <table className="vend-table">
            <thead>
              <tr><th>Client</th><th>Trade</th><th>Place</th><th>Vendor</th><th>Rank</th><th>Note</th><th /></tr>
            </thead>
            <tbody>
              {data.preferred.map((r) => (
                <tr key={r.id}>
                  <td>{r.client ?? <i>Any client</i>}</td>
                  <td>{r.trade ?? <i>Any trade</i>}</td>
                  <td>{[r.city, r.state].filter(Boolean).join(', ') || '—'}</td>
                  <td className="vend-name">
                    <Link to={`/vendors/${r.vendor.id}`}>{r.vendor.name}</Link>
                    {r.vendor.blacklisted && <span><span className="chip chip-danger chip-sm">Blacklisted</span></span>}
                  </td>
                  <td>
                    {canEdit ? (
                      <select className="fld" style={{ height: 28, minWidth: 56 }} value={r.rank} aria-label="Rank" onChange={(e) => patch.mutate({ id: r.id, rank: Number(e.target.value) })}>
                        {Array.from({ length: Math.max(9, r.rank) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    ) : r.rank}
                  </td>
                  <td>{r.note ?? '—'}</td>
                  <td>
                    {canEdit && (
                      <button type="button" className="icon-btn" aria-label="Remove this rule" title="Remove" onClick={() => del.mutate(r.id)}>
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Suggested vendors (0069) ─────────────────────────────────────────────────

/* How the "Suggested vendors" list on a work order is put together. Every
   control saves by itself; the server answers with the whole setting. */
function SuggestCard({ data, canEdit }: { data: AdminVendorsResponse; canEdit: boolean }) {
  const qc = useQueryClient();
  const s = data.suggest;
  const save = useMutation({
    mutationFn: (patch: Partial<SuggestSettings>) => saveSuggestSettings(patch),
    onSuccess: (res) => {
      qc.setQueryData<AdminVendorsResponse>(KEY, (old) => (old ? { ...old, suggest: res.suggest } : old));
      void qc.invalidateQueries({ queryKey: ['wo-suggested-vendors'] });
    },
  });
  const locked = !canEdit || save.isPending;
  const move = (key: SuggestSignal, by: -1 | 1) => {
    const order = [...s.order];
    const i = order.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    save.mutate({ order });
  };
  const toggle = (key: SuggestSignal) => save.mutate({ off: s.off.includes(key) ? s.off.filter((k) => k !== key) : [...s.off, key] });
  const check = (key: 'auto_fill' | 'match_trade' | 'in_coverage' | 'require_compliance' | 'emergency_availability' | 'cascade_auto', label: string, disabled = false) => (
    <label className="tmap-check">
      <input type="checkbox" checked={s[key]} disabled={locked || disabled} onChange={(e) => save.mutate({ [key]: e.target.checked })} />
      <span>{label}</span>
    </label>
  );
  const signals = s.order.map((k) => SUGGEST_SIGNALS.find((x) => x.key === k)).filter((x): x is (typeof SUGGEST_SIGNALS)[number] => Boolean(x));

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Suggested vendors</h2>
        <span className={`chip chip-sm${s.auto_fill ? ' chip-ok' : ' chip-outline'}`}>{s.auto_fill ? 'Automatic fill on' : 'Hand-picked only'}</span>
      </div>
      <p className="hint" style={{ padding: '0 14px 4px', margin: 0 }}>
        The short list on a work order’s People tab. The preferred vendors above come first, in their order. The places left
        over are filled automatically: vendors that pass the filters, sorted by the tie-breakers from top to bottom. A
        blacklisted vendor is never suggested.
      </p>
      <div className="vadm-settings">
        <div className="field">
          <label className="lbl" htmlFor="sg-size">Vendors on the list</label>
          <input
            className="fld mono"
            id="sg-size"
            type="number"
            min={1}
            max={SUGGEST_MAX_SIZE}
            defaultValue={s.size}
            key={s.size}
            disabled={!canEdit}
            onBlur={(e) => {
              const n = Math.round(Number(e.target.value));
              if (n >= 1 && n <= SUGGEST_MAX_SIZE && n !== s.size) save.mutate({ size: n });
              else e.target.value = String(s.size);
            }}
          />
          {check('auto_fill', 'Fill the places left over automatically')}
          <span className="hint">Off, the list shows only the preferred vendors somebody picked.</span>
        </div>
        <div className="field">
          <span className="lbl">An automatic pick must</span>
          {check('match_trade', 'Be filed under the work order’s trade', !s.auto_fill)}
          {check('in_coverage', 'Cover its location (in the map radius, statewide there, or nationwide)', !s.auto_fill)}
          {check('emergency_availability', 'Take same-day emergencies, when the work order is an Emergency', !s.auto_fill)}
        </div>
        <div className="field">
          <span className="lbl">Paperwork and offers</span>
          {check('require_compliance', 'Leave out a vendor whose COI is missing or expired')}
          <span className="hint">Off, they stay on the list with a warning. This one also applies to preferred vendors.</span>
          {check('cascade_auto', 'Dispatch offers may go to automatic picks', !s.auto_fill)}
          <span className="hint">Off, dispatch offers keep to the preferred vendors, as before.</span>
        </div>
      </div>
      <div className="vadm-signals">
        <span className="lbl">Tie-breakers, in order</span>
        <ol>
          {signals.map((sig, i) => {
            const off = s.off.includes(sig.key);
            return (
              <li key={sig.key} className={off ? 'is-off' : undefined}>
                <span className="vadm-signal-n mono">{i + 1}</span>
                <span className="vadm-signal-text">
                  <b>{sig.label}</b>
                  <small>{sig.hint}</small>
                </span>
                {canEdit && (
                  <span className="vadm-signal-acts">
                    <button type="button" className="icon-btn" aria-label={`Move ${sig.label} up`} title="Move up" disabled={locked || !s.auto_fill || i === 0} onClick={() => move(sig.key, -1)}>
                      <Icon name="chev-u" size={14} />
                    </button>
                    <button type="button" className="icon-btn" aria-label={`Move ${sig.label} down`} title="Move down" disabled={locked || !s.auto_fill || i === signals.length - 1} onClick={() => move(sig.key, 1)}>
                      <Icon name="chev-d" size={14} />
                    </button>
                    <button type="button" className="link-btn" disabled={locked || !s.auto_fill} onClick={() => toggle(sig.key)}>
                      {off ? 'Turn on' : 'Turn off'}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      {save.isError && <p className="snooze-err" role="alert" style={{ margin: '0 14px 12px' }}><Icon name="alert-circle" size={12} />{errText(save.error, 'Could not save.')}</p>}
    </section>
  );
}

// ── The lists ────────────────────────────────────────────────────────────────

interface ListItem { key: string; label: string; active: boolean; color?: string; locked?: boolean }

function ListCard({ list, title, note, items, canEdit, withColor, noRename }: {
  list: VendorListName;
  title: string;
  note: string;
  items: ListItem[];
  canEdit: boolean;
  withColor?: boolean;
  noRename?: boolean;
}) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const done = (res: AdminVendorsResponse) => { qc.setQueryData(KEY, res); setError(null); void qc.invalidateQueries({ queryKey: ['vendors-meta'] }); };
  const add = useMutation({
    mutationFn: () => addVendorListValue(list, { label: label.trim() }),
    onSuccess: (res) => { done(res); setLabel(''); },
    onError: (e) => setError(errText(e, 'Could not add it.')),
  });
  const patch = useMutation({
    mutationFn: (v: { key: string; input: { label?: string; color?: string; is_active?: boolean } }) => updateVendorListValue(list, v.key, v.input),
    onSuccess: done,
    onError: (e) => setError(errText(e, 'Could not change it.')),
  });

  return (
    <section className="card">
      <div className="card-head"><h2 className="card-title">{title}</h2></div>
      <p className="hint" style={{ padding: '0 14px 6px', margin: 0 }}>{note}</p>
      <ul className="vadm-list">
        {items.map((it) => (
          <li key={it.key} className={it.active ? undefined : 'is-off'}>
            {withColor && <span className={`vstatus is-${it.color ?? 'slate'}`} aria-hidden="true" />}
            <span>{it.label}</span>
            {it.locked && <span className="chip chip-outline chip-sm" title="The app sets or reads this status itself">Built in</span>}
            {canEdit && (
              <span className="push" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {withColor && (
                  <select className="fld" style={{ height: 26, minWidth: 80 }} aria-label={`${it.label} colour`} value={it.color ?? 'slate'} onChange={(e) => patch.mutate({ key: it.key, input: { color: e.target.value } })}>
                    {STATUS_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
                {!noRename && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Rename ${it.label}`}
                    title="Rename"
                    onClick={() => {
                      const next = window.prompt('New name', it.label);
                      if (next && next.trim() && next.trim() !== it.label) patch.mutate({ key: it.key, input: { label: next.trim() } });
                    }}
                  >
                    <Icon name="pencil" size={12} />
                  </button>
                )}
                <button type="button" className="link-btn" onClick={() => patch.mutate({ key: it.key, input: { is_active: !it.active } })}>
                  {it.active ? 'Turn off' : 'Turn on'}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form className="vadm-add" onSubmit={(e) => { e.preventDefault(); if (label.trim()) add.mutate(); }}>
          <input className="fld" placeholder="Add one…" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} aria-label={`New value for ${title}`} />
          <button type="submit" className="btn btn-sm" disabled={label.trim() === '' || add.isPending}>Add</button>
        </form>
      )}
      {error && <p className="snooze-err" role="alert" style={{ margin: '0 14px 12px' }}><Icon name="alert-circle" size={12} />{error}</p>}
    </section>
  );
}

// ── Who has been opening the map ─────────────────────────────────────────────

function UsageCard({ data }: { data: AdminVendorsResponse }) {
  const over = data.usage.filter((u) => u.over_limit);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Map use, last 14 days</h2>
        <span className={`chip chip-sm${over.length > 0 ? ' chip-danger' : ''}`}>
          {over.length === 0 ? 'No alerts' : `${over.length} alert${over.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {data.usage.length === 0 ? (
        <div className="empty-flat">Nobody has opened the map yet.</div>
      ) : (
        <div className="vend-wrap">
          <table className="vend-table">
            <thead><tr><th>Day</th><th>Person</th><th>Map opens</th><th /></tr></thead>
            <tbody>
              {data.usage.slice(0, 60).map((u) => (
                <tr key={`${u.day}-${u.principal.id}`}>
                  <td className="mono">{u.day}</td>
                  <td>{u.principal.name}</td>
                  <td className="num">{u.opens}</td>
                  <td>{u.over_limit && <span className="chip chip-danger chip-sm">Over {data.settings.map_daily_alert}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
