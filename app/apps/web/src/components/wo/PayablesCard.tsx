/* WO-detail rail card — the payables entry point (S4).

   The mini list is three rows deep on purpose: it exists to answer "has this
   technician already been paid something on this job?" before someone requests
   another advance. The full ledger lives on the request screen. */

import { Link } from 'react-router-dom';
import type { PaymentRequest } from '../../api/client';
import { payeeLabel, PAYMENT_STATUS_LABEL } from '../payments/PaymentsTable';
import { shortDate } from '../../lib/fields';
import { usd } from '../../lib/quoteTotals';
import { Icon } from '../Icon';

interface PayablesCardProps {
  woNumber: string;
  items: PaymentRequest[];
  totalPaid: number | null;
  loading: boolean;
}

const MAX_ROWS = 3;

export function PayablesCard({ woNumber, items, totalPaid, loading }: PayablesCardProps) {
  const shown = items.slice(0, MAX_ROWS);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Payables</h2>
        {!loading && (
          <span className="card-meta">
            {items.length === 0
              ? 'None yet'
              : `${usd(totalPaid ?? 0)} paid · ${items.length} request${items.length === 1 ? '' : 's'}`}
          </span>
        )}
      </div>

      {loading ? (
        <div className="empty-flat">Loading payables…</div>
      ) : items.length === 0 ? (
        <div className="empty-flat">No technician payments have been requested on this WO.</div>
      ) : (
        <ul className="mini-pay">
          {shown.map((p) => (
            <li className="mini-pay-row" key={p.id}>
              <span className="mini-pay-when">{shortDate(p.created_at) ?? '—'}</span>
              <span className="mini-pay-who">
                {payeeLabel(p)}
                {p.status !== 'paid' && ` · ${PAYMENT_STATUS_LABEL[p.status]}`}
              </span>
              <span className="mini-pay-amt">{usd(p.amount)}</span>
            </li>
          ))}
          {items.length > MAX_ROWS && (
            <li className="mini-pay-row">
              <span className="mini-pay-who">
                +{items.length - MAX_ROWS} more on the request screen
              </span>
            </li>
          )}
        </ul>
      )}

      <div className="card-foot">
        <Link
          className="btn btn-sm"
          to={`/work-orders/${encodeURIComponent(woNumber)}/request-payment`}
        >
          <Icon name="dollar" size={12} />
          Request payment
        </Link>
      </div>
    </section>
  );
}
