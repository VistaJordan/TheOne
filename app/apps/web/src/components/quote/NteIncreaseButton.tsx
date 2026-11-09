/* Request NTE increase, from the quote builder (Elise, 2026-11-04).

   A quote above the client NTE is not sent (409 QUOTE_OVER_NTE): the NTE is
   raised first through a manual NTE increase request (0064, wo_nte_request),
   which a manager decides under Approvals › NTE increase requests. This is
   the ask, drawn beside the locked Send to client: the amount opens at the
   quote's figure (rounded up to the dollar) and the reason is required, as
   the API asks. While a request is open it says so instead. */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, requestNteIncrease } from '../../api/client';
import { useWoRecord } from '../wo/record/RecordParts';
import { Icon } from '../Icon';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function NteIncreaseButton({ woNumber, quoteTotal, quoteNumber }: { woNumber: string; quoteTotal: number; quoteNumber: string | null }) {
  const qc = useQueryClient();
  const record = useWoRecord(woNumber);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: () => requestNteIncrease(woNumber, Number(amount), reason.trim()),
    onSuccess: () => {
      setOpen(false);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['wo-record'] });
      void qc.invalidateQueries({ queryKey: ['nte-requests'] });
      void qc.invalidateQueries({ queryKey: ['wo-activity'] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : 'The request did not go through'),
  });

  const pending = record.data?.nte_requests.find((n) => n.status === 'open');
  if (pending) {
    return (
      <span className="chip chip-accent" title={pending.reason}>
        <Icon name="clock" size={12} />
        NTE increase to {usd(pending.requested_nte)} waiting for a manager
      </span>
    );
  }

  const value = Number(amount);
  const valid = amount.trim() !== '' && Number.isFinite(value) && value > 0 && reason.trim() !== '';

  return (
    <>
      <button
        type="button"
        className="btn btn-lg"
        onClick={() => {
          setAmount(String(Math.ceil(quoteTotal)));
          setReason(`Quote ${quoteNumber ?? ''} for ${usd(quoteTotal)} is above the current NTE`.replace('  ', ' '));
          setError(null);
          setOpen(true);
        }}
      >
        <Icon name="plus" size={14} />
        Request NTE increase
      </button>
      {/* To the body: the button sits in the pinned header band, whose stacking
          context would otherwise keep this dialog under the work-order header. */}
      {open && createPortal(
        <div className="modal-scrim" onClick={() => !ask.isPending && setOpen(false)} role="presentation">
          <div className="modal is-narrow" role="dialog" aria-modal="true" aria-label="Request NTE increase" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Request NTE increase</h2>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label className="lbl" htmlFor="nte-ask-amount">
                  New NTE <span className="req" aria-hidden="true">*</span>
                </label>
                <input
                  id="nte-ask-amount"
                  className="fld"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                />
              </div>
              <div className="field">
                <label className="lbl" htmlFor="nte-ask-reason">
                  Why is more needed? <span className="req" aria-hidden="true">*</span>
                </label>
                <textarea id="nte-ask-reason" className="fld" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
                <span className="hint">A manager decides it under Approvals › NTE increase requests. Once approved, Send to client unlocks.</span>
              </div>
              {error && <p className="composer-err" role="alert">{error}</p>}
            </div>
            <div className="sheet-f">
              <button type="button" className="btn" disabled={ask.isPending} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={!valid || ask.isPending} onClick={() => ask.mutate()}>
                {ask.isPending ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
