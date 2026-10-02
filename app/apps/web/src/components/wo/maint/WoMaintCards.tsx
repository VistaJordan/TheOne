/* 0065 · Maintenance on a work order.
 *
 *   JobPlanServicesCard   Checklist tab: lay a job plan over the work order
 *                         (its steps join the checklist) and the services done
 *   TimeCard              Timelog tab: who worked on it, from when to when,
 *                         with a running timer
 *   PermitsCard           Related tab: the work permits of this job
 *   PermitDialog          write or change a permit (the Maintenance page uses
 *                         it too)
 *
 * One read, `/work-orders/:id/maintenance`, feeds all three; every write
 * returns the same payload.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMIT_PRECAUTIONS, PERMIT_STATE_LABELS, PERMIT_TYPES, TIME_KINDS, TIME_KIND_LABELS, formatMinutes, permitRequestProblem } from '@theone/shared';
import type { PermitAction, PermitPrecaution, PermitState, TimeEntry, TimeKind, WoMaintenance, WorkPermit } from '@theone/shared';
import {
  actOnPermit,
  addTimeEntry,
  addWoService,
  applyJobPlan,
  createPermit,
  deletePermit,
  deleteTimeEntry,
  getWoMaintenance,
  removeWoService,
  updatePermit,
  updateTimeEntry,
  updateWoService,
} from '../../../api/client';
import { Icon } from '../../Icon';
import { F, Sheet, dayText, errText, numOrNull, stampText, usd } from '../../ui/Sheet';

export const maintKey = (woId: string) => ['wo-maintenance', woId];

export function useWoMaintenance(woId: string | undefined, enabled = true) {
  return useQuery({ queryKey: maintKey(woId ?? ''), queryFn: () => getWoMaintenance(woId!), enabled: Boolean(woId) && enabled, refetchInterval: (q) => (q.state.data?.time.some((t) => !t.ended_at) ? 60_000 : false) });
}

/** A write that returns the whole payload: it replaces the cache, and the
 *  checklist (which a job plan adds to) and the audit trail are refetched. */
function useMaintWrite<T>(woId: string, fn: (arg: T) => Promise<WoMaintenance>, onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (res) => {
      qc.setQueryData(maintKey(woId), res);
      void qc.invalidateQueries({ queryKey: ['wo-record', woId] });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: ['maintenance'] });
      onDone?.();
    },
  });
}

const PERMIT_TONE: Record<PermitState, string> = {
  draft: '', requested: ' chip-warn', approved: ' chip-accent', active: ' chip-ok', expired: ' chip-danger', rejected: ' chip-danger', closed: '',
};
export function PermitChip({ state }: { state: PermitState }) {
  return <span className={`chip chip-sm${PERMIT_TONE[state]}`}>{PERMIT_STATE_LABELS[state]}</span>;
}

// ═══ Job plan + services (Checklist tab) ═════════════════════════════════════

export function JobPlanServicesCard({ woId }: { woId: string }) {
  const q = useWoMaintenance(woId);
  const m = q.data;
  const [planId, setPlanId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [typed, setTyped] = useState('');
  const [qty, setQty] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const opts = (fallback: string) => ({ onError: (e: unknown) => setError(errText(e, fallback)), onSuccess: () => setError(null) });
  const apply = useMaintWrite(woId, (id: string) => applyJobPlan(woId, id), () => setPlanId(''));
  const add = useMaintWrite(woId, (x: { service_id?: string; name?: string; qty: number }) => addWoService(woId, x), () => { setServiceId(''); setTyped(''); setQty('1'); });
  const change = useMaintWrite(woId, (x: { id: string; qty: number }) => updateWoService(woId, x.id, { qty: x.qty }));
  const remove = useMaintWrite(woId, (id: string) => removeWoService(woId, id));
  if (!m) return null;
  const showPlans = m.plans.length > 0 || m.plans_applied.length > 0;
  const showServices = m.catalogue.length > 0 || m.services.length > 0 || m.can.services;
  if (!showPlans && !showServices) return null;
  const free = m.plans.filter((p) => !p.applied);
  const hasPrices = m.services.some((s) => s.unit_price !== null);

  return (
    <>
      {showPlans && (
        <section className="card">
          <div className="card-head"><h2 className="card-title grow">Job plan</h2></div>
          {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
          {m.plans_applied.length > 0 && (
            <ul className="mt-applied">
              {m.plans_applied.map((p) => (
                <li key={p.plan_id}><Icon name="check-circle" size={14} /><b>{p.name}</b><small>applied {stampText(p.applied_at)}{p.applied_by ? ` by ${p.applied_by.name}` : ''}</small></li>
              ))}
            </ul>
          )}
          {m.can.plans && free.length > 0 ? (
            <form className="rec-add" onSubmit={(e) => { e.preventDefault(); if (planId) apply.mutate(planId, opts('Could not apply the plan.')); }}>
              <select className="fld" value={planId} onChange={(e) => setPlanId(e.target.value)} aria-label="Job plan">
                <option value="">Pick a job plan…</option>
                {free.map((p) => <option key={p.id} value={p.id}>{p.name}{p.trade ? ` · ${p.trade}` : ''} — {p.steps} {p.steps === 1 ? 'step' : 'steps'}{p.services ? `, ${p.services} ${p.services === 1 ? 'service' : 'services'}` : ''}</option>)}
              </select>
              <button type="submit" className="btn btn-sm" disabled={!planId || apply.isPending}>Apply</button>
            </form>
          ) : m.plans_applied.length === 0 ? (
            <div className="empty-flat">No job plan applied.</div>
          ) : null}
          {m.can.plans && free.length > 0 && <p className="hint mt-hint">Applying a plan adds its steps to the checklist above and its services below.</p>}
        </section>
      )}

      {showServices && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title grow">Services</h2>
            {hasPrices && <span className="card-meta">{usd(m.services_total.price)}</span>}
          </div>
          {m.services.length === 0 ? (
            <div className="empty-flat">No services on this work order yet.</div>
          ) : (
            <div className="vend-wrap">
              <table className="vend-table mt-table">
                <thead><tr><th>Service</th><th className="num">Qty</th><th>Unit</th><th className="num">Price</th><th className="num">Total</th><th /></tr></thead>
                <tbody>
                  {m.services.map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}{s.note && <small className="mt-sub">{s.note}</small>}</td>
                      <td className="num">
                        {m.can.services ? (
                          <input className="fld mt-qty" type="number" min="0.01" step="any" defaultValue={s.qty} aria-label={`Quantity of ${s.name}`}
                            onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0 && n !== s.qty) change.mutate({ id: s.id, qty: n }, opts('Could not save.')); else e.target.value = String(s.qty); }} />
                        ) : s.qty}
                      </td>
                      <td>{s.unit}</td>
                      <td className="num">{usd(s.unit_price)}</td>
                      <td className="num">{s.unit_price === null ? '—' : usd(s.qty * s.unit_price)}</td>
                      <td className="mt-acts">{m.can.services && <button type="button" className="icon-btn" aria-label={`Remove ${s.name}`} disabled={remove.isPending} onClick={() => remove.mutate(s.id, opts('Could not remove it.'))}><Icon name="x" size={12} /></button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {m.can.services && (
            <form className="rec-add mt-add" onSubmit={(e) => {
              e.preventDefault();
              const n = Number(qty);
              if (!(Number.isFinite(n) && n > 0)) { setError('The quantity must be more than zero.'); return; }
              if (serviceId) add.mutate({ service_id: serviceId, qty: n }, opts('Could not add the service.'));
              else if (typed.trim()) add.mutate({ name: typed.trim(), qty: n }, opts('Could not add the service.'));
            }}>
              <select className="fld" value={serviceId} onChange={(e) => setServiceId(e.target.value)} aria-label="Service from the catalogue">
                <option value="">{m.catalogue.length ? 'From the catalogue…' : 'The catalogue is empty'}</option>
                {m.catalogue.map((c) => <option key={c.id} value={c.id}>{c.name}{c.unit_price !== null ? ` — ${usd(c.unit_price)} / ${c.unit}` : ''}</option>)}
              </select>
              {!serviceId && <input className="fld" placeholder="…or type one" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Service name" />}
              <input className="fld mt-qty" type="number" min="0.01" step="any" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity" />
              <button type="submit" className="btn btn-sm" disabled={(!serviceId && !typed.trim()) || add.isPending}>Add</button>
            </form>
          )}
        </section>
      )}
    </>
  );
}

// ═══ Technician time (Timelog tab) ═══════════════════════════════════════════

/** A datetime-local value in the browser's zone, from an ISO stamp. */
const toLocalInput = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

export function TimeEntryDialog({ woId, entry, technicians, onClose }: { woId: string; entry: TimeEntry | null; technicians: { vendor_id: string; name: string }[]; onClose: () => void }) {
  const [d, setD] = useState({
    tech_name: entry?.tech_name ?? technicians[0]?.name ?? '',
    kind: (entry?.kind ?? 'labor') as TimeKind,
    started_at: toLocalInput(entry?.started_at ?? null),
    ended_at: toLocalInput(entry?.ended_at ?? null),
    hourly_rate: entry?.hourly_rate !== null && entry?.hourly_rate !== undefined ? String(entry.hourly_rate) : '',
    billable: entry?.billable ?? true,
    note: entry?.note ?? '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMaintWrite(woId, () => {
    if (!d.tech_name.trim()) throw new Error('Say whose time this is.');
    if (!entry && !d.started_at) throw new Error('Give the start, or use “Start a timer” instead.');
    const vendor = technicians.find((t) => t.name.toLowerCase() === d.tech_name.trim().toLowerCase());
    const input = {
      tech_name: d.tech_name.trim(), kind: d.kind, billable: d.billable, hourly_rate: numOrNull(d.hourly_rate), note: d.note.trim() || null,
      started_at: fromLocalInput(d.started_at) ?? undefined, ended_at: fromLocalInput(d.ended_at),
    };
    return entry ? updateTimeEntry(woId, entry.id, input) : addTimeEntry(woId, { ...input, vendor_id: vendor?.vendor_id ?? null });
  }, onClose);
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((cur) => ({ ...cur, [k]: v }));
  return (
    <Sheet title={entry ? 'Change a time entry' : 'Log time'} icon="clock" onClose={onClose} problem={problem}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(undefined, { onError: (e) => setProblem(errText(e, 'Could not save the entry.')) })}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </>}>
      <div className="pf-form">
        <F label="Technician" wide>
          <input className="fld" list="mt-techs" autoFocus={!entry} value={d.tech_name} onChange={(e) => set('tech_name', e.target.value)} />
          <datalist id="mt-techs">{technicians.map((t) => <option key={t.vendor_id} value={t.name} />)}</datalist>
        </F>
        <F label="Started"><input className="fld" type="datetime-local" value={d.started_at} onChange={(e) => set('started_at', e.target.value)} /></F>
        <F label="Ended" hint="Leave empty for a timer that is still running."><input className="fld" type="datetime-local" value={d.ended_at} onChange={(e) => set('ended_at', e.target.value)} /></F>
        <F label="Kind">
          <select className="fld" value={d.kind} onChange={(e) => set('kind', e.target.value as TimeKind)}>{TIME_KINDS.map((k) => <option key={k} value={k}>{TIME_KIND_LABELS[k]}</option>)}</select>
        </F>
        <F label="Hourly rate"><input className="fld" type="number" min="0" step="0.01" placeholder="e.g. 85" value={d.hourly_rate} onChange={(e) => set('hourly_rate', e.target.value)} /></F>
        <F label="Note" wide><input className="fld" value={d.note} onChange={(e) => set('note', e.target.value)} /></F>
        <label className="tmap-check pf-field"><input type="checkbox" checked={d.billable} onChange={(e) => set('billable', e.target.checked)} /><span>Billable</span></label>
      </div>
    </Sheet>
  );
}

/** Ticks once a minute so running timers count up without a refetch. */
function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}
export const liveMinutes = (e: TimeEntry, now: number) => (e.ended_at ? e.minutes : Math.max(e.minutes, Math.round((now - Date.parse(e.started_at)) / 60_000)));

export function TimeCard({ woId }: { woId: string }) {
  const q = useWoMaintenance(woId);
  const m = q.data;
  const [dialog, setDialog] = useState<TimeEntry | 'new' | null>(null);
  const [tech, setTech] = useState('');
  const [error, setError] = useState<string | null>(null);
  const opts = (fallback: string) => ({ onError: (e: unknown) => setError(errText(e, fallback)), onSuccess: () => setError(null) });
  const start = useMaintWrite(woId, (name: string) => addTimeEntry(woId, { tech_name: name, vendor_id: m?.technicians.find((t) => t.name === name)?.vendor_id ?? null }), () => setTech(''));
  const stop = useMaintWrite(woId, (id: string) => updateTimeEntry(woId, id, { stop: true }));
  const remove = useMaintWrite(woId, (id: string) => deleteTimeEntry(woId, id));
  const now = useMinuteTick(Boolean(m?.time.some((t) => !t.ended_at)));
  if (!m || !m.can.time_view) return null;
  const total = m.time.reduce((n, e) => n + liveMinutes(e, now), 0);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Technician time</h2>
        {m.time.length > 0 && <span className="card-meta">{formatMinutes(total)}{m.time_total.amount > 0 ? ` · ${usd(m.time_total.amount)}` : ''}</span>}
        {m.can.time_create && <button type="button" className="btn btn-sm is-ghost" onClick={() => setDialog('new')}><Icon name="plus" size={12} /> Log time</button>}
      </div>
      {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
      {m.time.length === 0 ? (
        <div className="empty-flat">No time logged. Start a timer when a technician begins, or log the hours afterwards.</div>
      ) : (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th>Technician</th><th>Kind</th><th>Started</th><th>Ended</th><th className="num">Time</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {m.time.map((e) => (
                <tr key={e.id}>
                  <td>{e.tech_name}{e.note && <small className="mt-sub">{e.note}</small>}</td>
                  <td>{TIME_KIND_LABELS[e.kind]}{!e.billable && <small className="mt-sub">not billable</small>}</td>
                  <td>{stampText(e.started_at)}</td>
                  <td>{e.ended_at ? stampText(e.ended_at) : <span className="chip chip-sm chip-ok">Running</span>}</td>
                  <td className="num">{formatMinutes(liveMinutes(e, now))}</td>
                  <td className="num">{e.amount === null ? '—' : usd(e.amount)}</td>
                  <td className="mt-acts">
                    {!e.ended_at && m.can.time_edit && <button type="button" className="btn btn-sm" disabled={stop.isPending} onClick={() => stop.mutate(e.id, opts('Could not stop the timer.'))}>Stop</button>}
                    {m.can.time_edit && <button type="button" className="icon-btn" aria-label="Change this entry" onClick={() => setDialog(e)}><Icon name="pencil" size={12} /></button>}
                    {m.can.time_delete && <button type="button" className="icon-btn" aria-label="Delete this entry" disabled={remove.isPending} onClick={() => remove.mutate(e.id, opts('Could not delete it.'))}><Icon name="trash" size={12} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {m.can.time_create && (
        <form className="rec-add mt-add" onSubmit={(e) => { e.preventDefault(); if (tech.trim()) start.mutate(tech.trim(), opts('Could not start the timer.')); }}>
          <input className="fld" list="mt-techs-start" placeholder="Technician — start a timer now" value={tech} onChange={(e) => setTech(e.target.value)} aria-label="Technician" />
          <datalist id="mt-techs-start">{m.technicians.map((t) => <option key={t.vendor_id} value={t.name} />)}</datalist>
          <button type="submit" className="btn btn-sm" disabled={!tech.trim() || start.isPending}><Icon name="clock" size={12} /> Start a timer</button>
        </form>
      )}
      {dialog && <TimeEntryDialog woId={woId} entry={dialog === 'new' ? null : dialog} technicians={m.technicians} onClose={() => setDialog(null)} />}
    </section>
  );
}

// ═══ Work permits (Related tab) ══════════════════════════════════════════════

export function PermitDialog({ woId, permit, canEdit, canApprove, canCreate, onClose }: {
  woId: string;
  permit: WorkPermit | null;
  canEdit: boolean;
  canApprove: boolean;
  canCreate: boolean;
  onClose: () => void;
}) {
  const locked = permit ? permit.status === 'requested' || permit.status === 'approved' : false;
  const closed = permit?.status === 'closed';
  const editable = permit ? canEdit && !closed : canCreate;
  const [d, setD] = useState({
    permit_type: permit?.permit_type ?? PERMIT_TYPES[0] as string,
    holder: permit?.holder ?? '',
    valid_from: permit?.valid_from ?? '',
    valid_to: permit?.valid_to ?? '',
    hazards: permit?.hazards ?? '',
  });
  const [precautions, setPrecautions] = useState<PermitPrecaution[]>(permit?.precautions ?? (PERMIT_PRECAUTIONS[PERMIT_TYPES[0]] ?? []).map((text) => ({ text, done: false })));
  const [extra, setExtra] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const fail = (fallback: string) => ({ onError: (e: unknown) => setProblem(errText(e, fallback)) });
  const input = () => ({
    ...(locked ? {} : { permit_type: d.permit_type, holder: d.holder.trim() || null, valid_from: d.valid_from || null, valid_to: d.valid_to || null, hazards: d.hazards.trim() || null }),
    precautions,
  });
  const save = useMaintWrite(woId, () => (permit ? updatePermit(woId, permit.id, input()) : createPermit(woId, input())), onClose);
  const act = useMaintWrite(woId, async (action: PermitAction) => {
    // Save what is on screen first, so the request carries the latest text.
    if (permit && editable && (action === 'request')) await updatePermit(woId, permit.id, input());
    return actOnPermit(woId, permit!.id, action, note.trim() || null);
  }, onClose);
  const setType = (t: string) => {
    setD((cur) => ({ ...cur, permit_type: t }));
    // A new permit follows the type's starting list until somebody ticks one.
    if (!permit && !precautions.some((p) => p.done)) setPrecautions((PERMIT_PRECAUTIONS[t] ?? []).map((text) => ({ text, done: false })));
  };
  const requestProblem = permitRequestProblem({ permit_type: d.permit_type, holder: d.holder, valid_from: d.valid_from || null, valid_to: d.valid_to || null });
  const busy = save.isPending || act.isPending;

  return (
    <Sheet
      title={permit ? <>{permit.permit_number} <PermitChip state={permit.state} /></> : 'Write a work permit'}
      icon="lock"
      onClose={onClose}
      problem={problem}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        {permit && permit.status === 'requested' && canApprove && (
          <>
            <button type="button" className="btn is-danger" disabled={busy} onClick={() => (note.trim() ? act.mutate('reject', fail('Could not reject the permit.')) : setProblem('Say why the permit is rejected, in the note.'))}>Reject</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act.mutate('approve', fail('Could not approve the permit.'))}>Approve</button>
          </>
        )}
        {permit && permit.status === 'approved' && canEdit && <button type="button" className="btn" disabled={busy} onClick={() => act.mutate('close', fail('Could not close the permit.'))}>Close the permit</button>}
        {permit && permit.status === 'rejected' && canEdit && <button type="button" className="btn" disabled={busy} onClick={() => act.mutate('reopen', fail('Could not reopen the permit.'))}>Back to draft</button>}
        {editable && <button type="button" className={`btn${permit && permit.status === 'draft' ? '' : ' btn-primary'}`} disabled={busy} onClick={() => save.mutate(undefined, fail('Could not save the permit.'))}>{save.isPending ? 'Saving…' : permit ? 'Save' : 'Save as draft'}</button>}
        {permit && permit.status === 'draft' && canCreate && (
          <button type="button" className="btn btn-primary" disabled={busy || requestProblem !== null} title={requestProblem ?? undefined} onClick={() => act.mutate('request', fail('Could not send the permit.'))}>Send for approval</button>
        )}
      </>}>
      {permit?.status === 'rejected' && permit.decision_note && <p className="mt-banner is-danger"><Icon name="alert-circle" size={14} />Rejected by {permit.decided_by?.name ?? 'a manager'}: {permit.decision_note}</p>}
      {permit?.status === 'approved' && <p className="mt-banner"><Icon name="check-circle" size={14} />Approved by {permit.decided_by?.name ?? 'a manager'} on {stampText(permit.decided_at)}. Only the precautions can be ticked now.</p>}
      <div className="pf-form">
        <F label="Kind of permit">
          <select className="fld" value={d.permit_type} disabled={!editable || locked} onChange={(e) => setType(e.target.value)}>
            {!(PERMIT_TYPES as readonly string[]).includes(d.permit_type) && <option value={d.permit_type}>{d.permit_type}</option>}
            {PERMIT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </F>
        <F label="Permit holder" hint="The technician or company doing the work.">
          <input className="fld" value={d.holder} disabled={!editable || locked} onChange={(e) => setD((c) => ({ ...c, holder: e.target.value }))} />
        </F>
        <F label="First day"><input className="fld" type="date" value={d.valid_from} disabled={!editable || locked} onChange={(e) => setD((c) => ({ ...c, valid_from: e.target.value }))} /></F>
        <F label="Last day"><input className="fld" type="date" value={d.valid_to} disabled={!editable || locked} onChange={(e) => setD((c) => ({ ...c, valid_to: e.target.value }))} /></F>
        <F label="Hazards" wide><textarea className="fld" rows={2} value={d.hazards} disabled={!editable || locked} onChange={(e) => setD((c) => ({ ...c, hazards: e.target.value }))} /></F>
        <div className="pf-field is-wide">
          <span className="lbl">Precautions</span>
          <ul className="mt-precautions">
            {precautions.map((p, i) => (
              <li key={`${p.text}-${i}`}>
                <label className="tmap-check"><input type="checkbox" checked={p.done} disabled={!editable} onChange={(e) => setPrecautions((cur) => cur.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))} /><span>{p.text}</span></label>
                {editable && !locked && <button type="button" className="icon-btn" aria-label={`Remove “${p.text}”`} onClick={() => setPrecautions((cur) => cur.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>}
              </li>
            ))}
          </ul>
          {editable && !locked && (
            <div className="mt-inline">
              <input className="fld" placeholder="Add a precaution" value={extra} onChange={(e) => setExtra(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && extra.trim()) { e.preventDefault(); setPrecautions((cur) => [...cur, { text: extra.trim(), done: false }]); setExtra(''); } }} />
              <button type="button" className="btn btn-sm" disabled={!extra.trim()} onClick={() => { setPrecautions((cur) => [...cur, { text: extra.trim(), done: false }]); setExtra(''); }}>Add</button>
            </div>
          )}
        </div>
        {permit && permit.status === 'requested' && canApprove && (
          <F label="Note to the requester" wide hint="Needed to reject."><input className="fld" value={note} onChange={(e) => setNote(e.target.value)} /></F>
        )}
      </div>
      {permit && permit.status === 'draft' && requestProblem && <p className="hint mt-hint">{requestProblem}</p>}
    </Sheet>
  );
}

export function PermitsCard({ woId }: { woId: string }) {
  const q = useWoMaintenance(woId);
  const m = q.data;
  const [dialog, setDialog] = useState<WorkPermit | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = useMaintWrite(woId, (id: string) => deletePermit(woId, id));
  if (!m || !m.can.permits_view) return null;
  const covered = m.permits.some((p) => p.state === 'active' || p.state === 'approved');
  // The dialog shows the latest copy of the permit it was opened on.
  const open = dialog && dialog !== 'new' ? (m.permits.find((p) => p.id === dialog.id) ?? dialog) : dialog;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Work permits</h2>
        {m.permit_needed && !covered && <span className="chip chip-sm chip-warn">A permit is needed</span>}
        {m.can.permits_create && <button type="button" className="btn btn-sm is-ghost" onClick={() => setDialog('new')}><Icon name="plus" size={12} /> Write a permit</button>}
      </div>
      {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
      {m.permits.length === 0 ? (
        <div className="empty-flat">{m.permit_needed ? 'This work order is marked as needing a work permit, and none is written yet.' : 'No work permits on this work order.'}</div>
      ) : (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th>Permit</th><th>Kind</th><th>Holder</th><th>Valid</th><th>Status</th><th /></tr></thead>
            <tbody>
              {m.permits.map((p) => (
                <tr key={p.id}>
                  <td><button type="button" className="link-btn mono" onClick={() => setDialog(p)}>{p.permit_number}</button></td>
                  <td>{p.permit_type}</td>
                  <td>{p.holder ?? '—'}</td>
                  <td>{p.valid_from ? `${dayText(p.valid_from)} → ${dayText(p.valid_to)}` : '—'}</td>
                  <td><PermitChip state={p.state} /></td>
                  <td className="mt-acts">
                    {(p.status === 'draft' || p.status === 'rejected') && m.can.permits_edit && (
                      <button type="button" className="icon-btn" aria-label={`Delete ${p.permit_number}`} disabled={remove.isPending}
                        onClick={() => remove.mutate(p.id, { onError: (e) => setError(errText(e, 'Could not delete the permit.')), onSuccess: () => setError(null) })}><Icon name="trash" size={12} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <PermitDialog woId={woId} permit={open === 'new' ? null : open} canEdit={m.can.permits_edit} canApprove={m.can.permits_approve} canCreate={m.can.permits_create} onClose={() => setDialog(null)} />}
    </section>
  );
}
