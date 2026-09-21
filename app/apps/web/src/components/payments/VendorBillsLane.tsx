/* The Vendor bills lane of the Payments page, and the "Record bill" dialog
   the work order's Payables tab shares (0047).

   A vendor bill is the technician's own invoice for the job. It is recorded
   (anyone who may raise a payment request), approved (payments:approve —
   and the amount's tier, rule 6.2.3), then paid (payments/process:edit).
   Every verb the viewer may not use stays VISIBLE and locked with the
   reason, never hidden (product/quotes-payments.md discoverability rule). */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  VENDOR_BILL_STATUS_HINTS,
  VENDOR_BILL_STATUS_LABELS,
  vendorBillNextActions,
  type VendorBill,
  type VendorBillCreateInput,
  type VendorBillLineInput,
  type VendorBillStatus,
} from '@theone/shared';
import {
  ApiRequestError,
  approveVendorBill,
  createVendorBill,
  disputeVendorBill,
  listVendorBills,
  markVendorBillPaid,
  resolveVendorBill,
  voidVendorBill,
} from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../Icon';
import { usd } from '../../lib/quoteTotals';

const STATUS_CHIP: Record<VendorBillStatus, string> = {
  received: 'chip-outline',
  approved: '',
  paid: 'chip-accent',
  disputed: 'chip-danger',
  void: 'chip-outline',
};

/** The shared hook: every verb, its permission and its refresh. */
export function useVendorBillActions(onDone?: () => void) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: ['vendor-bills'] });
    void qc.invalidateQueries({ queryKey: ['wo-vendor-bills'] });
    void qc.invalidateQueries({ queryKey: ['wo-activity'] });
    void qc.invalidateQueries({ queryKey: ['wo-feed'] });
    onDone?.();
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : 'That did not go through');
  const act = useMutation({
    mutationFn: async ({ kind, id, text }: { kind: string; id: string; text?: string }) => {
      switch (kind) {
        case 'approve':
          return approveVendorBill(id);
        case 'mark_paid':
          return markVendorBillPaid(id, text ?? null);
        case 'dispute':
          return disputeVendorBill(id, text ?? '');
        case 'resolve':
          return resolveVendorBill(id);
        case 'void':
          return voidVendorBill(id);
        default:
          throw new Error(`Unknown action ${kind}`);
      }
    },
    onSuccess: refresh,
    onError: fail,
  });
  return { act, error, setError, refresh };
}

export function VendorBillsLane() {
  const { can } = useAuth();
  const canRecord = can('payments', 'create');
  const q = useQuery({ queryKey: ['vendor-bills'], queryFn: listVendorBills, retry: 0 });
  const items = q.data?.items ?? [];
  const totals = q.data?.totals;
  const [recording, setRecording] = useState(false);
  const { act, error } = useVendorBillActions();

  return (
    <>
      <div className="payq-head">
        <div className="payq-sum">
          <span>On file, not agreed <b>{usd(totals?.received ?? 0)}</b></span>
          <span>Approved, unpaid <b>{usd(totals?.approved ?? 0)}</b></span>
          {(totals?.overdue ?? 0) > 0 && <span>Past due <b>{usd(totals?.overdue ?? 0)}</b></span>}
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canRecord}
          title={canRecord ? 'Record a bill a vendor sent us' : 'You cannot record vendor bills'}
          onClick={() => setRecording(true)}
        >
          <Icon name="plus" size={14} /> Record bill
        </button>
      </div>

      {error && (
        <p className="payq-err" role="alert">
          <Icon name="alert-circle" size={14} /> {error}
        </p>
      )}

      <div className="table-wrap">
        <table className="ct">
          <thead>
            <tr>
              <th className="col-wo">WO #</th>
              <th>Vendor · Bill #</th>
              <th>Client</th>
              <th className="col-date">Received · Due</th>
              <th className="num">Total</th>
              <th>Status</th>
              <th className="rcv-action-th">Decision</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && <tr className="ct-empty"><td colSpan={7}>Loading vendor bills…</td></tr>}
            {q.isError && <tr className="ct-empty"><td colSpan={7}>Could not load vendor bills.</td></tr>}
            {!q.isLoading && !q.isError && items.length === 0 && (
              <tr className="ct-empty"><td colSpan={7}>No vendor bills on file. Record the first one from a work order's Payables tab, or here.</td></tr>
            )}
            {items.map((b) => (
              <tr key={b.id}>
                <td className="col-wo">
                  <Link className="wo-num wo-num-link" to={`/work-orders/${encodeURIComponent(b.wo_number)}`}>
                    {b.wo_number}
                  </Link>
                </td>
                <td>
                  <div className="site">
                    <strong>{b.vendor_name}</strong>
                    <small className="mono">{b.bill_number ?? '—'}</small>
                  </div>
                </td>
                <td className="rcv-trunc">{b.client ?? '—'}</td>
                <td className="col-date">
                  {b.received_on}
                  {b.due_on ? ` · due ${b.due_on}` : ''}
                  {b.overdue_days ? <span className="rcv-status-extra"> · {b.overdue_days}d overdue</span> : null}
                </td>
                <td className="num">{usd(b.total)}</td>
                <td>
                  <span className={`chip chip-sm ${STATUS_CHIP[b.status]}`} title={VENDOR_BILL_STATUS_HINTS[b.status]}>
                    {VENDOR_BILL_STATUS_LABELS[b.status]}
                  </span>
                  {b.tier && <small className="payq-tier"> {b.tier.label}</small>}
                </td>
                <td className="rcv-action-td">
                  <VendorBillActions bill={b} busy={act.isPending} onAct={(kind, text) => act.mutate({ kind, id: b.id, text })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {recording && <RecordBillDialog onClose={() => setRecording(false)} onSaved={() => setRecording(false)} />}
    </>
  );
}

/** The verbs for one bill, each locked with its reason when the viewer may
    not use it. */
export function VendorBillActions({
  bill,
  busy,
  onAct,
}: {
  bill: VendorBill;
  busy: boolean;
  onAct: (kind: string, text?: string) => void;
}) {
  const { can } = useAuth();
  const canApprove = can('payments', 'approve');
  const canProcess = can('payments/process', 'edit');
  const canRecord = can('payments', 'create');
  const next = vendorBillNextActions(bill.status);
  const [asking, setAsking] = useState<'dispute' | 'paid' | null>(null);
  const [text, setText] = useState('');

  if (next.length === 0) {
    return <span className="rcv-none">{bill.status === 'paid' ? `Paid${bill.paid_reference ? ` · ${bill.paid_reference}` : ''}` : 'Void'}</span>;
  }

  const tierBlocked = bill.tier !== null && !bill.tier.allowed;

  return (
    <span className="payq-actions">
      {next.includes('approve') && (
        <button
          type="button"
          className="rcv-btn is-primary"
          disabled={!canApprove || tierBlocked || busy}
          title={
            !canApprove
              ? 'You cannot approve vendor bills'
              : tierBlocked
                ? `${bill.tier?.label}: needs a role allowed for this amount (rule 6.2.3)`
                : 'Agree the bill'
          }
          onClick={() => onAct('approve')}
        >
          <Icon name="check" size={12} /> Approve
        </button>
      )}
      {next.includes('mark_paid') && asking !== 'paid' && (
        <button
          type="button"
          className="rcv-btn is-primary"
          disabled={!canProcess || busy}
          title={canProcess ? 'Record that it was paid' : 'You cannot mark vendor bills paid'}
          onClick={() => setAsking('paid')}
        >
          <Icon name="dollar" size={12} /> Mark paid
        </button>
      )}
      {next.includes('resolve') && (
        <button type="button" className="rcv-btn" disabled={!canRecord || busy} onClick={() => onAct('resolve')}>
          <Icon name="refresh" size={12} /> Resolved
        </button>
      )}
      {next.includes('dispute') && asking !== 'dispute' && (
        <button type="button" className="rcv-btn" disabled={!canRecord || busy} onClick={() => setAsking('dispute')}>
          <Icon name="flag" size={12} /> Dispute
        </button>
      )}
      {next.includes('void') && (
        <button type="button" className="rcv-btn" disabled={!canRecord || busy} title="Cancel this bill" onClick={() => onAct('void')}>
          <Icon name="x" size={12} />
        </button>
      )}
      {asking && (
        <span className="payq-inline">
          <input
            className="fld"
            autoFocus
            placeholder={asking === 'dispute' ? 'What is wrong with it?' : 'Payment reference (optional)'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="button"
            className="rcv-btn is-primary"
            disabled={busy || (asking === 'dispute' && text.trim() === '')}
            onClick={() => {
              onAct(asking === 'dispute' ? 'dispute' : 'mark_paid', text.trim() || undefined);
              setAsking(null);
              setText('');
            }}
          >
            {asking === 'dispute' ? 'Dispute' : 'Paid'}
          </button>
          <button type="button" className="rcv-btn" onClick={() => setAsking(null)}>Cancel</button>
        </span>
      )}
    </span>
  );
}

interface DraftLine {
  key: number;
  description: string;
  quantity: string;
  unit_price: string;
}
let seq = 0;
const blank = (): DraftLine => ({ key: ++seq, description: '', quantity: '1', unit_price: '' });

/** Record a bill: the vendor, their number, the dates, the lines. When opened
    from a work order the WO is fixed; from the Payments page it is typed. */
export function RecordBillDialog({
  taskId,
  woNumber,
  onClose,
  onSaved,
}: {
  taskId?: string;
  woNumber?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { refresh } = useVendorBillActions();
  const [wo, setWo] = useState(taskId ?? '');
  const [vendor, setVendor] = useState('');
  const [number, setNumber] = useState('');
  const [received, setReceived] = useState(new Date().toISOString().slice(0, 10));
  const [due, setDue] = useState('');
  const [tax, setTax] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([blank()]);
  const [error, setError] = useState<string | null>(null);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const input = (): VendorBillCreateInput => ({
    task_id: wo.trim(),
    vendor_name: vendor.trim(),
    bill_number: number.trim() || null,
    received_on: received,
    due_on: due || null,
    tax: tax.trim() === '' ? 0 : Number(tax),
    note: note.trim() || null,
    lines: lines
      .filter((l) => l.description.trim() !== '')
      .map((l): VendorBillLineInput => ({
        description: l.description.trim(),
        quantity: Number(l.quantity) || 1,
        unit_price: Number(l.unit_price) || 0,
      })),
  });

  const save = useMutation({
    mutationFn: () => createVendorBill(input()),
    onSuccess: () => {
      refresh();
      onSaved();
    },
    onError: (err: unknown) => setError(err instanceof ApiRequestError ? err.message : 'The bill did not save'),
  });

  const total = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0) + (Number(tax) || 0);
  const missing =
    wo.trim() === ''
      ? 'the work order'
      : vendor.trim() === ''
        ? 'the vendor'
        : !lines.some((l) => l.description.trim() !== '')
          ? 'a line'
          : null;

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="Record a vendor bill" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Record a vendor bill{woNumber ? ` on ${woNumber}` : ''}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="intake-grid">
            {!taskId && (
              <div className="field intake-wide">
                <label className="lbl" htmlFor="vb-wo">Work order id</label>
                <input id="vb-wo" className="fld mono" value={wo} onChange={(e) => setWo(e.target.value)} placeholder="Paste the work order's id (open it and copy from the address bar)" />
              </div>
            )}
            <div className="field">
              <label className="lbl" htmlFor="vb-vendor">Vendor</label>
              <input id="vb-vendor" className="fld" autoFocus value={vendor} onChange={(e) => setVendor(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="vb-number">Their invoice #</label>
              <input id="vb-number" className="fld" value={number} onChange={(e) => setNumber(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="vb-received">Received</label>
              <input id="vb-received" className="fld" type="date" value={received} onChange={(e) => setReceived(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="vb-due">Due</label>
              <input id="vb-due" className="fld" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="vb-tax">Tax</label>
              <input id="vb-tax" className="fld" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="0.00" />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="vb-note">Note</label>
              <input id="vb-note" className="fld" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>

          <table className="ct" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Line</th>
                <th className="num" style={{ width: 90 }}>Qty</th>
                <th className="num" style={{ width: 120 }}>Unit price</th>
                <th style={{ width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td><input className="fld" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label={`Line ${i + 1}`} /></td>
                  <td><input className="fld" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label={`Line ${i + 1} quantity`} /></td>
                  <td><input className="fld" inputMode="decimal" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} aria-label={`Line ${i + 1} unit price`} placeholder="0.00" /></td>
                  <td>
                    <button type="button" className="rowdel" aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLines([...lines, blank()])}>
            <Icon name="plus" size={12} /> Add line
          </button>

          {error && <p className="modal-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <span className="card-meta">{missing ? `Still needs ${missing}` : `Total ${usd(total)}`}</span>
          <button type="button" className="btn-sm is-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-sm is-primary" disabled={Boolean(missing) || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Record bill'}
          </button>
        </div>
      </div>
    </div>
  );
}
