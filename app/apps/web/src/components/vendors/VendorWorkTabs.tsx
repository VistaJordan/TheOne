/* 0058 · The three working tabs of the Vendors section.
 *
 *   Tasks         what waits on you: your own tasks and, for a reviewer, the
 *                 review queue (possible duplicates, missing information, COI
 *                 reviews), each decided in place. Today's target on top.
 *   Alerts        every insurance date that counts, soonest first.
 *   Data quality  duplicates, missing information, records not on the map.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VENDOR_KIND_LABELS, VENDOR_TASK_TYPE_LABELS } from '@theone/shared';
import type {
  DailyTarget,
  DuplicateBy,
  ExpiryBand,
  VendorBrandSource,
  VendorStatusDef,
  VendorTask,
  VendorTaskAction,
  VendorTaskType,
  VendorTasksResponse,
} from '@theone/shared';
import {
  ApiRequestError,
  createVendorTask,
  deleteVendor,
  getVendorAlerts,
  getVendorDataQuality,
  getVendorTasks,
  resolveVendorTask,
  setVendorTarget,
  vendorDocumentUrl,
} from '../../api/client';
import { feedTime } from '../../lib/fields';
import { ConfirmDialog } from '../ConfirmDialog';
import { Icon } from '../Icon';

const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

// ═══ Tasks ═══════════════════════════════════════════════════════════════════

type TaskFilter = 'open' | VendorTaskType | 'done';

const ACTION_LABELS: Record<VendorTaskAction, string> = {
  keep: 'Keep both',
  remove: 'Remove this one',
  acknowledge: 'Acknowledge',
  approve: 'Approve',
  send_back: 'Send back',
  fixed: 'Mark fixed',
  done: 'Mark done',
};

const ACTIONS: Record<VendorTaskType, VendorTaskAction[]> = {
  DUPLICATE_REVIEW: ['keep', 'remove'],
  MISSING_INFO_REVIEW: ['acknowledge'],
  COMPLIANCE_REVIEW: ['approve', 'send_back'],
  COMPLIANCE_FIX: ['fixed'],
  MANUAL: ['done'],
};

export function VendorTasksTab({ brands }: { brands: VendorBrandSource[] }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<TaskFilter>('open');
  const q = useQuery({ queryKey: ['vendor-tasks'], queryFn: getVendorTasks });
  const data = q.data;
  const open = (data?.tasks ?? []).filter((t) => t.status === 'OPEN');
  const done = (data?.tasks ?? []).filter((t) => t.status === 'DONE');
  const shown = filter === 'open' ? open : filter === 'done' ? done : open.filter((t) => t.type === filter);
  const count = (t: VendorTaskType) => open.filter((x) => x.type === t).length;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['vendor-tasks'] });
    void qc.invalidateQueries({ queryKey: ['vendors'] });
    void qc.invalidateQueries({ queryKey: ['vendors-meta'] });
  };

  return (
    <div className="vwork">
      {data && <Targets data={data} onChanged={refresh} />}

      <div className="vwork-bar">
        <div className="seg" role="group" aria-label="Which tasks">
          <SegBtn on={filter === 'open'} onClick={() => setFilter('open')}>All open · {open.length}</SegBtn>
          {(Object.keys(VENDOR_TASK_TYPE_LABELS) as VendorTaskType[])
            .filter((t) => count(t) > 0 || t === 'MANUAL')
            .map((t) => (
              <SegBtn key={t} on={filter === t} onClick={() => setFilter(t)}>
                {VENDOR_TASK_TYPE_LABELS[t]} · {count(t)}
              </SegBtn>
            ))}
          <SegBtn on={filter === 'done'} onClick={() => setFilter('done')}>Done · {done.length}</SegBtn>
        </div>
      </div>

      {data && <NewTask data={data} onCreated={refresh} />}

      {q.isLoading && <div className="empty-flat">Loading tasks…</div>}
      {q.isError && <div className="empty-flat">{errText(q.error, 'Could not load the tasks.')}</div>}
      {data && shown.length === 0 && (
        <div className="empty-flat">
          {filter === 'done' ? 'Nothing closed in the last 30 days.' : 'Nothing waiting. New vendors that look like duplicates, lack required information or upload a certificate show up here.'}
        </div>
      )}
      <ul className="vtasks">
        {shown.map((t) => <TaskRow key={t.id} task={t} brands={brands} onDone={refresh} />)}
      </ul>
    </div>
  );
}

function SegBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`seg-btn${on ? ' is-on' : ''}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

function TaskRow({ task, brands, onDone }: { task: VendorTask; brands: VendorBrandSource[]; onDone: () => void }) {
  const [noteFor, setNoteFor] = useState<VendorTaskAction | null>(null);
  const [note, setNote] = useState('');
  const act = useMutation({
    mutationFn: (v: { action: VendorTaskAction; note?: string }) => resolveVendorTask(task.id, v.action, v.note),
    onSuccess: () => {
      setNoteFor(null);
      setNote('');
      onDone();
    },
  });
  const entity = task.entity && task.entity !== '-' ? (brands.find((b) => b.key === task.entity)?.label ?? task.entity) : null;
  const closed = task.status === 'DONE';

  const press = (action: VendorTaskAction) => {
    // Sending a certificate back needs to say why; removing a record asks first.
    if (action === 'send_back' || action === 'remove') setNoteFor(action);
    else act.mutate({ action });
  };

  return (
    <li className={`vtask${closed ? ' is-done' : ''}`}>
      <div className="vtask-main">
        <span className="chip chip-sm">{VENDOR_TASK_TYPE_LABELS[task.type]}</span>
        {entity && <span className="chip chip-outline chip-sm">{entity}</span>}
        <b>{task.title}</b>
        <span className="vtask-meta">
          {task.vendor && <Link to={`/vendors/${task.vendor.id}`}>Open {task.vendor.name}</Link>}
          <span>
            {closed
              ? `${task.outcome ?? 'done'} · ${task.completed_by?.name ?? 'system'} · ${task.completed_at ? feedTime(task.completed_at) : ''}`
              : `Raised ${feedTime(task.created_at)}${task.created_by ? ` by ${task.created_by.name}` : ''}${task.assigned_to ? ` · for ${task.assigned_to.name}` : ' · review queue'}`}
          </span>
        </span>
        {task.note && <span className="vtask-note">{task.note}</span>}
        {task.documents && task.documents.length > 0 && task.vendor && (
          <span className="vtask-docs">
            {task.documents.map((d) => (
              <a key={d.id} className="chip chip-sm" href={vendorDocumentUrl(task.vendor!.id, d.id)} target="_blank" rel="noreferrer">
                <Icon name="file" size={12} />
                {d.file_name}
              </a>
            ))}
          </span>
        )}
        {task.type === 'COMPLIANCE_REVIEW' && !closed && (task.documents?.length ?? 0) === 0 && (
          <span className="vtask-note">No certificate file on record for this company — open the vendor to check.</span>
        )}
      </div>
      {!closed && (
        <div className="vtask-actions">
          {ACTIONS[task.type].map((a) => (
            <button
              key={a}
              type="button"
              className={`btn btn-sm${a === 'remove' || a === 'send_back' ? ' is-danger' : a === 'keep' ? ' is-ghost' : ''}`}
              disabled={act.isPending}
              onClick={() => press(a)}
            >
              {ACTION_LABELS[a]}
            </button>
          ))}
        </div>
      )}
      {noteFor === 'send_back' && (
        <div className="vtask-compose">
          <label className="lbl" htmlFor={`sb-${task.id}`}>What needs fixing?</label>
          <textarea className="fld" id={`sb-${task.id}`} rows={2} autoFocus value={note} onChange={(e) => setNote(e.target.value)} />
          <span className="vtask-actions">
            <button type="button" className="btn btn-sm is-ghost" onClick={() => setNoteFor(null)}>Cancel</button>
            <button type="button" className="btn btn-sm is-danger" disabled={note.trim() === '' || act.isPending} onClick={() => act.mutate({ action: 'send_back', note: note.trim() })}>
              Send back to the owner
            </button>
          </span>
        </div>
      )}
      {noteFor === 'remove' && (
        <ConfirmDialog
          title={`Remove ${task.vendor?.name ?? 'this vendor'}?`}
          message={<>It is the record flagged as a possible duplicate. The one it matched stays.</>}
          confirmLabel="Remove"
          danger
          busy={act.isPending}
          onCancel={() => setNoteFor(null)}
          onConfirm={() => act.mutate({ action: 'remove' })}
        />
      )}
      {act.isError && <span className="err"><Icon name="alert" size={12} />{errText(act.error, 'Could not do that.')}</span>}
    </li>
  );
}

function NewTask({ data, onCreated }: { data: VendorTasksResponse; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [who, setWho] = useState('');
  const add = useMutation({
    mutationFn: () => createVendorTask({ title: title.trim(), assigned_to: who || null }),
    onSuccess: () => {
      setTitle('');
      onCreated();
    },
  });
  return (
    <form className="vwork-new" onSubmit={(e) => { e.preventDefault(); if (title.trim()) add.mutate(); }}>
      <input className="fld" placeholder="Add a task…" value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} aria-label="New task" />
      {data.can_review && (
        <select className="fld" value={who} onChange={(e) => setWho(e.target.value)} aria-label="For">
          <option value="">For me</option>
          {data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      <button type="submit" className="btn btn-sm" disabled={title.trim() === '' || add.isPending}>Add</button>
      {add.isError && <span className="err">{errText(add.error, 'Could not add the task.')}</span>}
    </form>
  );
}

function Targets({ data, onChanged }: { data: VendorTasksResponse; onChanged: () => void }) {
  const [who, setWho] = useState('');
  const [nw, setNw] = useState('');
  const [sw, setSw] = useState('');
  const set = useMutation({
    mutationFn: () => setVendorTarget({ principal_id: who, nationwide_target: Number(nw) || 0, statewide_target: Number(sw) || 0 }),
    onSuccess: () => {
      setNw('');
      setSw('');
      onChanged();
    },
  });
  if (!data.my_target && !data.can_review) return null;
  const bar = (t: DailyTarget) => (
    <span className="vtarget-nums">
      <span>Nationwide <b className="num">{t.nationwide_added}/{t.nationwide_target}</b></span>
      <span>Statewide <b className="num">{t.statewide_added}/{t.statewide_target}</b></span>
    </span>
  );
  return (
    <section className="vtarget">
      <span className="overline">Today’s target</span>
      {data.my_target ? bar(data.my_target) : !data.can_review ? null : <span className="hint">None set for you today.</span>}
      {data.can_review && (
        <>
          {data.targets.filter((t) => t.principal.id !== data.my_target?.principal.id).map((t) => (
            <span className="vtarget-row" key={t.principal.id}>
              <b>{t.principal.name}</b>
              {bar(t)}
            </span>
          ))}
          <form className="vtarget-form" onSubmit={(e) => { e.preventDefault(); if (who) set.mutate(); }}>
            <select className="fld" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Rep">
              <option value="">Set a target for…</option>
              {data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input className="fld mono" inputMode="numeric" placeholder="Nationwide" value={nw} onChange={(e) => setNw(e.target.value)} aria-label="Nationwide vendors to add" />
            <input className="fld mono" inputMode="numeric" placeholder="Statewide" value={sw} onChange={(e) => setSw(e.target.value)} aria-label="Statewide vendors to add" />
            <button type="submit" className="btn btn-sm" disabled={!who || set.isPending}>Set</button>
          </form>
          <span className="hint">Counted from the vendors that rep added today. Both at 0 clears the target.</span>
        </>
      )}
    </section>
  );
}

// ═══ Alerts ══════════════════════════════════════════════════════════════════

const BAND_LABEL: Record<ExpiryBand, string> = { expired: 'Expired', two_weeks: 'Within 2 weeks', month: 'Within a month', later: 'Later' };

export function VendorAlertsTab({ brands, statuses }: { brands: VendorBrandSource[]; statuses: VendorStatusDef[] }) {
  const [band, setBand] = useState<'all' | ExpiryBand>('all');
  const q = useQuery({ queryKey: ['vendor-alerts'], queryFn: getVendorAlerts });
  const all = q.data?.alerts ?? [];
  const n = (b: ExpiryBand) => all.filter((a) => a.band === b).length;
  const shown = band === 'all' ? all : band === 'month' ? all.filter((a) => a.band === 'month' || a.band === 'two_weeks') : all.filter((a) => a.band === band);
  return (
    <div className="vwork">
      <div className="vwork-bar">
        <div className="seg" role="group" aria-label="Which dates">
          <SegBtn on={band === 'all'} onClick={() => setBand('all')}>All · {all.length}</SegBtn>
          <SegBtn on={band === 'expired'} onClick={() => setBand('expired')}>Expired · {n('expired')}</SegBtn>
          <SegBtn on={band === 'two_weeks'} onClick={() => setBand('two_weeks')}>Within 2 weeks · {n('two_weeks')}</SegBtn>
          <SegBtn on={band === 'month'} onClick={() => setBand('month')}>Within a month · {n('two_weeks') + n('month')}</SegBtn>
        </div>
        <span className="hint">Only the latest date of each insurance counts — a renewed policy’s old date is not an alert.</span>
      </div>
      {q.isLoading && <div className="empty-flat">Loading…</div>}
      {q.isError && <div className="empty-flat">{errText(q.error, 'Could not load the alerts.')}</div>}
      {q.data && shown.length === 0 && <div className="empty-flat">No insurance dates here. Add them on a vendor’s record.</div>}
      {shown.length > 0 && (
        <div className="vend-wrap">
          <table className="vend-table">
            <thead><tr><th>Vendor</th><th>Insurance</th><th>Company</th><th>Expires</th><th /><th>Status</th><th>Owner</th></tr></thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td className="vend-name"><Link to={`/vendors/${a.vendor.id}`}>{a.vendor.name}</Link></td>
                  <td>{a.insurance_type}</td>
                  <td>{a.entity ? (brands.find((b) => b.key === a.entity)?.label ?? a.entity) : '—'}</td>
                  <td className="mono">{a.expires_on}</td>
                  <td>
                    <span className={`chip chip-sm${a.band === 'expired' || a.band === 'two_weeks' ? ' chip-danger' : a.band === 'month' ? ' chip-warn' : ''}`}>{BAND_LABEL[a.band]}</span>
                  </td>
                  <td>{statuses.find((s) => s.key === a.vendor.status)?.label ?? a.vendor.status}</td>
                  <td>{a.vendor.owner ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══ Data quality ════════════════════════════════════════════════════════════

export function VendorDataQualityTab({ canDelete }: { canDelete: boolean }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'duplicates' | 'missing' | 'map'>('duplicates');
  const [by, setBy] = useState<DuplicateBy>('phone');
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const q = useQuery({ queryKey: ['vendor-quality', by], queryFn: () => getVendorDataQuality(by) });
  const d = q.data;
  const remove = useMutation({
    mutationFn: (id: string) => deleteVendor(id),
    onSuccess: () => {
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: ['vendor-quality'] });
      void qc.invalidateQueries({ queryKey: ['vendors'] });
      void qc.invalidateQueries({ queryKey: ['vendors-meta'] });
    },
  });
  const age = useMemo(() => (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000), []);

  return (
    <div className="vwork">
      <div className="vwork-bar">
        <div className="seg" role="group" aria-label="Which check">
          <SegBtn on={tab === 'duplicates'} onClick={() => setTab('duplicates')}>Duplicates · {d?.counts.duplicates ?? '…'}</SegBtn>
          <SegBtn on={tab === 'missing'} onClick={() => setTab('missing')}>Missing information · {d?.counts.missing ?? '…'}</SegBtn>
          <SegBtn on={tab === 'map'} onClick={() => setTab('map')}>Not on the map · {d?.counts.not_on_map ?? '…'}</SegBtn>
        </div>
        {tab === 'duplicates' && (
          <label className="vwork-by">
            Same
            <select className="fld" value={by} onChange={(e) => setBy(e.target.value as DuplicateBy)}>
              <option value="phone">phone</option>
              <option value="name">name</option>
              <option value="email">email</option>
            </select>
          </label>
        )}
      </div>
      {q.isLoading && <div className="empty-flat">Checking…</div>}
      {q.isError && <div className="empty-flat">{errText(q.error, 'Could not run the checks.')}</div>}

      {d && tab === 'duplicates' && (
        d.duplicates.length === 0 ? <div className="empty-flat">No two records share a {by}.</div> : (
          <ul className="vdup">
            {d.duplicates.map((g) => (
              <li key={g.key}>
                <span className="overline">{by === 'phone' ? `+${g.key}` : g.key}</span>
                <div className="vend-wrap">
                  <table className="vend-table">
                    <tbody>
                      {g.vendors.map((v) => (
                        <tr key={v.id}>
                          <td className="vend-name"><Link to={`/vendors/${v.id}`}>{v.name}</Link></td>
                          <td>{VENDOR_KIND_LABELS[v.kind]}</td>
                          <td className="mono">{v.phone ?? '—'}</td>
                          <td>{v.email ?? '—'}</td>
                          <td>{[v.city, v.state].filter(Boolean).join(', ') || '—'}</td>
                          <td>{v.owner ?? '—'}</td>
                          <td><span className={`chip chip-sm${age(v.created_at) >= 14 ? ' chip-danger' : age(v.created_at) >= 7 ? ' chip-warn' : ''}`}>{age(v.created_at)}d old</span></td>
                          <td>
                            {canDelete && (
                              <button type="button" className="btn btn-sm is-danger" onClick={() => setRemoving({ id: v.id, name: v.name })}>Remove</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </li>
            ))}
          </ul>
        )
      )}

      {d && tab === 'missing' && (
        d.missing.length === 0 ? <div className="empty-flat">Every vendor carries the required fields.</div> : (
          <div className="vend-wrap">
            <table className="vend-table">
              <thead><tr><th>Vendor</th><th>What is missing</th><th>Owner</th><th>Added</th></tr></thead>
              <tbody>
                {d.missing.map((v) => (
                  <tr key={v.id}>
                    <td className="vend-name"><Link to={`/vendors/${v.id}`}>{v.name}</Link></td>
                    <td>
                      <span className="vend-chips">
                        {v.problems.map((p) => (
                          <span key={p.key} className={`chip chip-sm ${p.problem === 'invalid' ? 'chip-danger' : 'chip-warn'}`} title={p.problem === 'invalid' ? 'There, but not usable' : 'Empty'}>
                            {p.label}{p.problem === 'invalid' ? ' · unusable' : ''}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td>{v.owner ?? '—'}</td>
                    <td>{feedTime(v.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {d && tab === 'map' && (
        d.not_on_map.length === 0 ? <div className="empty-flat">Every record is on the map.</div> : (
          <div className="vend-wrap">
            <table className="vend-table">
              <thead><tr><th>Record</th><th>Kind</th><th>City</th><th>State</th><th>ZIP</th></tr></thead>
              <tbody>
                {d.not_on_map.map((v) => (
                  <tr key={v.id}>
                    <td className="vend-name"><Link to={`/vendors/${v.id}`}>{v.name}</Link></td>
                    <td>{VENDOR_KIND_LABELS[v.kind]}</td>
                    <td>{v.city ?? '—'}</td>
                    <td>{v.state ?? '—'}</td>
                    <td className="mono">{v.zip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message={<>It leaves the list and the maps; the other record in the group stays. The removal is in the audit log.</>}
          confirmLabel="Remove"
          danger
          busy={remove.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.id)}
        />
      )}
    </div>
  );
}
