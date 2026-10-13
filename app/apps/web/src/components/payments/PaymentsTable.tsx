/* "Previous payments on this work order" (comp: .tbl) — now the WO's payment
   LEDGER at Yoda parity: status, W9 / blacklist flags, pending-delete marker
   and the AP row actions.

   Sortable, newest-first by default. Method and purpose are rendered as LABELS,
   not raw column values: an AP ledger read by a dispatcher has to say "ACH ·
   Parts advance", not "ach"/"parts_advance".

   The footer totals only what has actually been PAID — a requested-but-unpaid
   row is money promised, not money out, and adding the two together is how a WO
   looks over-spent when it is not. */

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { methodLabel } from '../../api/client';
import type { PaymentRequest, PaymentRequestStatus } from '../../api/client';
import { usd } from '../../lib/quoteTotals';
import { shortDate } from '../../lib/fields';
import { PaymentActions } from './PaymentActions';
import { Icon } from '../Icon';

type SortKey = 'date' | 'who' | 'method' | 'purpose' | 'status' | 'amount';

interface PaymentsTableProps {
  items: PaymentRequest[];
  loading: boolean;
  error: boolean;
  woNumber: string;
  totalPaid: number;
  /** Show the AP action column (default on). */
  actions?: boolean;
}

export const PAYMENT_STATUS_LABEL: Record<PaymentRequestStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  // Retired hand-off (0016 → 0028); a row that still carries it reads as approved.
  sent_to_yoda: 'Approved',
  paid: 'Paid',
  rejected: 'Rejected',
};

const STATUS_COLOR: Record<PaymentRequestStatus, string> = {
  requested: '#4466ff',
  approved: '#0f9d9f',
  sent_to_yoda: '#0f9d9f',
  paid: '#6bed5e',
  rejected: '#e05a5a',
};

export function PaymentStatusPill({ status, pendingDelete }: { status: PaymentRequestStatus; pendingDelete?: boolean }) {
  const style = { ['--pill' as string]: pendingDelete ? '#e0a22e' : STATUS_COLOR[status] } as CSSProperties;
  return (
    <span className="pill pill-sm" style={style} title={pendingDelete ? 'Delete requested — awaiting admin' : undefined}>
      <span className="pill-dot" aria-hidden="true" />
      <span className="pill-label">{pendingDelete ? 'Pending delete' : PAYMENT_STATUS_LABEL[status]}</span>
    </span>
  );
}

export function payeeLabel(item: PaymentRequest): string {
  return item.payee.name ?? (item.payee.vendor_id ? 'Vendor record' : 'Unnamed technician');
}

/** The compliance chips Yoda's payment list shows per row (COI, W9, blacklist). */
export function ComplianceChips({ item }: { item: PaymentRequest }) {
  const chips: { label: string; cls: string; title: string }[] = [];
  if (item.needs_w9) chips.push({ label: 'W9 needed', cls: 'chip-danger', title: 'Technician crossed $599 this year without a W9 on file' });
  if (item.payee.is_blacklisted) chips.push({ label: 'Blacklisted', cls: 'chip-danger', title: 'Vendor is blacklisted' });
  if (item.payee.insurance_expires_on && new Date(item.payee.insurance_expires_on) < new Date()) {
    chips.push({ label: 'COI expired', cls: 'chip-outline', title: `Insurance expired ${item.payee.insurance_expires_on}` });
  }
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((c) => (
        <span key={c.label} className={`chip chip-sm ${c.cls}`} title={c.title} style={{ marginLeft: 6 }}>
          <Icon name="alert" size={12} />
          {c.label}
        </span>
      ))}
    </>
  );
}

export function PaymentsTable({ items, loading, error, woNumber, totalPaid, actions = true }: PaymentsTableProps) {
  const [sort, setSort] = useState<SortKey>('date');
  const [desc, setDesc] = useState(true);

  const rows = useMemo(() => {
    const value = (p: PaymentRequest): string | number => {
      switch (sort) {
        case 'who': return payeeLabel(p).toLowerCase();
        case 'method': return (p.method ?? '').toLowerCase();
        case 'purpose': return (p.purpose ?? '').toLowerCase();
        case 'status': return p.status;
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

  const cols = actions ? 7 : 6;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Payments on this work order</h2>
        <span className="card-meta">
          {loading
            ? 'Loading…'
            : `${items.length} payment${items.length === 1 ? '' : 's'} · ${desc && sort === 'date' ? 'newest first' : 'sorted'}`}
        </span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <caption className="sr">Payments requested and made on {woNumber}</caption>
          <thead>
            <tr>
              {th('date', 'Date', '12%')}
              {th('who', 'Recipient', '24%')}
              {th('method', 'Method', '11%')}
              {th('purpose', 'Purpose', '21%')}
              {th('status', 'Status', '12%')}
              {th('amount', 'Amount', '10%', true)}
              {actions && <th scope="col" style={{ width: '10%' }}><span className="sr">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={cols}>Loading payments…</td></tr>}
            {error && !loading && (
              <tr><td colSpan={cols}>Could not load the payments on this work order.</td></tr>
            )}
            {!loading && !error && rows.length === 0 && (
              <tr><td colSpan={cols}>No payments have been requested on this work order yet.</td></tr>
            )}
            {!loading &&
              !error &&
              rows.map((p) => (
                <tr key={p.id} className={p.pending_delete ? 'is-pending-delete' : p.status === 'rejected' ? 'is-rejected' : undefined}>
                  <td className="td-date">{shortDate(p.created_at) ?? '—'}</td>
                  <td className="td-who">
                    {payeeLabel(p)}
                    {p.recipient_name && (
                      <span className="ctx-sub"> · paid to {p.recipient_name}{p.recipient_is_store ? ' (store)' : ''}</span>
                    )}
                    <ComplianceChips item={p} />
                  </td>
                  <td>
                    <span className="chip chip-sm">
                      <Icon name="card" size={12} />
                      {methodLabel(p.method)}
                    </span>
                  </td>
                  <td>
                    {p.purpose || '—'}
                    {p.rejection_note && <span className="ctx-sub"> · {p.rejection_note}</span>}
                  </td>
                  <td>
                    <PaymentStatusPill status={p.status} pendingDelete={p.pending_delete} />
                    {p.paid_by && p.status === 'paid' && (
                      <span className="ctx-sub"> · {p.paid_by.display_name}</span>
                    )}
                  </td>
                  <td className="td-amt">{usd(p.amount)}</td>
                  {actions && (
                    <td className="td-actions">
                      <PaymentActions item={p} compact />
                    </td>
                  )}
                </tr>
              ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="tbl-foot-k" colSpan={cols - (actions ? 2 : 1)}>Total paid on this WO</td>
              <td className="td-amt">{usd(totalPaid)}</td>
              {actions && <td />}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
