/* 0083 (UAT M7): "Mark paid" on a client invoice records HOW the client paid
   (the reference — a check number, an ACH trace, a remittance id) and WHEN the
   money arrived. Both are required by the API (POST /invoices/:id/paid
   {reference, paid_on}); this is the small dialog that asks for them. The
   grant is invoicing:edit, the same one every non-send move takes. */

import { useState } from 'react';
import { Icon } from '../Icon';

interface Props {
  number: string;
  busy: boolean;
  /** invoicing:edit — without it the button is drawn locked. */
  canEdit: boolean;
  className: string;
  iconSize?: 12 | 14;
  onConfirm: (reference: string, paidOn: string) => void;
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

export function MarkInvoicePaid({ number, busy, canEdit, className, iconSize = 12, onConfirm }: Props) {
  const [open, setOpen] = useState(false);
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const ok = reference.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(paidOn);

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={busy || !canEdit}
        title={canEdit ? 'Record the client’s payment' : 'You cannot change invoices'}
        onClick={() => {
          setReference('');
          setPaidOn(today());
          setOpen(true);
        }}
      >
        <Icon name="check" size={iconSize} />
        Mark paid
      </button>
      {open && (
        <div className="modal-scrim" onClick={() => !busy && setOpen(false)} role="presentation">
          <div
            className="modal is-narrow"
            role="dialog"
            aria-modal="true"
            aria-label={`Mark invoice ${number} paid`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2>Mark {number} paid</h2>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="modal-body">
              <label className="flabel" htmlFor={`paid-ref-${number}`}>
                Payment reference <span className="req" aria-hidden="true">*</span>
              </label>
              <input
                className="finput"
                id={`paid-ref-${number}`}
                value={reference}
                maxLength={120}
                placeholder="Check number, ACH trace, remittance id…"
                onChange={(e) => setReference(e.target.value)}
              />
              <label className="flabel" htmlFor={`paid-on-${number}`}>
                Date paid <span className="req" aria-hidden="true">*</span>
              </label>
              <input
                className="finput"
                id={`paid-on-${number}`}
                type="date"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
              />
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                aria-disabled={!ok || busy ? true : undefined}
                onClick={() => {
                  if (!ok || busy) return;
                  onConfirm(reference.trim(), paidOn);
                  setOpen(false);
                }}
              >
                Mark paid
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
