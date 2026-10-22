/* Assign, reassign or unassign a work order (Elise, 2026-10-22) — from the
   header's assignee chip and from Incoming › Unassigned. The same dispatcher
   picker as Accept (the API refuses anyone who is not a dispatcher,
   ASSIGNEE_NOT_DISPATCHER) with "Who's available?" beside it; no note — the
   write is an ordinary Assignee field save, audited and mirrored like one
   typed on the People tab, so the 11.1.1 gate and the scope rule apply. */

import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isDispatcherRole } from '@theone/shared';
import { getPrincipals } from '../../api/client';
import { Icon } from '../Icon';
import { AssigneeSelect } from './AssigneeAvailability';

export function AssignDialog({
  woNumber,
  client,
  current,
  busy,
  error,
  onAssign,
  onUnassign,
  onCancel,
}: {
  woNumber: string;
  /** The work order's client — the availability view's "for this client" list. */
  client: string | null;
  /** Who holds it now (null = nobody). */
  current: string | null;
  busy: boolean;
  /** The API's sentence after a refused save, drawn under the picker. */
  error: string | null;
  onAssign: (assignee: string) => void;
  /** Offered only when someone holds it and the caller allows clearing. */
  onUnassign?: () => void;
  onCancel: () => void;
}) {
  const [assignee, setAssignee] = useState('');
  const people = useQuery({ queryKey: ['principals'], queryFn: getPrincipals, retry: 0 });
  const humans = (people.data?.items ?? []).filter((p) => p.kind === 'human');
  const dispatchers = humans.filter((p) => isDispatcherRole(p.role)).map((p) => p.name);
  const ok = assignee.trim().length > 0 && assignee.trim() !== (current ?? '');
  const whoId = 'assign-dialog-who';
  const facts: { k: string; v: string }[] = [
    { k: 'Work order', v: woNumber },
    { k: 'Assignee now', v: current ?? 'Nobody' },
  ];

  return (
    <div className="modal-scrim" onClick={busy ? undefined : onCancel} role="presentation">
      <div
        className="modal is-narrow confirm payq-dialog is-info"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head confirm-head">
          <span className="confirm-icon" aria-hidden="true">
            <Icon name="user-plus" size={18} />
          </span>
          <h2 id="assign-dialog-title">{current ? 'Reassign this work order?' : 'Assign this work order?'}</h2>
        </div>
        <div className="modal-body">
          <dl className="kv">
            {facts.map((f) => (
              <Fragment key={f.k}>
                <dt>{f.k}</dt>
                <dd>{f.v}</dd>
              </Fragment>
            ))}
          </dl>
          <div className="field">
            <label className="lbl" htmlFor={whoId}>Assign to</label>
            <AssigneeSelect
              id={whoId}
              value={assignee}
              autoFocus
              disabled={people.isLoading || busy}
              client={client}
              onChange={setAssignee}
            >
              <option value="">{people.isLoading ? 'Loading people…' : 'Pick a dispatcher'}</option>
              {dispatchers.length > 0 && (
                <optgroup label="Dispatchers">
                  {dispatchers.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </optgroup>
              )}
            </AssigneeSelect>
            <span className="hint">
              {people.isError
                ? 'The people list could not be loaded — try again.'
                : `The name lands in the Assignee seat of ${woNumber}; the work order then shows in that dispatcher's list (rule 7.1.4).`}
            </span>
          </div>
          {error && (
            <p className="payq-err" role="alert">{error}</p>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-sm is-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {current && onUnassign && (
            <button
              type="button"
              className="btn-sm is-danger"
              onClick={onUnassign}
              disabled={busy}
              title="Clear the Assignee seat — the work order leaves their list and shows under Incoming › Unassigned"
            >
              <Icon name="x" size={12} />
              Unassign
            </button>
          )}
          <button type="button" className="btn-sm" onClick={() => ok && onAssign(assignee.trim())} disabled={busy || !ok}>
            {busy ? 'Saving…' : current ? 'Reassign' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  );
}
