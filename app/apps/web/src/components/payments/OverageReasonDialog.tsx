import { useEffect, useState } from 'react';
import { OVERAGE_REASON_MAX, OVERAGE_REASON_MIN } from '@theone/shared';
import { Icon } from '../Icon';

interface OverageReasonDialogProps {
  /** The API's sentence: what the payment takes Cost past, and by how much. */
  message: string;
  busy: boolean;
  error: string | null;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}

/**
 * Elise, 2026-10-28: a payment request that takes Cost past the NTE or the
 * approved quote is still filed, but only with a reason. The API answers 409
 * PAYMENT_OVERAGE_REASON; this asks for the reason and the form resubmits
 * with it. The reason rides on the hold the manager decides (NTE override for
 * AM and the managers, over-the-quote for ATL and above).
 */
export function OverageReasonDialog({ message, busy, error, onSubmit, onCancel }: OverageReasonDialogProps) {
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= OVERAGE_REASON_MIN;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-scrim" onClick={busy ? undefined : onCancel} role="presentation">
      <div
        className="modal is-narrow confirm is-danger"
        role="dialog"
        aria-modal="true"
        aria-labelledby="overage-title"
        aria-describedby="overage-message"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head confirm-head">
          <span className="confirm-icon" aria-hidden="true">
            <Icon name="alert" size={18} />
          </span>
          <h2 id="overage-title">This payment goes over</h2>
        </div>
        <div className="modal-body">
          <p className="confirm-message" id="overage-message">
            {message}
          </p>
          <label className="snooze-field">
            <span className="overline">
              Reason <span className="snooze-req">required</span>
            </span>
            <textarea
              autoFocus
              className="composer-input snooze-reason"
              placeholder="Why does this payment go over? e.g. extra parts the client agreed on the phone, second trip…"
              value={reason}
              maxLength={OVERAGE_REASON_MAX}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <p className="confirm-note is-info">
            <Icon name="info" size={14} />
            <span>
              The request is filed and held. A manager sees your reason under Approvals and decides the hold before it
              can be approved or paid.
            </span>
          </p>
          {error && (
            <p className="ferr" role="alert">
              <Icon name="alert-circle" size={12} />
              {error}
            </p>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-sm is-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-sm is-danger"
            onClick={() => ok && onSubmit(reason.trim())}
            disabled={busy || !ok}
            title={ok ? undefined : `Write at least ${OVERAGE_REASON_MIN} characters`}
          >
            {busy ? 'Submitting…' : 'Submit with reason'}
          </button>
        </div>
      </div>
    </div>
  );
}
