/* Receivables › Invoicing (0045) — downstream of the completion audit.
 *
 * Two lanes that come from different places, on purpose:
 *
 *   Ready      a JUDGEMENT about a work order — its audit is clean and both
 *              release boxes are ticked. Derived, and it disappears the moment
 *              an invoice is raised against that work order.
 *   The rest   a DOCUMENT that exists: a row in `invoice`, its number issued
 *              from its billing entity's own sequence, its lines snapshotted
 *              from the approved quote, its status moving one way only.
 *
 * Until now this whole pipeline was React state: "Generate invoice" and "Mark
 * paid" changed a variable, the number was derived from the work order's id,
 * and a reload put everything back. Nothing here is derived any more except
 * the Ready lane, which should be.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  INVOICE_STATUS_HINTS,
  INVOICE_STATUS_LABELS,
  type Invoice,
  type InvoiceStatus,
  type InvoicesResponse,
} from '@theone/shared';
import {
  ApiRequestError,
  confirmBillingProposal,
  createInvoice,
  dismissBillingProposal,
  listBillingProposals,
  markInvoicePaid,
  sendInvoice,
  type WorkOrderListItemV2,
} from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../Icon';
import { StatCard, money } from './bits';

export type StageFilter = 'all' | 'ready' | 'proposed' | InvoiceStatus;

const STAGE_FILTERS: { key: StageFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'proposed', label: 'Proposed' },
  { key: 'ready', label: 'Ready' },
  { key: 'draft', label: 'Drafts' },
  { key: 'sent', label: 'Sent' },
  { key: 'paid', label: 'Paid' },
];

export interface ReadyRow {
  wo: WorkOrderListItemV2;
  amount: number;
}

interface InvoicingTabProps {
  ready: ReadyRow[];
  invoices: Invoice[];
  totals: InvoicesResponse['totals'] | undefined;
  blockedCount: number;
  loading: boolean;
  error: boolean;
}

export function InvoicingTab({
  ready,
  invoices,
  totals,
  blockedCount,
  loading,
  error,
}: InvoicingTabProps) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<StageFilter>('all');
  const [failure, setFailure] = useState<string | null>(null);
  const { can } = useAuth();
  const canRaise = can('invoicing', 'create');
  const canSend = can('invoicing', 'approve');

  // 0053 · BRD §6.4: invoices a contract proposed on completion, waiting on
  // AR. Confirming files one (it then appears below as a draft); dismissing
  // files nothing. Vendor-bill proposals belong to Payments, not here.
  const proposalsQ = useQuery({ queryKey: ['billing-proposals'], queryFn: listBillingProposals, retry: 0 });
  const proposed = (proposalsQ.data?.items ?? []).filter((p) => p.kind === 'invoice');

  const done = () => {
    setFailure(null);
    void qc.invalidateQueries({ queryKey: ['invoices'] });
    void qc.invalidateQueries({ queryKey: ['billing-proposals'] });
  };
  const fail = (err: unknown) =>
    setFailure(err instanceof ApiRequestError ? err.message : 'That did not go through');

  const raise = useMutation({ mutationFn: createInvoice, onSuccess: done, onError: fail });
  const send = useMutation({ mutationFn: sendInvoice, onSuccess: done, onError: fail });
  const pay = useMutation({
    mutationFn: (id: string) => markInvoicePaid(id),
    onSuccess: done,
    onError: fail,
  });
  const confirm = useMutation({ mutationFn: (id: string) => confirmBillingProposal(id), onSuccess: done, onError: fail });
  const dismiss = useMutation({ mutationFn: (id: string) => dismissBillingProposal(id), onSuccess: done, onError: fail });
  const busy = raise.isPending || send.isPending || pay.isPending || confirm.isPending || dismiss.isPending;

  const showReady = filter === 'all' || filter === 'ready';
  const showProposed = filter === 'all' || filter === 'proposed';
  const visibleInvoices =
    filter === 'all'
      ? invoices
      : filter === 'ready' || filter === 'proposed'
        ? []
        : invoices.filter((i) => i.status === filter);
  const COLS = 7;

  const countFor = (key: StageFilter) =>
    key === 'all'
      ? proposed.length + ready.length + invoices.length
      : key === 'ready'
        ? ready.length
        : key === 'proposed'
          ? proposed.length
          : invoices.filter((i) => i.status === key).length;

  return (
    <>
      <p className="rcv-lede">
        Everything the audit released, staged to cash. A work order lands here the moment its audit
        is clean and both release checks are ticked; raising an invoice gives it a number and takes
        it out of the Ready lane.
      </p>

      <div className="rcv-stats">
        <StatCard label="Ready to invoice" value={loading ? '—' : ready.length} tone="clean" />
        <StatCard label="Drafts" value={loading ? '—' : money(totals?.draft ?? 0)} tone="neutral" />
        <StatCard
          label="Outstanding"
          value={loading ? '—' : money(totals?.outstanding ?? 0)}
          tone="major"
        />
        <StatCard
          label="Collected (30d)"
          value={loading ? '—' : money(totals?.paid_30d ?? 0)}
          tone="neutral"
        />
      </div>

      {(totals?.overdue ?? 0) > 0 && !loading && (
        <div className="rcv-blocked">
          <Icon name="alert" size={12} />
          {money(totals?.overdue ?? 0)} is past its due date.
        </div>
      )}

      {blockedCount > 0 && !loading && (
        <div className="rcv-blocked">
          <Icon name="flag" size={12} />
          {blockedCount} work order{blockedCount === 1 ? ' is' : 's are'} still held by the
          completion audit —{' '}
          <Link to="/receivables" className="rcv-blocked-link">
            clear them in the Audit tab
          </Link>
          .
        </div>
      )}

      {failure && (
        <div className="rcv-blocked" role="alert">
          <Icon name="alert" size={12} />
          {failure}
        </div>
      )}

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Filter by invoice stage">
          {STAGE_FILTERS.map((f) => (
            <button
              type="button"
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={`seg-btn${filter === f.key ? ' is-on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="rcv-tab-count">{countFor(f.key)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="table-wrap">
        <table className="ct rcv-table">
          <thead>
            <tr>
              <th className="col-wo">WO #</th>
              <th>Client / Site</th>
              <th>Billing entity</th>
              <th>Invoice</th>
              <th className="num">Amount</th>
              <th>Stage</th>
              <th className="rcv-action-th">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr className="ct-empty">
                <td colSpan={COLS}>Loading the invoicing pipeline…</td>
              </tr>
            )}
            {error && !loading && (
              <tr className="ct-empty">
                <td colSpan={COLS}>Failed to load work orders. Is the API running on :5174?</td>
              </tr>
            )}
            {!loading && !error && ready.length === 0 && visibleInvoices.length === 0 && !(showProposed && proposed.length > 0) && (
              <tr className="ct-empty">
                <td colSpan={COLS}>
                  {filter === 'proposed'
                    ? 'Nothing proposed — a contract with "bill automatically on completion" fills this lane when its work orders complete.'
                    : filter === 'ready' || filter === 'all'
                      ? 'Nothing is ready yet — clean WOs with Admin + Quote ticked appear here.'
                      : 'Nothing in this stage.'}
                </td>
              </tr>
            )}

            {/* 0053 · Proposed on completion: no number yet, so nothing to show there. */}
            {!loading &&
              !error &&
              showProposed &&
              proposed.map((p) => (
                <tr key={p.id}>
                  <td className="col-wo">
                    <Link
                      className="wo-num wo-num-link"
                      to={`/work-orders/${encodeURIComponent(p.wo_number)}`}
                    >
                      {p.wo_number}
                    </Link>
                  </td>
                  <td>
                    <div className="site">
                      <strong>{p.client ?? '—'}</strong>
                      <small>
                        From {p.contract_name}
                        {p.hours > 0 ? ` · ${p.hours} h on site` : ''}
                        {p.visits > 0 ? ` · ${p.visits} visit${p.visits === 1 ? '' : 's'}` : ''}
                      </small>
                    </div>
                  </td>
                  <td className="rcv-trunc">{p.billing_entity ?? p.client ?? '—'}</td>
                  <td className="rcv-co">
                    <span className="rcv-none">—</span>
                  </td>
                  <td className="num rcv-amount">{money(p.total)}</td>
                  <td>
                    <span className="rcv-stage is-proposed" title="Generated by the contract when the work order completed">
                      <span className="rcv-status-dot" aria-hidden="true" />
                      Proposed
                    </span>
                  </td>
                  <td className="rcv-action-td">
                    <button
                      type="button"
                      className="rcv-btn is-primary"
                      disabled={!canRaise || busy}
                      title={canRaise ? 'File the invoice with exactly these lines' : 'You cannot raise invoices'}
                      onClick={() => confirm.mutate(p.id)}
                    >
                      <Icon name="check" size={12} />
                      {confirm.isPending ? 'Filing…' : 'Confirm'}
                    </button>{' '}
                    <button
                      type="button"
                      className="rcv-btn"
                      disabled={!canRaise || busy}
                      title="File nothing"
                      onClick={() => dismiss.mutate(p.id)}
                    >
                      Dismiss
                    </button>
                  </td>
                </tr>
              ))}

            {/* Ready: no invoice yet, so there is no number to show. */}
            {!loading &&
              !error &&
              showReady &&
              ready.map((r) => (
                <tr key={r.wo.id}>
                  <td className="col-wo">
                    <Link
                      className="wo-num wo-num-link"
                      to={`/work-orders/${encodeURIComponent(r.wo.wo_number)}`}
                    >
                      {r.wo.wo_number}
                    </Link>
                  </td>
                  <td>
                    <div className="site">
                      <strong>{r.wo.client ?? '—'}</strong>
                      <small>{[r.wo.city, r.wo.state].filter(Boolean).join(', ') || '—'}</small>
                    </div>
                  </td>
                  <td className="rcv-trunc">{r.wo.billing_entity ?? r.wo.client ?? '—'}</td>
                  <td className="rcv-co">
                    <span className="rcv-none">—</span>
                  </td>
                  <td className="num rcv-amount">{money(r.amount)}</td>
                  <td>
                    <span className="rcv-stage is-ready">
                      <span className="rcv-status-dot" aria-hidden="true" />
                      Ready to invoice
                    </span>
                  </td>
                  <td className="rcv-action-td">
                    <button
                      type="button"
                      className="rcv-btn is-primary"
                      disabled={!canRaise || busy}
                      title={
                        canRaise
                          ? 'Raise a draft from the approved quote'
                          : 'You cannot raise invoices'
                      }
                      onClick={() => raise.mutate({ task_id: r.wo.id })}
                    >
                      <Icon name="file" size={12} />
                      {raise.isPending ? 'Raising…' : 'Raise invoice'}
                    </button>
                  </td>
                </tr>
              ))}

            {/* Real invoices, newest first. */}
            {!loading &&
              !error &&
              visibleInvoices.map((inv) => (
                <tr key={inv.id}>
                  <td className="col-wo">
                    <Link
                      className="wo-num wo-num-link"
                      to={`/work-orders/${encodeURIComponent(inv.wo_number)}`}
                    >
                      {inv.wo_number}
                    </Link>
                  </td>
                  <td>
                    <div className="site">
                      <strong>{inv.client ?? '—'}</strong>
                      <small>
                        {inv.lines.length} line{inv.lines.length === 1 ? '' : 's'}
                        {inv.due_at ? ` · due ${inv.due_at}` : ''}
                      </small>
                    </div>
                  </td>
                  <td className="rcv-trunc">{inv.billing_entity ?? '—'}</td>
                  <td className="rcv-co mono">{inv.number}</td>
                  <td className="num rcv-amount">{money(inv.total)}</td>
                  <td>
                    <span
                      className={`rcv-stage is-${inv.status === 'sent' ? 'invoiced' : inv.status}`}
                      title={INVOICE_STATUS_HINTS[inv.status]}
                    >
                      <span className="rcv-status-dot" aria-hidden="true" />
                      {INVOICE_STATUS_LABELS[inv.status]}
                      {inv.overdue_days ? (
                        <span className="rcv-status-extra"> · {inv.overdue_days}d overdue</span>
                      ) : null}
                    </span>
                  </td>
                  <td className="rcv-action-td">
                    {inv.status === 'draft' ? (
                      <button
                        type="button"
                        className="rcv-btn is-primary"
                        disabled={!canSend || busy}
                        title={canSend ? 'Send it to the client' : 'You cannot send invoices'}
                        onClick={() => send.mutate(inv.id)}
                      >
                        <Icon name="send" size={12} />
                        Send
                      </button>
                    ) : inv.status === 'sent' ? (
                      <button
                        type="button"
                        className="rcv-btn"
                        disabled={busy}
                        onClick={() => pay.mutate(inv.id)}
                      >
                        <Icon name="check" size={12} />
                        Mark paid
                      </button>
                    ) : inv.status === 'paid' ? (
                      <span className="rcv-paid-mark">
                        <Icon name="check-circle" size={12} />
                        Settled
                      </span>
                    ) : (
                      <span className="rcv-none">Void</span>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
