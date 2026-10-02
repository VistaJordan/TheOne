/* 0066 · What the invoicing rules and the credit notes add to a vendor bill.
 *
 *   BillWarnings   a chip that says how many rules the bill trips; the reasons
 *                  are in its title and, on click, spelled out underneath.
 *                  A warning never blocks anything.
 *   BillCredits    the credit notes of a bill, its net, and "Credit note".
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CREDIT_NOTE_STATUS_LABELS, creditNoteProblem, type VendorBill } from '@theone/shared';
import { addVendorCreditNote, decideVendorCreditNote } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../Icon';
import { F, Sheet, errText, usd } from '../ui/Sheet';

export function BillWarnings({ bill }: { bill: VendorBill }) {
  const [open, setOpen] = useState(false);
  const list = bill.warnings ?? [];
  if (list.length === 0) return null;
  return (
    <span className="bx-warn">
      <button type="button" className="chip chip-sm chip-warn" title={list.map((w) => w.message).join('\n')} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="alert" size={12} /> {list.length} {list.length === 1 ? 'check' : 'checks'}
      </button>
      {open && <ul>{list.map((w, i) => <li key={`${w.rule}-${i}`}>{w.message}</li>)}</ul>}
    </span>
  );
}

function useBillRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['vendor-bills'] });
    void qc.invalidateQueries({ queryKey: ['wo-vendor-bills'] });
    void qc.invalidateQueries({ queryKey: ['wo-activity'] });
  };
}

function CreditDialog({ bill, onClose }: { bill: VendorBill; onClose: () => void }) {
  const refresh = useBillRefresh();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [ref, setRef] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const live = (bill.credit_notes ?? []).filter((c) => c.status !== 'void').reduce((s, c) => s + c.amount, 0);
  const save = useMutation({
    mutationFn: () => {
      const p = creditNoteProblem(Number(amount), reason, bill.total, live, bill.status);
      if (p) throw new Error(p);
      return addVendorCreditNote(bill.id, { amount: Number(amount), reason: reason.trim(), vendor_ref: ref.trim() || null });
    },
    onSuccess: () => { refresh(); onClose(); },
    onError: (e) => setProblem(errText(e, 'Could not save the credit note.')),
  });
  return (
    <Sheet title={`Credit note against ${bill.vendor_name}’s bill`} icon="card" onClose={onClose} problem={problem}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Raise credit note'}</button>
      </>}>
      <p className="rec-current"><span>Bill total <b>{usd(bill.total)}</b></span><span>Already credited <b>{usd(live)}</b></span><span>Left <b>{usd(Math.max(0, bill.total - live))}</b></span></p>
      <div className="pf-form">
        <F label="Amount"><input className="fld" type="number" min="0.01" step="0.01" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} /></F>
        <F label="Vendor’s credit memo #" hint="If they sent one."><input className="fld mono" value={ref} onChange={(e) => setRef(e.target.value)} /></F>
        <F label="What it is for" wide><textarea className="fld" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></F>
      </div>
      <p className="hint">A small credit is approved as it is written. A larger one waits for somebody who approves payments (the limit is set in Admin › Vendors &amp; map).</p>
    </Sheet>
  );
}

export function BillCredits({ bill }: { bill: VendorBill }) {
  const { can } = useAuth();
  const refresh = useBillRefresh();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notes = bill.credit_notes ?? [];
  const decide = useMutation({
    mutationFn: (x: { id: string; decision: 'approve' | 'void'; note?: string }) => decideVendorCreditNote(x.id, x.decision, x.note),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e) => setError(errText(e, 'That did not go through.')),
  });
  const canRaise = can('payments', 'create') && bill.status !== 'void';
  const canApprove = can('payments', 'approve');
  if (notes.length === 0 && !canRaise) return null;
  return (
    <div className="bx-credits">
      {notes.length > 0 && (
        <ul>
          {notes.map((c) => (
            <li key={c.id} className={c.status === 'void' ? 'is-off' : undefined}>
              <span className="mono">{c.credit_number}</span>
              <span className="bx-reason" title={c.reason}>{c.reason}</span>
              <span className={`chip chip-sm${c.status === 'pending' ? ' chip-warn' : c.status === 'void' ? ' chip-outline' : ''}`}>{CREDIT_NOTE_STATUS_LABELS[c.status]}</span>
              <b className="num">−{usd(c.amount)}</b>
              {c.status === 'pending' && canApprove && <button type="button" className="link-btn" disabled={decide.isPending} onClick={() => decide.mutate({ id: c.id, decision: 'approve' })}>Approve</button>}
              {c.status !== 'void' && canApprove && (
                <button type="button" className="link-btn" disabled={decide.isPending} onClick={() => { const note = window.prompt(`Why is ${c.credit_number} void?`); if (note && note.trim()) decide.mutate({ id: c.id, decision: 'void', note: note.trim() }); }}>Void</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="bx-foot">
        {(bill.credited ?? 0) > 0 && <span>Net of credits <b>{usd(bill.net_total ?? bill.total)}</b></span>}
        {canRaise && <button type="button" className="link-btn" onClick={() => setAdding(true)}>Credit note</button>}
      </div>
      {error && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
      {adding && <CreditDialog bill={bill} onClose={() => setAdding(false)} />}
    </div>
  );
}
