/* Incoming Work Orders › Unassigned (Elise, 2026-10-22): every live work
   order nobody carries — whether it arrived from Ecotrak, the CSV import,
   the form, or was unassigned from the header — in one list with an Assign
   button per row. The rows come from the ordinary /work-orders list with
   `unassignedWorkFilter()` (shared), so the rule-8.5 scope applies; the
   write is an Assignee field save (audited, mirrored, gated like any other).
   Since 2026-10-27 (Elise) it is a section of the main Incoming page, under
   the To accept queue, not a tab of its own; ApprovalsPage draws it in
   intake mode, which needs `approvals/intake` view. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkOrderListItemV2 } from '../api/client';
import { ApiRequestError, patchWorkOrderFields } from '../api/client';
import { Icon } from './Icon';
import { StatusPill } from './StatusPill';
import { AssignDialog } from './wo/AssignDialog';
import { useCanEditField } from './wo/fieldEdit';
import { DASH, FIELD, numericDate } from '../lib/fields';
import { useLinkNav } from '../lib/linkNav';
import { UNASSIGNED_QUERY_KEY, UNASSIGNED_STORE_KEY as STORE_KEY, fetchUnassigned } from '../lib/unassigned';

const ASSIGNEE_KEY = `fields.${FIELD.assignee}`;

export function UnassignedSection() {
  const { linkTo } = useLinkNav();
  const qc = useQueryClient();
  const canAssign = useCanEditField(ASSIGNEE_KEY);
  const [target, setTarget] = useState<WorkOrderListItemV2 | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useQuery({ queryKey: UNASSIGNED_QUERY_KEY, queryFn: fetchUnassigned, retry: 0, staleTime: 30 * 1000 });

  const assign = useMutation({
    mutationFn: (v: { id: string; name: string }) => patchWorkOrderFields(v.id, { [ASSIGNEE_KEY]: v.name }),
    onSuccess: () => {
      setTarget(null);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      void qc.invalidateQueries({ queryKey: ['approval-counts'] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : 'Could not assign this work order'),
  });

  const items = rows.data?.items ?? [];
  const total = rows.data?.total ?? items.length;

  return (
    <section className="incoming-unassigned" aria-labelledby="incoming-unassigned-title">
      <div className="incoming-section-head">
        <h2 id="incoming-unassigned-title" className="card-title">
          <Icon name="user" size={14} />
          Unassigned
          {!rows.isLoading && <span className={`payq-count${total > 0 ? ' is-hot' : ''}`}>{total}</span>}
        </h2>
        <p className="page-sub">
          {rows.isLoading ? 'Loading…' : 'Live work nobody carries yet — assign each to a dispatcher'}
          {total > items.length && ` · showing the first ${items.length}`}
        </p>
      </div>
      {rows.isError && (
        <p className="payq-err" role="alert">
          {rows.error instanceof ApiRequestError && rows.error.status === 403
            ? 'You do not have access to the work-order list.'
            : 'Could not load the unassigned work orders.'}
        </p>
      )}
      {!rows.isError && (
        <div className="card intake-list">
          <div className="intake-tbl">
            <table className="ct">
              <thead>
                <tr>
                  <th>WO#</th>
                  <th>Client · Store</th>
                  <th>Trade</th>
                  <th>Status</th>
                  <th>Received</th>
                  <th>Age</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.isLoading && (
                  <tr className="ct-empty"><td colSpan={7}>Loading the unassigned work orders…</td></tr>
                )}
                {!rows.isLoading && items.length === 0 && (
                  <tr className="ct-empty"><td colSpan={7}>Every live work order has a dispatcher.</td></tr>
                )}
                {items.map((r) => {
                  const store = r.custom?.[STORE_KEY] ?? null;
                  return (
                    <tr key={r.id} className={`is-link${r.emergency ? ' is-emergency' : ''}${r.escalated ? ' is-escalated' : ''}`} {...linkTo(`/work-orders/${encodeURIComponent(r.wo_number)}`)}>
                      <td className="mono">{r.wo_number}</td>
                      <td>
                        {r.client || DASH}
                        {store && <span className="intake-dim"> · {store}</span>}
                      </td>
                      <td>{r.trade || DASH}</td>
                      <td><StatusPill status={r.status} /></td>
                      <td>{numericDate(r.date_received) ?? DASH}</td>
                      <td>{r.age_days == null ? DASH : `${r.age_days}d`}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {canAssign ? (
                          <button
                            type="button"
                            className="btn-sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setError(null);
                              setTarget(r);
                            }}
                          >
                            <Icon name="user-plus" size={12} />
                            Assign
                          </button>
                        ) : (
                          <span className="intake-dim" title="Needs edit on the Assignee field">View only</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {target && (
        <AssignDialog
          woNumber={target.wo_number}
          client={target.client}
          current={null}
          busy={assign.isPending}
          error={error}
          onAssign={(name) => assign.mutate({ id: target.id, name })}
          onCancel={() => {
            setTarget(null);
            setError(null);
          }}
        />
      )}
    </section>
  );
}
