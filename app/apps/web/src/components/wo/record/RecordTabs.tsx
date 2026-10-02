/* 0064 · The four tabs that read the work-order record.
 *
 *   ChecklistTab       the steps of the job, ticked as they are done
 *   CostBreakdownTab   what the client is asked for against what the job
 *                      costs, each figure saying where it came from; and the
 *                      NTE increase requests
 *   TimelogTab         how long it sat in each status, each visit, each pause
 *   RelatedTab         the same asset's and the same site's other work
 *                      orders, and what hangs on this one
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { GEOFENCE_RESULT_LABELS, formatFeet, formatMinutes } from '@theone/shared';
import type { WoCostLine, WoRecord, WoRelatedWorkOrder } from '@theone/shared';
import { addWoChecklist, decideNteIncrease, removeWoChecklist, updateWoChecklist } from '../../../api/client';
import { feedTime } from '../../../lib/fields';
import { plainStatus } from '../../../lib/quo';
import { Icon } from '../../Icon';
import { errText, usd, useRecordWrite } from './RecordParts';

interface TabProps { woId: string; woNumber: string; record: WoRecord }

const stamp = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

// ═══ Checklist ═══════════════════════════════════════════════════════════════

export function ChecklistTab({ woId, woNumber, record }: TabProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fail = (fallback: string) => ({ onError: (e: unknown) => setError(errText(e, fallback)), onSuccess: () => setError(null) });
  const add = useRecordWrite(woId, woNumber, (titles: string[]) => addWoChecklist(woId, titles), () => setText(''));
  const tick = useRecordWrite(woId, woNumber, (x: { id: string; done: boolean }) => updateWoChecklist(woId, x.id, { done: x.done }));
  const remove = useRecordWrite(woId, woNumber, (id: string) => removeWoChecklist(woId, id));
  const items = record.checklist;
  const done = items.filter((i) => i.done).length;
  const edit = record.can.edit;
  // One step per line, so a whole list can be pasted in.
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Checklist</h2>
        {items.length > 0 && <span className="card-meta">{done} of {items.length} done</span>}
      </div>
      {items.length > 0 && <div className="rec-progress" aria-hidden="true"><span style={{ width: `${Math.round((done / items.length) * 100)}%` }} /></div>}
      {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
      {items.length === 0 ? (
        <div className="empty-flat">No steps yet. List what has to happen on this job — one step per line — and tick them off as they are done.</div>
      ) : (
        <ul className="rec-check">
          {items.map((i) => (
            <li key={i.id} className={i.done ? 'is-done' : undefined}>
              <label>
                <input type="checkbox" checked={i.done} disabled={!edit || tick.isPending} onChange={(e) => tick.mutate({ id: i.id, done: e.target.checked }, fail('Could not save.'))} />
                <span>{i.title}</span>
              </label>
              {i.done && <small>{[i.done_by?.name, i.done_at ? feedTime(i.done_at) : null].filter(Boolean).join(' · ')}</small>}
              {edit && (
                <button type="button" className="icon-btn" aria-label={`Remove “${i.title}”`} disabled={remove.isPending} onClick={() => remove.mutate(i.id, fail('Could not remove it.'))}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <form className="rec-add" onSubmit={(e) => { e.preventDefault(); if (lines.length) add.mutate(lines, fail('Could not add the steps.')); }}>
          <textarea className="fld" rows={lines.length > 1 ? Math.min(6, lines.length + 1) : 1} placeholder="Add a step — or paste several, one per line" value={text} onChange={(e) => setText(e.target.value)} aria-label="New steps" />
          <button type="submit" className="btn btn-sm" disabled={lines.length === 0 || add.isPending}>{lines.length > 1 ? `Add ${lines.length} steps` : 'Add'}</button>
        </form>
      )}
    </section>
  );
}

// ═══ Cost breakdown ══════════════════════════════════════════════════════════

const LINE_TYPE: Record<string, string> = { service: 'Service / trip', labor: 'Labour', part: 'Parts', material: 'Materials' };

function Lines({ title, lines, empty }: { title: string; lines: WoCostLine[]; empty: string }) {
  const total = lines.reduce((s, l) => s + (l.status === 'rejected' || l.status === 'void' ? 0 : l.amount), 0);
  return (
    <div className="rec-cost-block">
      <h3>{title}{lines.length > 0 && <span>{usd(total)}</span>}</h3>
      {lines.length === 0 ? <p className="pf-muted">{empty}</p> : (
        <ul>
          {lines.map((l, i) => (
            <li key={i} className={l.status === 'rejected' || l.status === 'void' ? 'is-off' : undefined}>
              <span>{l.label}{l.detail ? <small> · {l.detail}</small> : null}</span>
              {l.status && <span className="chip chip-sm">{l.status.replace(/_/g, ' ')}</span>}
              <b className="num">{usd(l.amount)}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CostBreakdownTab({ woId, woNumber, record }: TabProps) {
  const b = record.breakdown;
  const c = record.cost;
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = useRecordWrite(woId, woNumber, (x: { id: string; decision: 'approve' | 'reject' | 'withdraw'; note?: string }) => decideNteIncrease(woId, x.id, x.decision, x.note), () => setRejecting(null));
  const act = (x: { id: string; decision: 'approve' | 'reject' | 'withdraw'; note?: string }) =>
    decide.mutate(x, { onError: (e) => setError(errText(e, 'Could not decide the request.')), onSuccess: () => setError(null) });
  if (!record.can.see_money) return <section className="card"><div className="empty-flat">Your role does not show the money on a work order.</div></section>;
  const margin = b.revenue !== null && b.cost !== null ? b.revenue - b.cost : null;

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">Cost breakdown</h2>
          {c.over_nte && <span className="chip chip-danger chip-sm">Cost is over the NTE</span>}
        </div>
        <div className="rec-sum">
          <div><span>Client NTE</span><b>{usd(c.nte)}</b></div>
          <div><span>Revenue</span><b>{usd(b.revenue)}</b><small>{b.revenue_basis}</small></div>
          <div><span>Cost</span><b>{usd(b.cost)}</b><small>{b.cost_basis}</small></div>
          <div className={margin !== null && margin < 0 ? 'is-neg' : undefined}>
            <span>Margin</span>
            <b>{usd(margin)}</b>
            <small>{margin !== null && b.revenue ? `${Math.round((margin / b.revenue) * 1000) / 10}% of revenue` : 'Needs both figures'}</small>
          </div>
        </div>
        <div className="rec-cost-grid">
          <div className="rec-cost-col">
            <h2 className="overline">What the client pays</h2>
            <div className="rec-cost-block">
              <h3>Quote{b.quote && <span>{usd(b.quote.total)}</span>}</h3>
              {!b.quote ? <p className="pf-muted">No quote on this work order.</p> : (
                <ul>
                  {b.quote.by_type.map((t) => (
                    <li key={t.type}>
                      <span>{LINE_TYPE[t.type] ?? t.type}<small> · {t.count} {t.count === 1 ? 'line' : 'lines'}</small></span>
                      <b className="num">{usd(t.amount)}</b>
                    </li>
                  ))}
                  {b.quote.tax > 0 && <li><span>Tax</span><b className="num">{usd(b.quote.tax)}</b></li>}
                  <li className="rec-note"><span>Status: {b.quote.status.replace(/_/g, ' ')}</span><Link to={`/work-orders/${encodeURIComponent(woNumber)}/quote`}>Open the quote</Link></li>
                </ul>
              )}
            </div>
            <Lines title="Invoices" lines={b.invoices} empty="Nothing invoiced yet." />
          </div>
          <div className="rec-cost-col">
            <h2 className="overline">What the job costs</h2>
            <div className="rec-cost-block">
              <h3>Cost on the work order<span>{usd(c.cost)}</span></h3>
              <p className="pf-muted">The final vendor cost, as entered in the Cost field.</p>
            </div>
            <Lines title="Vendor bills" lines={b.vendor_bills} empty="No vendor bill on file." />
            <Lines title="Payment requests" lines={b.payables} empty="Nothing requested." />
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2 className="card-title">NTE increases</h2></div>
        {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
        {record.nte_requests.length === 0 ? (
          <div className="empty-flat">Nobody has asked for a higher NTE. Use “Increase NTE” above the tabs to ask.</div>
        ) : (
          <ul className="vtasks rec-nte">
            {record.nte_requests.map((n) => (
              <li key={n.id} className={`vtask${n.status === 'open' ? '' : ' is-done'}`}>
                <div className="vtask-main">
                  <span className={`chip chip-sm${n.status === 'approved' ? ' chip-accent' : n.status === 'rejected' ? ' chip-danger' : ''}`}>{n.status === 'open' ? 'Waiting' : n.status}</span>
                  <b>{usd(n.current_nte)} → {usd(n.requested_nte)}</b>
                  <span className="vtask-meta"><span>Asked by {n.requested_by?.name ?? 'someone'} · {feedTime(n.created_at)}</span></span>
                  <span className="vtask-note">{n.reason}</span>
                  {n.status !== 'open' && n.status !== 'withdrawn' && (
                    <span className="vtask-note">{n.status} by {n.decided_by?.name ?? 'someone'}{n.decided_at ? ` · ${feedTime(n.decided_at)}` : ''}{n.decision_note ? ` — ${n.decision_note}` : ''}</span>
                  )}
                </div>
                {rejecting?.id === n.id ? (
                  <div className="vtask-compose">
                    <label className="lbl" htmlFor={`nte-${n.id}`}>Why is it rejected?</label>
                    <textarea className="fld" id={`nte-${n.id}`} rows={2} autoFocus value={rejecting.note} onChange={(e) => setRejecting({ id: n.id, note: e.target.value })} />
                    <span className="vtask-actions">
                      <button type="button" className="btn btn-sm is-ghost" onClick={() => setRejecting(null)}>Back</button>
                      <button type="button" className="btn btn-sm is-danger" disabled={rejecting.note.trim() === '' || decide.isPending} onClick={() => act({ id: n.id, decision: 'reject', note: rejecting.note.trim() })}>Reject</button>
                    </span>
                  </div>
                ) : (n.can.decide || n.can.withdraw) && (
                  <div className="vtask-actions">
                    {n.can.decide && <button type="button" className="btn btn-sm" disabled={decide.isPending} onClick={() => act({ id: n.id, decision: 'approve' })}>Approve — set the NTE to {usd(n.requested_nte)}</button>}
                    {n.can.decide && <button type="button" className="btn btn-sm is-danger" onClick={() => setRejecting({ id: n.id, note: '' })}>Reject</button>}
                    {n.can.withdraw && <button type="button" className="btn btn-sm is-ghost" disabled={decide.isPending} onClick={() => act({ id: n.id, decision: 'withdraw' })}>Withdraw</button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ═══ Timelog & metrics ═══════════════════════════════════════════════════════

export function TimelogTab({ record }: TabProps) {
  const t = record.timelog;
  const time = record.time;
  const longest = Math.max(1, ...t.statuses.map((s) => s.minutes));
  return (
    <>
      <section className="card">
        <div className="card-head"><h2 className="card-title">Metrics</h2></div>
        <div className="rec-sum">
          <div><span>{record.state.completion ? 'Open for' : 'Open so far'}</span><b>{formatMinutes(t.open_minutes)}</b><small>from received to {record.state.completion ? 'service completed' : 'now'}</small></div>
          <div><span>Response time</span><b>{formatMinutes(t.response_minutes)}</b><small>received to the first check-in</small></div>
          <div><span>Time on site</span><b>{time.visits === 0 ? '—' : formatMinutes(time.on_site_minutes)}</b><small>{time.visits} {time.visits === 1 ? 'visit' : 'visits'}</small></div>
          <div><span>Paused</span><b>{time.paused_minutes > 0 || t.pauses.length > 0 ? formatMinutes(t.pauses.reduce((s, p) => s + p.minutes, 0)) : '—'}</b><small>{t.pauses.length} {t.pauses.length === 1 ? 'pause' : 'pauses'} — a marker, no clock stops</small></div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2 className="card-title grow">Time in each status</h2><span className="card-meta">{t.statuses.length} {t.statuses.length === 1 ? 'status' : 'statuses'}</span></div>
        <ul className="rec-spans">
          {t.statuses.map((s, i) => (
            <li key={i} className={s.to === null ? 'is-now' : undefined}>
              <span className="rec-span-name">{plainStatus(s.status) ?? s.status}{s.to === null && <small> · now</small>}</span>
              <span className="rec-span-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.round((s.minutes / longest) * 100))}%` }} /></span>
              <b className="num">{formatMinutes(s.minutes)}</b>
              <small>{stamp(s.from)}{s.by ? ` · ${s.by.name}` : ''}</small>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="card-head"><h2 className="card-title">Visits</h2></div>
        {t.visits.length === 0 ? <div className="empty-flat">No visit logged yet.</div> : (
          <div className="vend-wrap">
            <table className="vend-table">
              <thead><tr><th>Visit</th><th>Technician</th><th>Checked in</th><th>Checked out</th><th>On site</th><th>Location</th></tr></thead>
              <tbody>
                {t.visits.map((v) => (
                  <tr key={v.id}>
                    <td>{v.seq} · {v.visit_type}</td>
                    <td>{v.tech_name ?? '—'}</td>
                    <td>{stamp(v.checked_in_at)}</td>
                    <td>{v.checked_out_at ? stamp(v.checked_out_at) : v.checked_in_at ? 'Still on site' : '—'}</td>
                    <td className="num">{formatMinutes(v.minutes)}</td>
                    <td>
                      {v.geofence_result ? (
                        <span className={`chip chip-sm${v.geofence_result === 'inside' ? ' chip-accent' : v.geofence_result === 'outside' ? ' chip-danger' : ''}`}>
                          {GEOFENCE_RESULT_LABELS[v.geofence_result]}{v.geofence_ft !== null ? ` · ${formatFeet(v.geofence_ft)}` : ''}
                        </span>
                      ) : <span className="pf-muted">Not recorded</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {t.pauses.length > 0 && (
        <section className="card">
          <div className="card-head"><h2 className="card-title">Pauses</h2></div>
          <ul className="vrec-list">
            {t.pauses.map((p) => (
              <li key={p.id}>
                <b>{formatMinutes(p.minutes)}</b>
                <span>{stamp(p.paused_at)} → {p.resumed_at ? stamp(p.resumed_at) : 'still paused'}</span>
                <span className="pf-muted">{[p.reason, p.paused_by?.name].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// ═══ Related ═════════════════════════════════════════════════════════════════

function WoList({ items, empty }: { items: WoRelatedWorkOrder[]; empty: string }) {
  if (items.length === 0) return <div className="empty-flat">{empty}</div>;
  return (
    <div className="vend-wrap">
      <table className="vend-table">
        <thead><tr><th>Work order</th><th>Status</th><th>Trade</th><th>Received</th></tr></thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.wo_number}>
              <td className="vend-name">
                <Link to={`/work-orders/${encodeURIComponent(w.wo_number)}`}>{w.wo_number}</Link>
                <span className="pf-wo-title">{w.title}</span>
              </td>
              <td><span className={`chip chip-sm${w.status_group === 'done' || w.status_group === 'closed' ? ' chip-outline' : ''}`}>{plainStatus(w.status) ?? w.status}</span></td>
              <td>{w.trade ?? '—'}</td>
              <td>{w.date_received ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const APPROVAL_KIND: Record<string, string> = { nte_override: 'NTE override', status_change: 'Status change request', manager_review: 'Manager review', wo_acceptance: 'Acceptance' };

export function RelatedTab({ record }: TabProps) {
  const r = record.related;
  const open = (list: WoRelatedWorkOrder[]) => list.filter((w) => w.status_group !== 'done' && w.status_group !== 'closed').length;
  return (
    <>
      <section className="card">
        <div className="card-head"><h2 className="card-title">On this work order</h2></div>
        {r.records.length === 0 ? <div className="empty-flat">Nothing else hangs on this work order yet.</div> : (
          <div className="rec-links">
            {r.records.map((x) => (x.link ? <Link key={x.kind} className="chip" to={x.link}>{x.label}</Link> : <span key={x.kind} className="chip">{x.label}</span>))}
          </div>
        )}
        {r.approvals.length > 0 && (
          <ul className="vrec-list">
            {r.approvals.map((a, i) => (
              <li key={i}>
                <span className="chip chip-sm">{APPROVAL_KIND[a.kind] ?? a.kind}</span>
                <span>{a.title}</span>
                <span className="push pf-muted">{a.status} · {feedTime(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">Same asset</h2>
          <span className="card-meta">{r.same_asset.length}{open(r.same_asset) > 0 ? ` · ${open(r.same_asset)} open` : ''}</span>
        </div>
        <WoList items={r.same_asset} empty="No other work order on this asset — or no asset is linked (Site tab)." />
      </section>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">Same site</h2>
          <span className="card-meta">{r.same_site.length}{open(r.same_site) > 0 ? ` · ${open(r.same_site)} open` : ''}</span>
        </div>
        <WoList items={r.same_site} empty="No other work order at this site — or no site record is linked (Site tab)." />
      </section>
    </>
  );
}
