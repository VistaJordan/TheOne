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

import { Link } from 'react-router-dom';
import type { PaymentRequest, WorkOrderDetailV2 } from '../../api/client';
import { payeeLabel, PAYMENT_STATUS_LABEL } from '../payments/PaymentsTable';
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
  paid: 'chip-accent',
  rejected: 'chip-danger',
};

export function PayablesFieldsCard({ wo }: { wo: WorkOrderDetailV2 }) {
  const byKey = useWoCatalogue();
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
            <div className="fieldrow" key={f.key}>
              <dt>{f.label}</dt>
              <dd>
                <InlineField wo={wo} fieldKey={f.key} label={f.label} />
              </dd>
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
}

export function PaymentHistoryCard({ woNumber, items, totalPaid, loading }: PaymentHistoryCardProps) {
  // 0015 · the entry point needs payments:create; the ledger needs only view.
  const canRequest = useAuth().can('payments', 'create');
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Payment requests</h2>
        {!loading && items.length > 0 && (
          <span className="card-meta">
            {`${usd(totalPaid ?? 0)} paid · ${items.length} request${items.length === 1 ? '' : 's'}`}
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
            <li className="payh-row" key={p.id}>
              <span className="payh-when">{shortDate(p.created_at) ?? '—'}</span>
              <span className="payh-who">
                <span className="payh-name">
                  {payeeLabel(p)}
                  {p.recipient_name && <span className="payh-sub"> · paid to {p.recipient_name}</span>}
                </span>
                {(p.purpose || p.method) && (
                  <span className="payh-sub">
                    {[p.purpose, p.method].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
              <span className={`chip chip-sm ${STATUS_CHIP[p.status]}`.trim()}>
                {PAYMENT_STATUS_LABEL[p.status]}
              </span>
              <span className="payh-amt">{usd(p.amount)}</span>
            </li>
          ))}
        </ul>
      )}

      {canRequest && (
        <div className="card-foot">
          <Link
            className="btn btn-sm"
            to={`/work-orders/${encodeURIComponent(woNumber)}/request-payment`}
          >
            <Icon name="dollar" size={12} />
            Request payment
          </Link>
        </div>
      )}
    </section>
  );
}
