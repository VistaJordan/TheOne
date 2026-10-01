/* 0057 · The technician map on a work order.
 *
 * Opens centred on the work order's own ZIP / city and lists who is in reach:
 * the VR team's vendors and the technicians the viewer may see (their own, or
 * everyone's — Admin › Roles). From a result: call through Quo (the call lands
 * on this work order), hire onto the work order, leave a note, blacklist.
 *
 * Filtering: trade and availability re-ask the server; source, coverage,
 * blacklisted and "top 5" narrow what is already here. Statewide / nationwide
 * vendors whose city we could not place are pinned at the work order, as Tech
 * Locator did, and say so. */

import { Suspense, lazy, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AVAILABILITY_FLAGS, US_STATE_CODES, VENDOR_KIND_LABELS } from '@theone/shared';
import type { AvailabilityKey, MapVendor, VendorNote, WoMapResponse } from '@theone/shared';
import type { WorkOrderDetailV2 } from '../../../api/client';
import {
  ApiRequestError,
  addVendorNote,
  addWoTechnician,
  blacklistVendor,
  getVendorNotes,
  getWoTechMap,
  hireWoTechnician,
  releaseWoTechnician,
  suggestCities,
} from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
import { feedTime } from '../../../lib/fields';
import { tradeSlot } from '../../../lib/mapPoints';
import { useTheme } from '../../../theme/ThemeProvider';
import { Icon } from '../../Icon';
import { CallDialog } from '../calls/CallButton';
import type { MapPoint } from '../../map/VendorMap';

const VendorMap = lazy(() => import('../../map/VendorMap'));

const money = (n: number | null): string | null => (n === null ? null : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

interface Props {
  wo: WorkOrderDetailV2;
  onClose: () => void;
}

export function TechMapSheet({ wo, onClose }: Props) {
  const { theme } = useTheme();
  const { can } = useAuth();
  const qc = useQueryClient();

  // ── Filters ────────────────────────────────────────────────────────────────
  /** null = every trade. Starts on the work order's own trade. */
  const [trades, setTrades] = useState<string[] | null>(wo.trade ? [wo.trade] : null);
  const [availability, setAvailability] = useState<AvailabilityKey[]>([]);
  const [sources, setSources] = useState<{ vendor: boolean; tech: boolean }>({ vendor: true, tech: true });
  const [reach, setReach] = useState<{ local: boolean; statewide: boolean; nationwide: boolean }>({ local: true, statewide: true, nationwide: true });
  const [hideBlacklisted, setHideBlacklisted] = useState(false);
  const [top5, setTop5] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'warn' | 'ok'; text: string } | null>(null);
  const [calling, setCalling] = useState<{ name: string; phone: string; kind: MapVendor['kind'] } | null>(null);

  const opened = useRef(false);
  const key = ['wo-tech-map', wo.id, trades?.join('|') ?? '*', availability.join(',')] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: () => {
      const first = !opened.current;
      opened.current = true;
      return getWoTechMap(wo.id, { trades: trades ?? undefined, availability, opened: first });
    },
    placeholderData: keepPreviousData,
  });
  const data: WoMapResponse | undefined = query.data;
  const scope = data?.scope;

  const visible = useMemo(() => {
    let list = data?.vendors ?? [];
    list = list.filter((v) => v.hired || ((sources[v.kind] ?? true) && reach[v.reach]));
    if (hideBlacklisted) list = list.filter((v) => !v.blacklisted || v.hired);
    if (top5) {
      list = [...list]
        .filter((v) => v.kind === 'tech')
        .sort((a, b) => b.work_orders_count - a.work_orders_count)
        .slice(0, 5);
    }
    return list;
  }, [data, sources, reach, hideBlacklisted, top5]);

  const tradeList = data?.trades ?? [];
  const points = useMemo<MapPoint[]>(() => {
    const c = data?.center;
    const out: MapPoint[] = [];
    for (const v of visible) {
      // Not placed (a statewide / nationwide vendor with no city on file):
      // pinned at the work order, like Tech Locator.
      const lat = v.lat ?? c?.lat ?? null;
      const lng = v.lng ?? c?.lng ?? null;
      if (lat === null || lng === null) continue;
      out.push({
        id: v.id,
        lat,
        lng,
        slot: tradeSlot(v.primary_trade, tradeList),
        kind: v.kind,
        blacklisted: v.blacklisted,
        marked: v.hired || v.preferred_rank !== null,
      });
    }
    return out;
  }, [visible, data?.center, tradeList]);

  const selected = visible.find((v) => v.id === selectedId) ?? null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['wo-tech-map', wo.id] });
    void qc.invalidateQueries({ queryKey: ['wo-technicians', wo.id] });
  };

  const hire = useMutation({
    mutationFn: (v: MapVendor) => hireWoTechnician(wo.id, v.id),
    onSuccess: (res, v) => {
      setBanner(res.warning ? { tone: 'warn', text: `Hired — ${res.warning}` } : { tone: 'ok', text: `${v.name} is on ${wo.wo_number} now.` });
      refresh();
    },
    onError: (e) => setBanner({ tone: 'warn', text: errText(e, 'Could not hire.') }),
  });
  const release = useMutation({
    mutationFn: (v: MapVendor) => releaseWoTechnician(wo.id, v.id),
    onSuccess: (_r, v) => {
      setBanner({ tone: 'ok', text: `${v.name} was taken off ${wo.wo_number}.` });
      refresh();
    },
    onError: (e) => setBanner({ tone: 'warn', text: errText(e, 'Could not remove.') }),
  });

  const toggleTrade = (t: string) => {
    const all = tradeList;
    const cur = trades ?? all;
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
    setTrades(next.length === 0 || next.length === all.length ? null : next);
  };
  const tradeLabel =
    trades === null ? 'All trades' : trades.length === 1 ? trades[0] : `${trades.length} trades`;

  const fitKey = `${data?.center?.lat ?? 'x'}:${data?.radius_miles ?? 0}`;

  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="techMapT"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !calling && !adding) onClose();
      }}
    >
      <div className="sheet tmap-sheet">
        <header className="tmap-head">
          <h2 className="sheet-t" id="techMapT">
            <Icon name="pin" size={18} />
            Technicians near {wo.wo_number}
          </h2>
          <span className="tmap-where">
            {data?.center
              ? `${data.center.label} · within ${data.radius_miles} miles`
              : data
                ? 'This work order has no ZIP or city we can place'
                : 'Finding the work order…'}
          </span>
          <span className="tmap-count">
            {query.isFetching ? 'Searching…' : `${visible.length} found`}
          </span>
          {scope?.add && (
            <button type="button" className="btn btn-sm is-ghost" onClick={() => setAdding(true)}>
              <Icon name="user-plus" size={14} />
              Add a technician
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close the map" title="Close">
            <Icon name="x" size={16} />
          </button>
        </header>

        {banner && (
          <div className={`tmap-banner is-${banner.tone}`} role="status">
            <Icon name={banner.tone === 'warn' ? 'alert' : 'check-circle'} size={14} />
            <span>{banner.text}</span>
            <button type="button" className="icon-btn" onClick={() => setBanner(null)} aria-label="Dismiss">
              <Icon name="x" size={12} />
            </button>
          </div>
        )}

        <div className="tmap-body">
          {/* ── Left: filters + results ─────────────────────────────────── */}
          <aside className="tmap-side">
            <div className="tmap-filters">
              <details className="tmap-filter">
                <summary>
                  <span className="overline">Trade</span>
                  <b>{tradeLabel}</b>
                </summary>
                <div className="tmap-checks">
                  <label className="tmap-check">
                    <input type="checkbox" checked={trades === null} onChange={() => setTrades(trades === null ? (wo.trade ? [wo.trade] : []) : null)} />
                    <span>All trades</span>
                  </label>
                  {tradeList.map((t) => (
                    <label className="tmap-check" key={t}>
                      <input type="checkbox" checked={trades === null || trades.includes(t)} onChange={() => toggleTrade(t)} />
                      <span>{t}</span>
                    </label>
                  ))}
                </div>
              </details>

              <div className="tmap-filter">
                <span className="overline">Availability</span>
                <div className="tmap-checks is-row">
                  {AVAILABILITY_FLAGS.map((f) => (
                    <label className="tmap-check" key={f.key}>
                      <input
                        type="checkbox"
                        checked={availability.includes(f.key)}
                        onChange={() =>
                          setAvailability((cur) => (cur.includes(f.key) ? cur.filter((k) => k !== f.key) : [...cur, f.key]))
                        }
                      />
                      <span>{f.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="tmap-filter">
                <span className="overline">Show</span>
                <div className="tmap-checks is-row">
                  {scope?.vr && (
                    <label className="tmap-check">
                      <input type="checkbox" checked={sources.vendor} onChange={() => setSources((s) => ({ ...s, vendor: !s.vendor }))} />
                      <span><i className="tmap-key is-vendor" aria-hidden="true" />VR vendors</span>
                    </label>
                  )}
                  <label className="tmap-check">
                    <input type="checkbox" checked={sources.tech} onChange={() => setSources((s) => ({ ...s, tech: !s.tech }))} />
                    <span><i className="tmap-key is-tech" aria-hidden="true" />{scope?.allTechs ? 'Technicians' : 'My technicians'}</span>
                  </label>
                  {(scope?.statewide || scope?.nationwide) && (
                    <label className="tmap-check">
                      <input type="checkbox" checked={reach.local} onChange={() => setReach((r) => ({ ...r, local: !r.local }))} />
                      <span>Local</span>
                    </label>
                  )}
                  {scope?.statewide && (
                    <label className="tmap-check">
                      <input type="checkbox" checked={reach.statewide} onChange={() => setReach((r) => ({ ...r, statewide: !r.statewide }))} />
                      <span>Statewide</span>
                    </label>
                  )}
                  {scope?.nationwide && (
                    <label className="tmap-check">
                      <input type="checkbox" checked={reach.nationwide} onChange={() => setReach((r) => ({ ...r, nationwide: !r.nationwide }))} />
                      <span>Nationwide</span>
                    </label>
                  )}
                  <label className="tmap-check">
                    <input type="checkbox" checked={top5} onChange={() => setTop5((v) => !v)} />
                    <span>Top 5 technicians</span>
                  </label>
                  <label className="tmap-check">
                    <input type="checkbox" checked={hideBlacklisted} onChange={() => setHideBlacklisted((v) => !v)} />
                    <span>Hide blacklisted</span>
                  </label>
                </div>
              </div>
            </div>

            <ul className="tmap-list" aria-label="Results">
              {query.isError && (
                <li className="tmap-empty">
                  <Icon name="alert" size={16} />
                  {errText(query.error, 'Could not load the map.')}
                </li>
              )}
              {!query.isError && data && visible.length === 0 && (
                <li className="tmap-empty">
                  {data.center
                    ? `Nobody in reach${trades ? ` for ${tradeLabel}` : ''}. Try all trades${scope?.add ? ', or add a technician' : ''}.`
                    : 'Add a ZIP code or a city and state to the work order, then open the map again.'}
                </li>
              )}
              {visible.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className={`tmap-row${v.id === selectedId ? ' is-on' : ''}${v.blacklisted ? ' is-black' : ''}`}
                    onClick={() => setSelectedId(v.id === selectedId ? null : v.id)}
                    aria-pressed={v.id === selectedId}
                  >
                    <span className={`tmap-key is-${v.kind}`} aria-hidden="true" />
                    <span className="tmap-row-main">
                      <b>{v.name}</b>
                      <span>
                        {[v.primary_trade, [v.city, v.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || VENDOR_KIND_LABELS[v.kind]}
                      </span>
                    </span>
                    <span className="tmap-row-tags">
                      {v.hired && <span className="chip chip-accent chip-sm">Hired</span>}
                      {v.preferred_rank !== null && <span className="chip chip-sm" title={v.preferred_note ?? 'Preferred for this client / trade'}>Preferred{v.preferred_rank > 1 ? ` #${v.preferred_rank}` : ''}</span>}
                      {v.blacklisted && <span className="chip chip-danger chip-sm">Blacklisted</span>}
                      {v.mine && !v.hired && <span className="chip chip-sm">Yours</span>}
                      <span className="tmap-dist">
                        {v.reach === 'local' && v.distance_miles !== null
                          ? `${v.distance_miles} mi`
                          : v.reach === 'statewide'
                            ? 'Statewide'
                            : 'Nationwide'}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {/* ── Right: the map, with the selected record over it ─────────── */}
          <div className="tmap-map">
            <Suspense fallback={<div className="tmap-loading">Loading the map…</div>}>
              <VendorMap
                key={theme}
                theme={theme}
                points={points}
                center={data?.center ?? null}
                radiusMiles={data?.radius_miles}
                selectedId={selectedId}
                onSelect={setSelectedId}
                fitKey={fitKey}
              />
            </Suspense>
            {selected && (
              <VendorCard
                key={selected.id}
                v={selected}
                woNumber={wo.wo_number}
                canHire={Boolean(scope?.hire)}
                canNote={can('vendors/blacklist', 'create')}
                busy={hire.isPending || release.isPending}
                onClose={() => setSelectedId(null)}
                onCall={(phone) => setCalling({ name: selected.name, phone, kind: selected.kind })}
                onHire={() => hire.mutate(selected)}
                onRelease={() => release.mutate(selected)}
                onChanged={refresh}
              />
            )}
            <div className="tmap-legend" aria-hidden="true">
              <span><i className="tmap-key is-vendor" />VR vendor</span>
              <span><i className="tmap-key is-tech" />Technician</span>
              <span><i className="tmap-key is-center" />{wo.wo_number}</span>
            </div>
          </div>
        </div>
      </div>

      {adding && data && (
        <AddTechDialog
          woId={wo.id}
          woNumber={wo.wo_number}
          trades={tradeList}
          defaultTrade={wo.trade ?? ''}
          defaultState={data.work_order.state ?? ''}
          canHire={Boolean(scope?.hire)}
          onClose={() => setAdding(false)}
          onDone={(text, tone) => {
            setAdding(false);
            setBanner({ tone, text });
            refresh();
          }}
        />
      )}
      {calling && (
        <CallDialog
          wo={wo}
          onClose={() => setCalling(null)}
          preset={{ name: calling.name, phone: calling.phone, role: calling.kind === 'tech' ? 'tech' : 'vendor' }}
        />
      )}
    </div>
  );
}

// ── The selected record ──────────────────────────────────────────────────────

function VendorCard({ v, woNumber, canHire, canNote, busy, onClose, onCall, onHire, onRelease, onChanged }: {
  v: MapVendor;
  woNumber: string;
  canHire: boolean;
  canNote: boolean;
  busy: boolean;
  onClose: () => void;
  onCall: (phone: string) => void;
  onHire: () => void;
  onRelease: () => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<'none' | 'note' | 'blacklist'>('none');
  const [text, setText] = useState('');
  const [showNotes, setShowNotes] = useState(v.blacklisted);
  const qc = useQueryClient();
  const notesKey = ['vendor-notes', v.id];
  const notes = useQuery({ queryKey: notesKey, queryFn: () => getVendorNotes(v.id), enabled: showNotes && canNote });

  const save = useMutation({
    mutationFn: () => (mode === 'blacklist' ? blacklistVendor(v.id, text.trim(), woNumber) : addVendorNote(v.id, text.trim(), woNumber)),
    onSuccess: (res) => {
      qc.setQueryData(notesKey, res);
      setText('');
      setShowNotes(true);
      if (mode === 'blacklist') onChanged();
      setMode('none');
    },
  });

  const rates: [string, string | null][] = [
    ['Regular', money(v.regular_hourly_rate) && `${money(v.regular_hourly_rate)}/hr`],
    ['After hours', money(v.after_hours_rate) && `${money(v.after_hours_rate)}/hr`],
    ['Weekend / emergency', money(v.weekend_emergency_rate) && `${money(v.weekend_emergency_rate)}/hr`],
    ['Trip charge', money(v.trip_charge)],
    ['Diagnostic', money(v.diagnostic_fee)],
    ['Minimum', money(v.minimum_charge)],
  ];
  const shownRates = rates.filter((r): r is [string, string] => Boolean(r[1]));
  const phones = v.phones.length > 0 ? v.phones : v.phone ? [v.phone] : [];
  const placed = v.lat !== null;

  return (
    <section className="tmap-card" aria-label={v.name}>
      <header className="tmap-card-head">
        <span className={`tmap-key is-${v.kind}`} aria-hidden="true" />
        <div className="tmap-card-title">
          <b>{v.name}</b>
          <span>
            {VENDOR_KIND_LABELS[v.kind]}
            {v.is_subcontractor ? ' · Subcontractor' : ''}
            {v.kind === 'tech' ? ` · ${v.work_orders_count} work order${v.work_orders_count === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={14} />
        </button>
      </header>

      {v.blacklisted && (
        <p className="tmap-flag is-danger">
          <Icon name="alert" size={12} />
          <span><b>Blacklisted.</b> {v.blacklist_reason}</span>
        </p>
      )}
      {v.compliance_warning && (
        <p className="tmap-flag is-warn">
          <Icon name="alert" size={12} />
          <span>{v.compliance_warning}</span>
        </p>
      )}
      {v.preferred_rank !== null && (
        <p className="tmap-flag is-ok">
          <Icon name="check-circle" size={12} />
          <span>Preferred for this client / trade{v.preferred_note ? ` — ${v.preferred_note}` : ''}</span>
        </p>
      )}

      <dl className="tmap-facts">
        <div>
          <dt>Trade</dt>
          <dd>{[v.primary_trade, ...v.secondary_trades].filter(Boolean).join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>
            {[v.city, v.state].filter(Boolean).join(', ') || '—'}
            {v.reach === 'local' && v.distance_miles !== null ? ` · ${v.distance_miles} mi away` : ''}
            {v.reach !== 'local' ? ` · ${v.reach === 'statewide' ? 'Statewide' : 'Nationwide'}` : ''}
            {!placed ? ' · location not on file, shown at the work order' : ''}
          </dd>
        </div>
        {v.kind === 'vendor' && (
          <div>
            <dt>Availability</dt>
            <dd>
              {AVAILABILITY_FLAGS.filter((f) => v[f.key] === true).map((f) => f.label).join(' · ') || 'None recorded'}
            </dd>
          </div>
        )}
        {v.kind === 'tech' && AVAILABILITY_FLAGS.every((f) => v[f.key] === null) && (
          <div>
            <dt>Availability</dt>
            <dd>Not asked yet</dd>
          </div>
        )}
        {shownRates.length > 0 && (
          <div>
            <dt>Rates</dt>
            <dd>{shownRates.map(([k, val]) => `${k} ${val}`).join(' · ')}</dd>
          </div>
        )}
        {v.estimated_response_time && (
          <div>
            <dt>Response</dt>
            <dd>{v.estimated_response_time}</dd>
          </div>
        )}
        {v.email && (
          <div>
            <dt>Email</dt>
            <dd>{v.email}</dd>
          </div>
        )}
      </dl>

      <div className="tmap-phones">
        {phones.length === 0 && <span className="hint">No phone on file</span>}
        {phones.map((p) => (
          <button type="button" className="btn btn-sm is-ghost" key={p} onClick={() => onCall(p)} title="Call through Quo — the call is recorded on this work order">
            <Icon name="phone" size={12} />
            <span className="mono">{p}</span>
          </button>
        ))}
      </div>

      <div className="tmap-actions">
        {canHire &&
          (v.hired ? (
            <button type="button" className="btn btn-sm is-ghost" disabled={busy} onClick={onRelease}>
              <Icon name="x" size={12} />
              Take off {woNumber}
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={onHire}>
              <Icon name="check" size={12} />
              Hire for {woNumber}
            </button>
          ))}
        {canNote && (
          <>
            <button type="button" className="btn btn-sm is-ghost" onClick={() => setMode(mode === 'note' ? 'none' : 'note')}>
              <Icon name="pencil" size={12} />
              Add note
            </button>
            {!v.blacklisted && (
              <button type="button" className="btn btn-sm is-danger" onClick={() => setMode(mode === 'blacklist' ? 'none' : 'blacklist')}>
                <Icon name="flag" size={12} />
                Blacklist
              </button>
            )}
            <button type="button" className="tr-more" onClick={() => setShowNotes((s) => !s)} aria-expanded={showNotes}>
              {showNotes ? 'Hide notes' : 'Notes'}
              <Icon name="chev-d" size={12} />
            </button>
          </>
        )}
      </div>

      {mode !== 'none' && (
        <div className="tmap-compose">
          <label className="lbl" htmlFor="tmap-text">
            {mode === 'blacklist' ? 'Why should nobody use this technician?' : 'Note'}
          </label>
          <textarea id="tmap-text" className="fld" rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
          {mode === 'blacklist' && (
            <span className="hint">Everyone sees the flag and your reason. A manager can clear it.</span>
          )}
          {save.isError && <span className="err"><Icon name="alert" size={12} />{errText(save.error, 'Could not save.')}</span>}
          <div className="tmap-actions">
            <button type="button" className="btn btn-sm is-ghost" onClick={() => setMode('none')}>Cancel</button>
            <button
              type="button"
              className={`btn btn-sm${mode === 'blacklist' ? ' is-danger' : ''}`}
              disabled={text.trim() === '' || save.isPending}
              onClick={() => save.mutate()}
            >
              {mode === 'blacklist' ? 'Mark blacklisted' : 'Save note'}
            </button>
          </div>
        </div>
      )}

      {showNotes && canNote && <NoteLog notes={notes.data?.notes} loading={notes.isLoading} />}
    </section>
  );
}

export function NoteLog({ notes, loading }: { notes: VendorNote[] | undefined; loading: boolean }) {
  if (loading) return <p className="hint">Loading notes…</p>;
  if (!notes || notes.length === 0) return <p className="hint">No notes yet.</p>;
  return (
    <ul className="tmap-notes">
      {notes.map((n) => (
        <li key={n.id} className={n.kind === 'blacklist' ? 'is-danger' : undefined}>
          <span className="tmap-note-meta">
            {n.kind === 'blacklist' ? 'Blacklisted' : n.kind === 'blacklist_cleared' ? 'Blacklist cleared' : 'Note'}
            {' · '}
            {n.author?.name ?? 'Unknown'} · {feedTime(n.created_at)}
            {n.wo_number ? ` · ${n.wo_number}` : ''}
          </span>
          <span>{n.body}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Add a technician ─────────────────────────────────────────────────────────

function AddTechDialog({ woId, woNumber, trades, defaultTrade, defaultState, canHire, onClose, onDone }: {
  woId: string;
  woNumber: string;
  trades: string[];
  defaultTrade: string;
  defaultState: string;
  canHire: boolean;
  onClose: () => void;
  onDone: (text: string, tone: 'ok' | 'warn') => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState(defaultState);
  const [zip, setZip] = useState('');
  const [trade, setTrade] = useState(trades.find((t) => t.toLowerCase() === defaultTrade.toLowerCase()) ?? '');
  const [hireNow, setHireNow] = useState(canHire);

  const cities = useQuery({
    queryKey: ['city-suggest', city, state],
    queryFn: () => suggestCities(city, state || undefined),
    enabled: city.trim().length >= 2,
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: () => addWoTechnician(woId, { name: name.trim(), phone: phone.trim(), city: city.trim(), state, zip: zip.trim() || null, trade, hire: hireNow }),
    onSuccess: (res) => {
      const what = res.outcome === 'linked' ? 'That number was already on file — the technician is yours now too' : `${name.trim()} was added`;
      const hired = hireNow ? ` and hired for ${woNumber}` : '';
      if (!res.on_map) onDone(`${what}${hired}. We could not place “${city.trim()}, ${state}” on the map — check the city.`, 'warn');
      else onDone(res.warning ? `${what}${hired} — ${res.warning}` : `${what}${hired}.`, res.warning ? 'warn' : 'ok');
    },
  });

  const ready = name.trim() !== '' && phone.replace(/\D/g, '').length >= 10 && city.trim() !== '' && state !== '' && trade !== '';

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="addTechT" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="sheet call-sheet">
        <h2 className="sheet-t" id="addTechT">
          <Icon name="user-plus" size={18} />
          Add a technician
        </h2>
        <p className="sheet-b">They appear on your map from now on. If the phone number is already on file, that record becomes yours too.</p>
        <div className="call-other">
          <div className="field">
            <label className="lbl" htmlFor="at-name">Name</label>
            <input className="fld" id="at-name" autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label className="lbl" htmlFor="at-phone">Phone</label>
            <input className="fld mono" id="at-phone" type="tel" value={phone} maxLength={40} placeholder="(409) 555-0143" onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="field">
            <label className="lbl" htmlFor="at-city">City</label>
            <input className="fld" id="at-city" list="at-cities" value={city} maxLength={120} onChange={(e) => setCity(e.target.value)} />
            <datalist id="at-cities">
              {(cities.data?.cities ?? []).map((c) => <option key={`${c.city}-${c.state}`} value={c.city}>{c.state}</option>)}
            </datalist>
          </div>
          <div className="field">
            <label className="lbl" htmlFor="at-state">State</label>
            <select className="fld" id="at-state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">—</option>
              {US_STATE_CODES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="lbl" htmlFor="at-zip">ZIP (optional)</label>
            <input className="fld mono" id="at-zip" value={zip} maxLength={10} onChange={(e) => setZip(e.target.value)} />
          </div>
          <div className="field">
            <label className="lbl" htmlFor="at-trade">Trade</label>
            <select className="fld" id="at-trade" value={trade} onChange={(e) => setTrade(e.target.value)}>
              <option value="">—</option>
              {trades.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
        {canHire && (
          <label className="tmap-check" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={hireNow} onChange={() => setHireNow((v) => !v)} />
            <span>Hire for {woNumber} straight away</span>
          </label>
        )}
        {save.isError && (
          <p className="snooze-err" role="alert">
            <Icon name="alert-circle" size={12} />
            {errText(save.error, 'Could not add the technician.')}
          </p>
        )}
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Adding…' : 'Add technician'}
          </button>
        </div>
      </div>
    </div>
  );
}
