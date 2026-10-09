/* /payments — the sidebar's "Payments" destination: the payables queue
   (Yoda payment-list).

   Every technician payment request across every live work order the viewer
   may see (0026 scope), in three lanes: Needs approval (requested), To pay
   (approved) and All. Pending deletes pin to the top of every lane. Each row
   carries its own decision cluster, so the tab is the place the money is
   decided — the request page on the work order only raises it.

   Three permissions drive what a row offers (0015 / 0028):
     payments:approve          Approve / Reject
     payments/process:edit     Pay / Change method / Delete
     payments/process:delete   Confirm or keep a pending delete (admin)
   A verb the viewer may not use stays VISIBLE and locked with the reason
   (product/quotes-payments.md discoverability rule) — never hidden. */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PAYMENT_PROCESS_PERM_KEY } from '@theone/shared';
import type { PaymentListItem, PaymentRequestStatus } from '../api/client';
import { ApiRequestError, listPayments, methodLabel } from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { ListPagination, PAGE_SIZES } from '../components/ListPagination';
import { PaymentActions } from '../components/payments/PaymentActions';
import { ComplianceChips, PaymentStatusPill, payeeLabel } from '../components/payments/PaymentsTable';
import { useAuth } from '../auth/AuthProvider';
import { usd } from '../lib/quoteTotals';
import { numericDate } from '../lib/fields';

type Lane = 'approval' | 'process' | 'all';

const LANE_LABEL: Record<Lane, string> = {
  approval: 'Needs approval',
  process: 'To pay',
  all: 'All requests',
};

const LANE_STATUS: Record<Lane, PaymentRequestStatus | undefined> = {
  approval: 'requested',
  process: 'approved',
  all: undefined,
};

export function PaymentsPage() {
  const { can } = useAuth();
  const canApprove = can('payments', 'approve');
  const canProcess = can(PAYMENT_PROCESS_PERM_KEY, 'edit');

  // Land on the lane that is this person's job: approvers on what needs a
  // decision, AP on what needs paying, everyone else on the whole ledger.
  const [lane, setLane] = useState<Lane>(canApprove ? 'approval' : canProcess ? 'process' : 'all');
  const [q, setQ] = useState('');
  const [company, setCompany] = useState('');
  const [onlyW9, setOnlyW9] = useState(false);
  const [onlyPendingDelete, setOnlyPendingDelete] = useState(false);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [offset, setOffset] = useState(0);

  const params = useMemo(
    () => ({
      status: LANE_STATUS[lane],
      q: q.trim() || undefined,
      billing_entity: company.trim() || undefined,
      needs_w9: onlyW9 ? ('true' as const) : undefined,
      pending_delete: onlyPendingDelete ? ('true' as const) : undefined,
      page: Math.floor(offset / pageSize) + 1,
      page_size: pageSize,
    }),
    [lane, q, company, onlyW9, onlyPendingDelete, offset, pageSize],
  );

  const paymentsQuery = useQuery({
    queryKey: ['payments', params],
    queryFn: () => listPayments(params),
    retry: 0,
    placeholderData: (prev) => prev,
  });
  const items = paymentsQuery.data?.items ?? [];
  const total = paymentsQuery.data?.total ?? 0;
  const counts = paymentsQuery.data?.counts;
  const pendingDeletes = paymentsQuery.data?.pending_delete_count ?? 0;

  const laneCount = (l: Lane): number | undefined => {
    if (!counts) return undefined;
    const s = LANE_STATUS[l];
    if (s) return counts[s] + (s === 'approved' ? counts.sent_to_yoda : 0);
    return Object.values(counts).reduce((n, c) => n + c, 0);
  };

  const onPage = (amount: (i: PaymentListItem) => boolean) =>
    items.filter(amount).reduce((sum, i) => sum + i.amount, 0);

  const notServed =
    paymentsQuery.error instanceof ApiRequestError && paymentsQuery.error.status === 404;
  const forbidden =
    paymentsQuery.error instanceof ApiRequestError && paymentsQuery.error.status === 403;

  const reset = () => setOffset(0);
  const switchLane = (l: Lane) => {
    setLane(l);
    reset();
  };

  return (
    <AppShell active="Payments">
      <div className="pay">
      <div className="page-head">
        <p className="page-sub">
          {paymentsQuery.isLoading
            ? 'Loading…'
            : forbidden
              ? 'Payments — needs the payments permission'
              : `${total} request${total === 1 ? '' : 's'} · ${LANE_LABEL[lane].toLowerCase()}${pendingDeletes ? ` · ${pendingDeletes} pending delete` : ''}`}
        </p>
      </div>

      {forbidden ? (
        <div className="quotes-empty">
          <Icon name="lock" size={22} />
          <b>The payments queue needs the payments permission</b>
          <span>Ask an admin for payments:view, or track a request from its work order's Request payment screen.</span>
        </div>
      ) : (
        <>
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
                  Awaiting approval <b>{usd(onPage((i) => i.status === 'requested'))}</b>
                </span>
                <span>
                  Approved, not yet paid{' '}
                  <b>{usd(onPage((i) => i.status === 'approved' || i.status === 'sent_to_yoda'))}</b>
                </span>
              </div>
            )}
          </div>

          <div className="pay-filters card card-pad">
            <div className="pay-filter-row">
              <div className="field">
                <label className="flabel" htmlFor="pq-q">Search</label>
                <div className="amtwrap">
                  <span className="amt-cur" aria-hidden="true"><Icon name="search" size={14} /></span>
                  <input
                    className="amt-in"
                    id="pq-q"
                    placeholder="WO number, purpose, technician…"
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      reset();
                    }}
                  />
                </div>
              </div>
              <div className="field">
                <label className="flabel" htmlFor="pq-company">Company</label>
                <input
                  className="finput"
                  id="pq-company"
                  placeholder="SFM, BKR, AF…"
                  value={company}
                  onChange={(e) => {
                    setCompany(e.target.value);
                    reset();
                  }}
                />
              </div>
              <label className="ck">
                <input type="checkbox" checked={onlyW9} onChange={(e) => { setOnlyW9(e.target.checked); reset(); }} />
                <span>W9 needed</span>
              </label>
              <label className="ck">
                <input type="checkbox" checked={onlyPendingDelete} onChange={(e) => { setOnlyPendingDelete(e.target.checked); reset(); }} />
                <span>Pending delete</span>
              </label>
            </div>
          </div>

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
              <table className="ct pay-queue">
                <thead>
                  <tr>
                    <th className="col-wo">WO #</th>
                    <th className="col-client">Client / Title</th>
                    <th>Technician / Purpose</th>
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
                  {!paymentsQuery.isLoading && items.length === 0 && (
                    <tr className="ct-empty">
                      <td colSpan={7}>
                        {q || company || onlyW9 || onlyPendingDelete
                          ? 'Nothing matches these filters.'
                          : lane === 'approval'
                            ? 'Nothing is waiting for approval.'
                            : lane === 'process'
                              ? 'Nothing is waiting to be paid.'
                              : 'No technician payments have been requested yet.'}
                      </td>
                    </tr>
                  )}
                  {items.map((p) => (
                    <PaymentRow key={p.id} item={p} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!paymentsQuery.isError && (
            <ListPagination
              total={paymentsQuery.isLoading ? undefined : total}
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
        </>
      )}
      </div>
    </AppShell>
  );
}

// ── One row ──────────────────────────────────────────────────────────────────

function PaymentRow({ item }: { item: PaymentListItem }) {
  const woHref = `/work-orders/${encodeURIComponent(item.wo_number)}`;
  const when = numericDate(item.created_at) ?? '—';
  const by = item.requested_by?.display_name;

  // What happened last, for the status cell's second line.
  const trail = item.pending_delete
    ? (item.delete_reason ?? 'delete requested')
    : item.status === 'approved' && item.approved_by
      ? `by ${item.approved_by.display_name}${item.approved_at ? ` · ${numericDate(item.approved_at)}` : ''}`
      : item.status === 'paid' && item.paid_at
        ? `${numericDate(item.paid_at)}${item.paid_by ? ` · ${item.paid_by.display_name}` : ''}`
        : item.status === 'rejected'
          ? (item.rejection_note ?? (item.rejected_by ? `by ${item.rejected_by.display_name}` : null))
          : null;

  return (
    <tr className={item.pending_delete ? 'is-pending-delete' : item.status === 'rejected' ? 'is-rejected' : undefined}>
      <td className="col-wo">
        <Link className="wo-num wo-num-link" to={woHref}>
          {item.wo_number}
        </Link>
        {item.billing_entity && <small className="ctx-sub"> · {item.billing_entity}</small>}
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
            <ComplianceChips item={item} />
            {item.recipient_name && <span className="ctx-sub"> · paid to {item.recipient_name}</span>}
          </strong>
          <small>{[item.purpose, methodLabel(item.method)].filter(Boolean).join(' · ')}</small>
        </div>
      </td>
      <td className="num">{usd(item.amount)}</td>
      <td className="col-status">
        <span className="payq-status">
          <PaymentStatusPill status={item.status} pendingDelete={item.pending_delete} />
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
        <PaymentActions item={item} />
      </td>
    </tr>
  );
}
