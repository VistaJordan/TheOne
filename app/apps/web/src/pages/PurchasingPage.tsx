/* /purchasing — purchase requests, requests for quotation, purchase orders,
 * and the cost centers, AFEs and budgets they are filed under (0067). One tab
 * each; a person sees the tabs their role grants. The tab lives in ?tab=.
 *
 * Also here: the card that shows a work order's purchasing (its Payables
 * tab), since it opens the same dialogs.
 */

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PO_STATUSES, PO_STATUS_LABELS, PR_STATUSES, PR_STATUS_LABELS, RFQ_STATUSES, RFQ_STATUS_LABELS } from '@theone/shared';
import type { Afe, BudgetRow, BudgetsResponse, CostCenter, PurchaseOrder, PurchaseRequest, PurchasingMeta, Rfq, WoPurchasing } from '@theone/shared';
import {
  getBudgets,
  getPurchasingMeta,
  getWoPurchasing,
  listPurchaseOrders,
  listPurchaseRequests,
  listRfqs,
  saveAfe,
  saveBudget,
  saveCostCenter,
  setWoFiling,
} from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { OrderDialog, PoChip, PrChip, RequestDialog, RfqChip, RfqDialog } from '../components/purchasing/PurchasingParts';
import { F, PageTabs, Sheet, dayText, errText, numOrNull, usd } from '../components/ui/Sheet';

type Tab = 'requests' | 'rfqs' | 'orders' | 'budgets';

export function PurchasingPage() {
  const [sp, setSp] = useSearchParams();
  const meta = useQuery({ queryKey: ['purchasing', 'meta'], queryFn: getPurchasingMeta });
  const m = meta.data;
  const tabs: { id: Tab; label: string }[] = m
    ? [
        ...(m.can.requests.view ? [{ id: 'requests' as Tab, label: 'Requests' }] : []),
        ...(m.can.rfqs.view ? [{ id: 'rfqs' as Tab, label: 'Requests for quotation' }] : []),
        ...(m.can.orders.view ? [{ id: 'orders' as Tab, label: 'Purchase orders' }] : []),
        ...(m.can.budgets.view ? [{ id: 'budgets' as Tab, label: 'Budgets' }] : []),
      ]
    : [];
  const tab = (tabs.find((t) => t.id === sp.get('tab')) ?? tabs[0])?.id;
  return (
    <AppShell active="Purchasing">
      <div className="canvas-inner">
        <div className="vend-head"><div className="page-head" style={{ margin: 0 }}><h1 className="page-title">Purchasing</h1></div></div>
        {meta.isError && <section className="card"><div className="empty-flat">{errText(meta.error, 'Could not load Purchasing.')}</div></section>}
        {m && tabs.length === 0 && <section className="card"><div className="empty-flat">Your role does not open any part of Purchasing.</div></section>}
        {m && tab && (
          <>
            <PageTabs tabs={tabs} value={tab} onChange={(id) => setSp({ tab: id }, { replace: true })} />
            {tab === 'requests' && <RequestsTab meta={m} />}
            {tab === 'rfqs' && <RfqsTab meta={m} />}
            {tab === 'orders' && <OrdersTab meta={m} />}
            {tab === 'budgets' && <BudgetsTab />}
          </>
        )}
      </div>
    </AppShell>
  );
}

function useListState() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  return { status, setStatus, search, setSearch, applied, apply: () => setApplied(search.trim()) };
}

function StatusChips({ statuses, labels, value, counts, onChange }: { statuses: readonly string[]; labels: Record<string, string>; value: string; counts: Record<string, number> | undefined; onChange: (s: string) => void }) {
  return (
    <div className="mt-states">
      <button type="button" className={`chip${value === '' ? ' chip-accent' : ''}`} onClick={() => onChange('')}>All</button>
      {statuses.map((s) => <button key={s} type="button" className={`chip${value === s ? ' chip-accent' : ''}`} onClick={() => onChange(s)}>{labels[s]}{counts ? ` · ${counts[s] ?? 0}` : ''}</button>)}
    </div>
  );
}

const woLink = (t: { wo_number: string } | null) => (t ? <Link className="mono" to={`/work-orders/${encodeURIComponent(t.wo_number)}?tab=payables`}>{t.wo_number}</Link> : <span className="pf-muted">—</span>);

// ═══ Requests ════════════════════════════════════════════════════════════════

function RequestsTab({ meta }: { meta: PurchasingMeta }) {
  const s = useListState();
  const q = useQuery({ queryKey: ['purchasing', 'requests', s.status, s.applied], queryFn: () => listPurchaseRequests({ status: s.status || undefined, search: s.applied || undefined }), placeholderData: keepPreviousData });
  const [open, setOpen] = useState<PurchaseRequest | 'new' | null>(null);
  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const [rfq, setRfq] = useState<Rfq | null>(null);
  const rows = q.data?.items ?? [];
  return (
    <section className="card">
      <form className="vend-filters" onSubmit={(e) => { e.preventDefault(); s.apply(); }}>
        <input className="fld vend-search" type="search" placeholder="Search PR #, title, WO # or vendor" value={s.search} onChange={(e) => s.setSearch(e.target.value)} onBlur={s.apply} aria-label="Search requests" />
        <StatusChips statuses={PR_STATUSES} labels={PR_STATUS_LABELS} value={s.status} counts={q.data?.counts} onChange={s.setStatus} />
        {meta.can.requests.create && <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setOpen('new')}><Icon name="plus" size={12} /> New request</button>}
      </form>
      {q.isError ? <div className="empty-flat">{errText(q.error, 'Could not load the requests.')}</div> : (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th>Request</th><th>What</th><th>Work order</th><th>Vendor</th><th>Needed by</th><th className="num">Estimate</th><th>Status</th><th>Requested by</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><button type="button" className="link-btn mono" onClick={() => setOpen(r)}>{r.pr_number}</button></td>
                  <td>{r.title}<small className="mt-sub">{r.lines.length} {r.lines.length === 1 ? 'item' : 'items'}{r.cost_center ? ` · ${r.cost_center.code}` : ''}</small></td>
                  <td>{woLink(r.task)}</td>
                  <td>{r.vendor?.name ?? '—'}</td>
                  <td>{dayText(r.needed_by)}</td>
                  <td className="num">{usd(r.estimate)}</td>
                  <td><PrChip status={r.status} /></td>
                  <td>{r.requested_by?.name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.data && rows.length === 0 && <div className="empty-flat">{s.status || s.applied ? 'Nothing matches.' : 'No purchase requests yet. A request says what needs buying and waits for a manager’s approval.'}</div>}
        </div>
      )}
      {open && <RequestDialog request={open === 'new' ? null : open} meta={meta} onClose={() => setOpen(null)} onOrder={setOrder} onRfq={setRfq} />}
      {order && <OrderDialog order={order} meta={meta} onClose={() => setOrder(null)} />}
      {rfq && <RfqDialog rfq={rfq} meta={meta} onClose={() => setRfq(null)} onOrder={setOrder} />}
    </section>
  );
}

// ═══ Requests for quotation ══════════════════════════════════════════════════

function RfqsTab({ meta }: { meta: PurchasingMeta }) {
  const s = useListState();
  const q = useQuery({ queryKey: ['purchasing', 'rfqs', s.status, s.applied], queryFn: () => listRfqs({ status: s.status || undefined, search: s.applied || undefined }), placeholderData: keepPreviousData });
  const [open, setOpen] = useState<Rfq | 'new' | null>(null);
  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const rows = q.data?.items ?? [];
  return (
    <section className="card">
      <form className="vend-filters" onSubmit={(e) => { e.preventDefault(); s.apply(); }}>
        <input className="fld vend-search" type="search" placeholder="Search RFQ #, title or WO #" value={s.search} onChange={(e) => s.setSearch(e.target.value)} onBlur={s.apply} aria-label="Search requests for quotation" />
        <StatusChips statuses={RFQ_STATUSES} labels={RFQ_STATUS_LABELS} value={s.status} counts={q.data?.counts} onChange={s.setStatus} />
        {meta.can.rfqs.create && <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setOpen('new')}><Icon name="plus" size={12} /> New request for quotation</button>}
      </form>
      {q.isError ? <div className="empty-flat">{errText(q.error, 'Could not load them.')}</div> : (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th>RFQ</th><th>What</th><th>Work order</th><th>Due</th><th className="num">Vendors</th><th className="num">Quotes</th><th className="num">Lowest</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const low = r.quotes.filter((x) => x.total > 0).reduce<number | null>((a, b) => (a === null || b.total < a ? b.total : a), null);
                return (
                  <tr key={r.id}>
                    <td><button type="button" className="link-btn mono" onClick={() => setOpen(r)}>{r.rfq_number}</button></td>
                    <td>{r.title}{r.request && <small className="mt-sub">from {r.request.pr_number}</small>}</td>
                    <td>{woLink(r.task)}</td>
                    <td>{dayText(r.due_on)}</td>
                    <td className="num">{r.vendors.length}</td>
                    <td className="num">{r.quotes.length}</td>
                    <td className="num">{low === null ? '—' : usd(low)}</td>
                    <td><RfqChip status={r.status} />{r.order && <small className="mt-sub">{r.order.po_number}</small>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {q.data && rows.length === 0 && <div className="empty-flat">{s.status || s.applied ? 'Nothing matches.' : 'None yet. A request for quotation asks several vendors to price the same list, and lays their answers side by side.'}</div>}
        </div>
      )}
      {open && <RfqDialog rfq={open === 'new' ? null : open} meta={meta} onClose={() => setOpen(null)} onOrder={setOrder} />}
      {order && <OrderDialog order={order} meta={meta} onClose={() => setOrder(null)} />}
    </section>
  );
}

// ═══ Purchase orders ═════════════════════════════════════════════════════════

function OrdersTab({ meta }: { meta: PurchasingMeta }) {
  const s = useListState();
  const q = useQuery({ queryKey: ['purchasing', 'orders', s.status, s.applied], queryFn: () => listPurchaseOrders({ status: s.status || undefined, search: s.applied || undefined }), placeholderData: keepPreviousData });
  const [open, setOpen] = useState<PurchaseOrder | 'new' | null>(null);
  const rows = q.data?.items ?? [];
  return (
    <section className="card">
      <form className="vend-filters" onSubmit={(e) => { e.preventDefault(); s.apply(); }}>
        <input className="fld vend-search" type="search" placeholder="Search PO #, vendor or WO #" value={s.search} onChange={(e) => s.setSearch(e.target.value)} onBlur={s.apply} aria-label="Search purchase orders" />
        <StatusChips statuses={PO_STATUSES} labels={PO_STATUS_LABELS} value={s.status} counts={q.data?.counts} onChange={s.setStatus} />
        {meta.can.orders.create && <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setOpen('new')}><Icon name="plus" size={12} /> New purchase order</button>}
      </form>
      {q.isError ? <div className="empty-flat">{errText(q.error, 'Could not load the orders.')}</div> : (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th>Order</th><th>Vendor</th><th>Work order</th><th>Ordered</th><th>Expected</th><th className="num">Total</th><th className="num">Received</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><button type="button" className="link-btn mono" onClick={() => setOpen(r)}>{r.po_number}</button>{r.warnings.length > 0 && <small className="mt-sub rec-neg">{r.warnings.length} to check</small>}</td>
                  <td>{r.vendor.name}{(r.cost_center || r.afe) && <small className="mt-sub">{[r.cost_center?.code, r.afe?.afe_number].filter(Boolean).join(' · ')}</small>}</td>
                  <td>{woLink(r.task)}</td>
                  <td>{dayText(r.order_date)}</td>
                  <td>{dayText(r.expected_on)}</td>
                  <td className="num">{usd(r.total)}</td>
                  <td className="num">{r.received_value > 0 ? usd(r.received_value) : '—'}</td>
                  <td><PoChip status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.data && rows.length === 0 && <div className="empty-flat">{s.status || s.applied ? 'Nothing matches.' : 'No purchase orders yet.'}</div>}
        </div>
      )}
      {open && <OrderDialog order={open === 'new' ? null : open} meta={meta} onClose={() => setOpen(null)} />}
    </section>
  );
}

// ═══ Budgets, cost centers, AFEs ═════════════════════════════════════════════

function BudgetsTab() {
  const qc = useQueryClient();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const key = ['purchasing', 'budgets', year];
  const q = useQuery({ queryKey: key, queryFn: () => getBudgets(year), placeholderData: keepPreviousData });
  const [cc, setCc] = useState<CostCenter | 'new' | null>(null);
  const [afe, setAfe] = useState<Afe | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = (res: BudgetsResponse) => { qc.setQueryData(['purchasing', 'budgets', res.year], res); void qc.invalidateQueries({ queryKey: ['purchasing'] }); setError(null); };
  const budget = useMutation({ mutationFn: (x: { id: string; amount: number | null }) => saveBudget(x.id, year, x.amount), onSuccess: done, onError: (e) => setError(errText(e, 'Could not save the budget.')) });
  const d = q.data;
  const edit = Boolean(d?.can.edit);
  const bar = (r: BudgetRow) => {
    if (r.budget === null || r.budget <= 0) return null;
    const a = Math.min(100, (r.actual / r.budget) * 100);
    const c = Math.min(100 - a, (r.committed / r.budget) * 100);
    return <i className={`pu-bar${r.over ? ' is-over' : ''}`} aria-hidden="true"><i style={{ width: `${a}%` }} /><i className="is-committed" style={{ width: `${c}%` }} /></i>;
  };
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">Budgets by cost center</h2>
          <label className="mt-range">Year <input className="fld mt-qty" type="number" min="2000" max="2100" value={year} onChange={(e) => { const n = Number(e.target.value); if (n >= 2000 && n <= 2100) setYear(n); }} /></label>
          {edit && <button type="button" className="btn btn-sm is-ghost" onClick={() => setCc('new')}><Icon name="plus" size={12} /> Cost center</button>}
        </div>
        <div className="rec-sum">
          <div><span>Budget</span><b>{usd(d?.totals.budget ?? 0)}</b></div>
          <div><span>Spent</span><b>{usd(d?.totals.actual ?? 0)}</b><small>Work-order Cost, plus received purchase orders not tied to a work order</small></div>
          <div><span>Committed</span><b>{usd(d?.totals.committed ?? 0)}</b><small>Issued purchase orders still to arrive</small></div>
        </div>
        {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
        {q.isError ? <div className="empty-flat">{errText(q.error, 'Could not load the budgets.')}</div> : (
          <div className="vend-wrap">
            <table className="vend-table mt-table">
              <thead><tr><th>Cost center</th><th>Client</th><th className="num">Budget {year}</th><th className="num">Work orders</th><th className="num">Spent</th><th className="num">Committed</th><th className="num">Left</th><th>Used</th></tr></thead>
              <tbody>
                {(d?.rows ?? []).map((r) => (
                  <tr key={r.cost_center.id} className={r.cost_center.is_active ? undefined : 'pu-off'}>
                    <td className="vend-name">{edit ? <button type="button" className="link-btn" onClick={() => setCc(r.cost_center)}><span className="mono">{r.cost_center.code}</span> · {r.cost_center.name}</button> : <span><span className="mono">{r.cost_center.code}</span> · {r.cost_center.name}</span>}</td>
                    <td>{r.cost_center.client ?? '—'}</td>
                    <td className="num">
                      {edit ? (
                        <input className="fld pu-money" type="number" min="0" step="1" placeholder="not set" defaultValue={r.budget ?? ''} key={`${r.cost_center.id}-${year}-${r.budget}`} aria-label={`Budget for ${r.cost_center.code}`}
                          onBlur={(e) => { const n = numOrNull(e.target.value); if (n !== r.budget) budget.mutate({ id: r.cost_center.id, amount: n }); }} />
                      ) : r.budget === null ? '—' : usd(r.budget)}
                    </td>
                    <td className="num">{r.work_orders}</td>
                    <td className="num">{usd(r.actual)}</td>
                    <td className="num">{r.committed ? usd(r.committed) : '—'}</td>
                    <td className="num">{r.remaining === null ? '—' : <b className={r.over ? 'rec-neg' : undefined}>{usd(r.remaining)}</b>}</td>
                    <td className="pu-used">{bar(r)}{r.used_pct !== null && <small>{r.used_pct}%</small>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d && d.rows.length === 0 && <div className="empty-flat">No cost centers yet. A cost center is a bucket work orders and purchase orders are filed under, so their spend can be held against a budget.</div>}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">AFEs</h2>
          {edit && <button type="button" className="btn btn-sm is-ghost" onClick={() => setAfe('new')}><Icon name="plus" size={12} /> AFE</button>}
        </div>
        <p className="hint mt-hint">An authorization for expenditure is an amount approved for one purpose. Work orders and purchase orders cite it; going over it warns, it does not block.</p>
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th>AFE</th><th>Title</th><th>Cost center</th><th>Valid</th><th className="num">Authorized</th><th className="num">Used</th><th className="num">Left</th><th>Status</th></tr></thead>
            <tbody>
              {(d?.afes ?? []).map((a) => (
                <tr key={a.id}>
                  <td>{edit ? <button type="button" className="link-btn mono" onClick={() => setAfe(a)}>{a.afe_number}</button> : <span className="mono">{a.afe_number}</span>}</td>
                  <td>{a.title}</td>
                  <td>{a.cost_center?.code ?? '—'}</td>
                  <td>{a.valid_from || a.valid_to ? `${dayText(a.valid_from)} → ${dayText(a.valid_to)}` : '—'}</td>
                  <td className="num">{usd(a.amount)}</td>
                  <td className="num">{usd(a.used)}</td>
                  <td className="num"><b className={a.over ? 'rec-neg' : undefined}>{usd(a.remaining)}</b></td>
                  <td><span className={`chip chip-sm${a.status === 'open' ? ' chip-ok' : ' chip-outline'}`}>{a.status === 'open' ? 'Open' : 'Closed'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {d && d.afes.length === 0 && <div className="empty-flat">No AFEs yet.</div>}
        </div>
      </section>

      {cc && d && <CostCenterDialog cc={cc === 'new' ? null : cc} clients={d.clients} onClose={() => setCc(null)} onSaved={done} />}
      {afe && d && <AfeDialog afe={afe === 'new' ? null : afe} centers={d.cost_centers} onClose={() => setAfe(null)} onSaved={done} />}
    </>
  );
}

function CostCenterDialog({ cc, clients, onClose, onSaved }: { cc: CostCenter | null; clients: string[]; onClose: () => void; onSaved: (r: BudgetsResponse) => void }) {
  const [d, setD] = useState({ code: cc?.code ?? '', name: cc?.name ?? '', client: cc?.client ?? '', description: cc?.description ?? '', is_active: cc?.is_active ?? true });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      if (!d.code.trim() || !d.name.trim()) throw new Error('A cost center needs a code and a name.');
      return saveCostCenter(cc?.id ?? null, { code: d.code.trim(), name: d.name.trim(), client: d.client.trim() || null, description: d.description.trim() || null, is_active: d.is_active });
    },
    onSuccess: (res) => { onSaved(res); onClose(); },
    onError: (e) => setProblem(errText(e, 'Could not save the cost center.')),
  });
  return (
    <Sheet title={cc ? `${cc.code} · ${cc.name}` : 'New cost center'} icon="briefcase" onClose={onClose} problem={problem}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button></>}>
      <div className="pf-form">
        <F label="Code"><input className="fld mono" autoFocus={!cc} value={d.code} onChange={(e) => setD((c) => ({ ...c, code: e.target.value }))} /></F>
        <F label="Name"><input className="fld" value={d.name} onChange={(e) => setD((c) => ({ ...c, name: e.target.value }))} /></F>
        <F label="Client" wide hint="Leave empty when it is not tied to one client.">
          <input className="fld" list="pu-clients" value={d.client} onChange={(e) => setD((c) => ({ ...c, client: e.target.value }))} />
          <datalist id="pu-clients">{clients.map((c) => <option key={c} value={c} />)}</datalist>
        </F>
        <F label="What it covers" wide><textarea className="fld" rows={2} value={d.description} onChange={(e) => setD((c) => ({ ...c, description: e.target.value }))} /></F>
        {cc && <label className="tmap-check pf-field"><input type="checkbox" checked={d.is_active} onChange={(e) => setD((c) => ({ ...c, is_active: e.target.checked }))} /><span>Active — clear it to stop offering this cost center</span></label>}
      </div>
    </Sheet>
  );
}

function AfeDialog({ afe, centers, onClose, onSaved }: { afe: Afe | null; centers: CostCenter[]; onClose: () => void; onSaved: (r: BudgetsResponse) => void }) {
  const [d, setD] = useState({ afe_number: afe?.afe_number ?? '', title: afe?.title ?? '', cost_center_id: afe?.cost_center?.id ?? '', amount: afe ? String(afe.amount) : '', valid_from: afe?.valid_from ?? '', valid_to: afe?.valid_to ?? '', note: afe?.note ?? '', status: afe?.status ?? 'open' });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const amount = numOrNull(d.amount);
      if (!d.title.trim() || (!afe && !d.afe_number.trim())) throw new Error('An AFE needs a number and a title.');
      if (amount === null) throw new Error('Give the amount authorized.');
      return saveAfe(afe?.id ?? null, { ...(afe ? {} : { afe_number: d.afe_number.trim() }), title: d.title.trim(), cost_center_id: d.cost_center_id || null, amount, valid_from: d.valid_from || null, valid_to: d.valid_to || null, note: d.note.trim() || null, status: d.status as 'open' | 'closed' });
    },
    onSuccess: (res) => { onSaved(res); onClose(); },
    onError: (e) => setProblem(errText(e, 'Could not save the AFE.')),
  });
  return (
    <Sheet title={afe ? afe.afe_number : 'New AFE'} icon="card" onClose={onClose} problem={problem}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button></>}>
      <div className="pf-form">
        <F label="AFE number"><input className="fld mono" autoFocus={!afe} disabled={Boolean(afe)} value={d.afe_number} onChange={(e) => setD((c) => ({ ...c, afe_number: e.target.value }))} /></F>
        <F label="Amount authorized"><input className="fld" type="number" min="0" step="0.01" value={d.amount} onChange={(e) => setD((c) => ({ ...c, amount: e.target.value }))} /></F>
        <F label="Title" wide><input className="fld" value={d.title} onChange={(e) => setD((c) => ({ ...c, title: e.target.value }))} /></F>
        <F label="Cost center">
          <select className="fld" value={d.cost_center_id} onChange={(e) => setD((c) => ({ ...c, cost_center_id: e.target.value }))}>
            <option value="">None</option>
            {centers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </select>
        </F>
        <F label="Status">
          <select className="fld" value={d.status} onChange={(e) => setD((c) => ({ ...c, status: e.target.value as 'open' | 'closed' }))}><option value="open">Open</option><option value="closed">Closed</option></select>
        </F>
        <F label="Valid from"><input className="fld" type="date" value={d.valid_from} onChange={(e) => setD((c) => ({ ...c, valid_from: e.target.value }))} /></F>
        <F label="Valid to"><input className="fld" type="date" value={d.valid_to} onChange={(e) => setD((c) => ({ ...c, valid_to: e.target.value }))} /></F>
        <F label="Note" wide><textarea className="fld" rows={2} value={d.note} onChange={(e) => setD((c) => ({ ...c, note: e.target.value }))} /></F>
      </div>
    </Sheet>
  );
}

// ═══ On a work order (its Payables tab) ══════════════════════════════════════

export function WoPurchasingCard({ woId, woNumber }: { woId: string; woNumber: string }) {
  const qc = useQueryClient();
  const key = ['wo-purchasing', woId];
  const q = useQuery({ queryKey: key, queryFn: () => getWoPurchasing(woId), retry: false });
  const [pr, setPr] = useState<PurchaseRequest | 'new' | null>(null);
  const [rfq, setRfq] = useState<Rfq | 'new' | null>(null);
  const [po, setPo] = useState<PurchaseOrder | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useMutation({
    mutationFn: (x: { cost_center_id?: string | null; afe_id?: string | null }) => setWoFiling(woId, x),
    onSuccess: (res: WoPurchasing) => { qc.setQueryData(key, res); setError(null); void qc.invalidateQueries({ queryKey: ['activity'] }); },
    onError: (e) => setError(errText(e, 'Could not file it.')),
  });
  const d = q.data;
  if (!d) return null;
  const m = d.meta;
  const any = m.can.requests.view || m.can.rfqs.view || m.can.orders.view;
  if (!any && !m.can.budgets.view) return null;
  const empty = d.requests.length + d.rfqs.length + d.orders.length === 0;
  return (
    <section className="card pu-wo">
      <div className="card-head">
        <h2 className="card-title grow">Purchasing</h2>
        {m.can.requests.create && <button type="button" className="btn btn-sm is-ghost" onClick={() => setPr('new')}><Icon name="plus" size={12} /> Purchase request</button>}
        {m.can.rfqs.create && <button type="button" className="btn btn-sm is-ghost" onClick={() => setRfq('new')}><Icon name="plus" size={12} /> Ask for quotes</button>}
        {m.can.orders.create && <button type="button" className="btn btn-sm is-ghost" onClick={() => setPo('new')}><Icon name="plus" size={12} /> Purchase order</button>}
      </div>
      {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
      {m.can.budgets.view && (m.cost_centers.length > 0 || d.cost_center) && (
        <div className="vx-settings">
          <label className="mt-range">Cost center
            <select className="fld" value={d.cost_center?.id ?? ''} disabled={!d.can_file || file.isPending} onChange={(e) => file.mutate({ cost_center_id: e.target.value || null })}>
              <option value="">None</option>
              {d.cost_center && !m.cost_centers.some((c) => c.id === d.cost_center!.id) && <option value={d.cost_center.id}>{d.cost_center.code} · {d.cost_center.name}</option>}
              {m.cost_centers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </label>
          {(m.afes.length > 0 || d.afe) && (
            <label className="mt-range">AFE
              <select className="fld" value={d.afe?.id ?? ''} disabled={!d.can_file || file.isPending} onChange={(e) => file.mutate({ afe_id: e.target.value || null })}>
                <option value="">None</option>
                {d.afe && !m.afes.some((a) => a.id === d.afe!.id) && <option value={d.afe.id}>{d.afe.afe_number} · {d.afe.title}</option>}
                {m.afes.map((a) => <option key={a.id} value={a.id}>{a.afe_number} · {a.title}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      {any && (empty ? (
        <div className="empty-flat">Nothing bought for this work order yet.</div>
      ) : (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead><tr><th>Document</th><th>What</th><th>Vendor</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {d.requests.map((r) => (
                <tr key={r.id}><td><button type="button" className="link-btn mono" onClick={() => setPr(r)}>{r.pr_number}</button></td><td>{r.title}</td><td>{r.vendor?.name ?? '—'}</td><td className="num">{usd(r.estimate)}</td><td><PrChip status={r.status} /></td></tr>
              ))}
              {d.rfqs.map((r) => (
                <tr key={r.id}><td><button type="button" className="link-btn mono" onClick={() => setRfq(r)}>{r.rfq_number}</button></td><td>{r.title}</td><td>{r.vendors.length} asked · {r.quotes.length} quoted</td><td className="num">—</td><td><RfqChip status={r.status} /></td></tr>
              ))}
              {d.orders.map((r) => (
                <tr key={r.id}><td><button type="button" className="link-btn mono" onClick={() => setPo(r)}>{r.po_number}</button></td><td>{r.lines.length} {r.lines.length === 1 ? 'item' : 'items'}</td><td>{r.vendor.name}</td><td className="num">{usd(r.total)}</td><td><PoChip status={r.status} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {any && <p className="hint mt-hint">A purchase order is a document beside the work order: it does not change the work order’s Cost.</p>}
      {pr && <RequestDialog request={pr === 'new' ? null : pr} meta={m} woNumber={woNumber} onClose={() => setPr(null)} onOrder={setPo} onRfq={setRfq} />}
      {rfq && <RfqDialog rfq={rfq === 'new' ? null : rfq} meta={m} woNumber={woNumber} onClose={() => setRfq(null)} onOrder={setPo} />}
      {po && <OrderDialog order={po === 'new' ? null : po} meta={m} woNumber={woNumber} onClose={() => setPo(null)} />}
    </section>
  );
}
