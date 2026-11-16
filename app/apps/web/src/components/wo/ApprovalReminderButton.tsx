/* Send reminder (Elise, 2026-11-16, UAT #48) — in the work order's header,
   for the dispatchers (OM Under Probation, OM, Senior OM) and the OP Admin.
   Drawn only while something on the work order waits for a manager: a status
   change, an NTE or money hold, a quote, a payment request, an NTE increase or
   a purchase request. The person picks which one, may add a note, and the
   managers who decide it get a notice (Notifications) that opens where it is
   decided. One reminder per approval per hour, whoever sends it — the API
   answers REMINDER_TOO_SOON otherwise, and the row says when the next may go. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { APPROVAL_REMINDER_NOTE_MAX, mayRemindApprovals, type PendingApproval } from '@theone/shared';
import { useAuth } from '../../auth/AuthProvider';
import { ApiRequestError, getPendingApprovals, sendApprovalReminder } from '../../api/client';
import { Icon } from '../Icon';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const timeOnly = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function ApprovalReminderButton({ woId, woNumber }: { woId: string; woNumber: string }) {
  const { actingAs } = useAuth();
  const allowed = mayRemindApprovals(actingAs?.role ?? null, actingAs?.is_super_admin === true);
  const [open, setOpen] = useState(false);
  const pending = useQuery({
    queryKey: ['wo-pending-approvals', woId],
    queryFn: () => getPendingApprovals(woId),
    enabled: allowed,
    retry: 0,
    staleTime: 30_000,
  });
  const items = pending.data?.items ?? [];
  if (!allowed || items.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen(true)}
        title="Remind the managers about an approval that is still waiting on this work order"
      >
        <Icon name="bell" size={14} />
        Send reminder
        <span className="payq-count is-hot">{items.length}</span>
      </button>
      {open && <ReminderDialog woId={woId} woNumber={woNumber} items={items} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReminderDialog({
  woId,
  woNumber,
  items,
  onClose,
}: {
  woId: string;
  woNumber: string;
  items: PendingApproval[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const firstReady = items.find((i) => !i.next_reminder_at) ?? items[0];
  const [pick, setPick] = useState<string>(firstReady ? `${firstReady.kind}:${firstReady.id}` : '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const chosen = items.find((i) => `${i.kind}:${i.id}` === pick) ?? null;

  const send = useMutation({
    mutationFn: () => sendApprovalReminder(woId, { kind: chosen!.kind, id: chosen!.id, note: note.trim() || null }),
    onSuccess: (res) => {
      setError(null);
      setNote('');
      setSent(`Reminder sent to ${res.sent_to} ${res.sent_to === 1 ? 'manager' : 'managers'}: ${res.item.label}.`);
      void qc.invalidateQueries({ queryKey: ['wo-pending-approvals', woId] });
    },
    onError: (err) => {
      setSent(null);
      setError(err instanceof ApiRequestError ? err.message : 'The reminder could not be sent.');
      void qc.invalidateQueries({ queryKey: ['wo-pending-approvals', woId] });
    },
  });

  const locked = chosen?.next_reminder_at ?? null;

  return (
    <div className="modal-scrim" onClick={send.isPending ? undefined : onClose} role="presentation">
      <div
        className="modal is-narrow confirm payq-dialog is-info"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remind-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head confirm-head">
          <span className="confirm-icon" aria-hidden="true">
            <Icon name="bell" size={18} />
          </span>
          <h2 id="remind-dialog-title">Send a reminder for this approval</h2>
        </div>
        <div className="modal-body">
          <p className="hint">
            Waiting for a manager on {woNumber}. The managers who can decide it get a notification that opens where they
            decide it.
          </p>
          <fieldset className="remind-list">
            <legend className="lbl">Which approval?</legend>
            {items.map((i) => {
              const key = `${i.kind}:${i.id}`;
              return (
                <label key={key} className={`remind-item${pick === key ? ' is-on' : ''}`}>
                  <input type="radio" name="remind-pick" value={key} checked={pick === key} onChange={() => setPick(key)} />
                  <span className="remind-item-text">
                    <b>{i.label}</b>
                    <span className="hint">
                      {i.requested_by ? `${i.requested_by} · ` : ''}waiting since {when(i.waiting_since)}
                      {i.reminded_at ? ` · last reminder ${when(i.reminded_at)}` : ''}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div className="field">
            <label className="lbl" htmlFor="remind-note">Note (optional)</label>
            <textarea
              id="remind-note"
              className="fld"
              rows={2}
              maxLength={APPROVAL_REMINDER_NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={send.isPending}
            />
          </div>
          {locked && <p className="hint">A reminder for this one was just sent. The next can go at {timeOnly(locked)}.</p>}
          {sent && (
            <p className="hint" role="status">
              <Icon name="check" size={12} /> {sent}
            </p>
          )}
          {error && (
            <p className="payq-err" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-sm is-ghost" onClick={onClose} disabled={send.isPending}>
            {sent ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => chosen && send.mutate()}
            disabled={send.isPending || !chosen || locked !== null}
          >
            <Icon name="send" size={12} />
            {send.isPending ? 'Sending…' : 'Send reminder'}
          </button>
        </div>
      </div>
    </div>
  );
}
