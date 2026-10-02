/* /maintenance — the maintenance modules (0065), one tab each:
 *
 *   Assignment     who carries what, and the queue of work orders to hand out
 *   Job plans      reusable lists of steps (and services) for a kind of job
 *   Services       the catalogue of what we do, with a unit and a price
 *   Time tracker   technician time across work orders
 *   Work permits   every permit, by where it stands
 *
 * A person sees the tabs their role grants (`maintenance/...`). The tab lives
 * in the URL as ?tab=.
 */

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAINT_PERM, PERMIT_STATE_LABELS, SERVICE_UNITS, TIME_KIND_LABELS, formatMinutes, suggestAssignees } from '@theone/shared';
import type { JobPlan, JobPlansResponse, PermitState, ServiceItem, ServicesResponse, WorkPermit } from '@theone/shared';
import {
  assignWorkOrders,
  deleteJobPlan,
  deleteService,
  getAssignmentBoard,
  getJobPlans,
  getPermits,
  getServices,
  getTimeTracker,
  saveJobPlan,
  saveService,
} from '../api/client';
import { useCan } from '../auth/AuthProvider';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { F, PageTabs, Sheet, dayText, errText, numOrNull, stampText, usd } from '../components/ui/Sheet';
import { PermitChip, PermitDialog } from '../components/wo/maint/WoMaintCards';
import { plainStatus } from '../lib/quo';

type Tab = 'assignment' | 'plans' | 'services' | 'time' | 'permits';
const TABS: { id: Tab; label: string; perm: string }[] = [
  { id: 'assignment', label: 'Assignment', perm: MAINT_PERM.assignment },
  { id: 'plans', label: 'Job plans', perm: MAINT_PERM.plans },
  { id: 'services', label: 'Services', perm: MAINT_PERM.services },
  { id: 'time', label: 'Time tracker', perm: MAINT_PERM.time },
  { id: 'permits', label: 'Work permits', perm: MAINT_PERM.permits },
];

export function MaintenancePage() {
  const can = useCan();
  const [sp, setSp] = useSearchParams();
  const tabs = TABS.filter((t) => can(t.perm, 'view'));
  const tab = (tabs.find((t) => t.id === sp.get('tab')) ?? tabs[0])?.id;
  return (
    <AppShell active="Maintenance">
      <div className="canvas-inner">
        <div className="vend-head">
          <div className="page-head" style={{ margin: 0 }}><h1 className="page-title">Maintenance</h1></div>
        </div>
        {tabs.length === 0 ? (
          <section className="card"><div className="empty-flat">Your role does not open any of the maintenance modules.</div></section>
        ) : (
          <>
            <PageTabs tabs={tabs} value={tab!} onChange={(id) => setSp({ tab: id }, { replace: true })} />
            {tab === 'assignment' && <AssignmentTab />}
            {tab === 'plans' && <JobPlansTab />}
            {tab === 'services' && <ServicesTab />}
            {tab === 'time' && <TimeTab />}
            {tab === 'permits' && <PermitsTab />}
          </>
        )}
      </div>
    </AppShell>
  );
}

// ═══ Assignment Manager ══════════════════════════════════════════════════════

function AssignmentTab() {
  const qc = useQueryClient();
  const [who, setWho] = useState('unassigned');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['maintenance', 'assignment', who, applied], queryFn: () => getAssignmentBoard({ who, search: applied }), placeholderData: keepPreviousData });
  const assign = useMutation({
    mutationFn: () => assignWorkOrders([...picked], target === 'nobody' ? null : target),
    onSuccess: (res) => {
      setPicked(new Set());
      setError(null);
      setResult(
        `${res.assigned} ${res.assigned === 1 ? 'work order' : 'work orders'} ${target === 'nobody' ? 'unassigned' : 'assigned'}.` +
          (res.failed.length ? ` ${res.failed.length} could not be changed: ${res.failed.map((f) => `${f.wo_number} (${f.reason})`).join('; ')}` : ''),
      );
      void qc.invalidateQueries({ queryKey: ['maintenance', 'assignment'] });
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
    },
    onError: (e) => setError(errText(e, 'Could not assign the work orders.')),
  });
  const d = q.data;
  const rows = d?.work_orders ?? [];
  const people = d?.people ?? [];
  const max = Math.max(1, ...people.map((p) => p.open));
  const suggested = useMemo(() => suggestAssignees(people.filter((p) => p.open > 0 || /om|dispatch|coordinator/i.test(p.role_label ?? ''))), [people]);
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const toggle = (id: string) => setPicked((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  return (
    <div className="mt-assign">
      <section className="card mt-people">
        <div className="card-head"><h2 className="card-title grow">Workload</h2><span className="card-meta">open work orders</span></div>
        <ul>
          <li><button type="button" className={who === 'unassigned' ? 'is-on' : undefined} onClick={() => { setWho('unassigned'); setPicked(new Set()); }}><span><b>Unassigned</b></span><b className="num">{d?.unassigned ?? '…'}</b></button></li>
          <li><button type="button" className={who === 'all' ? 'is-on' : undefined} onClick={() => { setWho('all'); setPicked(new Set()); }}><span><b>Everything open</b></span></button></li>
          {people.map((p) => (
            <li key={p.id}>
              <button type="button" className={who === p.name ? 'is-on' : undefined} onClick={() => { setWho(p.name); setPicked(new Set()); }}>
                <span>
                  <b>{p.name}</b>
                  <small>{[p.role_label, p.emergencies ? `${p.emergencies} emergency` : null, p.overdue ? `${p.overdue} past SLA` : null].filter(Boolean).join(' · ')}</small>
                  <i className="mt-load" aria-hidden="true"><i style={{ width: `${Math.round((p.open / max) * 100)}%` }} /></i>
                </span>
                <b className="num">{p.open}</b>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <form className="vend-filters" onSubmit={(e) => { e.preventDefault(); setApplied(search.trim()); }}>
          <input className="fld vend-search" type="search" placeholder="Search WO #, client, store or city" value={search} onChange={(e) => setSearch(e.target.value)} onBlur={() => setApplied(search.trim())} aria-label="Search work orders" />
          <span className="card-meta" style={{ marginLeft: 'auto' }}>{who === 'unassigned' ? 'Unassigned' : who === 'all' ? 'Everything open' : who}{d ? ` · ${d.total}` : ''}</span>
        </form>
        {d?.can.edit && (
          <div className="mt-assignbar">
            <span>{picked.size ? `${picked.size} picked` : 'Tick work orders, then'}</span>
            <select className="fld" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Assign to">
              <option value="">Assign to…</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.open} open</option>)}
              <option value="nobody">Nobody (unassign)</option>
            </select>
            <button type="button" className="btn btn-primary btn-sm" disabled={picked.size === 0 || !target || assign.isPending} onClick={() => assign.mutate()}>{assign.isPending ? 'Assigning…' : 'Assign'}</button>
            {suggested.length > 0 && (
              <span className="mt-suggest">Lightest load: {suggested.map((p) => <button key={p.id} type="button" className="chip chip-sm" onClick={() => setTarget(p.id)}>{p.name} · {p.open}</button>)}</span>
            )}
          </div>
        )}
        {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
        {result && <p className="mt-banner" role="status"><Icon name="check-circle" size={14} />{result}</p>}
        {q.isError ? <div className="empty-flat">{errText(q.error, 'Could not load the board.')}</div> : (
          <div className="vend-wrap">
            <table className="vend-table mt-table">
              <thead>
                <tr>
                  {d?.can.edit && <th className="mt-ck"><input type="checkbox" aria-label="Pick every row" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)))} /></th>}
                  <th>Work order</th><th>Client</th><th>Where</th><th>Trade</th><th>Status</th><th>Assignee</th><th>Vendor</th><th className="num">Age</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={picked.has(r.id) ? 'is-picked' : undefined}>
                    {d?.can.edit && <td className="mt-ck"><input type="checkbox" aria-label={`Pick ${r.wo_number}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>}
                    <td className="vend-name"><Link to={`/work-orders/${encodeURIComponent(r.wo_number)}`} className="mono">{r.wo_number}</Link>{r.emergency && <span><span className="chip chip-sm chip-danger">Emergency</span></span>}</td>
                    <td>{[r.client, r.store ? `#${r.store.replace(/^#/, '')}` : null].filter(Boolean).join(' ') || '—'}</td>
                    <td>{[r.city, r.state].filter(Boolean).join(', ') || '—'}</td>
                    <td>{r.trade ?? '—'}</td>
                    <td>{plainStatus(r.status_name)}</td>
                    <td>{r.assignee ?? <span className="pf-muted">Nobody</span>}</td>
                    <td>{r.vendor ?? '—'}</td>
                    <td className="num">{r.age_days}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d && rows.length === 0 && <div className="empty-flat">{who === 'unassigned' ? 'Every open work order has somebody on it.' : 'Nothing here.'}</div>}
          </div>
        )}
        <div className="vend-foot"><span>{q.isFetching ? 'Loading…' : d && d.total > rows.length ? `Showing the oldest ${rows.length} of ${d.total}` : `${rows.length} ${rows.length === 1 ? 'work order' : 'work orders'}`}</span></div>
      </section>
    </div>
  );
}

// ═══ Job plans ═══════════════════════════════════════════════════════════════

function JobPlansTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['maintenance', 'plans'], queryFn: getJobPlans });
  const [editing, setEditing] = useState<JobPlan | 'new' | null>(null);
  const [deleting, setDeleting] = useState<JobPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => deleteJobPlan(id),
    onSuccess: (res) => { qc.setQueryData(['maintenance', 'plans'], res); setDeleting(null); setError(null); },
    onError: (e) => { setDeleting(null); setError(errText(e, 'Could not delete the plan.')); },
  });
  const d = q.data;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Job plans</h2>
        {d?.can.create && <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={12} /> New job plan</button>}
      </div>
      <p className="hint mt-hint">A job plan is the list of steps for a kind of job. Apply it on a work order (Checklist tab) or name it on a planned-maintenance schedule, and its steps become that work order’s checklist.</p>
      {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
      {q.isError ? <div className="empty-flat">{errText(q.error, 'Could not load the job plans.')}</div> : (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th>Plan</th><th>Trade</th><th className="num">Steps</th><th className="num">Services</th><th className="num">Est. time</th><th className="num">Applied</th><th /></tr></thead>
            <tbody>
              {(d?.plans ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="vend-name"><button type="button" className="link-btn" onClick={() => setEditing(p)}>{p.name}</button>{!p.is_active && <span><span className="chip chip-outline chip-sm">Inactive</span></span>}</td>
                  <td>{p.trade ?? 'Any'}</td>
                  <td className="num">{p.steps.length}</td>
                  <td className="num">{p.services.length}</td>
                  <td className="num">{p.est_minutes ? formatMinutes(p.est_minutes) : '—'}</td>
                  <td className="num">{p.used}</td>
                  <td className="mt-acts">{d?.can.delete && <button type="button" className="icon-btn" aria-label={`Delete ${p.name}`} onClick={() => setDeleting(p)}><Icon name="trash" size={12} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d && d.plans.length === 0 && <div className="empty-flat">No job plans yet.</div>}
        </div>
      )}
      {editing && d && <JobPlanDialog plan={editing === 'new' ? null : editing} meta={d} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog title={`Delete ${deleting.name}?`} message="Work orders it was applied to keep their steps." confirmLabel="Delete" danger busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)} onCancel={() => setDeleting(null)} />
      )}
    </section>
  );
}

function JobPlanDialog({ plan, meta, onClose }: { plan: JobPlan | null; meta: JobPlansResponse; onClose: () => void }) {
  const qc = useQueryClient();
  const readOnly = plan ? !meta.can.edit : !meta.can.create;
  const [d, setD] = useState({
    name: plan?.name ?? '', trade: plan?.trade ?? '', description: plan?.description ?? '',
    est: plan?.est_minutes ? String(plan.est_minutes) : '', steps: (plan?.steps ?? []).map((s) => s.title).join('\n'), is_active: plan?.is_active ?? true,
  });
  const [services, setServices] = useState<{ service_id: string; qty: string }[]>((plan?.services ?? []).map((s) => ({ service_id: s.service_id, qty: String(s.qty) })));
  const [addId, setAddId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      if (!d.name.trim()) throw new Error('The job plan needs a name.');
      const steps = d.steps.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (steps.length === 0) throw new Error('List at least one step, one per line.');
      return saveJobPlan(plan?.id ?? null, {
        name: d.name.trim(), trade: d.trade || null, description: d.description.trim() || null, est_minutes: numOrNull(d.est) === null ? null : Math.round(numOrNull(d.est)!),
        is_active: d.is_active, steps, services: services.map((s) => ({ service_id: s.service_id, qty: Number(s.qty) > 0 ? Number(s.qty) : 1 })),
      });
    },
    onSuccess: (res) => { qc.setQueryData(['maintenance', 'plans'], res); onClose(); },
    onError: (e) => setProblem(errText(e, 'Could not save the job plan.')),
  });
  const nameOf = (id: string) => meta.services.find((s) => s.id === id)?.name ?? plan?.services.find((s) => s.service_id === id)?.name ?? 'Service';
  const free = meta.services.filter((s) => !services.some((x) => x.service_id === s.id));
  return (
    <Sheet title={plan ? plan.name : 'New job plan'} icon="list" onClose={onClose} problem={problem}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : plan ? 'Save changes' : 'Add job plan'}</button>}
      </>}>
      <fieldset className="mt-fieldset" disabled={readOnly}>
        <div className="pf-form">
          <F label="Name" wide><input className="fld" autoFocus={!plan} value={d.name} onChange={(e) => setD((c) => ({ ...c, name: e.target.value }))} /></F>
          <F label="Trade">
            <select className="fld" value={d.trade} onChange={(e) => setD((c) => ({ ...c, trade: e.target.value }))}>
              <option value="">Any trade</option>
              {d.trade && !meta.trades.includes(d.trade) && <option value={d.trade}>{d.trade}</option>}
              {meta.trades.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </F>
          <F label="Estimated minutes"><input className="fld" type="number" min="0" value={d.est} onChange={(e) => setD((c) => ({ ...c, est: e.target.value }))} /></F>
          <F label="What it is for" wide><input className="fld" value={d.description} onChange={(e) => setD((c) => ({ ...c, description: e.target.value }))} /></F>
          <F label="Steps" wide hint="One step per line, in the order they are done."><textarea className="fld" rows={7} value={d.steps} onChange={(e) => setD((c) => ({ ...c, steps: e.target.value }))} /></F>
          <div className="pf-field is-wide">
            <span className="lbl">Services</span>
            {services.length > 0 && (
              <ul className="mt-precautions">
                {services.map((s, i) => (
                  <li key={s.service_id}>
                    <span className="grow">{nameOf(s.service_id)}</span>
                    <input className="fld mt-qty" type="number" min="0.01" step="any" value={s.qty} aria-label="Quantity" onChange={(e) => setServices((cur) => cur.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                    <button type="button" className="icon-btn" aria-label="Remove" onClick={() => setServices((cur) => cur.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
                  </li>
                ))}
              </ul>
            )}
            {free.length > 0 ? (
              <div className="mt-inline">
                <select className="fld" value={addId} onChange={(e) => setAddId(e.target.value)} aria-label="Service to add">
                  <option value="">Add a service from the catalogue…</option>
                  {free.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <button type="button" className="btn btn-sm" disabled={!addId} onClick={() => { setServices((cur) => [...cur, { service_id: addId, qty: '1' }]); setAddId(''); }}>Add</button>
              </div>
            ) : services.length === 0 ? <span className="hint">The services catalogue is empty.</span> : null}
          </div>
          {plan && <label className="tmap-check pf-field"><input type="checkbox" checked={d.is_active} onChange={(e) => setD((c) => ({ ...c, is_active: e.target.checked }))} /><span>Active — clear it to stop offering this plan</span></label>}
        </div>
      </fieldset>
    </Sheet>
  );
}

// ═══ Services ════════════════════════════════════════════════════════════════

function ServicesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['maintenance', 'services'], queryFn: getServices });
  const [editing, setEditing] = useState<ServiceItem | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ServiceItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const remove = useMutation({
    mutationFn: (id: string) => deleteService(id),
    onSuccess: (res) => { qc.setQueryData(['maintenance', 'services'], res); setDeleting(null); setError(null); },
    onError: (e) => { setDeleting(null); setError(errText(e, 'Could not delete the service.')); },
  });
  const d = q.data;
  const needle = search.trim().toLowerCase();
  const rows = (d?.services ?? []).filter((s) => !needle || `${s.name} ${s.code ?? ''} ${s.trade ?? ''}`.toLowerCase().includes(needle));
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Services catalogue</h2>
        {d?.can.create && <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={12} /> New service</button>}
      </div>
      <div className="vend-filters"><input className="fld vend-search" type="search" placeholder="Search name, code or trade" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search services" /></div>
      {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
      {q.isError ? <div className="empty-flat">{errText(q.error, 'Could not load the services.')}</div> : (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th>Service</th><th>Code</th><th>Trade</th><th>Unit</th><th className="num">Price</th><th className="num">Cost</th><th className="num">Est. time</th><th className="num">On work orders</th><th /></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="vend-name"><button type="button" className="link-btn" onClick={() => setEditing(s)}>{s.name}</button>{!s.is_active && <span><span className="chip chip-outline chip-sm">Inactive</span></span>}</td>
                  <td className="mono">{s.code ?? '—'}</td>
                  <td>{s.trade ?? 'Any'}</td>
                  <td>{s.unit}</td>
                  <td className="num">{usd(s.unit_price)}</td>
                  <td className="num">{usd(s.unit_cost)}</td>
                  <td className="num">{s.est_minutes ? formatMinutes(s.est_minutes) : '—'}</td>
                  <td className="num">{s.used}</td>
                  <td className="mt-acts">{d?.can.delete && <button type="button" className="icon-btn" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)}><Icon name="trash" size={12} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d && rows.length === 0 && <div className="empty-flat">{needle ? 'Nothing matches.' : 'The catalogue is empty. Add the services you sell, with a unit and a price.'}</div>}
        </div>
      )}
      {editing && d && <ServiceDialog service={editing === 'new' ? null : editing} meta={d} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog title={`Delete ${deleting.name}?`} message="Work orders that already carry it keep their line." confirmLabel="Delete" danger busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)} onCancel={() => setDeleting(null)} />
      )}
    </section>
  );
}

function ServiceDialog({ service, meta, onClose }: { service: ServiceItem | null; meta: ServicesResponse; onClose: () => void }) {
  const qc = useQueryClient();
  const readOnly = service ? !meta.can.edit : !meta.can.create;
  const s = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  const [d, setD] = useState({
    name: service?.name ?? '', code: service?.code ?? '', trade: service?.trade ?? '', description: service?.description ?? '', unit: service?.unit ?? 'each',
    unit_price: s(service?.unit_price), unit_cost: s(service?.unit_cost), est: s(service?.est_minutes), is_active: service?.is_active ?? true,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((cur) => ({ ...cur, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      if (!d.name.trim()) throw new Error('The service needs a name.');
      const est = numOrNull(d.est);
      return saveService(service?.id ?? null, {
        name: d.name.trim(), code: d.code.trim() || null, trade: d.trade || null, description: d.description.trim() || null, unit: d.unit,
        unit_price: numOrNull(d.unit_price), unit_cost: numOrNull(d.unit_cost), est_minutes: est === null ? null : Math.round(est), is_active: d.is_active,
      });
    },
    onSuccess: (res) => { qc.setQueryData(['maintenance', 'services'], res); void qc.invalidateQueries({ queryKey: ['maintenance', 'plans'] }); onClose(); },
    onError: (e) => setProblem(errText(e, 'Could not save the service.')),
  });
  return (
    <Sheet title={service ? service.name : 'New service'} icon="wrench" onClose={onClose} problem={problem}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : service ? 'Save changes' : 'Add service'}</button>}
      </>}>
      <fieldset className="mt-fieldset" disabled={readOnly}>
        <div className="pf-form">
          <F label="Name" wide><input className="fld" autoFocus={!service} value={d.name} onChange={(e) => set('name', e.target.value)} /></F>
          <F label="Code"><input className="fld mono" value={d.code} onChange={(e) => set('code', e.target.value)} /></F>
          <F label="Trade">
            <select className="fld" value={d.trade} onChange={(e) => set('trade', e.target.value)}>
              <option value="">Any trade</option>
              {d.trade && !meta.trades.includes(d.trade) && <option value={d.trade}>{d.trade}</option>}
              {meta.trades.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </F>
          <F label="Unit">
            <select className="fld" value={d.unit} onChange={(e) => set('unit', e.target.value)}>
              {!(SERVICE_UNITS as readonly string[]).includes(d.unit) && <option value={d.unit}>{d.unit}</option>}
              {SERVICE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </F>
          <F label="Estimated minutes"><input className="fld" type="number" min="0" value={d.est} onChange={(e) => set('est', e.target.value)} /></F>
          <F label="Price per unit" hint="What the client is charged."><input className="fld" type="number" min="0" step="0.01" value={d.unit_price} onChange={(e) => set('unit_price', e.target.value)} /></F>
          <F label="Cost per unit" hint="What it costs us."><input className="fld" type="number" min="0" step="0.01" value={d.unit_cost} onChange={(e) => set('unit_cost', e.target.value)} /></F>
          <F label="Description" wide><textarea className="fld" rows={2} value={d.description} onChange={(e) => set('description', e.target.value)} /></F>
          {service && <label className="tmap-check pf-field"><input type="checkbox" checked={d.is_active} onChange={(e) => set('is_active', e.target.checked)} /><span>Active — clear it to stop offering this service</span></label>}
        </div>
      </fieldset>
    </Sheet>
  );
}

// ═══ Time tracker ════════════════════════════════════════════════════════════

const isoDay = (d: Date) => d.toLocaleDateString('en-CA');

function TimeTab() {
  const [range, setRange] = useState(() => { const to = new Date(); const from = new Date(); from.setDate(from.getDate() - 6); return { from: isoDay(from), to: isoDay(to) }; });
  const [tech, setTech] = useState('');
  const q = useQuery({ queryKey: ['maintenance', 'time', range, tech], queryFn: () => getTimeTracker({ ...range, tech: tech || undefined }), placeholderData: keepPreviousData, refetchInterval: 60_000 });
  const d = q.data;
  return (
    <>
      <section className="card">
        <div className="vend-filters">
          <label className="mt-range">From <input className="fld" type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} /></label>
          <label className="mt-range">To <input className="fld" type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} /></label>
          {tech && <button type="button" className="chip" onClick={() => setTech('')}>{tech} <Icon name="x" size={12} /></button>}
        </div>
        <div className="rec-sum">
          <div><span>Total time</span><b>{formatMinutes(d?.totals.minutes ?? 0)}</b></div>
          <div><span>Billable</span><b>{formatMinutes(d?.totals.billable_minutes ?? 0)}</b></div>
          <div><span>Labor value</span><b>{usd(d?.totals.amount ?? 0)}</b><small>Entries with a rate</small></div>
          <div><span>Timers running</span><b>{d?.totals.running ?? 0}</b></div>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h2 className="card-title grow">By technician</h2></div>
        {q.isError ? <div className="empty-flat">{errText(q.error, 'Could not load the time tracker.')}</div> : (
          <div className="vend-wrap">
            <table className="vend-table mt-table">
              <thead><tr><th>Technician</th><th className="num">Work orders</th><th className="num">Entries</th><th className="num">Time</th><th className="num">Billable</th><th className="num">Value</th></tr></thead>
              <tbody>
                {(d?.technicians ?? []).map((t) => (
                  <tr key={t.tech_name}>
                    <td className="vend-name"><button type="button" className="link-btn" onClick={() => setTech(t.tech_name)}>{t.tech_name}</button>{t.running > 0 && <span><span className="chip chip-sm chip-ok">Timer running</span></span>}</td>
                    <td className="num">{t.work_orders}</td>
                    <td className="num">{t.entries}</td>
                    <td className="num">{formatMinutes(t.minutes)}</td>
                    <td className="num">{formatMinutes(t.billable_minutes)}</td>
                    <td className="num">{t.amount ? usd(t.amount) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d && d.technicians.length === 0 && <div className="empty-flat">No time was logged in these days. Time is logged on a work order, under its Timelog tab.</div>}
          </div>
        )}
      </section>
      {d && d.entries.length > 0 && (
        <section className="card">
          <div className="card-head"><h2 className="card-title grow">Entries</h2><span className="card-meta">{d.entries.length}</span></div>
          <div className="vend-wrap">
            <table className="vend-table mt-table">
              <thead><tr><th>Technician</th><th>Work order</th><th>Kind</th><th>Started</th><th>Ended</th><th className="num">Time</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {d.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{e.tech_name}{e.note && <small className="mt-sub">{e.note}</small>}</td>
                    <td><Link className="mono" to={`/work-orders/${encodeURIComponent(e.wo_number)}?tab=timelog`}>{e.wo_number}</Link>{e.place && <small className="mt-sub">{e.place}</small>}</td>
                    <td>{TIME_KIND_LABELS[e.kind]}{!e.billable && <small className="mt-sub">not billable</small>}</td>
                    <td>{stampText(e.started_at)}</td>
                    <td>{e.ended_at ? stampText(e.ended_at) : <span className="chip chip-sm chip-ok">Running</span>}</td>
                    <td className="num">{formatMinutes(e.minutes)}</td>
                    <td className="num">{e.amount === null ? '—' : usd(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

// ═══ Work permits ════════════════════════════════════════════════════════════

const PERMIT_STATES: PermitState[] = ['requested', 'active', 'approved', 'draft', 'expired', 'rejected', 'closed'];

function PermitsTab() {
  const [state, setState] = useState<PermitState | ''>('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [open, setOpen] = useState<WorkPermit | null>(null);
  const q = useQuery({ queryKey: ['maintenance', 'permits', state, applied], queryFn: () => getPermits({ state: state || undefined, search: applied || undefined }), placeholderData: keepPreviousData });
  const d = q.data;
  const current = open ? (d?.permits.find((p) => p.id === open.id) ?? open) : null;
  return (
    <section className="card">
      <form className="vend-filters" onSubmit={(e) => { e.preventDefault(); setApplied(search.trim()); }}>
        <input className="fld vend-search" type="search" placeholder="Search permit #, WO #, holder or client" value={search} onChange={(e) => setSearch(e.target.value)} onBlur={() => setApplied(search.trim())} aria-label="Search permits" />
        <div className="mt-states">
          <button type="button" className={`chip${state === '' ? ' chip-accent' : ''}`} onClick={() => setState('')}>All</button>
          {PERMIT_STATES.map((s) => (
            <button key={s} type="button" className={`chip${state === s ? ' chip-accent' : ''}`} onClick={() => setState(s)}>{PERMIT_STATE_LABELS[s]}{d ? ` · ${d.counts[s]}` : ''}</button>
          ))}
        </div>
      </form>
      {q.isError ? <div className="empty-flat">{errText(q.error, 'Could not load the permits.')}</div> : (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th>Permit</th><th>Work order</th><th>Kind</th><th>Holder</th><th>Valid</th><th>Status</th><th>Requested by</th></tr></thead>
            <tbody>
              {(d?.permits ?? []).map((p) => (
                <tr key={p.id}>
                  <td><button type="button" className="link-btn mono" onClick={() => setOpen(p)}>{p.permit_number}</button></td>
                  <td><Link className="mono" to={`/work-orders/${encodeURIComponent(p.wo_number)}?tab=related`}>{p.wo_number}</Link>{p.place && <small className="mt-sub">{p.place}</small>}</td>
                  <td>{p.permit_type}</td>
                  <td>{p.holder ?? '—'}</td>
                  <td>{p.valid_from ? `${dayText(p.valid_from)} → ${dayText(p.valid_to)}` : '—'}</td>
                  <td><PermitChip state={p.state} /></td>
                  <td>{p.requested_by?.name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d && d.permits.length === 0 && <div className="empty-flat">{state || applied ? 'Nothing matches.' : 'No work permits yet. A permit is written on a work order, under its Related tab.'}</div>}
        </div>
      )}
      {current && d && <PermitDialog woId={current.task_id} permit={current} canEdit={d.can.edit} canApprove={d.can.approve} canCreate={d.can.create} onClose={() => setOpen(null)} />}
    </section>
  );
}
