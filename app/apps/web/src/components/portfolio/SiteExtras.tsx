/* 0064 · Two more things on a site, and one across sites.
 *
 *   SiteEventsCard   what is happening at this site that the people working
 *                    it should know — a closure, a remodel, restricted access.
 *                    A running event also shows on every work order there.
 *   SpaceViewer      the site's buildings, floors and spaces, each with the
 *                    assets standing in it and the work orders open against
 *                    them — pick a place, see what is there.
 *   SiteEventsList   the events across every site (Sites › Events).
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SITE_EVENT_KINDS, SITE_EVENT_KIND_LABELS, flattenLocations, locationPath, locationTree } from '@theone/shared';
import type { SiteEvent, SiteEventKind } from '@theone/shared';
import { addSiteEvent, getSiteEvents, getSiteSpaces, removeSiteEvent, updateSiteEvent } from '../../api/client';
import { Icon } from '../Icon';
import { AssetStatusChip, ConditionChip, day, errText } from './PortfolioParts';

const PHASE_LABEL = { running: 'Now', upcoming: 'Upcoming', ended: 'Ended' } as const;
const span = (e: SiteEvent) => `${day(e.starts_on)} → ${e.ends_on ? day(e.ends_on) : 'until ended'}`;
const todayIso = () => new Date().toLocaleDateString('en-CA');

function EventRow({ e, showSite, actions }: { e: SiteEvent; showSite?: boolean; actions?: React.ReactNode }) {
  return (
    <li className={`sev is-${e.phase}`}>
      <span className="sev-head">
        <span className={`chip chip-sm${e.phase === 'running' ? ' chip-warn' : e.phase === 'ended' ? ' chip-outline' : ''}`}>{PHASE_LABEL[e.phase]}</span>
        <span className="chip chip-sm">{SITE_EVENT_KIND_LABELS[e.kind]}</span>
        <b>{e.title}</b>
        {actions && <span className="push">{actions}</span>}
      </span>
      {showSite && <span><Link to={`/sites/${e.site.id}`}>{e.site.name}</Link>{[e.site.city, e.site.state].filter(Boolean).length ? ` · ${[e.site.city, e.site.state].filter(Boolean).join(', ')}` : ''}</span>}
      <span>{span(e)}{e.created_by ? ` · added by ${e.created_by.name}` : ''}</span>
      {e.detail && <span>{e.detail}</span>}
    </li>
  );
}

export function SiteEventsCard({ siteId, canEdit }: { siteId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ['site-events', siteId];
  const q = useQuery({ queryKey: key, queryFn: () => getSiteEvents(siteId) });
  const [form, setForm] = useState<{ kind: SiteEventKind; title: string; detail: string; starts_on: string; ends_on: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const landed = (res: { events: SiteEvent[] }) => {
    qc.setQueryData(key, res);
    void qc.invalidateQueries({ queryKey: ['site-events', 'all'] });
    void qc.invalidateQueries({ queryKey: ['wo-record'] });
    setForm(null);
    setError(null);
  };
  const add = useMutation({
    mutationFn: () => addSiteEvent(siteId, { kind: form!.kind, title: form!.title.trim(), detail: form!.detail.trim() || null, starts_on: form!.starts_on, ends_on: form!.ends_on || null }),
    onSuccess: landed,
    onError: (e) => setError(errText(e, 'Could not add the event.')),
  });
  const end = useMutation({ mutationFn: (id: string) => updateSiteEvent(siteId, id, { ends_on: todayIso() }), onSuccess: landed, onError: (e) => setError(errText(e, 'Could not end the event.')) });
  const remove = useMutation({ mutationFn: (id: string) => removeSiteEvent(siteId, id), onSuccess: landed, onError: (e) => setError(errText(e, 'Could not remove the event.')) });
  const events = q.data?.events ?? [];
  const running = events.filter((e) => e.phase === 'running').length;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Site events</h2>
        {running > 0 && <span className="chip chip-warn chip-sm">{running} now</span>}
        {canEdit && form === null && (
          <button type="button" className="btn btn-sm is-ghost" onClick={() => setForm({ kind: 'notice', title: '', detail: '', starts_on: todayIso(), ends_on: '' })}>
            <Icon name="plus" size={12} /> Add event
          </button>
        )}
      </div>
      {error && <p className="snooze-err" role="alert" style={{ margin: '0 14px 8px' }}><Icon name="alert-circle" size={12} />{error}</p>}
      {form !== null && (
        <form className="sev-form" onSubmit={(e) => { e.preventDefault(); if (form.title.trim()) add.mutate(); }}>
          <label><span className="lbl">Kind</span>
            <select className="fld" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as SiteEventKind })}>
              {SITE_EVENT_KINDS.map((k) => <option key={k} value={k}>{SITE_EVENT_KIND_LABELS[k]}</option>)}
            </select>
          </label>
          <label><span className="lbl">What is happening</span>
            <input className="fld" autoFocus value={form.title} maxLength={200} placeholder="e.g. Parking lot resurfacing" onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          <label><span className="lbl">From</span><input className="fld" type="date" value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} /></label>
          <label><span className="lbl">Until (empty = until ended)</span><input className="fld" type="date" value={form.ends_on} min={form.starts_on} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} /></label>
          <label className="is-wide"><span className="lbl">What a technician should know</span>
            <textarea className="fld" rows={2} value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} />
          </label>
          <span className="is-wide" style={{ display: 'flex', gap: 6 }}>
            <button type="submit" className="btn btn-sm" disabled={form.title.trim() === '' || add.isPending}>Add the event</button>
            <button type="button" className="btn btn-sm is-ghost" onClick={() => setForm(null)}>Cancel</button>
          </span>
        </form>
      )}
      {events.length === 0 && form === null ? (
        <div className="empty-flat">{q.isLoading ? 'Loading…' : 'Nothing going on at this site. A closure, a remodel or restricted access goes here, and shows on its work orders while it runs.'}</div>
      ) : (
        <ul className="sev-list">
          {events.map((e) => (
            <EventRow
              key={e.id}
              e={e}
              actions={canEdit ? (
                <>
                  {e.phase === 'running' && <button type="button" className="link-btn" disabled={end.isPending} onClick={() => end.mutate(e.id)}>End today</button>}
                  <button type="button" className="icon-btn" aria-label={`Remove ${e.title}`} disabled={remove.isPending} onClick={() => remove.mutate(e.id)}><Icon name="trash" size={12} /></button>
                </>
              ) : undefined}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function SiteEventsList() {
  const q = useQuery({ queryKey: ['site-events', 'all'], queryFn: () => getSiteEvents() });
  const events = q.data?.events ?? [];
  const order = { running: 0, upcoming: 1, ended: 2 } as const;
  const sorted = [...events].sort((a, b) => order[a.phase] - order[b.phase] || a.starts_on.localeCompare(b.starts_on));
  return (
    <>
      {q.isError && <div className="empty-flat">{errText(q.error, 'Could not load the events.')}</div>}
      {q.data && events.length === 0 && <div className="empty-flat">No site events. Add one from a site’s own page — a closure, a remodel, restricted access.</div>}
      <ul className="sev-list" style={{ paddingTop: 12 }}>
        {sorted.map((e) => <EventRow key={e.id} e={e} showSite />)}
      </ul>
      <div className="vend-foot"><span>{q.isFetching ? 'Loading…' : `${events.filter((e) => e.phase === 'running').length} running · ${events.filter((e) => e.phase === 'upcoming').length} upcoming · ${events.filter((e) => e.phase === 'ended').length} ended in the last 30 days`}</span></div>
    </>
  );
}

// ═══ The space viewer ════════════════════════════════════════════════════════

export function SpaceViewer({ siteId }: { siteId: string }) {
  const q = useQuery({ queryKey: ['site-spaces', siteId], queryFn: () => getSiteSpaces(siteId) });
  const [picked, setPicked] = useState<string | null>(null);
  const spaces = q.data?.spaces ?? [];
  const flat = useMemo(() => flattenLocations(locationTree(spaces)), [spaces]);
  // What is in a place includes what is in the places inside it.
  const inside = useMemo(() => {
    const kids = new Map<string, string[]>();
    for (const s of spaces) if (s.parent_id) kids.set(s.parent_id, [...(kids.get(s.parent_id) ?? []), s.id]);
    const all = (id: string): string[] => [id, ...(kids.get(id) ?? []).flatMap(all)];
    return (id: string) => new Set(all(id));
  }, [spaces]);
  if (q.isLoading) return <div className="empty-flat">Loading the spaces…</div>;
  if (q.isError || !q.data) return <div className="empty-flat">{errText(q.error, 'Could not load the spaces.')}</div>;
  if (spaces.length === 0 && q.data.unplaced.length === 0) {
    return <div className="empty-flat">Nothing to show yet. Add buildings, floors and spaces above, then place assets in them.</div>;
  }
  const current = picked && picked !== 'unplaced' ? spaces.find((s) => s.id === picked) ?? null : null;
  const scope = current ? inside(current.id) : null;
  const assets = picked === 'unplaced' ? q.data.unplaced : scope ? spaces.filter((s) => scope.has(s.id)).flatMap((s) => s.asset_list.map((a) => ({ ...a, where: s.id }))) : [];
  const wos = scope ? spaces.filter((s) => scope.has(s.id)).flatMap((s) => s.open_work_orders) : [];
  const totals = (id: string) => {
    const set = inside(id);
    const here = spaces.filter((s) => set.has(s.id));
    return { assets: here.reduce((n, s) => n + s.asset_list.length, 0), open: here.reduce((n, s) => n + s.open_work_orders.length, 0) };
  };

  return (
    <div className="spv">
      <ul className="spv-tree" aria-label="Places at this site">
        {flat.map((n) => {
          const t = totals(n.id);
          return (
            <li key={n.id}>
              <button type="button" className={picked === n.id ? 'is-on' : undefined} style={{ paddingLeft: 12 + n.depth * 18 }} onClick={() => setPicked(n.id)}>
                <Icon name={n.kind === 'building' ? 'home' : n.kind === 'floor' ? 'layers' : 'grid'} size={12} />
                {n.name}
                <span className="spv-n">
                  {t.assets > 0 && <span>{t.assets}</span>}
                  {t.open > 0 && <span className="spv-open" title="Open work orders">{t.open} open</span>}
                </span>
              </button>
            </li>
          );
        })}
        {q.data.unplaced.length > 0 && (
          <li>
            <button type="button" className={picked === 'unplaced' ? 'is-on' : undefined} onClick={() => setPicked('unplaced')}>
              <Icon name="package" size={12} /> Not placed anywhere
              <span className="spv-n"><span>{q.data.unplaced.length}</span></span>
            </button>
          </li>
        )}
      </ul>
      <div className="spv-main">
        {!picked ? (
          <p className="pf-muted">Pick a place on the left to see the assets standing in it and the work orders open against them.</p>
        ) : (
          <>
            <h3>{picked === 'unplaced' ? 'Not placed anywhere' : locationPath(spaces, picked)}</h3>
            {current && (current.space_type || current.area_sqft !== null || current.notes) && (
              <p className="pf-muted">{[current.space_type, current.area_sqft !== null ? `${current.area_sqft.toLocaleString()} sq ft` : null, current.notes].filter(Boolean).join(' · ')}</p>
            )}
            <div>
              <h4>Assets · {assets.length}</h4>
              {assets.length === 0 ? <p className="pf-muted">No asset stands here.</p> : (
                <ul>
                  {assets.map((a) => (
                    <li key={a.id}>
                      <Link to={`/assets/${a.id}`}>{a.name}</Link>
                      {a.asset_type && <span className="pf-muted">{a.asset_type}</span>}
                      <AssetStatusChip status={a.status as 'in_service'} />
                      <ConditionChip condition={a.condition as 'good' | null} />
                      {a.open_work_orders > 0 && <span className="chip chip-warn chip-sm">{a.open_work_orders} open</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {picked !== 'unplaced' && (
              <div>
                <h4>Open work orders · {wos.length}</h4>
                {wos.length === 0 ? <p className="pf-muted">Nothing open against the assets here.</p> : (
                  <ul>
                    {wos.map((w) => (
                      <li key={w.wo_number}>
                        <Link to={`/work-orders/${encodeURIComponent(w.wo_number)}`}>{w.wo_number}</Link>
                        <span>{w.title}</span>
                        <span className="chip chip-sm">{w.status.replace(/^[!<\s]+|[>\s]+$/g, '')}</span>
                        {w.asset && <span className="pf-muted">{w.asset}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
