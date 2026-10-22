/* Incoming Work Orders › Unassigned (Elise, 2026-10-22): every live work
   order nobody carries — whether it arrived from Ecotrak, the CSV import,
   the form, or was unassigned from the header — in one list with an Assign
   button per row. The rows come from the ordinary /work-orders list with
   `unassignedWorkFilter()` (shared), so the rule-8.5 scope applies; the
   write is an Assignee field save (audited, mirrored, gated like any other).
   Shown to `approvals/intake` view, beside To accept. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkOrderListItemV2 } from '../api/client';
import { ApiRequestError, patchWorkOrderFields } from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { IncomingTabs } from '../components/IncomingTabs';
import { StatusPill } from '../components/StatusPill';
import { AssignDialog } from '../components/wo/AssignDialog';
import { AddWorkOrderButton } from '../components/wo/list/AddWorkOrderButton';
import { useCanEditField } from '../components/wo/fieldEdit';
import { DASH, FIELD, numericDate } from '../lib/fields';
import { useLinkNav } from '../lib/linkNav';
import { UNASSIGNED_QUERY_KEY, UNASSIGNED_STORE_KEY as STORE_KEY, fetchUnassigned } from '../lib/unassigned';

const ASSIGNEE_KEY = `fields.${FIELD.assignee}`;

export function UnassignedPage() {
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
    <AppShell active="Incoming Work Orders">
      <IncomingTabs tab="unassigned" />
      <div className="page-head intake-page-head">
        <p className="page-sub">
          {rows.isLoading
            ? 'Loading…'
            : `${total} unassigned work order${total === 1 ? '' : 's'} · live work nobody carries yet — assign each to a dispatcher`}
          {total > items.length && ` · showing the first ${items.length}`}
        </p>
        <div className="intake-head-actions">
          <AddWorkOrderButton />
        </div>
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
    </AppShell>
  );
}
