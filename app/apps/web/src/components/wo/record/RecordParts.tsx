/* 0064 · The work-order record: what sits around the tabs.
 *
 *   useWoRecord     one read (GET …/record) shared by everything below, keyed
 *                   by the work order's id; every write answers with the whole
 *                   record and replaces it.
 *   RecordBar       under the header: what state the job is in (paused,
 *                   cancelled, an ETA, service completed, its tags, a site
 *                   event running) and the things a person can do to it.
 *   RecordRail      the right rail: Responsibility · Location · Time · Cost.
 *   VisitLocation   on a visit: where the check-in happened, against the
 *                   site's boundary.
 *
 * A pause stops no clock — it is a marker (rule 2.4.4). The bar says so. */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GEOFENCE_RESULT_LABELS,
  SITE_EVENT_KIND_LABELS,
  formatFeet,
  formatMinutes,
  minutesBetween,
} from '@theone/shared';
import type { WoRecord } from '@theone/shared';
import {
  ApiRequestError,
  addWoTag,
  cancelWo,
  clearWoCompletion,
  completeWoService,
  getWoPlace,
  getWoRecord,
  listVendors,
  locateVisit,
  pauseWo,
  removeWoTag,
  reopenWo,
  requestNteIncrease,
  resumeWo,
  setWoEta,
  setWoVendor,
} from '../../../api/client';
import { feedTime } from '../../../lib/fields';
import { useEscape } from '../../../lib/useEscape';
import { Icon } from '../../Icon';

export const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : fallback);
export const usd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const dayTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const dayOnly = (v: string | null | undefined) => {
  if (!v) return '—';
  const d = new Date(v.length === 10 ? `${v}T12:00:00` : v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const recordKey = (woId: string) => ['wo-record', woId];

export function useWoRecord(woId: string | undefined) {
  return useQuery({ queryKey: recordKey(woId ?? ''), queryFn: () => getWoRecord(woId!), enabled: Boolean(woId), retry: 0 });
}

/** A write on the record: the answer replaces the cached record, and whatever
    else shows the same facts (the work order itself, its audit trail) reloads. */
export function useRecordWrite<T>(woId: string, woNumber: string, fn: (arg: T) => Promise<WoRecord>, onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (res) => {
      qc.setQueryData(recordKey(woId), res);
      void qc.invalidateQueries({ queryKey: ['wo-activity', woId] });
      void qc.invalidateQueries({ queryKey: ['work-orders', 'detail', woNumber] });
      void qc.invalidateQueries({ queryKey: ['wo-feed', woId] });
      onDone?.();
    },
  });
}

// ═══ The bar under the header ════════════════════════════════════════════════

type Dialog = 'vendor' | 'pause' | 'eta' | 'cancel' | 'complete' | 'nte' | 'tag' | null;

export function RecordBar({ woId, woNumber, record }: { woId: string; woNumber: string; record: WoRecord | undefined }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => setDialog(null);
  const fail = (fallback: string) => (e: unknown) => setError(errText(e, fallback));
  const resume = useRecordWrite(woId, woNumber, () => resumeWo(woId));
  const reopen = useRecordWrite(woId, woNumber, () => reopenWo(woId));
  const dropTag = useRecordWrite(woId, woNumber, (id: string) => removeWoTag(woId, id));
  if (!record) return null;
  const s = record.state;
  const edit = record.can.edit;
  const openNte = record.nte_requests.find((n) => n.status === 'open');

  return (
    <div className="rec-bar">
      <div className="rec-chips">
        {s.cancelled && (
          <span className="chip chip-danger" title={s.cancelled.reason ?? undefined}>
            <Icon name="x" size={12} /> Cancelled{s.cancelled.reason ? ` — ${s.cancelled.reason}` : ''}
          </span>
        )}
        {s.paused && (
          <span className="chip chip-warn" title="A pause is a marker: no clock or SLA stops for it">
            <Icon name="clock" size={12} /> Paused {feedTime(s.paused.at)}{s.paused.reason ? ` — ${s.paused.reason}` : ''}
          </span>
        )}
        {s.eta && (
          <span className="chip chip-accent" title={s.eta.note ?? undefined}>
            <Icon name="truck" size={12} /> ETA {dayTime(s.eta.eta_at)}
          </span>
        )}
        {s.completion && (
          <span className="chip chip-accent" title={s.completion.note ?? undefined}>
            <Icon name="check-circle" size={12} /> Service completed{s.completion.temporary_fix ? ' · temporary fix' : ''}
          </span>
        )}
        {record.can.see_vendors && record.responsibility.vendor && (
          <Link className="chip" to={`/vendors/${record.responsibility.vendor.id}`}>
            <Icon name="briefcase" size={12} /> {record.responsibility.vendor.name}
          </Link>
        )}
        {openNte && <span className="chip chip-warn">NTE increase to {usd(openNte.requested_nte)} waiting</span>}
        {record.site_events.map((e) => (
          <span key={e.id} className="chip chip-warn" title={e.detail ?? undefined}>
            <Icon name="alert" size={12} /> {SITE_EVENT_KIND_LABELS[e.kind]}: {e.title}
          </span>
        ))}
        {record.tags.map((t) => (
          <span key={t.id} className="chip rec-tag" title={t.reason ?? undefined}>
            <Icon name="tag" size={12} /> {t.tag}
            {edit && (
              <button type="button" aria-label={`Remove the tag ${t.tag}`} disabled={dropTag.isPending} onClick={() => dropTag.mutate(t.id)}>
                <Icon name="x" size={12} />
              </button>
            )}
          </span>
        ))}
      </div>
      {edit && (
        <div className="rec-actions">
          {record.can.see_vendors && (
            <button type="button" className="btn btn-sm is-ghost" onClick={() => setDialog('vendor')}>
              <Icon name="briefcase" size={12} /> {record.responsibility.vendor ? 'Re-assign vendor' : 'Assign vendor'}
            </button>
          )}
          {!s.cancelled && (s.paused ? (
            <button type="button" className="btn btn-sm" disabled={resume.isPending} onClick={() => resume.mutate(undefined, { onError: fail('Could not resume.') })}>Resume</button>
          ) : (
            <button type="button" className="btn btn-sm is-ghost" onClick={() => setDialog('pause')}><Icon name="clock" size={12} /> Pause</button>
          ))}
          <button type="button" className="btn btn-sm is-ghost" onClick={() => setDialog('eta')}><Icon name="truck" size={12} /> {s.eta ? 'Change ETA' : 'Add ETA'}</button>
          <button type="button" className="btn btn-sm is-ghost" onClick={() => setDialog('tag')}><Icon name="tag" size={12} /> Tag</button>
          {record.can.see_money && !openNte && (
            <button type="button" className="btn btn-sm is-ghost" onClick={() => setDialog('nte')}><Icon name="dollar" size={12} /> Increase NTE</button>
          )}
          {!s.cancelled && (
            <button type="button" className="btn btn-sm is-ghost" onClick={() => setDialog('complete')}>
              <Icon name="check-circle" size={12} /> {s.completion ? 'Edit completion' : 'Complete service'}
            </button>
          )}
          {s.cancelled ? (
            <button type="button" className="btn btn-sm" disabled={reopen.isPending} onClick={() => reopen.mutate(undefined, { onError: fail('Could not reopen.') })}>Reopen</button>
          ) : (
            <button type="button" className="btn btn-sm is-danger" onClick={() => setDialog('cancel')}>Cancel work order</button>
          )}
        </div>
      )}
      {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}

      {dialog === 'vendor' && <VendorDialog woId={woId} woNumber={woNumber} record={record} onClose={close} />}
      {dialog === 'pause' && (
        <ReasonDialog title="Pause this work order" icon="clock" label="Why is it paused?" confirm="Pause" hint="A pause is a marker everyone sees. It does not stop the Pulse clocks or the SLA."
          woId={woId} woNumber={woNumber} run={(reason) => pauseWo(woId, reason)} onClose={close} />
      )}
      {dialog === 'cancel' && (
        <ReasonDialog title="Cancel this work order" icon="x" label="Why is it cancelled?" confirm="Cancel the work order" danger
          hint="It stays on file with its history, marked cancelled. If your workflow has a Cancelled status it is moved there. It can be reopened."
          woId={woId} woNumber={woNumber} run={(reason) => cancelWo(woId, reason)} onClose={close} />
      )}
      {dialog === 'eta' && <EtaDialog woId={woId} woNumber={woNumber} record={record} onClose={close} />}
      {dialog === 'tag' && <TagDialog woId={woId} woNumber={woNumber} record={record} onClose={close} />}
      {dialog === 'nte' && <NteDialog woId={woId} woNumber={woNumber} record={record} onClose={close} />}
      {dialog === 'complete' && <CompleteDialog woId={woId} woNumber={woNumber} record={record} onClose={close} />}
    </div>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

function Sheet({ title, icon, children, onClose, wide }: { title: string; icon: 'clock' | 'x' | 'truck' | 'tag' | 'dollar' | 'check-circle' | 'briefcase'; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`sheet vend-sheet${wide ? ' is-wide' : ''}`}>
        <h2 className="sheet-t"><Icon name={icon} size={16} />{title}</h2>
        {children}
      </div>
    </div>
  );
}

interface DialogProps { woId: string; woNumber: string; record: WoRecord; onClose: () => void }

function ReasonDialog({ title, icon, label, confirm, hint, danger, woId, woNumber, run, onClose }: {
  title: string; icon: 'clock' | 'x'; label: string; confirm: string; hint: string; danger?: boolean;
  woId: string; woNumber: string; run: (reason: string) => Promise<WoRecord>; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const go = useRecordWrite(woId, woNumber, () => run(reason.trim()), onClose);
  return (
    <Sheet title={title} icon={icon} onClose={onClose}>
      <p className="sheet-b">{hint}</p>
      <div className="vend-form">
        <label className="field"><span className="lbl">{label}</span>
          <textarea className="fld" rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      {go.isError && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{errText(go.error, 'Could not save.')}</p>}
      <div className="sheet-f">
        <button type="button" className="btn" onClick={onClose}>Back</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={reason.trim() === '' || go.isPending} onClick={() => go.mutate(undefined)}>{confirm}</button>
      </div>
    </Sheet>
  );
}

/** A datetime-local value for an ISO stamp, in the browser's own zone. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function EtaDialog({ woId, woNumber, record, onClose }: DialogProps) {
  const [at, setAt] = useState(toLocalInput(record.state.eta?.eta_at ?? null));
  const [note, setNote] = useState(record.state.eta?.note ?? '');
  const save = useRecordWrite(woId, woNumber, (clear: boolean) => setWoEta(woId, clear || !at ? null : new Date(at).toISOString(), note.trim() || null), onClose);
  return (
    <Sheet title="Estimated time of arrival" icon="truck" onClose={onClose}>
      <p className="sheet-b">When the technician is expected on site. Shown on the work order until it is changed or cleared.</p>
      <div className="vend-form">
        <label className="field"><span className="lbl">Expected on site</span>
          <input className="fld" type="datetime-local" autoFocus value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        <label className="field"><span className="lbl">Note (optional)</span>
          <input className="fld" value={note} placeholder="e.g. Leaving Houston at 2" onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {save.isError && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{errText(save.error, 'Could not save the ETA.')}</p>}
      <div className="sheet-f">
        <button type="button" className="btn" onClick={onClose}>Back</button>
        {record.state.eta && <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate(true)}>Clear the ETA</button>}
        <button type="button" className="btn btn-primary" disabled={!at || save.isPending} onClick={() => save.mutate(false)}>Save ETA</button>
      </div>
    </Sheet>
  );
}

function TagDialog({ woId, woNumber, record, onClose }: DialogProps) {
  const [tag, setTag] = useState('');
  const [reason, setReason] = useState('');
  const add = useRecordWrite(woId, woNumber, () => addWoTag(woId, tag.trim(), reason.trim() || null), onClose);
  const have = new Set(record.tags.map((t) => t.tag.toLowerCase()));
  const offer = record.tag_suggestions.filter((t) => !have.has(t.toLowerCase())).slice(0, 12);
  return (
    <Sheet title="Tag this work order" icon="tag" onClose={onClose}>
      <p className="sheet-b">A short label — “Recall”, “Warranty claim”, “Client escalation” — and why it applies.</p>
      <div className="vend-form">
        <label className="field"><span className="lbl">Tag</span>
          <input className="fld" autoFocus value={tag} maxLength={40} onChange={(e) => setTag(e.target.value)} />
        </label>
        {offer.length > 0 && (
          <div className="rec-suggest">
            {offer.map((t) => <button type="button" key={t} className="chip chip-sm" onClick={() => setTag(t)}>{t}</button>)}
          </div>
        )}
        <label className="field"><span className="lbl">Reason</span>
          <input className="fld" value={reason} maxLength={300} placeholder="Why this tag applies" onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      {add.isError && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{errText(add.error, 'Could not add the tag.')}</p>}
      <div className="sheet-f">
        <button type="button" className="btn" onClick={onClose}>Back</button>
        <button type="button" className="btn btn-primary" disabled={tag.trim() === '' || add.isPending} onClick={() => add.mutate(undefined)}>Add the tag</button>
      </div>
    </Sheet>
  );
}

function NteDialog({ woId, woNumber, record, onClose }: DialogProps) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const n = Number(amount.replace(/[^0-9.]/g, ''));
  const ask = useRecordWrite(woId, woNumber, () => requestNteIncrease(woId, n, reason.trim()), onClose);
  const current = record.cost.nte;
  return (
    <Sheet title="Ask for a higher NTE" icon="dollar" onClose={onClose}>
      <p className="sheet-b">
        The NTE is {current === null ? 'not set' : usd(current)}. A manager decides; approving writes the new NTE on the work order.
      </p>
      <div className="vend-form">
        <label className="field"><span className="lbl">New NTE</span>
          <input className="fld mono" inputMode="decimal" autoFocus value={amount} placeholder="e.g. 4500" onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field"><span className="lbl">Why more is needed</span>
          <textarea className="fld" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      {ask.isError && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{errText(ask.error, 'Could not send the request.')}</p>}
      <div className="sheet-f">
        <button type="button" className="btn" onClick={onClose}>Back</button>
        <button type="button" className="btn btn-primary" disabled={!(n > 0) || reason.trim() === '' || ask.isPending} onClick={() => ask.mutate(undefined)}>Send the request</button>
      </div>
    </Sheet>
  );
}

function CompleteDialog({ woId, woNumber, record, onClose }: DialogProps) {
  const c = record.state.completion;
  const [note, setNote] = useState(c?.note ?? '');
  const [fault, setFault] = useState(c?.fault_code ?? '');
  const [action, setAction] = useState(c?.action_code ?? '');
  const [temp, setTemp] = useState<'' | 'yes' | 'no'>(c?.temporary_fix === true ? 'yes' : c?.temporary_fix === false ? 'no' : '');
  const save = useRecordWrite(woId, woNumber, () => completeWoService(woId, { note: note.trim() || null, fault_code: fault || null, action_code: action || null, temporary_fix: temp === '' ? null : temp === 'yes' }), onClose);
  const clear = useRecordWrite(woId, woNumber, () => clearWoCompletion(woId), onClose);
  const codes = (list: WoRecord['codes']['fault'], cur: string) => list.filter((x) => x.is_active || x.code === cur);
  return (
    <Sheet title="Complete service" icon="check-circle" onClose={onClose} wide>
      <p className="sheet-b">What was found and what was done. This records the service; the status is still moved from the status button.</p>
      <div className="vend-form">
        <label className="field"><span className="lbl">Completion note</span>
          <textarea className="fld" rows={4} autoFocus value={note} placeholder="What the technician found and did" onChange={(e) => setNote(e.target.value)} />
        </label>
        <label className="field"><span className="lbl">Fault code — what was wrong</span>
          <select className="fld" value={fault} onChange={(e) => setFault(e.target.value)}>
            <option value="">—</option>
            {codes(record.codes.fault, fault).map((x) => <option key={x.id} value={x.code}>{x.code} · {x.label}</option>)}
          </select>
        </label>
        <label className="field"><span className="lbl">Action code — what was done</span>
          <select className="fld" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">—</option>
            {codes(record.codes.action, action).map((x) => <option key={x.id} value={x.code}>{x.code} · {x.label}</option>)}
          </select>
        </label>
        <div className="field">
          <span className="lbl">Is this a temporary fix?</span>
          <div className="seg" role="group" aria-label="Temporary fix">
            {([['no', 'No — it is fixed'], ['yes', 'Yes — a return is needed'], ['', 'Not said']] as const).map(([v, label]) => (
              <button key={v || 'unset'} type="button" className={`seg-btn${temp === v ? ' is-on' : ''}`} aria-pressed={temp === v} onClick={() => setTemp(v)}>{label}</button>
            ))}
          </div>
        </div>
      </div>
      {(save.isError || clear.isError) && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{errText(save.error ?? clear.error, 'Could not save.')}</p>}
      <div className="sheet-f">
        <button type="button" className="btn" onClick={onClose}>Back</button>
        {c && <button type="button" className="btn" disabled={clear.isPending} onClick={() => clear.mutate(undefined)}>Clear the completion</button>}
        <button type="button" className="btn btn-primary" disabled={(note.trim() === '' && !fault && !action) || save.isPending} onClick={() => save.mutate(undefined)}>
          {c ? 'Save' : 'Complete service'}
        </button>
      </div>
    </Sheet>
  );
}

function VendorDialog({ woId, woNumber, record, onClose }: DialogProps) {
  const [text, setText] = useState('');
  const term = text.trim();
  const hits = useQuery({ queryKey: ['vendor-pick', term], queryFn: () => listVendors({ search: term, page_size: 10 }), enabled: term.length >= 2 });
  const assign = useRecordWrite(woId, woNumber, (id: string | null) => setWoVendor(woId, id), onClose);
  const cur = record.responsibility.vendor;
  return (
    <Sheet title="Responsible vendor" icon="briefcase" onClose={onClose} wide>
      <p className="sheet-b">The one vendor answering for this job. Technicians hired onto it stay listed under People.</p>
      {cur && (
        <p className="rec-current">
          Now: <b>{cur.name}</b>{cur.primary_trade ? ` · ${cur.primary_trade}` : ''}
          <button type="button" className="link-btn" disabled={assign.isPending} onClick={() => assign.mutate(null)}>Remove</button>
        </p>
      )}
      {record.responsibility.technicians.length > 0 && (
        <div className="rec-suggest">
          <span className="pf-muted">Hired on this work order:</span>
          {record.responsibility.technicians.filter((t) => t.id !== cur?.id).map((t) => (
            <button type="button" key={t.id} className="chip chip-sm" disabled={assign.isPending} onClick={() => assign.mutate(t.id)}>{t.name}</button>
          ))}
        </div>
      )}
      <div className="vend-form">
        <label className="field"><span className="lbl">Find a vendor</span>
          <input className="fld" autoFocus value={text} placeholder="Search by name, email or phone" onChange={(e) => setText(e.target.value)} />
        </label>
      </div>
      {term.length >= 2 && (
        <div className="pf-pick-list">
          {hits.isLoading && <span className="pf-muted">Searching…</span>}
          {hits.data && hits.data.items.length === 0 && <span className="pf-muted">No vendor matches.</span>}
          {(hits.data?.items ?? []).map((v) => (
            <button type="button" key={v.id} disabled={assign.isPending || v.blacklisted} onClick={() => assign.mutate(v.id)}>
              <b>{v.name}{v.blacklisted ? ' — blacklisted' : ''}</b>
              <span>{[v.primary_trade, [v.city, v.state].filter(Boolean).join(', '), v.phone].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
        </div>
      )}
      {assign.isError && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{errText(assign.error, 'Could not assign the vendor.')}</p>}
      <div className="sheet-f">
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
    </Sheet>
  );
}

// ═══ The right rail ══════════════════════════════════════════════════════════

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rec-row">
      <span className="lbl">{label}</span>
      <span className="rec-val">{children}</span>
    </div>
  );
}

/** Ticks once a minute so the running figures stay honest. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export function RecordRail({ woId, record, loading }: { woId: string; record: WoRecord | undefined; loading: boolean }) {
  const now = useMinute();
  const place = useQuery({ queryKey: ['wo-place', woId], queryFn: () => getWoPlace(woId), retry: 0 });
  if (!record) return <aside className="rail rec-rail"><section className="card"><div className="empty-flat">{loading ? 'Loading…' : 'Could not load the record.'}</div></section></aside>;
  const r = record.responsibility;
  const t = record.time;
  const c = record.cost;
  const nowIso = new Date(now).toISOString();
  const live = (from: string | null) => formatMinutes(minutesBetween(from, nowIso));
  const site = place.data?.site ?? null;
  const asset = place.data?.asset ?? null;

  return (
    <aside className="rail rec-rail">
      <section className="card">
        <div className="card-head"><h2 className="card-title">Responsibility</h2></div>
        <div className="rec-rows">
          <Row label="Vendor">
            {!record.can.see_vendors ? '—' : r.vendor ? (
              <>
                <Link to={`/vendors/${r.vendor.id}`}>{r.vendor.name}</Link>
                <small>{[r.vendor.primary_trade, r.vendor.phone].filter(Boolean).join(' · ')}</small>
              </>
            ) : <span className="pf-muted">Nobody assigned</span>}
          </Row>
          <Row label="Dispatcher">{r.assignee ?? <span className="pf-muted">Unassigned</span>}</Row>
          <Row label="Account manager">{r.am ?? '—'}</Row>
          {record.can.see_vendors && r.technicians.length > 0 && (
            <Row label="Technicians">{r.technicians.map((x) => x.name).join(', ')}</Row>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2 className="card-title">Location</h2></div>
        <div className="rec-rows">
          <Row label="Site">
            {site ? (
              <>
                {place.data?.can.view_sites ? <Link to={`/sites/${site.id}`}>{site.name ?? site.client ?? 'Site'}</Link> : (site.name ?? site.client)}
                <small>{[site.address1, [site.city, site.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</small>
              </>
            ) : <span className="pf-muted">No site record linked</span>}
          </Row>
          <Row label="Asset">
            {asset ? (
              <>
                {place.data?.can.view_assets ? <Link to={`/assets/${asset.id}`}>{asset.name}</Link> : asset.name}
                <small>{[asset.asset_type ?? asset.category, asset.location].filter(Boolean).join(' · ')}</small>
              </>
            ) : <span className="pf-muted">—</span>}
          </Row>
          {site?.access_notes && <Row label="Getting in">{site.access_notes}</Row>}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">Time</h2>
          {t.on_site_since && <span className="chip chip-accent chip-sm">On site · {live(t.on_site_since)}</span>}
        </div>
        <div className="rec-rows">
          <Row label="Open for"><b className="num">{record.state.completion ? formatMinutes(record.timelog.open_minutes) : live(t.date_received ? `${t.date_received}T00:00:00Z` : t.created_at)}</b></Row>
          <Row label="In this status">{live(t.status_since)}</Row>
          <Row label="Received">{dayOnly(t.date_received ?? t.created_at)}</Row>
          <Row label="Scheduled">{t.scheduled ? dayTime(t.scheduled) : '—'}</Row>
          <Row label="Due">{dayOnly(t.due_date)}</Row>
          <Row label="SLA due">{t.sla_due ? dayTime(t.sla_due) : '—'}</Row>
          <Row label="First check-in">{dayTime(t.first_check_in)}</Row>
          <Row label="Last check-out">{dayTime(t.last_check_out)}</Row>
          <Row label="On site">{t.visits === 0 ? 'No visit yet' : `${formatMinutes(t.on_site_minutes)} over ${t.visits} ${t.visits === 1 ? 'visit' : 'visits'}`}</Row>
          {record.state.eta && <Row label="ETA">{dayTime(record.state.eta.eta_at)}</Row>}
          {(t.paused_minutes > 0 || record.state.paused) && (
            <Row label="Paused">{record.state.paused ? `now, for ${live(record.state.paused.at)}` : formatMinutes(t.paused_minutes)}</Row>
          )}
        </div>
      </section>

      {record.can.see_money && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title grow">Cost</h2>
            {c.over_nte && <span className="chip chip-danger chip-sm">Over NTE</span>}
          </div>
          <div className="rec-rows">
            <Row label="Client NTE"><b className="num">{usd(c.nte)}</b></Row>
            <Row label="Quote">{c.quote_total === null ? '—' : <>{usd(c.quote_total)}<small>{(c.quote_status ?? '').replace(/_/g, ' ')}</small></>}</Row>
            <Row label="Invoiced">{usd(c.invoiced)}</Row>
            <Row label="Cost">{usd(c.cost)}</Row>
            <Row label="Paid out">{c.payables_requested === null ? '—' : `${usd(c.payables_paid)} of ${usd(c.payables_requested)}`}</Row>
            <Row label="Profit">
              {c.profit === null ? '—' : <b className={`num${c.profit < 0 ? ' rec-neg' : ''}`}>{usd(c.profit)}{c.margin_pct !== null ? ` · ${c.margin_pct}%` : ''}</b>}
            </Row>
          </div>
        </section>
      )}
    </aside>
  );
}

// ═══ A visit's location, against the geofence ════════════════════════════════

export function VisitLocation({ woId, visitId, canEdit }: { woId: string; visitId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const record = useWoRecord(woId);
  const [typing, setTyping] = useState(false);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (at: { lat: number; lng: number } | null) => locateVisit(woId, visitId, at),
    onSuccess: (res) => { qc.setQueryData(recordKey(woId), res); setTyping(false); setError(null); },
    onError: (e) => setError(errText(e, 'Could not record the location.')),
  });
  const v = record.data?.timelog.visits.find((x) => x.id === visitId);
  if (!record.data || !v) return null;
  const here = () => {
    if (!navigator.geolocation) { setError('This browser cannot report a location. Type the coordinates instead.'); return; }
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => save.mutate({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setError('The location was not shared. Allow it in the browser, or type the coordinates.'),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };
  const tone = v.geofence_result === 'inside' ? ' chip-accent' : v.geofence_result === 'outside' ? ' chip-danger' : '';
  return (
    <div className="rec-geo">
      <Icon name="pin" size={12} />
      {v.geofence_result ? (
        <span className={`chip chip-sm${tone}`}>
          {GEOFENCE_RESULT_LABELS[v.geofence_result]}
          {v.geofence_ft !== null && (v.geofence_result === 'inside' || v.geofence_result === 'outside' || v.geofence_result === 'no_boundary') ? ` · ${formatFeet(v.geofence_ft)} from the pin` : ''}
        </span>
      ) : (
        <span className="pf-muted">Check-in location not recorded</span>
      )}
      {canEdit && !typing && (
        <>
          <button type="button" className="link-btn" disabled={save.isPending} onClick={here} title="Use the location of the device you are on — only meaningful when you are standing at the site">Use this device’s location</button>
          <button type="button" className="link-btn" onClick={() => setTyping(true)}>Type coordinates</button>
          {v.geofence_result && <button type="button" className="link-btn" disabled={save.isPending} onClick={() => save.mutate(null)}>Clear</button>}
        </>
      )}
      {typing && (
        <form className="rec-geo-form" onSubmit={(e) => { e.preventDefault(); const a = Number(lat); const b = Number(lng); if (Number.isFinite(a) && Number.isFinite(b) && lat !== '' && lng !== '') save.mutate({ lat: a, lng: b }); else setError('Give both numbers, e.g. 29.3013 and -94.7977.'); }}>
          <input className="fld mono" placeholder="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} aria-label="Latitude" autoFocus />
          <input className="fld mono" placeholder="Longitude" value={lng} onChange={(e) => setLng(e.target.value)} aria-label="Longitude" />
          <button type="submit" className="btn btn-sm" disabled={save.isPending}>Check</button>
          <button type="button" className="btn btn-sm is-ghost" onClick={() => setTyping(false)}>Cancel</button>
        </form>
      )}
      {error && <span className="rec-geo-err">{error}</span>}
    </div>
  );
}
