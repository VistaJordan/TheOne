/* 0067 · The dialogs of Purchasing, shared by the Purchasing page and the
 * card on a work order.
 *
 *   RequestDialog   write or read a purchase request; submit, approve, reject
 *   RfqDialog       a request for quotation: what is asked, who is asked, the
 *                   quotes that came back side by side, and the award
 *   OrderDialog     a purchase order: draft, issue, receive, close
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PO_STATUS_LABELS,
  PR_STATUS_LABELS,
  RFQ_STATUS_LABELS,
  compareQuotes,
  purchaseRequestProblem,
  purchaseTotals,
  quoteTotalFromLines,
  type PoAction,
  type PoStatus,
  type PrAction,
  type PrStatus,
  type PurchaseOrder,
  type PurchaseRequest,
  type PurchasingMeta,
  type Rfq,
  type RfqAction,
  type RfqStatus,
} from '@theone/shared';
import {
  actOnPurchaseOrder,
  actOnPurchaseRequest,
  actOnRfq,
  awardVendorQuote,
  deleteVendorQuote,
  receivePurchaseOrder,
  savePurchaseOrder,
  savePurchaseRequest,
  saveRfq,
  saveVendorQuote,
  searchPurchasingVendors,
} from '../../api/client';
import { Icon } from '../Icon';
import { F, Sheet, dayText, errText, numOrNull, usd } from '../ui/Sheet';

const PR_TONE: Record<PrStatus, string> = { draft: '', submitted: ' chip-warn', approved: ' chip-ok', rejected: ' chip-danger', ordered: ' chip-accent', cancelled: ' chip-outline' };
const RFQ_TONE: Record<RfqStatus, string> = { draft: '', sent: ' chip-warn', closed: '', awarded: ' chip-ok', cancelled: ' chip-outline' };
const PO_TONE: Record<PoStatus, string> = { draft: '', issued: ' chip-warn', partially_received: ' chip-warn', received: ' chip-ok', closed: ' chip-accent', cancelled: ' chip-outline' };
export const PrChip = ({ status }: { status: PrStatus }) => <span className={`chip chip-sm${PR_TONE[status]}`}>{PR_STATUS_LABELS[status]}</span>;
export const RfqChip = ({ status }: { status: RfqStatus }) => <span className={`chip chip-sm${RFQ_TONE[status]}`}>{RFQ_STATUS_LABELS[status]}</span>;
export const PoChip = ({ status }: { status: PoStatus }) => <span className={`chip chip-sm${PO_TONE[status]}`}>{PO_STATUS_LABELS[status]}</span>;

export function usePurchasingRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['purchasing'] });
    void qc.invalidateQueries({ queryKey: ['wo-purchasing'] });
    void qc.invalidateQueries({ queryKey: ['activity'] });
  };
}

// ── Lines ────────────────────────────────────────────────────────────────────

export interface DraftLine { description: string; qty: string; unit: string; unit_cost: string }
const blankLine = (): DraftLine => ({ description: '', qty: '1', unit: 'each', unit_cost: '' });
const toDraft = (lines: { description: string; qty: number; unit: string; unit_cost: number | null }[]): DraftLine[] =>
  lines.length ? lines.map((l) => ({ description: l.description, qty: String(l.qty), unit: l.unit, unit_cost: l.unit_cost === null ? '' : String(l.unit_cost) })) : [blankLine()];
const fromDraft = (lines: DraftLine[]) =>
  lines.filter((l) => l.description.trim()).map((l) => ({ description: l.description.trim(), qty: Number(l.qty) > 0 ? Number(l.qty) : 1, unit: l.unit.trim() || 'each', unit_cost: numOrNull(l.unit_cost) }));

function LinesEditor({ lines, onChange, disabled, costLabel, noCost }: { lines: DraftLine[]; onChange: (l: DraftLine[]) => void; disabled?: boolean; costLabel: string; noCost?: boolean }) {
  const set = (i: number, patch: Partial<DraftLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="pu-lines">
      <div className="pu-line pu-line-head"><span>Item</span><span>Qty</span><span>Unit</span>{!noCost && <span>{costLabel}</span>}<span /></div>
      {lines.map((l, i) => (
        <div className="pu-line" key={i}>
          <input className="fld" value={l.description} disabled={disabled} placeholder="What is it" onChange={(e) => set(i, { description: e.target.value })} aria-label="Item" />
          <input className="fld" type="number" min="0.01" step="any" value={l.qty} disabled={disabled} onChange={(e) => set(i, { qty: e.target.value })} aria-label="Quantity" />
          <input className="fld" value={l.unit} disabled={disabled} onChange={(e) => set(i, { unit: e.target.value })} aria-label="Unit" />
          {!noCost && <input className="fld" type="number" min="0" step="0.01" value={l.unit_cost} disabled={disabled} onChange={(e) => set(i, { unit_cost: e.target.value })} aria-label={costLabel} />}
          {!disabled ? <button type="button" className="icon-btn" aria-label="Remove this line" onClick={() => onChange(lines.length > 1 ? lines.filter((_, j) => j !== i) : [blankLine()])}><Icon name="x" size={12} /></button> : <span />}
        </div>
      ))}
      {!disabled && <button type="button" className="link-btn" onClick={() => onChange([...lines, blankLine()])}>+ Add a line</button>}
    </div>
  );
}

/** A vendor by name: type to search the records, or leave a typed name. */
function VendorField({ value, onChange, disabled, allowTyped }: { value: { id: string | null; name: string }; onChange: (v: { id: string | null; name: string }) => void; disabled?: boolean; allowTyped?: boolean }) {
  const [text, setText] = useState(value.name);
  useEffect(() => setText(value.name), [value.name]);
  const q = useQuery({ queryKey: ['purchasing', 'vendor-search', text], queryFn: () => searchPurchasingVendors(text), enabled: !disabled && text.trim().length >= 2 && text !== value.name });
  const hits = q.data?.hits ?? [];
  return (
    <div className="pu-vendor">
      <input className="fld" value={text} disabled={disabled} placeholder="Type a vendor’s name" onChange={(e) => { setText(e.target.value); onChange({ id: null, name: allowTyped ? e.target.value : '' }); }} aria-label="Vendor" />
      {value.id && <span className="chip chip-sm chip-ok">On file</span>}
      {hits.length > 0 && text !== value.name && (
        <ul>
          {hits.map((h) => (
            <li key={h.id}><button type="button" onClick={() => { onChange({ id: h.id, name: h.name }); setText(h.name); }}>{h.name}<small>{[h.primary_trade, [h.city, h.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</small></button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ═══ Purchase request ════════════════════════════════════════════════════════

export function RequestDialog({ request, meta, woNumber, onClose, onOrder, onRfq }: {
  request: PurchaseRequest | null;
  meta: PurchasingMeta;
  /** Raised from a work order: it is filed under it. */
  woNumber?: string;
  onClose: () => void;
  onOrder?: (order: PurchaseOrder) => void;
  onRfq?: (rfq: Rfq) => void;
}) {
  const refresh = usePurchasingRefresh();
  const can = meta.can.requests;
  const editable = request ? can.edit && (request.status === 'draft' || request.status === 'rejected') : can.create;
  const [d, setD] = useState({
    title: request?.title ?? '', reason: request?.reason ?? '', needed_by: request?.needed_by ?? '', task_ref: request?.task?.wo_number ?? woNumber ?? '',
    cost_center_id: request?.cost_center?.id ?? '',
  });
  const [vendor, setVendor] = useState<{ id: string | null; name: string }>({ id: request?.vendor?.id ?? null, name: request?.vendor?.name ?? '' });
  const [lines, setLines] = useState<DraftLine[]>(toDraft(request?.lines ?? []));
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const fail = (fallback: string) => ({ onError: (e: unknown) => setProblem(errText(e, fallback)) });
  const input = () => ({ title: d.title.trim(), reason: d.reason.trim() || null, needed_by: d.needed_by || null, task_ref: d.task_ref.trim() || null, cost_center_id: d.cost_center_id || null, vendor_id: vendor.id, vendor_name: vendor.id ? null : vendor.name.trim() || null, lines: fromDraft(lines) });
  const save = useMutation({ mutationFn: () => savePurchaseRequest(request?.id ?? null, input()), onSuccess: () => { refresh(); onClose(); } });
  const act = useMutation({
    mutationFn: async (action: PrAction) => {
      let id = request?.id;
      if (editable && action === 'submit') id = (await savePurchaseRequest(request?.id ?? null, input())).request.id;
      return actOnPurchaseRequest(id!, action, note.trim() || null);
    },
    onSuccess: () => { refresh(); onClose(); },
  });
  const toOrder = useMutation({ mutationFn: () => savePurchaseOrder(null, { request_id: request!.id }), onSuccess: (res) => { refresh(); onClose(); onOrder?.(res.order); } });
  const toRfq = useMutation({ mutationFn: () => saveRfq(null, { request_id: request!.id }), onSuccess: (res) => { refresh(); onClose(); onRfq?.(res.rfq); } });
  const draft = fromDraft(lines);
  const estimate = purchaseTotals(draft, 0).subtotal;
  const submitProblem = purchaseRequestProblem(d.title, draft);
  const busy = save.isPending || act.isPending || toOrder.isPending || toRfq.isPending;

  return (
    <Sheet title={request ? <>{request.pr_number} <PrChip status={request.status} /></> : 'New purchase request'} icon="clipboard" onClose={onClose} problem={problem}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        {request?.status === 'submitted' && can.approve && (
          <>
            <button type="button" className="btn is-danger" disabled={busy} onClick={() => (note.trim() ? act.mutate('reject', fail('Could not reject it.')) : setProblem('Say why the request is rejected, in the note.'))}>Reject</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act.mutate('approve', fail('Could not approve it.'))}>Approve</button>
          </>
        )}
        {request?.status === 'approved' && meta.can.rfqs.create && request.rfqs.length === 0 && <button type="button" className="btn" disabled={busy} onClick={() => toRfq.mutate(undefined, fail('Could not start the request for quotation.'))}>Ask vendors for quotes</button>}
        {request?.status === 'approved' && meta.can.orders.create && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => toOrder.mutate(undefined, fail('Could not raise the order.'))}>Raise a purchase order</button>}
        {request && (request.status === 'rejected' || request.status === 'cancelled') && can.edit && <button type="button" className="btn" disabled={busy} onClick={() => act.mutate('reopen', fail('Could not reopen it.'))}>Back to draft</button>}
        {request && ['draft', 'submitted', 'approved'].includes(request.status) && can.edit && <button type="button" className="btn is-ghost" disabled={busy} onClick={() => act.mutate('cancel', fail('Could not cancel it.'))}>Cancel the request</button>}
        {editable && <button type="button" className="btn" disabled={busy} onClick={() => save.mutate(undefined, fail('Could not save the request.'))}>{request ? 'Save' : 'Save as draft'}</button>}
        {editable && can.create && <button type="button" className="btn btn-primary" disabled={busy || submitProblem !== null} title={submitProblem ?? undefined} onClick={() => act.mutate('submit', fail('Could not submit it.'))}>Submit for approval</button>}
      </>}>
      {request?.status === 'rejected' && request.decision_note && <p className="mt-banner is-danger"><Icon name="alert-circle" size={14} />Rejected by {request.decided_by?.name ?? 'a manager'}: {request.decision_note}</p>}
      {request && (request.orders.length > 0 || request.rfqs.length > 0) && (
        <p className="mt-banner"><Icon name="info" size={14} />{[...request.rfqs.map((x) => x.rfq_number), ...request.orders.map((x) => x.po_number)].join(' · ')} {request.orders.length + request.rfqs.length === 1 ? 'was' : 'were'} raised from it.</p>
      )}
      <div className="pf-form">
        <F label="What is being bought" wide><input className="fld" autoFocus={!request} value={d.title} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, title: e.target.value }))} /></F>
        <F label="Work order" hint="Leave empty for stock or anything not tied to one job."><input className="fld mono" value={d.task_ref} disabled={!editable || Boolean(woNumber)} placeholder="WO-…" onChange={(e) => setD((c) => ({ ...c, task_ref: e.target.value }))} /></F>
        <F label="Needed by"><input className="fld" type="date" value={d.needed_by} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, needed_by: e.target.value }))} /></F>
        <F label="Suggested vendor"><VendorField value={vendor} onChange={setVendor} disabled={!editable} allowTyped /></F>
        {meta.cost_centers.length > 0 && (
          <F label="Cost center">
            <select className="fld" value={d.cost_center_id} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, cost_center_id: e.target.value }))}>
              <option value="">None</option>
              {meta.cost_centers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </F>
        )}
        <F label="Why" wide><textarea className="fld" rows={2} value={d.reason} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, reason: e.target.value }))} /></F>
        <div className="pf-field is-wide">
          <span className="lbl">Items</span>
          <LinesEditor lines={lines} onChange={setLines} disabled={!editable} costLabel="Est. unit cost" />
          <p className="pu-total">Estimate <b>{usd(estimate)}</b></p>
        </div>
        {request?.status === 'submitted' && can.approve && <F label="Note to the requester" wide hint="Needed to reject."><input className="fld" value={note} onChange={(e) => setNote(e.target.value)} /></F>}
      </div>
    </Sheet>
  );
}

// ═══ Request for quotation ═══════════════════════════════════════════════════

export function RfqDialog({ rfq: initial, meta, woNumber, onClose, onOrder }: { rfq: Rfq | null; meta: PurchasingMeta; woNumber?: string; onClose: () => void; onOrder?: (order: PurchaseOrder) => void }) {
  const refresh = usePurchasingRefresh();
  const [rfq, setRfq] = useState<Rfq | null>(initial);
  const can = meta.can.rfqs;
  const open = rfq ? rfq.status !== 'awarded' && rfq.status !== 'cancelled' : true;
  const editable = rfq ? can.edit && open : can.create;
  const [d, setD] = useState({ title: rfq?.title ?? '', description: rfq?.description ?? '', due_on: rfq?.due_on ?? '', task_ref: rfq?.task?.wo_number ?? woNumber ?? '' });
  const [lines, setLines] = useState<DraftLine[]>(toDraft(rfq?.lines ?? []));
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>(rfq?.vendors ?? []);
  const [pick, setPick] = useState<{ id: string | null; name: string }>({ id: null, name: '' });
  const [quoting, setQuoting] = useState<string | null>(null);
  const [q, setQ] = useState<{ prices: Record<string, string>; total: string; lead: string; ref: string; note: string }>({ prices: {}, total: '', lead: '', ref: '', note: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const fail = (fallback: string) => ({ onError: (e: unknown) => setProblem(errText(e, fallback)) });
  const took = (res: { rfq: Rfq }) => { setRfq(res.rfq); setVendors(res.rfq.vendors); setLines(toDraft(res.rfq.lines)); setProblem(null); refresh(); };
  const input = () => ({ title: d.title.trim(), description: d.description.trim() || null, due_on: d.due_on || null, task_ref: d.task_ref.trim() || null, lines: fromDraft(lines).map(({ unit_cost: _c, ...l }) => l), vendor_ids: vendors.map((v) => v.id) });
  const save = useMutation({ mutationFn: () => saveRfq(rfq?.id ?? null, input()), onSuccess: took });
  const act = useMutation({
    mutationFn: async (action: RfqAction) => {
      const id = action === 'send' && editable ? (await saveRfq(rfq?.id ?? null, input())).rfq.id : rfq!.id;
      return actOnRfq(id, action);
    },
    onSuccess: took,
  });
  const quote = useMutation({
    mutationFn: () => {
      const prices: Record<string, number> = {};
      for (const [k, v] of Object.entries(q.prices)) { const n = numOrNull(v); if (n !== null) prices[k] = n; }
      return saveVendorQuote(rfq!.id, { vendor_id: quoting!, prices, total: numOrNull(q.total), lead_days: numOrNull(q.lead) === null ? null : Math.round(numOrNull(q.lead)!), quote_ref: q.ref.trim() || null, note: q.note.trim() || null });
    },
    onSuccess: (res) => { took(res); setQuoting(null); },
  });
  const dropQuote = useMutation({ mutationFn: (id: string) => deleteVendorQuote(rfq!.id, id), onSuccess: took });
  const award = useMutation({ mutationFn: (id: string) => awardVendorQuote(rfq!.id, id), onSuccess: (res) => { refresh(); onClose(); onOrder?.(res.order); } });
  const startQuote = (vendorId: string) => {
    const cur = rfq?.quotes.find((x) => x.vendor.id === vendorId);
    setQ({ prices: Object.fromEntries(Object.entries(cur?.prices ?? {}).map(([k, v]) => [k, String(v)])), total: cur ? String(cur.total) : '', lead: cur?.lead_days != null ? String(cur.lead_days) : '', ref: cur?.quote_ref ?? '', note: cur?.note ?? '' });
    setQuoting(vendorId);
  };
  const cmp = rfq ? compareQuotes(rfq.lines, rfq.quotes) : null;
  const busy = save.isPending || act.isPending || quote.isPending || award.isPending || dropQuote.isPending;
  const qPrices: Record<string, number> = {};
  for (const [k, v] of Object.entries(q.prices)) { const n = numOrNull(v); if (n !== null) qPrices[k] = n; }
  const qFromLines = rfq ? quoteTotalFromLines(rfq.lines, qPrices) : null;
  const linesLocked = Boolean(rfq && rfq.status !== 'draft');

  return (
    <Sheet title={rfq ? <>{rfq.rfq_number} <RfqChip status={rfq.status} /></> : 'New request for quotation'} icon="send" onClose={onClose} problem={problem}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        {rfq && rfq.status === 'sent' && can.edit && <button type="button" className="btn is-ghost" disabled={busy} onClick={() => act.mutate('close', fail('Could not close it.'))}>Close to quotes</button>}
        {rfq && (rfq.status === 'closed' || rfq.status === 'cancelled') && can.edit && <button type="button" className="btn is-ghost" disabled={busy} onClick={() => act.mutate('reopen', fail('Could not reopen it.'))}>Reopen</button>}
        {rfq && open && can.edit && <button type="button" className="btn is-ghost" disabled={busy} onClick={() => act.mutate('cancel', fail('Could not cancel it.'))}>Cancel it</button>}
        {editable && <button type="button" className="btn" disabled={busy} onClick={() => save.mutate(undefined, fail('Could not save it.'))}>{rfq ? 'Save' : 'Save as draft'}</button>}
        {editable && (!rfq || rfq.status === 'draft') && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act.mutate('send', fail('Could not mark it as sent.'))} title="Marks it as out to the vendors. Nothing is emailed: contact them yourself.">Mark as sent to vendors</button>}
      </>}>
      {rfq?.order && <p className="mt-banner"><Icon name="check-circle" size={14} />Awarded. {rfq.order.po_number} was drafted from the winning quote.</p>}
      <div className="pf-form">
        <F label="What is to be quoted" wide><input className="fld" autoFocus={!rfq} value={d.title} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, title: e.target.value }))} /></F>
        <F label="Work order"><input className="fld mono" value={d.task_ref} disabled={!editable || Boolean(woNumber)} placeholder="WO-…" onChange={(e) => setD((c) => ({ ...c, task_ref: e.target.value }))} /></F>
        <F label="Quotes due by"><input className="fld" type="date" value={d.due_on} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, due_on: e.target.value }))} /></F>
        <F label="Details for the vendors" wide><textarea className="fld" rows={2} value={d.description} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, description: e.target.value }))} /></F>
        <div className="pf-field is-wide">
          <span className="lbl">Items</span>
          <LinesEditor lines={lines} onChange={setLines} disabled={!editable || linesLocked} costLabel="" noCost />
          {linesLocked && open && <span className="hint">The items are fixed once it is out to vendors, so every quote prices the same list.</span>}
        </div>
        <div className="pf-field is-wide">
          <span className="lbl">Vendors asked</span>
          {vendors.length > 0 && (
            <ul className="mt-precautions">
              {vendors.map((v) => {
                const got = rfq?.quotes.find((x) => x.vendor.id === v.id);
                return (
                  <li key={v.id}>
                    <span className="grow">{v.name}</span>
                    {got ? <span className="chip chip-sm chip-ok">Quoted {usd(got.total)}</span> : <span className="chip chip-sm chip-outline">No quote yet</span>}
                    {rfq && open && can.edit && <button type="button" className="link-btn" onClick={() => startQuote(v.id)}>{got ? 'Change quote' : 'Record quote'}</button>}
                    {editable && !got && <button type="button" className="icon-btn" aria-label={`Remove ${v.name}`} onClick={() => setVendors((cur) => cur.filter((x) => x.id !== v.id))}><Icon name="x" size={12} /></button>}
                  </li>
                );
              })}
            </ul>
          )}
          {editable && (
            <div className="mt-inline">
              <VendorField value={pick} onChange={(v) => { if (v.id && !vendors.some((x) => x.id === v.id)) { setVendors((cur) => [...cur, { id: v.id!, name: v.name }]); setPick({ id: null, name: '' }); } else setPick(v); }} />
            </div>
          )}
          {!rfq && <span className="hint">Save it first; quotes are recorded once it exists.</span>}
        </div>
      </div>

      {quoting && rfq && (
        <div className="pu-quote">
          <h3>Quote from {vendors.find((v) => v.id === quoting)?.name}</h3>
          <div className="pu-lines">
            <div className="pu-line pu-line-head"><span>Item</span><span>Qty</span><span>Unit</span><span>Unit price</span><span /></div>
            {rfq.lines.map((l) => (
              <div className="pu-line" key={l.id}>
                <span>{l.description}</span><span className="num">{l.qty}</span><span>{l.unit}</span>
                <input className="fld" type="number" min="0" step="0.01" value={q.prices[l.id] ?? ''} onChange={(e) => setQ((c) => ({ ...c, prices: { ...c.prices, [l.id]: e.target.value } }))} aria-label={`Unit price for ${l.description}`} />
                <span />
              </div>
            ))}
          </div>
          <div className="pf-form">
            <F label="Total quoted" hint={qFromLines !== null ? 'Every line is priced: the total is their sum.' : 'Or give only the total, when they did not price each line.'}>
              <input className="fld" type="number" min="0" step="0.01" value={qFromLines !== null ? String(qFromLines) : q.total} disabled={qFromLines !== null} onChange={(e) => setQ((c) => ({ ...c, total: e.target.value }))} />
            </F>
            <F label="Lead time (days)"><input className="fld" type="number" min="0" value={q.lead} onChange={(e) => setQ((c) => ({ ...c, lead: e.target.value }))} /></F>
            <F label="Their quote #"><input className="fld mono" value={q.ref} onChange={(e) => setQ((c) => ({ ...c, ref: e.target.value }))} /></F>
            <F label="Note"><input className="fld" value={q.note} onChange={(e) => setQ((c) => ({ ...c, note: e.target.value }))} /></F>
          </div>
          <div className="mt-inline">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => quote.mutate(undefined, fail('Could not save the quote.'))}>Save quote</button>
            <button type="button" className="btn btn-sm is-ghost" onClick={() => setQuoting(null)}>Cancel</button>
          </div>
        </div>
      )}

      {rfq && rfq.quotes.length > 0 && cmp && (
        <div className="pu-compare">
          <h3>Quotes side by side</h3>
          <div className="vend-wrap">
            <table className="vend-table mt-table">
              <thead>
                <tr><th>Item</th><th className="num">Qty</th>{rfq.quotes.map((x) => <th key={x.id} className="num">{x.vendor.name}</th>)}</tr>
              </thead>
              <tbody>
                {rfq.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.description}</td><td className="num">{l.qty} {l.unit}</td>
                    {rfq.quotes.map((x) => <td key={x.id} className={`num${cmp.lowest_by_line[l.id] === x.id ? ' pu-best' : ''}`}>{typeof x.prices[l.id] === 'number' ? usd(x.prices[l.id]) : '—'}</td>)}
                  </tr>
                ))}
                <tr className="pu-sum"><td>Total</td><td />{rfq.quotes.map((x) => <td key={x.id} className={`num${cmp.lowest_total === x.id ? ' pu-best' : ''}`}><b>{usd(x.total)}</b></td>)}</tr>
                <tr><td>Lead time</td><td />{rfq.quotes.map((x) => <td key={x.id} className={`num${cmp.fastest === x.id ? ' pu-best' : ''}`}>{x.lead_days === null ? '—' : `${x.lead_days} d`}</td>)}</tr>
                <tr><td>Their quote #</td><td />{rfq.quotes.map((x) => <td key={x.id} className="num mono">{x.quote_ref ?? '—'}</td>)}</tr>
                <tr>
                  <td /><td />
                  {rfq.quotes.map((x) => (
                    <td key={x.id} className="num">
                      {x.status === 'selected' ? <span className="chip chip-sm chip-ok">Awarded</span> : x.status === 'rejected' ? <span className="chip chip-sm chip-outline">Not chosen</span> : (
                        <>
                          {open && can.edit && meta.can.orders.create && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => award.mutate(x.id, fail('Could not award it.'))} title="Settles the request and drafts a purchase order from this quote">Award</button>}
                          {open && can.edit && <button type="button" className="icon-btn" aria-label={`Delete the quote from ${x.vendor.name}`} disabled={busy} onClick={() => dropQuote.mutate(x.id, fail('Could not delete the quote.'))}><Icon name="trash" size={12} /></button>}
                        </>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="hint">The lowest price on each row, the lowest total and the shortest lead time are marked.</p>
        </div>
      )}
    </Sheet>
  );
}

// ═══ Purchase order ══════════════════════════════════════════════════════════

export function OrderDialog({ order: initial, meta, woNumber, onClose }: { order: PurchaseOrder | null; meta: PurchasingMeta; woNumber?: string; onClose: () => void }) {
  const refresh = usePurchasingRefresh();
  const [order, setOrder] = useState<PurchaseOrder | null>(initial);
  const can = meta.can.orders;
  const editable = order ? can.edit && order.status === 'draft' : can.create;
  const receivable = Boolean(order && can.edit && ['issued', 'partially_received', 'received'].includes(order.status));
  const [d, setD] = useState({
    task_ref: order?.task?.wo_number ?? woNumber ?? '', expected_on: order?.expected_on ?? '', ship_to: order?.ship_to ?? '', note: order?.note ?? '',
    cost_center_id: order?.cost_center?.id ?? '', afe_id: order?.afe?.id ?? '', tax_rate_id: meta.tax_rates.find((r) => r.name === order?.tax_rate_name)?.id ?? (order ? '' : (meta.tax_rates.find((r) => r.is_default)?.id ?? '')),
  });
  const [vendor, setVendor] = useState<{ id: string | null; name: string }>({ id: order?.vendor.id ?? null, name: order?.vendor.name ?? '' });
  const [lines, setLines] = useState<DraftLine[]>(toDraft(order?.lines ?? []));
  const [got, setGot] = useState<Record<string, string>>(Object.fromEntries((order?.lines ?? []).map((l) => [l.id, String(l.received_qty ?? 0)])));
  const [problem, setProblem] = useState<string | null>(null);
  const fail = (fallback: string) => ({ onError: (e: unknown) => setProblem(errText(e, fallback)) });
  const took = (res: { order: PurchaseOrder }) => { setOrder(res.order); setLines(toDraft(res.order.lines)); setGot(Object.fromEntries(res.order.lines.map((l) => [l.id, String(l.received_qty ?? 0)]))); setProblem(null); refresh(); };
  const input = () => ({
    task_ref: d.task_ref.trim() || null, vendor_id: vendor.id, vendor_name: vendor.id ? null : vendor.name.trim() || null, expected_on: d.expected_on || null, ship_to: d.ship_to.trim() || null, note: d.note.trim() || null,
    cost_center_id: d.cost_center_id || null, afe_id: d.afe_id || null, tax_rate_id: d.tax_rate_id || null, lines: fromDraft(lines),
  });
  const save = useMutation({ mutationFn: () => savePurchaseOrder(order?.id ?? null, input()), onSuccess: took });
  const act = useMutation({
    mutationFn: async (action: PoAction) => {
      const id = action === 'issue' && editable ? (await savePurchaseOrder(order?.id ?? null, input())).order.id : order!.id;
      return actOnPurchaseOrder(id, action);
    },
    onSuccess: took,
  });
  const receive = useMutation({ mutationFn: () => receivePurchaseOrder(order!.id, order!.lines.map((l) => ({ line_id: l.id, received_qty: Number(got[l.id]) || 0 }))), onSuccess: took });
  const rate = meta.tax_rates.find((r) => r.id === d.tax_rate_id);
  const totals = editable ? purchaseTotals(fromDraft(lines), rate?.rate ?? 0) : { subtotal: order?.subtotal ?? 0, tax: order?.tax ?? 0, total: order?.total ?? 0 };
  const busy = save.isPending || act.isPending || receive.isPending;
  const afes = meta.afes.filter((a) => !d.cost_center_id || !a.cost_center_id || a.cost_center_id === d.cost_center_id);

  return (
    <Sheet title={order ? <>{order.po_number} <PoChip status={order.status} /></> : 'New purchase order'} icon="file" onClose={onClose} problem={problem}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        {order && <Link className="btn is-ghost" to={`/purchasing/orders/${order.id}/print`} target="_blank">Print / PDF</Link>}
        {order && order.status !== 'cancelled' && order.status !== 'closed' && (order.status === 'draft' ? can.edit : can.approve) && (order.received_value ?? 0) === 0 && <button type="button" className="btn is-ghost" disabled={busy} onClick={() => act.mutate('cancel', fail('Could not cancel it.'))}>Cancel the order</button>}
        {order && ['issued', 'partially_received', 'received'].includes(order.status) && can.edit && <button type="button" className="btn" disabled={busy} onClick={() => act.mutate('close', fail('Could not close it.'))}>Close the order</button>}
        {order?.status === 'closed' && can.edit && <button type="button" className="btn" disabled={busy} onClick={() => act.mutate('reopen', fail('Could not reopen it.'))}>Reopen</button>}
        {receivable && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => receive.mutate(undefined, fail('Could not record what arrived.'))}>Save what arrived</button>}
        {editable && <button type="button" className="btn" disabled={busy} onClick={() => save.mutate(undefined, fail('Could not save the order.'))}>{order ? 'Save' : 'Save as draft'}</button>}
        {editable && can.approve && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act.mutate('issue', fail('Could not issue it.'))} title="Makes the order firm. Nothing is emailed: send the printed order to the vendor yourself.">Issue the order</button>}
      </>}>
      {(order?.warnings ?? []).map((w, i) => <p key={i} className="mt-banner is-danger"><Icon name="alert" size={14} />{w}</p>)}
      {order && (order.request || order.rfq) && <p className="mt-banner"><Icon name="info" size={14} />Raised from {[order.request?.pr_number, order.rfq?.rfq_number].filter(Boolean).join(' and ')}.</p>}
      <div className="pf-form">
        <F label="Vendor" wide><VendorField value={vendor} onChange={setVendor} disabled={!editable} allowTyped /></F>
        <F label="Work order" hint="A purchase order does not change the work order’s Cost."><input className="fld mono" value={d.task_ref} disabled={!editable || Boolean(woNumber)} placeholder="WO-…" onChange={(e) => setD((c) => ({ ...c, task_ref: e.target.value }))} /></F>
        <F label="Expected on"><input className="fld" type="date" value={d.expected_on} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, expected_on: e.target.value }))} /></F>
        {meta.cost_centers.length > 0 && (
          <F label="Cost center">
            <select className="fld" value={d.cost_center_id} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, cost_center_id: e.target.value }))}>
              <option value="">None</option>
              {meta.cost_centers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </F>
        )}
        {meta.afes.length > 0 && (
          <F label="AFE">
            <select className="fld" value={d.afe_id} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, afe_id: e.target.value }))}>
              <option value="">None</option>
              {afes.map((a) => <option key={a.id} value={a.id}>{a.afe_number} · {a.title}</option>)}
            </select>
          </F>
        )}
        <F label="Ship to" wide><input className="fld" value={d.ship_to} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, ship_to: e.target.value }))} /></F>
        <div className="pf-field is-wide">
          <span className="lbl">{receivable ? 'Items — enter the total received so far' : 'Items'}</span>
          {receivable && order ? (
            <div className="pu-lines">
              <div className="pu-line pu-line-head"><span>Item</span><span>Ordered</span><span>Unit cost</span><span>Received</span><span /></div>
              {order.lines.map((l) => (
                <div className="pu-line" key={l.id}>
                  <span>{l.description}</span><span className="num">{l.qty} {l.unit}</span><span className="num">{usd(l.unit_cost)}</span>
                  <input className="fld" type="number" min="0" max={l.qty} step="any" value={got[l.id] ?? '0'} onChange={(e) => setGot((c) => ({ ...c, [l.id]: e.target.value }))} aria-label={`Received of ${l.description}`} />
                  <button type="button" className="link-btn" onClick={() => setGot((c) => ({ ...c, [l.id]: String(l.qty) }))}>All</button>
                </div>
              ))}
            </div>
          ) : (
            <LinesEditor lines={lines} onChange={setLines} disabled={!editable} costLabel="Unit cost" />
          )}
        </div>
        <F label="Tax rate">
          <select className="fld" value={d.tax_rate_id} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, tax_rate_id: e.target.value }))}>
            <option value="">No tax</option>
            {!editable && order?.tax_rate_name && !rate && <option value="">{order.tax_rate_name} · {order.tax_pct}%</option>}
            {meta.tax_rates.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.rate}%</option>)}
          </select>
        </F>
        <div className="pf-field">
          <span className="lbl">Totals</span>
          <p className="pu-total">Subtotal <b>{usd(totals.subtotal)}</b> · Tax <b>{usd(totals.tax)}</b> · Total <b>{usd(totals.total)}</b></p>
          {order && order.received_value > 0 && <p className="pu-total">Received so far <b>{usd(order.received_value)}</b></p>}
        </div>
        <F label="Note to the vendor" wide><textarea className="fld" rows={2} value={d.note} disabled={!editable} onChange={(e) => setD((c) => ({ ...c, note: e.target.value }))} /></F>
      </div>
      {order?.approved_by && <p className="hint">Issued by {order.approved_by.name} on {dayText(order.approved_at)}.</p>}
    </Sheet>
  );
}
