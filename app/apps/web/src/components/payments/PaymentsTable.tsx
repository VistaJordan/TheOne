/* "Previous payments on this work order" (comp: .tbl).

   Sortable, newest-first by default. Method and purpose are rendered as LABELS,
   not raw column values: an AP ledger read by a dispatcher has to say "ACH
   transfer · Parts advance", not "ach"/"parts_advance".

   The footer totals only what has actually been PAID — a requested-but-unpaid
   row is money promised, not money out, and adding the two together is how a WO
   looks over-spent when it is not. */

import { useMemo, useState } from 'react';
import type { PaymentRequest, PaymentRequestStatus } from '../../api/client';
import { usd } from '../../lib/quoteTotals';
import { shortDate } from '../../lib/fields';
import { Icon } from '../Icon';

type SortKey = 'date' | 'who' | 'method' | 'purpose' | 'amount';

interface PaymentsTableProps {
  items: PaymentRequest[];
  loading: boolean;
  error: boolean;
  woNumber: string;
  totalPaid: number;
}

export const PAYMENT_STATUS_LABEL: Record<PaymentRequestStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  paid: 'Paid',
  rejected: 'Rejected',
};

export function payeeLabel(item: PaymentRequest): string {
  return item.payee.name ?? (item.payee.vendor_id ? 'Vendor record' : 'Unnamed technician');
}

export function PaymentsTable({ items, loading, error, woNumber, totalPaid }: PaymentsTableProps) {
  const [sort, setSort] = useState<SortKey>('date');
  const [desc, setDesc] = useState(true);

  const rows = useMemo(() => {
    const value = (p: PaymentRequest): string | number => {
      switch (sort) {
        case 'who': return payeeLabel(p).toLowerCase();
        case 'method': return (p.method ?? '').toLowerCase();
        case 'purpose': return (p.purpose ?? '').toLowerCase();
        case 'amount': return p.amount;
        default: return p.created_at ?? '';
      }
    };
    return [...items].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return desc ? -cmp : cmp;
    });
  }, [items, sort, desc]);

  const toggle = (key: SortKey) => {
    if (key === sort) setDesc((d) => !d);
    else {
      setSort(key);
      setDesc(key === 'date' || key === 'amount');
    }
  };

  const th = (key: SortKey, label: string, width: string, right = false) => (
    <th
      scope="col"
      className={right ? 'th-r' : undefined}
      style={{ width }}
      aria-sort={sort === key ? (desc ? 'descending' : 'ascending') : undefined}
    >
      <button type="button" className="sortbtn" onClick={() => toggle(key)}>
        {label}
        <Icon name={sort === key && !desc ? 'sort' : 'sort-down'} size={12} />
      </button>
    </th>
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Previous payments on this work order</h2>
        <span className="card-meta">
          {loading
            ? 'Loading…'
            : `${items.length} payment${items.length === 1 ? '' : 's'} · ${desc && sort === 'date' ? 'newest first' : 'sorted'}`}
        </span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <caption className="sr">Payments already made on {woNumber}</caption>
          <thead>
            <tr>
              {th('date', 'Date', '15%')}
              {th('who', 'Recipient', '30%')}
              {th('method', 'Method', '14%')}
              {th('purpose', 'Purpose', '27%')}
              {th('amount', 'Amount', '14%', true)}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5}>Loading payments…</td></tr>}
            {error && !loading && (
              <tr><td colSpan={5}>Could not load the payments on this work order.</td></tr>
            )}
            {!loading && !error && rows.length === 0 && (
              <tr><td colSpan={5}>No payments have been requested on this work order yet.</td></tr>
            )}
            {!loading &&
              !error &&
              rows.map((p) => (
                <tr key={p.id}>
                  <td className="td-date">{shortDate(p.created_at) ?? '—'}</td>
                  <td className="td-who">
                    {payeeLabel(p)}
                    {p.recipient_name && (
                      <span className="ctx-sub"> · paid to {p.recipient_name}</span>
                    )}
                  </td>
                  <td>
                    <span className="chip chip-sm">
                      <Icon name="card" size={12} />
                      {p.method || '—'}
                    </span>
                  </td>
                  <td>
                    {p.purpose || '—'}
                    {p.status !== 'paid' && (
                      <span className="chip chip-sm chip-outline" style={{ marginLeft: 6 }}>
                        {PAYMENT_STATUS_LABEL[p.status]}
                      </span>
                    )}
                  </td>
                  <td className="td-amt">{usd(p.amount)}</td>
                </tr>
              ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="tbl-foot-k" colSpan={4}>Total paid on this WO</td>
              <td className="td-amt">{usd(totalPaid)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
