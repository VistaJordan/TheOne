/* /payments — the sidebar's "Payments" destination: the payables queue.

   Every technician payment request across every live work order, in three
   lanes: Needs approval (requested), To process (approved, sent to Yoda) and
   All. Each row carries its own decision cluster, so the tab is the place the
   money is decided — the request page on the work order only raises it.

   Two permissions drive what a row offers (0015/0016):
     payments:approve        Approve / Reject
     payments/process:edit   Send to Yoda / Mark paid
   A verb the viewer may not use stays VISIBLE and locked with the reason
   (product/quotes-payments.md discoverability rule) — never hidden. */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PAYMENT_PROCESS_PERM_KEY } from '@theone/shared';
import type { PaymentListItem, PaymentRequestStatus } from '../api/client';
import {
  ApiRequestError,
  approvePayment,
  listPayments,
  markPaymentPaid,
  rejectPayment,
  sendPaymentToYoda,
} from '../api/client';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { ListPagination, PAGE_SIZES } from '../components/ListPagination';
import { PAYMENT_STATUS_LABEL, payeeLabel } from '../components/payments/PaymentsTable';
import { useAuth } from '../auth/AuthProvider';
import { usd } from '../lib/quoteTotals';
import { numericDate } from '../lib/fields';
import { EmergencyBadge } from '../components/EmergencyBadge';
import { EscalatedBadge } from '../components/EscalatedBadge';

type Lane = 'approval' | 'process' | 'all';

const LANE_LABEL: Record<Lane, string> = {
  approval: 'Needs approval',
  process: 'To process',
  all: 'All requests',
};

const LANE_STATUSES: Record<Lane, PaymentRequestStatus[] | null> = {
  approval: ['requested'],
  process: ['approved', 'sent_to_yoda'],
  all: null,
};

/** Status → chip flavour, matching the ledger on the work order. */
const STATUS_CHIP: Record<PaymentRequestStatus, string> = {
  requested: 'chip-outline',
  approved: '',
  sent_to_yoda: '',
  paid: 'chip-accent',
  rejected: 'chip-danger',
};

type DecisionKind = 'approve' | 'reject' | 'send' | 'paid';

interface Pending {
  kind: DecisionKind;
  item: PaymentListItem;
}

export function PaymentsPage() {
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const canApprove = can('payments', 'approve');
  const canProcess = can(PAYMENT_PROCESS_PERM_KEY, 'edit');

  // Land on the lane that is this person's job: approvers on what needs a
  // decision, AP on what needs paying, everyone else on the whole ledger.
  const [lane, setLane] = useState<Lane>(canApprove ? 'approval' : canProcess ? 'process' : 'all');
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);

  const paymentsQuery = useQuery({ queryKey: ['payments'], queryFn: listPayments, retry: 0 });
  const items = paymentsQuery.data?.items ?? [];
  const counts = paymentsQuery.data?.counts;

  const laneItems = useMemo(() => {
    const allowed = LANE_STATUSES[lane];
    return allowed ? items.filter((i) => allowed.includes(i.status)) : items;
  }, [items, lane]);

  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [offset, setOffset] = useState(0);
  const pageItems = laneItems.slice(offset, offset + pageSize);

  const laneCount = (l: Lane): number | undefined => {
    if (!counts) return undefined;
    const allowed = LANE_STATUSES[l];
    return allowed ? allowed.reduce((n, s) => n + counts[s], 0) : items.length;
  };

  const inLane = (amount: (i: PaymentListItem) => boolean) =>
    laneItems.filter(amount).reduce((sum, i) => sum + i.amount, 0);

  const decide = useMutation({
    mutationFn: async ({ kind, item, text }: Pending & { text: string | null }) => {
      switch (kind) {
        case 'approve':
          return approvePayment(item.id);
        case 'reject':
          return rejectPayment(item.id, text ?? '');
        case 'send':
          return sendPaymentToYoda(item.id, text);
        case 'paid':
          return markPaymentPaid(item.id);
      }
    },
    onSuccess: () => {
      setPending(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      // The ledger on the work order and its audit trail show the same row.
      void queryClient.invalidateQueries({ queryKey: ['wo-payments'] });
      void queryClient.invalidateQueries({ queryKey: ['wo-activity'] });
      void queryClient.invalidateQueries({ queryKey: ['wo-feed'] });
    },
    onError: (err) => {
      setPending(null);
      setError(err instanceof ApiRequestError ? err.message : 'The decision could not be saved.');
    },
  });

  const notServed =
    paymentsQuery.error instanceof ApiRequestError && paymentsQuery.error.status === 404;

  const switchLane = (l: Lane) => {
    setLane(l);
    setOffset(0);
  };

  return (
    <AppShell active="Payments">
      <div className="page-head">
        <p className="page-sub">
          {paymentsQuery.isLoading
            ? 'Loading…'
            : `${laneItems.length} request${laneItems.length === 1 ? '' : 's'} · ${LANE_LABEL[lane].toLowerCase()}`}
        </p>
      </div>

      <div className="payq-head">
        <div className="seg payq-lanes" role="group" aria-label="Payment lanes">
          {(['approval', 'process', 'all'] as const).map((l) => {
            const n = laneCount(l);
            return (
              <button
                key={l}
                type="button"
                className={`seg-btn${lane === l ? ' is-on' : ''}`}
                aria-pressed={lane === l}
                onClick={() => switchLane(l)}
              >
                {LANE_LABEL[l]}
                {n !== undefined && (
                  <span className={`payq-count${l === 'approval' && n > 0 ? ' is-hot' : ''}`}>{n}</span>
                )}
              </button>
            );
          })}
        </div>
        {!paymentsQuery.isLoading && !paymentsQuery.isError && (
          <div className="payq-sum">
            <span>
              Awaiting approval <b>{usd(inLane((i) => i.status === 'requested'))}</b>
            </span>
            <span>
              Approved, not yet paid{' '}
              <b>{usd(inLane((i) => i.status === 'approved' || i.status === 'sent_to_yoda'))}</b>
            </span>
          </div>
        )}
      </div>

      {error && (
        <p className="payq-err" role="alert">
          <Icon name="alert-circle" size={14} />
          {error}
        </p>
      )}

      {paymentsQuery.isError && (
        <div className="quotes-empty">
          <Icon name="card" size={22} />
          <b>{notServed ? 'No payment requests to list yet' : 'Could not load payment requests'}</b>
          <span>
            {notServed
              ? 'Payments are requested from a work order — open one and use “Request payment”.'
              : 'Is the API running on :5174?'}
          </span>
        </div>
      )}

      {!paymentsQuery.isError && (
        <div className="table-wrap">
          <table className="ct">
            <thead>
              <tr>
                <th className="col-wo">WO #</th>
                <th className="col-client">Client / Title</th>
                <th>Payee / Purpose</th>
                <th className="num">Amount</th>
                <th className="col-status">Status</th>
                <th className="col-date">Requested</th>
                <th className="payq-actions">Decision</th>
              </tr>
            </thead>
            <tbody>
              {paymentsQuery.isLoading && (
                <tr className="ct-empty"><td colSpan={7}>Loading payment requests…</td></tr>
              )}
              {!paymentsQuery.isLoading && laneItems.length === 0 && (
                <tr className="ct-empty">
                  <td colSpan={7}>
                    {lane === 'approval'
                      ? 'Nothing is waiting for approval.'
                      : lane === 'process'
                        ? 'Nothing is waiting to be sent to Yoda or marked paid.'
                        : 'No technician payments have been requested yet.'}
                  </td>
                </tr>
              )}
              {pageItems.map((p) => (
                <PaymentRow
                  key={p.id}
                  item={p}
                  canApprove={canApprove}
                  canProcess={canProcess}
                  busy={decide.isPending}
                  onDecide={(kind) => {
                    setError(null);
                    setPending({ kind, item: p });
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!paymentsQuery.isError && (
        <ListPagination
          total={paymentsQuery.isLoading ? undefined : laneItems.length}
          offset={offset}
          limit={pageSize}
          noun="requests"
          onOffsetChange={setOffset}
          onLimitChange={(n) => {
            setPageSize(n);
            setOffset(0);
          }}
        />
      )}

      {pending?.kind === 'approve' && (
        <ConfirmDialog
          title="Approve this payment?"
          icon="check-circle"
          message={
            <>
              {usd(pending.item.amount)} to <b>{payeeLabel(pending.item)}</b> for{' '}
              {pending.item.purpose} on {pending.item.wo_number}.
            </>
          }
          note="Approving clears it for AP to send to Yoda. Nothing is paid until AP does."
          noteTone="info"
          confirmLabel="Approve payment"
          busy={decide.isPending}
          busyLabel="Approving…"
          onConfirm={() => decide.mutate({ ...pending, text: null })}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'paid' && (
        <ConfirmDialog
          title="Mark this payment paid?"
          icon="check-check"
          message={
            <>
              {usd(pending.item.amount)} to <b>{payeeLabel(pending.item)}</b> for{' '}
              {pending.item.purpose} on {pending.item.wo_number}
              {pending.item.yoda_ref ? ` (Yoda ref ${pending.item.yoda_ref})` : ''}.
            </>
          }
          note="This records that Yoda paid it. The amount joins “Total paid” on the work order."
          noteTone="info"
          confirmLabel="Mark paid"
          busy={decide.isPending}
          busyLabel="Saving…"
          onConfirm={() => decide.mutate({ ...pending, text: null })}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'reject' && (
        <TextDialog
          title="Reject this payment"
          item={pending.item}
          label="Why is it being rejected?"
          hint={`Posted as an internal update on ${pending.item.wo_number} — feedback for whoever raised it, never for the client.`}
          required
          multiline
          confirmLabel="Reject with note"
          danger
          busy={decide.isPending}
          onConfirm={(text) => decide.mutate({ ...pending, text })}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'send' && (
        <TextDialog
          title="Send to Yoda"
          item={pending.item}
          label="Yoda reference"
          hint="Optional — whatever Yoda gives back once the payment is entered there. Mark it paid here once Yoda has paid it."
          placeholder="e.g. YD-10422"
          confirmLabel="Sent to Yoda"
          busy={decide.isPending}
          onConfirm={(text) => decide.mutate({ ...pending, text: text.trim() || null })}
          onCancel={() => setPending(null)}
        />
      )}
    </AppShell>
  );
}

// ── One row ──────────────────────────────────────────────────────────────────

interface RowProps {
  item: PaymentListItem;
  canApprove: boolean;
  canProcess: boolean;
  busy: boolean;
  onDecide: (kind: DecisionKind) => void;
}

function PaymentRow({ item, canApprove, canProcess, busy, onDecide }: RowProps) {
  const woHref = `/work-orders/${encodeURIComponent(item.wo_number)}`;
  const when = numericDate(item.created_at) ?? '—';
  const by = item.requested_by?.display_name;

  // What happened last, for the status cell's second line.
  const trail =
    item.status === 'approved' && item.approved_by
      ? `by ${item.approved_by.display_name}${item.approved_at ? ` · ${numericDate(item.approved_at)}` : ''}`
      : item.status === 'sent_to_yoda'
        ? [item.yoda_ref ? `ref ${item.yoda_ref}` : null, item.sent_to_yoda_at ? numericDate(item.sent_to_yoda_at) : null]
            .filter(Boolean)
            .join(' · ')
        : item.status === 'paid' && item.paid_at
          ? `${numericDate(item.paid_at)}${item.paid_by ? ` · ${item.paid_by.display_name}` : ''}`
          : item.status === 'rejected'
            ? (item.rejection_note ?? (item.rejected_by ? `by ${item.rejected_by.display_name}` : null))
            : null;

  return (
    <tr
      className={
        [item.wo_emergency ? 'is-emergency' : '', item.wo_escalated ? 'is-escalated' : '']
          .filter(Boolean)
          .join(' ') || undefined
      }
    >
      <td className="col-wo">
        <Link className="wo-num wo-num-link" to={woHref}>
          {item.wo_number}
        </Link>
        {item.wo_emergency && <EmergencyBadge compact />}
        {item.wo_escalated && <EscalatedBadge compact />}
      </td>
      <td className="col-client">
        <div className="site">
          <strong>{item.client ?? '—'}</strong>
          <small>{item.title ?? '—'}</small>
        </div>
      </td>
      <td>
        <div className="site payq-who">
          <strong>
            {payeeLabel(item)}
            {item.recipient_name && <span className="ctx-sub"> · paid to {item.recipient_name}</span>}
          </strong>
          <small>{[item.purpose, item.method].filter(Boolean).join(' · ')}</small>
        </div>
      </td>
      <td className="num">{usd(item.amount)}</td>
      <td className="col-status">
        <span className="payq-status">
          <span className={`chip chip-sm ${STATUS_CHIP[item.status]}`.trim()}>
            {item.status === 'sent_to_yoda' && <Icon name="send" size={12} />}
            {PAYMENT_STATUS_LABEL[item.status]}
          </span>
          {trail && <small title={trail}>{trail}</small>}
        </span>
      </td>
      <td className="col-date">
        <span className="payq-status">
          <span>{when}</span>
          {by && <small>{by}</small>}
        </span>
      </td>
      <td className="payq-actions">
        <Decisions item={item} canApprove={canApprove} canProcess={canProcess} busy={busy} onDecide={onDecide} />
      </td>
    </tr>
  );
}

/** The verbs a row offers at its status. A verb the viewer may not use is
    drawn locked with the reason — the rule is "visible, never hidden". */
function Decisions({ item, canApprove, canProcess, busy, onDecide }: RowProps) {
  const verb = (
    label: string,
    icon: 'check' | 'x' | 'send' | 'check-check',
    kind: DecisionKind,
    allowed: boolean,
    reason: string,
    tone: 'primary' | 'danger' | 'plain' = 'plain',
  ) =>
    // .btn-sm is the list toolbar's vocabulary: filled accent by default (the
    // one filled button per row), outlined red for the destructive verb.
    allowed ? (
      <button
        type="button"
        className={`btn-sm${tone === 'danger' ? ' is-danger' : tone === 'plain' ? ' is-ghost' : ''}`}
        aria-disabled={busy ? true : undefined}
        onClick={() => !busy && onDecide(kind)}
      >
        <Icon name={icon} size={12} />
        {label}
      </button>
    ) : (
      <span className="tipwrap">
        <button
          type="button"
          className="btn-sm is-ghost btn-locked"
          tabIndex={0}
          aria-disabled="true"
          aria-describedby={`lock-${kind}-${item.id}`}
        >
          <Icon name="lock" size={12} />
          {label}
        </button>
        <span className="tip" id={`lock-${kind}-${item.id}`} role="tooltip">
          <Icon name="lock" size={12} />
          {reason}
        </span>
      </span>
    );

  // Rule 1.5.2: while an NTE override waits on a manager, the moves that let
  // money out are on hold — the API refuses them with a 409, this says so first.
  const hold = item.nte_override_open;
  const HOLD = 'On hold — the NTE override on this work order has to be decided first (rule 1.5.2)';

  switch (item.status) {
    case 'requested':
      return (
        <>
          {verb('Reject', 'x', 'reject', canApprove, 'Requires payment approval rights', 'danger')}
          {verb(
            'Approve',
            'check',
            'approve',
            canApprove && !hold,
            canApprove ? HOLD : 'Requires payment approval rights',
            'primary',
          )}
        </>
      );
    case 'approved':
      return (
        <>
          {verb('Reject', 'x', 'reject', canApprove, 'Requires payment approval rights', 'danger')}
          {verb(
            'Send to Yoda',
            'send',
            'send',
            canProcess && !hold,
            canProcess ? HOLD : 'AP processes payments',
            'primary',
          )}
        </>
      );
    case 'sent_to_yoda':
      return verb('Mark paid', 'check-check', 'paid', canProcess, 'AP processes payments', 'primary');
    case 'paid':
      return <span className="payq-done">Paid</span>;
    case 'rejected':
      return <span className="payq-done">Rejected</span>;
  }
}

// ── A one-field decision dialog (reject note, Yoda reference) ────────────────

interface TextDialogProps {
  title: string;
  item: PaymentListItem;
  label: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}

function TextDialog({
  title,
  item,
  label,
  hint,
  placeholder,
  required,
  multiline,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: TextDialogProps) {
  const [text, setText] = useState('');
  const ok = !required || text.trim().length > 0;
  const fieldId = `payq-text-${item.id}`;

  return (
    <div className="modal-scrim" onClick={busy ? undefined : onCancel} role="presentation">
      <div
        className={`modal is-narrow confirm payq-dialog is-${danger ? 'danger' : 'info'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="payq-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head confirm-head">
          <span className="confirm-icon" aria-hidden="true">
            <Icon name={danger ? 'x' : 'send'} size={18} />
          </span>
          <h2 id="payq-dialog-title">{title}</h2>
        </div>
        <div className="modal-body">
          <dl className="kv">
            <dt>Amount</dt>
            <dd>{usd(item.amount)}</dd>
            <dt>Payee</dt>
            <dd>{payeeLabel(item)}</dd>
            <dt>Work order</dt>
            <dd>{item.wo_number}</dd>
          </dl>
          <div className="field">
            <label className="lbl" htmlFor={fieldId}>
              {label}
              {required && <span className="req" aria-hidden="true"> *</span>}
            </label>
            {multiline ? (
              <textarea
                className="fld"
                id={fieldId}
                rows={3}
                value={text}
                autoFocus
                onChange={(e) => setText(e.target.value)}
              />
            ) : (
              <input
                className="fld"
                id={fieldId}
                type="text"
                value={text}
                placeholder={placeholder}
                autoFocus
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && ok && !busy) onConfirm(text);
                }}
              />
            )}
            {hint && <span className="hint">{hint}</span>}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-sm is-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn-sm${danger ? ' is-danger' : ''}`}
            onClick={() => ok && onConfirm(text)}
            disabled={busy || !ok}
          >
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
