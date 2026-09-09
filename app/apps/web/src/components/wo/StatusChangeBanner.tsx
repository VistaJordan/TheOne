/* The status-change request on a work order's header (0025, rules 2.4.1–3).

   Three states, one chip beside the status pill:
     open       "→ Quote Ready · pending approval"   Withdraw (the requester)
     approved   "→ Quote Ready · approved by Jordan"  Continue
     rejected   "Rejected: <reason> · by Jordan"      Request again · Understood

   Continue / Understood acknowledge the decision so it leaves the requester's
   My requests on /approvals; Request again just opens the status menu (a new
   request replaces nothing — the old row was decided — but is a fresh ask).
   Anyone may see the chip; only the requester (or an approver) can act. */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { APPROVALS_PERM_KEY, approvalSectionPermKey, type StatusChangeState } from '@theone/shared';
import { acknowledgeApprovalTask, withdrawApprovalTask } from '../../api/client';
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
  const mayOpenInbox = can(APPROVALS_PERM_KEY, 'view');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['work-orders'] });
    qc.invalidateQueries({ queryKey: ['approvals'] });
    qc.invalidateQueries({ queryKey: ['approval-counts'] });
    qc.invalidateQueries({ queryKey: ['wo-approvals'] });
    qc.invalidateQueries({ queryKey: ['wo-feed'] });
    qc.invalidateQueries({ queryKey: ['wo-activity'] });
  };
  const ack = useMutation({
    mutationFn: () => acknowledgeApprovalTask(state.approval_task_id),
    onSuccess: invalidate,
  });
  const withdraw = useMutation({
    mutationFn: () => withdrawApprovalTask(state.approval_task_id),
    onSuccess: invalidate,
  });
  const busy = ack.isPending || withdraw.isPending;
  const by = state.decided_by ? ` by ${state.decided_by.display_name}` : '';
  const when = state.decided_at ? numericDate(state.decided_at) : null;

  if (state.status === 'open') {
    return (
      <span className="scr scr-open" role="status">
        <Icon name="clock" size={12} />
        <span className="scr-text">
          <b>→ {state.to_status.name}</b> · pending approval
          {state.requested_by && !mine && <small> · asked by {state.requested_by.display_name}</small>}
        </span>
        {mayOpenInbox && approver && (
          <Link className="scr-act" to="/approvals">Decide</Link>
        )}
        {mayAct && (
          <button type="button" className="scr-act" disabled={busy} onClick={() => withdraw.mutate()}>
            Withdraw
          </button>
        )}
      </span>
    );
  }

  if (state.status === 'approved') {
    return (
      <span className="scr scr-approved" role="status">
        <Icon name="check-circle" size={12} />
        <span className="scr-text">
          <b>→ {state.to_status.name}</b> · approved{by}
          {when && <small> · {when}</small>}
          {state.decision_note && <small className="scr-note" title={state.decision_note}> · {state.decision_note}</small>}
        </span>
        {mayAct && (
          <button type="button" className="scr-act is-primary" disabled={busy} onClick={() => ack.mutate()}>
            Continue
          </button>
        )}
      </span>
    );
  }

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
