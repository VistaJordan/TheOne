import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Obligation } from '../../api/client';
import { ApiRequestError, snoozeObligation } from '../../api/client';
import { useInvalidateObligations } from '../../hooks/useObligations';
import { TIER_LABEL, ruleFullLabel, tierOf } from '../../lib/obligations';
import { Icon } from '../Icon';

/** The server bound: nothing sleeps for more than three days. */
const MAX_HOURS = 72;
const PRESETS = [1, 2, 4, 8, 24, 48, 72];

interface SnoozeDialogProps {
  ob: Obligation;
  onClose: () => void;
}

/**
 * Snooze = "I know, and here is when I will have it" — which is why the REASON
 * is mandatory and the whole thing is logged to the activity trail. There is no
 * dismiss button anywhere in S5: an obligation is silenced by EVIDENCE (a reply,
 * a quote, a status change) or it is not silenced at all.
 */
export function SnoozeDialog({ ob, onClose }: SnoozeDialogProps) {
  const [hours, setHours] = useState(4);
  const [reason, setReason] = useState('');
  const qc = useQueryClient();
  const invalidateObligations = useInvalidateObligations();
  const tier = tierOf(ob);

  const mutation = useMutation({
    mutationFn: () => snoozeObligation(ob.id, { hours, reason: reason.trim() }),
    onSuccess: () => {
      invalidateObligations();
      // A snooze writes an activity row against the work order.
      if (ob.wo_id) {
        void qc.invalidateQueries({ queryKey: ['wo-activity', ob.wo_id] });
        void qc.invalidateQueries({ queryKey: ['wo-feed', ob.wo_id] });
      }
      onClose();
    },
  });

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && hours > 0 && hours <= MAX_HOURS && !mutation.isPending;

  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="snoozeT"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="sheet snooze-sheet">
        <h2 className="sheet-t" id="snoozeT">
          <Icon name="clock" size={18} />
          Snooze this obligation
        </h2>
        <p className="sheet-b">
          <b>{ruleFullLabel(ob)}</b>
          {ob.wo_number ? ` · ${ob.wo_number}` : ''} · currently {TIER_LABEL[tier].toLowerCase()}.
          Snoozing moves the deadline and records the reason on the work order — it does not
          resolve anything.
        </p>

        <div className="snooze-field">
          <span className="overline">Snooze for</span>
          <div className="seg snooze-hours" role="group" aria-label="Snooze duration">
            {PRESETS.map((h) => (
              <button
                type="button"
                key={h}
                className={`seg-btn${hours === h ? ' is-on' : ''}`}
                aria-pressed={hours === h}
                onClick={() => setHours(h)}
              >
                {h < 24 ? `${h}h` : `${h / 24}d`}
              </button>
            ))}
          </div>
        </div>

        <label className="snooze-field">
          <span className="overline">
            Reason <span className="snooze-req">required</span>
          </span>
          <textarea
            autoFocus
            className="composer-input snooze-reason"
            placeholder="Why is this waiting? e.g. tech confirmed for 7am, client asked us to hold…"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        {tier >= 3 && (
          <p className="snooze-note" role="note">
            <Icon name="alert" size={12} />
            This obligation is critical — only ATL and above can snooze it.
          </p>
        )}

        {mutation.isError && (
          <p className="snooze-err" role="alert">
            <Icon name="alert-circle" size={12} />
            {errorText(mutation.error)}
          </p>
        )}

        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit}
            title={trimmed.length === 0 ? 'A reason is required' : undefined}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Snoozing…' : `Snooze ${hours < 24 ? `${hours}h` : `${hours / 24}d`}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function errorText(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'FORBIDDEN') {
      return `${err.message} — snoozing a critical obligation needs ATL or above.`;
    }
    return err.message;
  }
  return 'Could not snooze this obligation.';
}
