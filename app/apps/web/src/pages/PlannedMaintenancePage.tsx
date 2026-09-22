/* /planned-maintenance — the recurring jobs (0051).

   A schedule is one job at one place on a rhythm: every N days / weeks /
   months / years from a start date, until an end date. The app raises a work
   order for each due date a few days ahead (lead days), in the "PM Sched"
   status, numbered <code>-<due date>, and keeps every raise as history so a
   date is never raised twice.

   One page: the list with Active up top, the editor in a dialog, the history
   in another. Raise now and Skip act on the NEXT due date only — the app
   takes care of the rest on its own clock. */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  PM_UNITS,
  PM_UNIT_LABELS,
  frequencyLabel,
  type PmSchedule,
  type PmScheduleInput,
  type PmUnit,
} from '@theone/shared';
import {
  ApiRequestError,
  createPmSchedule,
  deletePmSchedule,
  getPmSchedule,
  listPmSchedules,
  raisePmNext,
  skipPmNext,
  updatePmSchedule,
} from '../api/client';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { useAuth } from '../auth/AuthProvider';

const today = () => new Date().toISOString().slice(0, 10);

/** "in 9 days", "today", "3 days overdue". */
function dueWord(day: string | null): string {
  if (!day) return 'Ended';
  const n = Math.round((Date.parse(day) - Date.parse(today())) / 86_400_000);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n > 1) return `in ${n} days`;
  return n === -1 ? '1 day overdue' : `${-n} days overdue`;
}

const woLink = (n: string) => `/work-orders/${encodeURIComponent(n)}`;

export function PlannedMaintenancePage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canView = can('planned_maintenance', 'view');
  const canCreate = can('planned_maintenance', 'create');
  const canEdit = can('planned_maintenance', 'edit');
  const canDelete = can('planned_maintenance', 'delete');

  const q = useQuery({ queryKey: ['pm-schedules'], queryFn: listPmSchedules, retry: 0, enabled: canView });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const [editing, setEditing] = useState<PmSchedule | 'new' | null>(null);
  const [history, setHistory] = useState<PmSchedule | null>(null);
  const [removing, setRemoving] = useState<PmSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [lane, setLane] = useState<'active' | 'all'>('active');

  const shown = lane === 'active' ? items.filter((s) => s.active && s.next_due_on) : items;

  const done = () => {
    setError(null);
    setEditing(null);
    setRemoving(null);
    void qc.invalidateQueries({ queryKey: ['pm-schedules'] });
    void qc.invalidateQueries({ queryKey: ['work-orders'] });
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : 'That change did not save');
  const remove = useMutation({ mutationFn: (id: string) => deletePmSchedule(id), onSuccess: done, onError: fail });
  const raise = useMutation({
    mutationFn: (id: string) => raisePmNext(id),
    onSuccess: (res) => {
      done();
      setNote(
        res.task_id
          ? `Raised ${res.schedule.last_wo?.wo_number ?? 'the work order'} for ${res.schedule.code}.`
          : 'That date was already raised.',
      );
    },
    onError: fail,
  });
  const skip = useMutation({
    mutationFn: (id: string) => skipPmNext(id),
    onSuccess: (res) => {
      done();
      setNote(`Skipped one date on ${res.schedule.code}; the next is ${res.schedule.next_due_on ?? 'none'}.`);
    },
    onError: fail,
  });

  if (!canView) {
    return (
      <AppShell active="Planned Maintenance">
        <div className="wo-state">
          <Icon name="lock" size={22} />
          <b>Planned maintenance is not available to you</b>
          <span>Ask an admin for the "Planned maintenance" permission.</span>
        </div>
      </AppShell>
    );
  }

  const busy = raise.isPending || skip.isPending || remove.isPending;

  return (
    <AppShell active="Planned Maintenance">
      <div className="page-head">
        <h1 className="page-title">Planned maintenance</h1>
        <p className="page-sub">
          The recurring jobs. Each schedule raises its own work order ahead of every due date, in
          PM Sched, numbered after the schedule — nothing to type on the day.
        </p>
      </div>

      <div className="payq-head">
        <div className="seg payq-lanes" role="group" aria-label="Schedules">
          <button type="button" className={`seg-btn${lane === 'active' ? ' is-on' : ''}`} aria-pressed={lane === 'active'} onClick={() => setLane('active')}>
            Active <span className="payq-count">{items.filter((s) => s.active && s.next_due_on).length}</span>
          </button>
          <button type="button" className={`seg-btn${lane === 'all' ? ' is-on' : ''}`} aria-pressed={lane === 'all'} onClick={() => setLane('all')}>
            All <span className="payq-count">{items.length}</span>
          </button>
        </div>
        {canCreate && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> New schedule
          </button>
        )}
      </div>

      {error && (
        <p className="payq-err" role="alert">
          <Icon name="alert-circle" size={14} /> {error}
        </p>
      )}
      {note && !error && <p className="hint" role="status">{note}</p>}

      <div className="table-wrap">
        <table className="ct">
          <thead>
            <tr>
              <th>Schedule</th>
              <th>Client · Site</th>
              <th>Trade</th>
              <th>Rhythm</th>
              <th className="col-date">Next due</th>
              <th>Last raised</th>
              <th>Dispatcher</th>
              <th className="rcv-action-th">Actions</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && <tr className="ct-empty"><td colSpan={8}>Loading schedules…</td></tr>}
            {q.isError && <tr className="ct-empty"><td colSpan={8}>Could not load planned maintenance.</td></tr>}
            {!q.isLoading && !q.isError && shown.length === 0 && (
              <tr className="ct-empty">
                <td colSpan={8}>
                  {items.length === 0
                    ? 'No schedules yet. Add the first one and its work orders will raise themselves.'
                    : 'Nothing active.'}
                </td>
              </tr>
            )}
            {shown.map((s) => (
              <tr key={s.id} className={s.active && s.next_due_on ? undefined : 'is-muted'}>
                <td>
                  <div className="site">
                    <strong>
                      <button type="button" className="linkbtn" onClick={() => setHistory(s)} title="Every work order this schedule has raised">
                        {s.code}
                      </button>{' '}
                      {s.name}
                    </strong>
                    <small>
                      {s.raised_count} raised
                      {!s.active ? ' · paused' : !s.next_due_on ? ' · ended' : ''}
                    </small>
                  </div>
                </td>
                <td>
                  <div className="site">
                    <strong>{s.client ?? '—'}</strong>
                    <small>
                      {[s.store ? `Store ${s.store}` : null, s.site_name, [s.city, s.state].filter(Boolean).join(', ') || null]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </small>
                  </div>
                </td>
                <td>{s.trade ?? '—'}</td>
                <td>
                  <div className="site">
                    <strong>{frequencyLabel(s.every, s.unit)}</strong>
                    <small>from {s.starts_on}{s.ends_on ? ` to ${s.ends_on}` : ''} · {s.lead_days}d ahead</small>
                  </div>
                </td>
                <td className="col-date">
                  <div className="site">
                    <strong>{s.next_due_on ?? '—'}</strong>
                    <small>{s.active ? dueWord(s.next_due_on) : 'paused'}</small>
                  </div>
                </td>
                <td>
                  {s.last_wo ? (
                    <div className="site">
                      <Link to={woLink(s.last_wo.wo_number)}><strong>{s.last_wo.wo_number}</strong></Link>
                      <small>due {s.last_wo.due_on}</small>
                    </div>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{s.assignee ?? '—'}</td>
                <td className="rcv-action-td">
                  {canEdit && s.active && s.next_due_on && (
                    <button type="button" className="rcv-btn" disabled={busy} onClick={() => raise.mutate(s.id)} title={`Raise ${s.code}-${s.next_due_on} now`}>
                      <Icon name="plus" size={12} /> Raise now
                    </button>
                  )}
                  {canEdit && s.active && s.next_due_on && (
                    <button type="button" className="rcv-btn" disabled={busy} onClick={() => skip.mutate(s.id)} title={`Skip ${s.next_due_on}`}>
                      Skip
                    </button>
                  )}
                  {canEdit && (
                    <button type="button" className="rcv-btn" onClick={() => setEditing(s)}>
                      <Icon name="pencil" size={12} /> Edit
                    </button>
                  )}
                  {canDelete && (
                    <button type="button" className="rcv-btn" onClick={() => setRemoving(s)} title="Delete this schedule">
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <ScheduleDialog
          schedule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={done}
        />
      )}

      {history && <HistoryDialog schedule={history} onClose={() => setHistory(null)} />}

      {removing && (
        <ConfirmDialog
          title={`Delete "${removing.code} · ${removing.name}"?`}
          message="Work orders it already raised stay where they are; no more will be raised."
          note="To stop it for a while instead, edit it and untick Active."
          noteTone="info"
          confirmLabel="Delete schedule"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.id)}
          busy={remove.isPending}
        />
      )}
    </AppShell>
  );
}

function ScheduleDialog({
  schedule,
  onClose,
  onSaved,
}: {
  schedule: PmSchedule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(schedule?.name ?? '');
  const [client, setClient] = useState(schedule?.client ?? '');
  const [entity, setEntity] = useState(schedule?.billing_entity ?? '');
  const [store, setStore] = useState(schedule?.store ?? '');
  const [siteName, setSiteName] = useState(schedule?.site_name ?? '');
  const [address, setAddress] = useState(schedule?.address ?? '');
  const [city, setCity] = useState(schedule?.city ?? '');
  const [state, setState] = useState(schedule?.state ?? '');
  const [trade, setTrade] = useState(schedule?.trade ?? '');
  const [description, setDescription] = useState(schedule?.description ?? '');
  const [nte, setNte] = useState(schedule?.nte === null || schedule?.nte === undefined ? '' : String(schedule.nte));
  const [assignee, setAssignee] = useState(schedule?.assignee ?? '');
  const [every, setEvery] = useState(String(schedule?.every ?? 1));
  const [unit, setUnit] = useState<PmUnit>(schedule?.unit ?? 'month');
  const [startsOn, setStartsOn] = useState(schedule?.starts_on ?? today());
  const [endsOn, setEndsOn] = useState(schedule?.ends_on ?? '');
  const [lead, setLead] = useState(String(schedule?.lead_days ?? 7));
  const [active, setActive] = useState(schedule?.active ?? true);
  const [error, setError] = useState<string | null>(null);

  const input = (): PmScheduleInput => ({
    name: name.trim(),
    client: client.trim() || null,
    billing_entity: entity.trim() || null,
    store: store.trim() || null,
    site_name: siteName.trim() || null,
    address: address.trim() || null,
    city: city.trim() || null,
    state: state.trim() || null,
    trade: trade.trim() || null,
    description: description.trim() || null,
    nte: nte.trim() === '' ? null : Number(nte),
    assignee: assignee.trim() || null,
    every: Number(every),
    unit,
    starts_on: startsOn,
    ends_on: endsOn || null,
    lead_days: Number(lead),
    active,
  });

  const save = useMutation({
    mutationFn: () => (schedule ? updatePmSchedule(schedule.id, input()) : createPmSchedule(input())),
    onSuccess: onSaved,
    onError: (err: unknown) => setError(err instanceof ApiRequestError ? err.message : 'The schedule did not save'),
  });

  const everyN = Number(every);
  const missing =
    name.trim() === ''
      ? 'a name'
      : !Number.isInteger(everyN) || everyN < 1
        ? 'how often'
        : !startsOn
          ? 'a start date'
          : nte.trim() !== '' && !Number.isFinite(Number(nte))
            ? 'a numeric NTE'
            : null;

  const rhythm = Number.isInteger(everyN) && everyN >= 1 ? frequencyLabel(everyN, unit) : '';

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label={schedule ? 'Edit schedule' : 'New schedule'} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{schedule ? `Edit ${schedule.code}` : 'New schedule'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="intake-grid">
            <div className="field intake-wide">
              <label className="lbl" htmlFor="pm-name">What is the job?</label>
              <input id="pm-name" className="fld" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Quarterly HVAC filter change" />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-client">Client</label>
              <input id="pm-client" className="fld" value={client} onChange={(e) => setClient(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-entity">Billing entity</label>
              <input id="pm-entity" className="fld" value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="SFM" />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-store">Store</label>
              <input id="pm-store" className="fld" value={store} onChange={(e) => setStore(e.target.value)} placeholder="1234" />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-site">Site name</label>
              <input id="pm-site" className="fld" value={siteName} onChange={(e) => setSiteName(e.target.value)} />
            </div>
            <div className="field intake-wide">
              <label className="lbl" htmlFor="pm-address">Address</label>
              <input id="pm-address" className="fld" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-city">City</label>
              <input id="pm-city" className="fld" value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-state">State</label>
              <input id="pm-state" className="fld" value={state} onChange={(e) => setState(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-trade">Trade</label>
              <input id="pm-trade" className="fld" value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="HVAC" />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-nte">Client NTE</label>
              <span className="money-in">
                <span className="cur" aria-hidden="true">$</span>
                <input id="pm-nte" className="fld" inputMode="decimal" value={nte} onChange={(e) => setNte(e.target.value)} />
              </span>
            </div>
            <div className="field intake-wide">
              <label className="lbl" htmlFor="pm-desc">Work order description</label>
              <textarea id="pm-desc" className="fld" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-assignee">Dispatcher (display name, blank = unassigned)</label>
              <input id="pm-assignee" className="fld" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-every">How often</label>
              <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span>Every</span>
                <input id="pm-every" className="fld" inputMode="numeric" style={{ width: 70 }} value={every} onChange={(e) => setEvery(e.target.value)} aria-label="Every N" />
                <select className="fld" value={unit} onChange={(e) => setUnit(e.target.value as PmUnit)} aria-label="Period">
                  {PM_UNITS.map((u) => (
                    <option key={u} value={u}>{everyN === 1 ? PM_UNIT_LABELS[u].one : PM_UNIT_LABELS[u].many}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-start">First due on</label>
              <input id="pm-start" className="fld" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-end">Ends (blank = open)</label>
              <input id="pm-end" className="fld" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="pm-lead">Raise the work order this many days ahead</label>
              <input id="pm-lead" className="fld" inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value)} />
            </div>
            <div className="field">
              <label className="ck">
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                <span>Active</span>
              </label>
            </div>
          </div>
          <p className="hint">
            {rhythm ? `${rhythm} from ${startsOn || '…'}. ` : ''}
            Each work order is numbered {schedule?.code ?? 'PM-…'}-&lt;due date&gt; and starts in PM Sched.
            {schedule ? ' Changing the rhythm keeps the dates already raised.' : ''}
          </p>
          {error && <p className="modal-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <span className="card-meta">{missing ? `Still needs ${missing}` : 'Ready'}</span>
          <button type="button" className="btn-sm is-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-sm is-primary" disabled={Boolean(missing) || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : schedule ? 'Save schedule' : 'Create schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryDialog({ schedule, onClose }: { schedule: PmSchedule; onClose: () => void }) {
  const q = useQuery({ queryKey: ['pm-schedule', schedule.id], queryFn: () => getPmSchedule(schedule.id), retry: 0 });
  const rows = q.data?.occurrences ?? [];
  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={`${schedule.code} history`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{schedule.code} · {schedule.name}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="hint">
            {frequencyLabel(schedule.every, schedule.unit)} from {schedule.starts_on}
            {schedule.ends_on ? ` to ${schedule.ends_on}` : ''}. Next due {schedule.next_due_on ?? 'never'}.
          </p>
          <table className="ct">
            <thead>
              <tr>
                <th className="col-date">Due</th>
                <th>Work order</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {q.isLoading && <tr className="ct-empty"><td colSpan={3}>Loading…</td></tr>}
              {!q.isLoading && rows.length === 0 && <tr className="ct-empty"><td colSpan={3}>Nothing raised yet.</td></tr>}
              {rows.map((o) => (
                <tr key={o.id}>
                  <td className="col-date">{o.due_on}</td>
                  <td>
                    {o.wo_number ? <Link to={woLink(o.wo_number)}>{o.wo_number}</Link> : o.status === 'skipped' ? 'Skipped' : '—'}
                  </td>
                  <td>{o.status === 'skipped' ? '—' : (o.wo_status ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-sm is-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
