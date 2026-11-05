/* Payment history: every step of every payment request on a work order —
   requested, edited, approved, paid, rejected, method changed, delete asked /
   refused / done — who and when, deleted requests included
   (GET …/payment-history). Drawn under "Money on this WO" on the payment
   request form (Elise, 2026-11-05), so also on the Finances tab. */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPaymentHistory, methodLabel } from '../../api/client';
import type { PaymentHistoryAction, PaymentHistoryEvent } from '@theone/shared';
import { shortDate, shortDateTime } from '../../lib/fields';
import { usd } from '../../lib/quoteTotals';

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
    enabled: woNumber.length > 0,
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
