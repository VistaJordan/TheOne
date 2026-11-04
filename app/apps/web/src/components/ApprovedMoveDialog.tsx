/* Moving a work order to Approved (Elise, 2026-11-04).

   The move IS the client's yes: on a sent quote it records the client's
   approval — the option locks and becomes incurred work for any later
   round, and the NTE takes its price (planApprovedMove on the API). So the
   move asks how the client approved and, with several options, which one.
   A quote that has not reached the client refuses the move (the API says
   the same); with no quote, or one already decided, the status just moves
   and only an optional confirmation is asked. */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { approvedMovePlan, QUOTE_NOT_SENT_TEXT, QUOTE_OPTION_REQUIRED_TEXT } from '@theone/shared';
import { getWorkOrderQuote } from '../api/client';
import { Icon } from './Icon';

interface Props {
  woId: string;
  statusName: string;
  busy: boolean;
  error: string | null;
  onConfirm: (approval: { note: string; section_id: string | null } | undefined) => void;
  onCancel: () => void;
}

export function ApprovedMoveDialog({ woId, statusName, busy, error, onConfirm, onCancel }: Props) {
  const quoteQuery = useQuery({ queryKey: ['wo-quote', woId], queryFn: () => getWorkOrderQuote(woId) });
  const [note, setNote] = useState('');
  const [sectionId, setSectionId] = useState<string | null>(null);

  const plan = quoteQuery.data ? approvedMovePlan(quoteQuery.data.quote) : null;
  const options = plan?.kind === 'record' ? plan.options : [];
  const picked = options.length === 1 ? options[0].id : sectionId;
  const ready =
    plan?.kind === 'move' || (plan?.kind === 'record' && note.trim() !== '' && picked !== null);

  return (
    <div className="modal-scrim" onClick={() => !busy && onCancel()} role="presentation">
      <div
        className="modal is-narrow"
        role="dialog"
        aria-modal="true"
        aria-label={`Move to ${statusName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Move to {statusName}</h2>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          {quoteQuery.isLoading && <p className="hint">Reading the quote…</p>}
          {quoteQuery.isError && <p className="composer-err" role="alert">The quote could not be read.</p>}
          {plan?.kind === 'not_sent' && (
            <div className="callout callout-lock">
              <Icon name="lock" size={14} />
              <span>{QUOTE_NOT_SENT_TEXT}</span>
            </div>
          )}
          {plan?.kind === 'move' && (
            <p className="hint">
              {quoteQuery.data?.quote
                ? 'The client has already decided the quote, so only the status moves.'
                : 'There is no quote on this work order, so only the status moves.'}
            </p>
          )}
          {plan?.kind === 'record' && (
            <>
              <p className="hint">
                This records the client’s approval on the quote: the approved option is locked, becomes incurred work
                for any additional quote, and the NTE is set to its price.
              </p>
              {options.length > 1 && (
                <div className="field">
                  <span className="lbl">
                    {QUOTE_OPTION_REQUIRED_TEXT} <span className="req" aria-hidden="true">*</span>
                  </span>
                  {options.map((o) => (
                    <label key={o.id} className="check-row">
                      <input
                        type="radio"
                        name="approved-option"
                        checked={sectionId === o.id}
                        onChange={() => setSectionId(o.id)}
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              )}
              <div className="field">
                <label className="lbl" htmlFor="approved-move-note">
                  How did the client approve? <span className="req" aria-hidden="true">*</span>
                </label>
                <textarea
                  id="approved-move-note"
                  className="fld"
                  rows={3}
                  autoFocus
                  placeholder="Who approved, the PO number, by email or on the portal…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </>
          )}
          {error && <p className="composer-err" role="alert">{error}</p>}
        </div>
        <div className="sheet-f">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !ready}
            onClick={() =>
              onConfirm(plan?.kind === 'record' ? { note: note.trim(), section_id: picked } : undefined)
            }
          >
            {busy ? 'Moving…' : `Move to ${statusName}`}
          </button>
        </div>
      </div>
    </div>
  );
}
