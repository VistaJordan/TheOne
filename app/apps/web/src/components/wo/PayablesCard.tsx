/* The Payables tab (two cards, side by side):

     PayablesFieldsCard   the All-fields "Payments" section (PPR link, Yoda
                          link, whatever the founder adds to it), as editable
                          rows — driven by FIELD_SECTIONS so the two views can
                          never drift apart.
     PaymentHistoryCard   every payment request on this WO, newest first, each
                          with its status (Requested / Approved / Paid /
                          Rejected), plus the "Request payment" entry point.
     PaymentTimelineCard  the history behind them: every step of every
                          request (requested, edited, approved, paid,
                          rejected, method changed, deleted), who and when —
                          deleted requests included (GET …/payment-history).

   The old rail-era mini card capped the ledger at three rows; the tab has the
   room to show all of it. */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { PaymentRequest, WoActionState, WorkOrderDetailV2 } from '../../api/client';
import { getPaymentHistory } from '../../api/client';
import { FieldHistory, HistoryToggle } from './FieldHistory';
import { payeeLabel, PAYMENT_STATUS_LABEL } from '../payments/PaymentsTable';
import { methodLabel } from '../../api/client';
import type { PaymentHistoryAction, PaymentHistoryEvent, PaymentRequestStatus } from '@theone/shared';
import { shortDate, shortDateTime } from '../../lib/fields';
import { usd } from '../../lib/quoteTotals';
import { FIELD_SECTIONS } from '../../lib/woFieldSections';
import { Icon } from '../Icon';
import { useAuth } from '../../auth/AuthProvider';
import { InlineField, useWoCatalogue } from './fieldEdit';

const PAYMENTS_SECTION_TITLE = 'Payments';

/** Status → chip flavour. Rejected wears the danger tint; Paid the accent. */
const STATUS_CHIP: Record<PaymentRequestStatus, string> = {
  requested: 'chip-outline',
  approved: '',
  sent_to_yoda: '',
  paid: 'chip-accent',
  rejected: 'chip-danger',
};

export function PayablesFieldsCard({ wo }: { wo: WorkOrderDetailV2 }) {
  const byKey = useWoCatalogue();
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const keys = FIELD_SECTIONS.find((s) => s.title === PAYMENTS_SECTION_TITLE)?.keys ?? [];
  const fields = keys
    .map((k) => byKey.get(k))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Payment links</h2>
      </div>
      {fields.length === 0 ? (
        <div className="empty-flat">No payment fields are defined in Admin › Custom fields.</div>
      ) : (
        <dl className="fieldlist">
          {fields.map((f) => (
            <div key={f.key}>
              <div className="fieldrow has-hist">
                <dt>{f.label}</dt>
                <dd>
                  <InlineField wo={wo} fieldKey={f.key} label={f.label} />
                  <HistoryToggle
                    field={f}
                    open={historyFor === f.key}
                    onToggle={() => setHistoryFor(historyFor === f.key ? null : f.key)}
                  />
                </dd>
              </div>
              {historyFor === f.key && <FieldHistory woId={wo.id} field={f} />}
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

interface PaymentHistoryCardProps {
  woNumber: string;
  items: PaymentRequest[];
  totalPaid: number | null;
  loading: boolean;
  /** The WO-status gate for requesting a payment (G-W01). */
  requestAction?: WoActionState | null;
}

export function PaymentHistoryCard({ woNumber, items, totalPaid, loading, requestAction }: PaymentHistoryCardProps) {
  // 0015 · the entry point needs payments:create; the ledger needs only view.
  const canRequest = useAuth().can('payments', 'create');
  // WO-status gate (allowedWoActions): a blocked request renders LOCKED with
  // the reason rather than vanishing (§3.5).
  const blocked = requestAction ? !requestAction.allowed : false;
  const flagged = items.filter((p) => p.needs_w9 || p.pending_delete).length;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Payment requests</h2>
        {!loading && items.length > 0 && (
          <span className="card-meta">
            {`${usd(totalPaid ?? 0)} paid · ${items.length} request${items.length === 1 ? '' : 's'}${flagged ? ` · ${flagged} flagged` : ''}`}
          </span>
        )}
      </div>

      {loading ? (
        <div className="empty-flat">Loading payables…</div>
      ) : items.length === 0 ? (
        <div className="empty-flat">No technician payments have been requested on this WO.</div>
      ) : (
        <ul className="payh">
          {items.map((p) => (
            <li className={`payh-row${p.pending_delete ? ' is-pending-delete' : ''}`} key={p.id}>
              <span className="payh-when">{shortDate(p.created_at) ?? '—'}</span>
              <span className="payh-who">
                <span className="payh-name">
                  {payeeLabel(p)}
                  {p.recipient_name && <span className="payh-sub"> · paid to {p.recipient_name}</span>}
                  {p.needs_w9 && (
                    <span className="chip chip-sm chip-danger" style={{ marginLeft: 6 }} title="Technician crossed $599 this year without a W9 on file">
                      W9
                    </span>
                  )}
                </span>
                {(p.purpose || p.method) && (
                  <span className="payh-sub">
                    {[p.purpose, methodLabel(p.method)].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
              <span className={`chip chip-sm ${p.pending_delete ? 'chip-warn' : STATUS_CHIP[p.status]}`.trim()}>
                {p.pending_delete ? 'Pending delete' : PAYMENT_STATUS_LABEL[p.status]}
              </span>
              <span className="payh-amt">{usd(p.amount)}</span>
            </li>
          ))}
        </ul>
      )}

      {canRequest && (
        <div className="card-foot">
          {blocked ? (
            <>
              <span className="tipwrap">
                <button type="button" className="btn btn-sm btn-locked" tabIndex={0} aria-disabled="true" aria-describedby="lockTipPayReq">
                  <Icon name="lock" size={12} />
                  Request payment
                </button>
                <span className="tip tip-below" id="lockTipPayReq" role="tooltip">
                  <Icon name="lock" size={12} />
                  {requestAction?.reason}
                </span>
              </span>
              {items.length > 0 && (
                <Link className="btn btn-sm" to={`/work-orders/${encodeURIComponent(woNumber)}/request-payment`}>
                  <Icon name="list" size={12} />
                  View ledger
                </Link>
              )}
            </>
          ) : (
            <Link
              className="btn btn-sm"
              to={`/work-orders/${encodeURIComponent(woNumber)}/request-payment`}
            >
              <Icon name="dollar" size={12} />
              Request payment
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

/** What each step reads as, and its chip. */
const HISTORY_LABEL: Record<PaymentHistoryAction, string> = {
  payment_requested: 'Requested',
  payment_updated: 'Edited',
  payment_approved: 'Approved',
  payment_paid: 'Paid',
  payment_rejected: 'Rejected',
  payment_method_changed: 'Method changed',
  payment_delete_requested: 'Delete asked',
  payment_delete_rejected: 'Delete refused',
  payment_deleted: 'Deleted',
};

const HISTORY_CHIP: Record<PaymentHistoryAction, string> = {
  payment_requested: 'chip-outline',
  payment_updated: 'chip-outline',
  payment_approved: '',
  payment_paid: 'chip-accent',
  payment_rejected: 'chip-danger',
  payment_method_changed: 'chip-outline',
  payment_delete_requested: 'chip-warn',
  payment_delete_rejected: 'chip-outline',
  payment_deleted: 'chip-danger',
};

/** Rows shown before "Show all". */
const HISTORY_FOLD = 8;

function historyDetail(e: PaymentHistoryEvent): string | null {
  switch (e.action) {
    case 'payment_requested':
      return e.auto_approved ? 'Approved automatically as it was raised' : null;
    case 'payment_updated':
      return e.fields.length ? `Changed ${e.fields.map((f) => f.replace(/_/g, ' ')).join(', ')}` : null;
    case 'payment_method_changed':
      return `${e.from_method ? methodLabel(e.from_method) : '—'} → ${e.to_method ? methodLabel(e.to_method) : '—'}`;
    case 'payment_delete_rejected':
      return 'The request was kept';
    default:
      return null;
  }
}

export function PaymentTimelineCard({ woNumber }: { woNumber: string }) {
  // Under ['wo-payments', wo] so every payment action's invalidation refreshes it.
  const historyQuery = useQuery({
    queryKey: ['wo-payments', woNumber, 'history'],
    queryFn: () => getPaymentHistory(woNumber),
    retry: 0,
  });
  const [showAll, setShowAll] = useState(false);
  const items = historyQuery.data?.items ?? [];
  const shown = showAll ? items : items.slice(0, HISTORY_FOLD);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Payment history</h2>
        {items.length > 0 && (
          <span className="card-meta">{`${items.length} event${items.length === 1 ? '' : 's'}`}</span>
        )}
      </div>

      {historyQuery.isLoading ? (
        <div className="empty-flat">Loading history…</div>
      ) : historyQuery.isError ? (
        <div className="empty-flat">Could not load the payment history.</div>
      ) : items.length === 0 ? (
        <div className="empty-flat">Nothing has happened to a payment on this WO yet.</div>
      ) : (
        <ul className="payh">
          {shown.map((e) => {
            const detail = historyDetail(e);
            return (
              <li className="payh-row" key={e.id}>
                <span className="payh-when">{shortDate(e.at) ?? '—'}</span>
                <span className="payh-who">
                  <span className="payh-name">
                    {e.payee ?? 'Technician'}
                    {e.purpose && <span className="payh-sub"> · {e.purpose}</span>}
                    {e.request_deleted && e.action !== 'payment_deleted' && (
                      <span className="payh-sub"> · since deleted</span>
                    )}
                  </span>
                  <span className="payh-sub">
                    {`by ${e.actor_name} · ${shortDateTime(e.at) ?? ''}`}
                    {e.self_approved && ' · own request (super admin)'}
                  </span>
                  {detail && <span className="payh-sub">{detail}</span>}
                  {e.reason && <span className="payh-sub">“{e.reason}”</span>}
                </span>
                <span className={`chip chip-sm ${HISTORY_CHIP[e.action]}`.trim()}>{HISTORY_LABEL[e.action]}</span>
                <span className="payh-amt">{e.amount == null ? '' : usd(e.amount)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {items.length > HISTORY_FOLD && (
        <div className="card-foot">
          <button type="button" className="btn btn-sm" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show all ${items.length}`}
          </button>
        </div>
      )}
    </section>
  );
}
