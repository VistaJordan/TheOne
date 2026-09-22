/* A billing proposal (0053), as the work order's cards show it: what the
   contract worked out once the job was done, waiting on a yes or a no.

   BRD §6.4: "If enabled, an invoice is generated automatically once the work
   order is completed; confirming it creates the invoice and files it in the
   Invoices section." The same block serves the client invoice (Finances
   tab) and the vendor bill (Payables tab) — only the verb differs. */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BillingProposal } from '@theone/shared';
import { ApiRequestError, confirmBillingProposal, dismissBillingProposal } from '../../api/client';
import { Icon } from '../Icon';
import { usd } from '../../lib/quoteTotals';

export function BillingProposalBlock({
  proposal,
  canDecide,
  confirmLabel,
  onDone,
}: {
  proposal: BillingProposal;
  canDecide: boolean;
  confirmLabel: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [dismissing, setDismissing] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const settle = () => {
    setError(null);
    setDismissing(false);
    void qc.invalidateQueries({ queryKey: ['billing-proposals'] });
    void qc.invalidateQueries({ queryKey: ['wo-billing-proposals', proposal.task_id] });
    onDone();
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : 'That did not go through');

  const confirm = useMutation({ mutationFn: () => confirmBillingProposal(proposal.id), onSuccess: settle, onError: fail });
  const dismiss = useMutation({
    mutationFn: () => dismissBillingProposal(proposal.id, note.trim() || null),
    onSuccess: settle,
    onError: fail,
  });
  const busy = confirm.isPending || dismiss.isPending;

  return (
    <div className="inv-proposal" role="group" aria-label="Proposed on completion">
      <div className="inv-proposal-head">
        <Icon name="alert" size={14} />
        <div>
          <b>Proposed on completion</b>
          <small>
            From {proposal.contract_name}
            {proposal.vendor_name ? ` · ${proposal.vendor_name}` : ''}
            {proposal.hours > 0 ? ` · ${proposal.hours} h on site` : ''}
            {proposal.visits > 0 ? ` · ${proposal.visits} visit${proposal.visits === 1 ? '' : 's'}` : ''}
          </small>
        </div>
      </div>

      <table className="ct inv-lines">
        <tbody>
          {proposal.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.description}
                <small className="inv-line-meta">
                  {l.quantity} × {usd(l.unit_price)}
                </small>
              </td>
              <td className="num">{usd(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {proposal.tax > 0 && (
            <tr>
              <td>Tax</td>
              <td className="num">{usd(proposal.tax)}</td>
            </tr>
          )}
          <tr className="inv-total">
            <td>Total</td>
            <td className="num">{usd(proposal.total)}</td>
          </tr>
        </tfoot>
      </table>

      {error && <p className="composer-err" role="alert">{error}</p>}

      {dismissing ? (
        <div className="inv-proposal-note">
          <label className="lbl" htmlFor={`bp-note-${proposal.id}`}>Why not? (optional)</label>
          <textarea
            id={`bp-note-${proposal.id}`}
            className="fld"
            rows={2}
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="inv-actions">
            <button type="button" className="btn-sm" disabled={busy} onClick={() => setDismissing(false)}>
              Keep it
            </button>
            <button type="button" className="btn-sm is-primary" disabled={busy} onClick={() => dismiss.mutate()}>
              {dismiss.isPending ? 'Dismissing…' : 'Dismiss proposal'}
            </button>
          </span>
        </div>
      ) : (
        <div className="inv-foot">
          <span className="card-meta">
            {canDecide
              ? 'Confirming files it with exactly these lines; it stays editable until sent.'
              : 'Waiting for someone who can raise it.'}
          </span>
          {canDecide && (
            <span className="inv-actions">
              <button type="button" className="btn-sm" disabled={busy} onClick={() => setDismissing(true)}>
                Dismiss
              </button>
              <button type="button" className="btn-sm is-primary" disabled={busy} onClick={() => confirm.mutate()}>
                <Icon name="check" size={14} />
                {confirm.isPending ? 'Filing…' : confirmLabel}
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
