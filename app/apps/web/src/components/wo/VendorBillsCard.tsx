/* The vendor bills on one work order, on the Payables tab (0047).
 *
 * The Payables tab stops at the payment request — what we asked to pay a
 * technician. This card is the document that request should be settling:
 * the vendor's own invoice, recorded here, approved here (with the amount's
 * tier), and marked paid here or from the Payments page. Same records, same
 * verbs, same locks.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { VENDOR_BILL_STATUS_HINTS, VENDOR_BILL_STATUS_LABELS } from '@theone/shared';
import { getWorkOrderVendorBills, type WorkOrderDetailV2 } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../Icon';
import { usd } from '../../lib/quoteTotals';
import { RecordBillDialog, VendorBillActions, useVendorBillActions } from '../payments/VendorBillsLane';

export function VendorBillsCard({ wo }: { wo: WorkOrderDetailV2 }) {
  const { can } = useAuth();
  const canView = can('payments', 'view');
  const canRecord = can('payments', 'create');
  const q = useQuery({
    queryKey: ['wo-vendor-bills', wo.id],
    queryFn: () => getWorkOrderVendorBills(wo.id),
    enabled: canView,
    retry: 0,
  });
  const [recording, setRecording] = useState(false);
  const { act, error } = useVendorBillActions();

  if (!canView) return null;
  const items = q.data?.items ?? [];
  const unpaid = items.filter((b) => b.status !== 'paid' && b.status !== 'void').reduce((s, b) => s + b.total, 0);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Vendor bills</h2>
        <span className="card-meta">
          {items.length === 0 ? 'None on file' : `${items.length} on file · ${usd(unpaid)} unpaid`}
        </span>
      </div>

      {error && <p className="composer-err" role="alert">{error}</p>}

      {q.isLoading ? (
        <p className="hint">Looking…</p>
      ) : items.length === 0 ? (
        <p className="hint">
          No vendor bill has been recorded for this work order. When the technician's invoice
          arrives, record it here so the payment request settles a document, not a number.
        </p>
      ) : (
        <table className="ct inv-lines">
          <tbody>
            {items.map((b) => (
              <tr key={b.id}>
                <td>
                  <b>{b.vendor_name}</b>
                  <small className="inv-line-meta">
                    {b.bill_number ? `${b.bill_number} · ` : ''}
                    received {b.received_on}
                    {b.due_on ? ` · due ${b.due_on}` : ''}
                    {b.overdue_days ? ` · ${b.overdue_days}d overdue` : ''}
                    {b.tier ? ` · ${b.tier.label}` : ''}
                  </small>
                </td>
                <td>
                  <span className="chip chip-sm" title={VENDOR_BILL_STATUS_HINTS[b.status]}>
                    {VENDOR_BILL_STATUS_LABELS[b.status]}
                  </span>
                </td>
                <td className="num">{usd(b.total)}</td>
                <td className="rcv-action-td">
                  <VendorBillActions bill={b} busy={act.isPending} onAct={(kind, text) => act.mutate({ kind, id: b.id, text })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="inv-foot">
        <span className="card-meta">Approving needs the amount's tier (rule 6.2.3); paying is AP's.</span>
        <span className="inv-actions">
          {canRecord && (
            <button type="button" className="btn-sm is-primary" onClick={() => setRecording(true)}>
              <Icon name="plus" size={14} /> Record bill
            </button>
          )}
        </span>
      </div>

      {recording && (
        <RecordBillDialog
          taskId={wo.id}
          woNumber={wo.wo_number}
          onClose={() => setRecording(false)}
          onSaved={() => setRecording(false)}
        />
      )}
    </section>
  );
}
