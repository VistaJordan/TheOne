/* The status-change request on a work order's header (0025, rules 2.4.1–3).

   Two states, one chip beside the status pill:
     open       "→ Quote Ready · pending approval"   Reject · Hold · Approve (a manager)
                                                     Withdraw (the requester)
     on hold    "→ Quote Ready · on hold · by Jordan" Reject · Release · Approve (a manager)
     rejected   "Rejected: <reason> · by Jordan"      Request again · Understood

   An approval moves the status directly and is acknowledged as it is decided
   (0102), so it draws no chip. Understood acknowledges a rejection so it leaves the requester's
   My requests on /approvals; Request again just opens the status menu (a new
   request replaces nothing — the old row was decided — but is a fresh ask).
   Anyone may see the chip; only the requester (or an approver) can act.
   2026-10-27 (Elise): a manager decides right here — Approve is one click (a
   move into Approved asks how the client approved, statusApprovalNeedsNote),
   Reject asks the reason. Same routes as the Approvals inbox.
   0123 (Elise, 2026-11-04): Hold is the middle answer — "not yet", with an
   optional note. The request stays open and keeps its chip here and its
   place in the inbox; Release lifts the hold. */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { approvalSectionPermKey, statusApprovalNeedsNote, type StatusChangeState } from '@theone/shared';
import {
  ApiRequestError,
  acknowledgeApprovalTask,
  approveApprovalTask,
  holdApprovalTask,
  rejectApprovalTask,
  releaseApprovalTask,
  withdrawApprovalTask,
} from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { numericDate } from '../../lib/fields';
import { Icon } from '../Icon';

export function StatusChangeBanner({
  state,
  onRequestAgain,
}: {
  state: StatusChangeState;
  /** Opens the status menu — wired by the header. */
  onRequestAgain?: () => void;
}) {
  const qc = useQueryClient();
  const { actingAs, can } = useAuth();
  const mine = !!actingAs && state.requested_by?.id === actingAs.id;
  const approver = can(approvalSectionPermKey('status'), 'approve');
  const mayAct = mine || approver;
  /** The note dialog: the rejection reason, or how the client approved. */
  const [asking, setAsking] = useState<'approve' | 'reject' | 'hold' | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const needsNote = statusApprovalNeedsNote(state.to_status.name);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['work-orders'] });
    qc.invalidateQueries({ queryKey: ['approvals'] });
    qc.invalidateQueries({ queryKey: ['approval-counts'] });
    qc.invalidateQueries({ queryKey: ['wo-approvals'] });
    qc.invalidateQueries({ queryKey: ['wo-feed'] });
    qc.invalidateQueries({ queryKey: ['wo-activity'] });
  };
  const fail = (err: unknown) => setError(err instanceof ApiRequestError ? err.message : 'That did not go through');
  const done = () => {
    setAsking(null);
    setNote('');
    setError(null);
    invalidate();
  };
  const ack = useMutation({
    mutationFn: () => acknowledgeApprovalTask(state.approval_task_id),
    onSuccess: invalidate,
  });
  const withdraw = useMutation({
    mutationFn: () => withdrawApprovalTask(state.approval_task_id),
    onSuccess: invalidate,
  });
  const approve = useMutation({
    mutationFn: (text: string | null) => approveApprovalTask(state.approval_task_id, text),
    onSuccess: done,
    onError: fail,
  });
  const reject = useMutation({
    mutationFn: (text: string) => rejectApprovalTask(state.approval_task_id, text),
    onSuccess: done,
    onError: fail,
  });
  const hold = useMutation({
    mutationFn: (text: string | null) => holdApprovalTask(state.approval_task_id, text),
    onSuccess: done,
    onError: fail,
  });
  const release = useMutation({
    mutationFn: () => releaseApprovalTask(state.approval_task_id),
    onSuccess: done,
    onError: fail,
  });
  const busy =
    ack.isPending || withdraw.isPending || approve.isPending || reject.isPending || hold.isPending || release.isPending;
  const by = state.decided_by ? ` by ${state.decided_by.display_name}` : '';
  const when = state.decided_at ? numericDate(state.decided_at) : null;

  if (state.status === 'open') {
    // The requester withdraws; a manager (not deciding their own ask) decides.
    const decides = approver && !mine;
    const noteId = `scr-note-${state.approval_task_id}`;
    const held = state.hold;
    return (
      <>
        <span className={`scr scr-open${held ? ' is-held' : ''}`} role="status">
          <Icon name="clock" size={12} />
          <span className="scr-text">
            <b>→ {state.to_status.name}</b> · {held ? 'on hold' : 'pending approval'}
            {held?.by && <small> · held by {held.by.display_name}</small>}
            {held?.note && <small className="scr-note" title={held.note}> · {held.note}</small>}
            {state.requested_by && !mine && <small> · asked by {state.requested_by.display_name}</small>}
            {error && !asking && <small className="scr-note" title={error}> · {error}</small>}
          </span>
          {decides && (
            <>
              <button
                type="button"
                className="scr-act"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setNote('');
                  setAsking('reject');
                }}
              >
                Reject
              </button>
              {held ? (
                <button type="button" className="scr-act" disabled={busy} onClick={() => release.mutate()}>
                  {release.isPending ? 'Releasing…' : 'Release'}
                </button>
              ) : (
                <button
                  type="button"
                  className="scr-act"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setNote('');
                    setAsking('hold');
                  }}
                >
                  Hold
                </button>
              )}
              <button
                type="button"
                className="scr-act is-primary"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  if (needsNote) {
                    setNote('');
                    setAsking('approve');
                  } else approve.mutate(null);
                }}
              >
                {approve.isPending ? 'Approving…' : 'Approve'}
              </button>
            </>
          )}
          {mine && (
            <button type="button" className="scr-act" disabled={busy} onClick={() => withdraw.mutate()}>
              Withdraw
            </button>
          )}
        </span>
        {asking && (
          <div className="modal-scrim" onClick={() => !busy && setAsking(null)} role="presentation">
            <div
              className="modal is-narrow"
              role="dialog"
              aria-modal="true"
              aria-label={
                asking === 'reject'
                  ? 'Reject this status change'
                  : asking === 'hold'
                    ? 'Put this status change on hold'
                    : `Approve the move to ${state.to_status.name}`
              }
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-head">
                <h2>
                  {asking === 'reject'
                    ? 'Reject this status change'
                    : asking === 'hold'
                      ? 'Put this status change on hold'
                      : `Approve the move to ${state.to_status.name}?`}
                </h2>
                <button type="button" className="icon-btn" onClick={() => setAsking(null)} aria-label="Close" disabled={busy}>
                  <Icon name="x" size={16} />
                </button>
              </div>
              <div className="modal-body">
                <div className="field">
                  <label className="lbl" htmlFor={noteId}>
                    {asking === 'reject'
                      ? 'Why is it being rejected?'
                      : asking === 'hold'
                        ? 'Why is it on hold? (optional)'
                        : 'How did the client approve?'}
                    {asking !== 'hold' && (
                      <>
                        {' '}
                        <span className="req" aria-hidden="true">*</span>
                      </>
                    )}
                  </label>
                  <textarea
                    id={noteId}
                    className="fld"
                    rows={3}
                    autoFocus
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <span className="hint">
                    {asking === 'hold'
                      ? 'The request stays open and waiting — any manager can still approve or reject it.'
                      : 'Posted as an internal update on this work order — never shown to the client.'}
                  </span>
                </div>
                {error && <p className="composer-err" role="alert">{error}</p>}
              </div>
              <div className="sheet-f">
                <button type="button" className="btn" disabled={busy} onClick={() => setAsking(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={`btn ${asking === 'reject' ? 'btn-danger' : 'btn-primary'}`}
                  disabled={busy || (asking !== 'hold' && note.trim() === '')}
                  onClick={() =>
                    asking === 'reject'
                      ? reject.mutate(note.trim())
                      : asking === 'hold'
                        ? hold.mutate(note.trim() || null)
                        : approve.mutate(note.trim())
                  }
                >
                  {asking === 'reject'
                    ? reject.isPending ? 'Rejecting…' : 'Reject with note'
                    : asking === 'hold'
                      ? hold.isPending ? 'Holding…' : 'Put on hold'
                      : approve.isPending ? 'Approving…' : 'Approve'}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // 0102 (Elise): an approval moves the status and is acknowledged as it is
  // decided, so there is nothing for the requester to confirm — no chip.
  if (state.status === 'approved') return null;

  return (
    <span className="scr scr-rejected" role="status">
      <Icon name="x" size={12} />
      <span className="scr-text">
        <b>→ {state.to_status.name}</b> · rejected{by}
        {when && <small> · {when}</small>}
        {state.decision_note && (
          <small className="scr-note" title={state.decision_note}> · {state.decision_note}</small>
        )}
      </span>
      {mine && onRequestAgain && (
        <button type="button" className="scr-act" disabled={busy} onClick={onRequestAgain}>
          Request again
        </button>
      )}
      {mayAct && (
        <button type="button" className="scr-act is-primary" disabled={busy} onClick={() => ack.mutate()}>
          Understood
        </button>
      )}
    </span>
  );
}
