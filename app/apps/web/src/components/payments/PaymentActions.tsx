/* The per-row AP actions (Yoda payment-list buttons): approve, pay (verify),
   reject, change method, delete / confirm-delete / reject-delete, edit.
   Role-gated controls render LOCKED with a tooltip (§3.5), never hidden. The
   reason sheets (reject / delete) are inline so the row never loses context. */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ApiRequestError,
  PAYMENT_METHODS,
  approvePaymentRequest,
  confirmDeletePaymentRequest,
  convertPaymentMethod,
  deletePaymentRequest,
  payPaymentRequest,
  rejectDeletePaymentRequest,
  rejectPaymentRequest,
} from '../../api/client';
import type { PaymentMethod, PaymentRequest } from '../../api/client';
import { PAYMENT_PROCESS_PERM_KEY } from '@theone/shared';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../Icon';

interface Props {
  item: PaymentRequest;
  /** Compact = icon buttons in a table row; full = labelled buttons in the queue. */
  compact?: boolean;
  onChanged?: () => void;
}

type Sheet = 'reject' | 'delete' | 'method' | null;

export function PaymentActions({ item, compact = false, onChanged }: Props) {
  // 0015 · three grants, one per half of the lifecycle (mirrors services/payments.ts):
  //   payments:approve          approve / reject
  //   payments/process:edit     pay / change method / delete
  //   payments/process:delete   confirm or keep a pending delete (admin)
  const { can, actingAs } = useAuth();
  const canApprove = can('payments', 'approve');
  const isAp = can(PAYMENT_PROCESS_PERM_KEY, 'edit');
  const isAdmin = can(PAYMENT_PROCESS_PERM_KEY, 'delete');
  const isOwner = actingAs?.id != null && item.requested_by?.id === actingAs.id;
  const queryClient = useQueryClient();

  const [sheet, setSheet] = useState<Sheet>(null);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<PaymentMethod>(item.method);
  const [error, setError] = useState<string | null>(null);

  const done = () => {
    setSheet(null);
    setReason('');
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ['wo-payments'] });
    void queryClient.invalidateQueries({ queryKey: ['payments'] });
    void queryClient.invalidateQueries({ queryKey: ['payment-queue'] });
    void queryClient.invalidateQueries({ queryKey: ['work-orders', 'detail'] });
    // The ledger on the work order and its audit trail show the same row.
    void queryClient.invalidateQueries({ queryKey: ['wo-activity'] });
    void queryClient.invalidateQueries({ queryKey: ['wo-feed'] });
    void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    onChanged?.();
  };
  const fail = (err: unknown) => setError(err instanceof ApiRequestError ? err.message : 'The action failed.');

  const approve = useMutation({ mutationFn: () => approvePaymentRequest(item.id), onSuccess: done, onError: fail });
  const pay = useMutation({ mutationFn: () => payPaymentRequest(item.id), onSuccess: done, onError: fail });
  const reject = useMutation({ mutationFn: () => rejectPaymentRequest(item.id, reason.trim()), onSuccess: done, onError: fail });
  const convert = useMutation({ mutationFn: () => convertPaymentMethod(item.id, method), onSuccess: done, onError: fail });
  const del = useMutation({ mutationFn: () => deletePaymentRequest(item.id, reason.trim()), onSuccess: done, onError: fail });
  const confirmDel = useMutation({ mutationFn: () => confirmDeletePaymentRequest(item.id), onSuccess: done, onError: fail });
  const rejectDel = useMutation({ mutationFn: () => rejectDeletePaymentRequest(item.id), onSuccess: done, onError: fail });

  const busy = [approve, pay, reject, convert, del, confirmDel, rejectDel].some((m) => m.isPending);
  const open = item.status === 'requested' || item.status === 'approved' || item.status === 'sent_to_yoda';
  const canDelete = item.status === 'requested' || item.status === 'rejected' ? isOwner || isAp : isAp || isOwner;
  // Rule 1.5.2: while an NTE override waits on a manager, the moves that let
  // money out are on hold — the API refuses them with a 409, this says so first.
  const hold = item.nte_override_open;
  const HOLD = 'On hold — the NTE override on this work order has to be decided first (rule 1.5.2)';

  const btn = (
    label: string,
    icon: Parameters<typeof Icon>[0]['name'],
    onClick: () => void,
    opts: { danger?: boolean; primary?: boolean; locked?: string | null; title?: string } = {},
  ) => {
    if (opts.locked) {
      return (
        <span className="tipwrap" key={label}>
          <button type="button" className={`btn btn-sm btn-locked${compact ? ' btn-icon' : ''}`} tabIndex={0} aria-disabled="true" aria-label={label} title={opts.locked}>
            <Icon name="lock" size={12} />
            {!compact && label}
          </button>
          <span className="tip tip-below" role="tooltip"><Icon name="lock" size={12} />{opts.locked}</span>
        </span>
      );
    }
    return (
      <button
        key={label}
        type="button"
        className={`btn btn-sm${opts.primary ? ' btn-primary' : ''}${opts.danger ? ' btn-danger' : ''}${compact ? ' btn-icon' : ''}${busy ? ' is-busy' : ''}`}
        aria-disabled={busy ? true : undefined}
        aria-label={label}
        title={opts.title ?? label}
        onClick={() => !busy && onClick()}
      >
        <Icon name={icon} size={12} />
        {!compact && label}
      </button>
    );
  };

  const apLock = isAp ? null : 'Requires the payments/process permission (AP)';
  const approveLock = canApprove ? null : 'Requires payment approval rights';
  const adminLock = isAdmin ? null : 'Requires admin';

  return (
    <div className={`pay-actions${compact ? ' is-compact' : ''}`}>
      {item.pending_delete ? (
        <>
          <span className="chip chip-sm chip-danger" title={item.delete_reason ?? ''}>
            <Icon name="alert" size={12} />
            Pending delete
          </span>
          {btn('Confirm delete', 'trash', () => confirmDel.mutate(), { danger: true, locked: adminLock })}
          {btn('Keep', 'refresh', () => rejectDel.mutate(), { locked: adminLock })}
        </>
      ) : (
        <>
          {item.status === 'requested' && btn('Approve', 'check', () => approve.mutate(), { locked: approveLock ?? (hold ? HOLD : null) })}
          {open && btn(item.status === 'requested' ? 'Pay now' : 'Mark paid', 'dollar', () => pay.mutate(), { primary: true, locked: apLock ?? (hold ? HOLD : null), title: 'Yoda “Verify” — stamps the payer and rolls the amount into the WO cost' })}
          {open && btn('Reject', 'x', () => setSheet(sheet === 'reject' ? null : 'reject'), { danger: true, locked: approveLock })}
          {item.status !== 'paid' && btn('Change method', 'swap', () => setSheet(sheet === 'method' ? null : 'method'), { locked: apLock })}
          {btn('Delete', 'trash', () => setSheet(sheet === 'delete' ? null : 'delete'), {
            danger: true,
            locked: canDelete ? null : 'Only the requester or AP can delete',
            title: item.status === 'paid' || item.status === 'approved' ? 'Processed payment — delete needs an admin to confirm' : 'Delete this request',
          })}
        </>
      )}

      {sheet === 'reject' && (
        <div className="pay-sheet">
          <label className="flabel" htmlFor={`rej-${item.id}`}>Reason for the requester <span className="req" aria-hidden="true">*</span></label>
          <input className="finput" id={`rej-${item.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why AP is not paying this" />
          <div className="sheet-f">
            <button type="button" className="btn btn-sm" onClick={() => setSheet(null)}>Cancel</button>
            <button type="button" className="btn btn-sm btn-danger" aria-disabled={reason.trim() === '' ? true : undefined} onClick={() => reason.trim() && reject.mutate()}>Reject</button>
          </div>
        </div>
      )}
      {sheet === 'delete' && (
        <div className="pay-sheet">
          <label className="flabel" htmlFor={`del-${item.id}`}>Deletion reason <span className="req" aria-hidden="true">*</span></label>
          <input className="finput" id={`del-${item.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Duplicate, wrong WO, wrong amount…" />
          <p className="fhelp">
            <Icon name="info" size={12} />
            {item.status === 'paid'
              ? 'Paid rows are flagged for an admin to confirm; the cost roll-up is reversed on confirmation.'
              : item.status === 'approved'
                ? 'Approved rows are flagged for an admin to confirm.'
                : 'Deletes immediately.'}
          </p>
          <div className="sheet-f">
            <button type="button" className="btn btn-sm" onClick={() => setSheet(null)}>Cancel</button>
            <button type="button" className="btn btn-sm btn-danger" aria-disabled={reason.trim() === '' ? true : undefined} onClick={() => reason.trim() && del.mutate()}>Delete</button>
          </div>
        </div>
      )}
      {sheet === 'method' && (
        <div className="pay-sheet">
          <label className="flabel" htmlFor={`meth-${item.id}`}>New method</label>
          <div className="selwrap">
            <select className="fselect" id={`meth-${item.id}`} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <span className="sel-chev" aria-hidden="true"><Icon name="chev-d" size={14} /></span>
          </div>
          <p className="fhelp"><Icon name="info" size={12} />Payout details for the old method are cleared.</p>
          <div className="sheet-f">
            <button type="button" className="btn btn-sm" onClick={() => setSheet(null)}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" aria-disabled={method === item.method ? true : undefined} onClick={() => method !== item.method && convert.mutate()}>Change</button>
          </div>
        </div>
      )}
      {error && (
        <p className="ferr" style={{ flexBasis: '100%' }}>
          <Icon name="alert-circle" size={12} />
          {error}
        </p>
      )}
    </div>
  );
}
