/* Approve / decline a quote from outside the builder (0053, BRD §6.4:
   "Administrators can approve or decline a quote either from this tab or
   from Financials › Quote in the sidebar").

   The builder's single CTA runs approve THEN send — approving is the act of
   agreeing the price with the client, and this mirrors it exactly so a quote
   approved from a list row ends up in the same state as one approved from
   the builder. Declining needs a note, posted as an internal comment for the
   dispatcher (the same route the builder uses). */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QuoteStatus } from '@theone/shared';
import { ApiRequestError, approveQuote, rejectQuote, sendQuote } from '../../api/client';
import { Icon } from '../Icon';

interface QuoteDecisionProps {
  woNumber: string;
  status: QuoteStatus;
  /** The viewer holds `quotes:approve`. Nothing renders without it. */
  canApprove: boolean;
  /** Rule 1.5.2: an NTE override is waiting on a manager — approve locks. */
  nteHold?: boolean;
  /** 'row' draws the compact table buttons; 'card' the card-foot ones. */
  size?: 'row' | 'card';
  onDone?: () => void;
}

const NTE_HOLD_TIP = 'On hold — decide the NTE override under Approvals first (rule 1.5.2)';

export function QuoteDecision({ woNumber, status, canApprove, nteHold, size = 'card', onDone }: QuoteDecisionProps) {
  const qc = useQueryClient();
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const settle = () => {
    setError(null);
    setDeclining(false);
    setNote('');
    void qc.invalidateQueries({ queryKey: ['quotes'] });
    void qc.invalidateQueries({ queryKey: ['wo-quote', woNumber] });
    void qc.invalidateQueries({ queryKey: ['approvals'] });
    void qc.invalidateQueries({ queryKey: ['wo-activity'] });
    onDone?.();
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : 'That did not go through');

  const approve = useMutation({
    mutationFn: async () => {
      await approveQuote(woNumber);
      await sendQuote(woNumber);
    },
    onSuccess: settle,
    onError: fail,
  });
  const decline = useMutation({
    mutationFn: () => rejectQuote(woNumber, note.trim()),
    onSuccess: settle,
    onError: fail,
  });

  if (!canApprove || status !== 'pending_approval') return null;
  const busy = approve.isPending || decline.isPending;
  const primary = size === 'row' ? 'rcv-btn is-primary' : 'btn btn-sm btn-primary';
  const plain = size === 'row' ? 'rcv-btn' : 'btn btn-sm btn-danger';

  return (
    <span className="qd" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={primary}
        disabled={busy || nteHold}
        title={nteHold ? NTE_HOLD_TIP : 'Approve the quote and send it to the client CMMS'}
        onClick={() => approve.mutate()}
      >
        <Icon name="check" size={12} />
        {approve.isPending ? 'Approving…' : 'Approve & send'}
      </button>
      <button type="button" className={plain} disabled={busy} onClick={() => setDeclining(true)}>
        <Icon name="x" size={12} />
        Decline
      </button>
      {error && <span className="qd-err" role="alert">{error}</span>}

      {declining && (
        <div className="modal-scrim" onClick={() => !busy && setDeclining(false)} role="presentation">
          <div
            className="modal is-narrow"
            role="dialog"
            aria-modal="true"
            aria-label="Decline quote"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2>Decline quote {woNumber}</h2>
              <button type="button" className="icon-btn" onClick={() => setDeclining(false)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label className="lbl" htmlFor={`qd-note-${woNumber}`}>
                  Why is this going back to draft? <span className="req" aria-hidden="true">*</span>
                </label>
                <textarea
                  id={`qd-note-${woNumber}`}
                  className="fld"
                  rows={3}
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <span className="hint">
                  Posted as an internal comment on {woNumber} — feedback for the dispatcher, never for
                  the client.
                </span>
              </div>
              {error && <p className="composer-err" role="alert">{error}</p>}
            </div>
            <div className="sheet-f">
              <button type="button" className="btn" disabled={busy} onClick={() => setDeclining(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || note.trim() === ''}
                onClick={() => decline.mutate()}
              >
                {decline.isPending ? 'Declining…' : 'Decline with note'}
              </button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
