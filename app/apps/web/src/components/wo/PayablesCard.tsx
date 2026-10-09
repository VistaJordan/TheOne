/* The Payables tab (two cards, side by side):

     PayablesFieldsCard   the All-fields "Payments" section (PPR link, Yoda
                          link, whatever the founder adds to it), as editable
                          rows — driven by FIELD_SECTIONS so the two views can
                          never drift apart.
     PaymentHistoryCard   every payment request on this WO, newest first, each
                          with its status (Requested / Approved / Paid /
                          Rejected), plus the "Request payment" entry point.

   The old rail-era mini card capped the ledger at three rows; the tab has the
   room to show all of it. */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PaymentRequest, WoActionState, WorkOrderDetailV2 } from '../../api/client';
import { FieldHistory, HistoryToggle } from './FieldHistory';
import { payeeLabel, PAYMENT_STATUS_LABEL } from '../payments/PaymentsTable';
import { methodLabel } from '../../api/client';
import type { PaymentRequestStatus } from '@theone/shared';
import { shortDate } from '../../lib/fields';
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
