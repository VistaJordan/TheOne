/* The client invoice, on the work order's Finances tab (0045).
 *
 * The money tabs used to stop at the quote: what we proposed, what it cost,
 * what we paid the technician. What the client was actually billed lived in a
 * spreadsheet. This card is the missing half — and it reads the same record
 * the Receivables queue does, so the two can never disagree about whether an
 * invoice exists.
 *
 * A draft can be raised, sent and settled from here. Editing lines stays in
 * Receivables: this card is the work order's view of the bill, not a second
 * invoice editor.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INVOICE_STATUS_HINTS,
  INVOICE_STATUS_LABELS,
  type Invoice,
} from '@theone/shared';
import {
  ApiRequestError,
  createInvoice,
  getWorkOrderInvoice,
  markInvoicePaid,
  sendInvoice,
  type WorkOrderDetailV2,
} from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../Icon';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

export function InvoiceCard({ wo }: { wo: WorkOrderDetailV2 }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const canView = can('invoicing', 'view');
  const canRaise = can('invoicing', 'create');
  const canSend = can('invoicing', 'approve');

  const q = useQuery({
    queryKey: ['wo-invoice', wo.id],
    queryFn: () => getWorkOrderInvoice(wo.id),
    enabled: canView,
    retry: 0,
  });

  const done = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: ['wo-invoice', wo.id] });
    void qc.invalidateQueries({ queryKey: ['invoices'] });
    void qc.invalidateQueries({ queryKey: ['wo-activity', wo.id] });
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : 'That did not go through');

  const raise = useMutation({
    mutationFn: () => createInvoice({ task_id: wo.id }),
    onSuccess: done,
    onError: fail,
  });
  const send = useMutation({
    mutationFn: (id: string) => sendInvoice(id),
    onSuccess: done,
    onError: fail,
  });
  const pay = useMutation({
    mutationFn: (id: string) => markInvoicePaid(id),
    onSuccess: done,
    onError: fail,
  });

  if (!canView) return null;

  const invoice = q.data?.invoice ?? null;
  const busy = raise.isPending || send.isPending || pay.isPending;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Client invoice</h2>
        <span className="card-meta">
          {invoice ? INVOICE_STATUS_HINTS[invoice.status] : 'Not raised yet'}
        </span>
      </div>

      {error && <p className="composer-err" role="alert">{error}</p>}

      {q.isLoading ? (
        <p className="hint">Looking…</p>
      ) : invoice ? (
        <InvoiceBody
          invoice={invoice}
          busy={busy}
          canSend={canSend}
          onSend={() => send.mutate(invoice.id)}
          onPaid={() => pay.mutate(invoice.id)}
        />
      ) : (
        <div className="inv-empty">
          <p className="hint">
            Nothing has been billed for this work order yet. Raising an invoice copies the approved
            quote's lines onto a draft, which stays editable until it is sent.
          </p>
          {canRaise && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => raise.mutate()}
            >
              <Icon name="file" size={14} />
              {raise.isPending ? 'Raising…' : 'Raise invoice'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function InvoiceBody({
  invoice,
  busy,
  canSend,
  onSend,
  onPaid,
}: {
  invoice: Invoice;
  busy: boolean;
  canSend: boolean;
  onSend: () => void;
  onPaid: () => void;
}) {
  return (
    <>
      <div className="inv-head">
        <span className="inv-number mono">{invoice.number}</span>
        <span className={`rcv-stage is-${invoice.status === 'sent' ? 'invoiced' : invoice.status}`}>
          <span className="rcv-status-dot" aria-hidden="true" />
          {INVOICE_STATUS_LABELS[invoice.status]}
          {invoice.overdue_days ? (
            <span className="rcv-status-extra"> · {invoice.overdue_days}d overdue</span>
          ) : null}
        </span>
      </div>

      <table className="ct inv-lines">
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.id}>
              <td>
                {l.description}
                <small className="inv-line-meta">
                  {l.quantity} × {money(l.unit_price)}
                </small>
              </td>
              <td className="num">{money(l.amount)}</td>
            </tr>
          ))}
          {invoice.lines.length === 0 && (
            <tr className="ct-empty">
              <td colSpan={2}>No lines yet — add them in Receivables.</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          {invoice.discount > 0 && (
            <tr>
              <td>Discount</td>
              <td className="num">−{money(invoice.discount)}</td>
            </tr>
          )}
          {invoice.tax > 0 && (
            <tr>
              <td>Tax</td>
              <td className="num">{money(invoice.tax)}</td>
            </tr>
          )}
          <tr className="inv-total">
            <td>Total</td>
            <td className="num">{money(invoice.total)}</td>
          </tr>
        </tfoot>
      </table>

      <div className="inv-foot">
        <span className="card-meta">
          {invoice.due_at ? `Due ${invoice.due_at}` : 'No due date'}
          {invoice.sent_by ? ` · sent by ${invoice.sent_by.display_name}` : ''}
          {invoice.paid_reference ? ` · ref ${invoice.paid_reference}` : ''}
        </span>
        <span className="inv-actions">
          <Link className="btn-sm is-ghost" to="/receivables/invoicing">
            Open in Receivables
          </Link>
          {invoice.status === 'draft' && canSend && (
            <button type="button" className="btn-sm is-primary" disabled={busy} onClick={onSend}>
              <Icon name="send" size={14} />
              Send to client
            </button>
          )}
          {invoice.status === 'sent' && (
            <button type="button" className="btn-sm is-primary" disabled={busy} onClick={onPaid}>
              <Icon name="check" size={14} />
              Mark paid
            </button>
          )}
        </span>
      </div>
    </>
  );
}
