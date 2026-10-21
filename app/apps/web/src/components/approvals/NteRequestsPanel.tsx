/* M25 (UAT round 1, Wave D) · "NTE increase requests" in Approvals.
 *
 * "NTE increases" used to mean two different things. This lane is the manual
 * one: somebody on the work order asked for a higher NTE (0064,
 * `wo_nte_request`; the Increase NTE button that raised them was removed on
 * 2026-10-20, so this lane holds the requests already open). The other lane, "NTE
 * override (cost over NTE)", is the approval task rule 1.5.2 raises when the
 * cost passes the NTE. Deciding here is the work order's own route, so the
 * gate (`approvals/nte` approve) and the audit row are the same as there.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { decideNteIncrease, listNteRequests, ApiRequestError } from '../../api/client';
import { Icon } from '../Icon';

const money = (n: number | null) =>
  n === null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function NteRequestsPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['nte-requests'], queryFn: listNteRequests, retry: 0 });
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ wo: string; id: string; note: string } | null>(null);

  const decide = useMutation({
    mutationFn: (v: { wo: string; id: string; decision: 'approve' | 'reject'; note?: string }) =>
      decideNteIncrease(v.wo, v.id, v.decision, v.note ?? null),
    onSuccess: () => {
      setError(null);
      setRejecting(null);
      void qc.invalidateQueries({ queryKey: ['nte-requests'] });
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : 'The decision could not be saved.'),
  });

  const items = q.data?.items ?? [];
  if (q.isLoading) return <p className="hint">Loading…</p>;
  if (q.isError) return <p className="payq-err" role="alert">Could not load the NTE increase requests.</p>;

  return (
    <div className="apq-nte-requests">
      <p className="hint">
        Increases somebody asked for on a work order. Approving writes the new NTE. Cost going over
        the NTE is the other lane, NTE override (cost over NTE).
      </p>
      {error && (
        <p className="payq-err" role="alert">
          <Icon name="alert-circle" size={14} />
          {error}
        </p>
      )}
      {items.length === 0 ? (
        <div className="quotes-empty">
          <Icon name="inbox" size={22} />
          <b>No NTE increase requests are waiting</b>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ct">
            <thead>
              <tr>
                <th>WO #</th>
                <th>Client</th>
                <th className="num">NTE now</th>
                <th className="num">Asked for</th>
                <th>Why</th>
                <th>Asked by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/work-orders/${encodeURIComponent(r.wo_number)}`} className="wo-num">
                      {r.wo_number}
                    </Link>
                  </td>
                  <td>{r.client ?? '—'}</td>
                  <td className="num">{money(r.current_nte)}</td>
                  <td className="num">{money(r.requested_nte)}</td>
                  <td>{r.reason}</td>
                  <td>{r.requested_by?.name ?? '—'}</td>
                  <td className="num">
                    {r.can_decide ? (
                      rejecting?.id === r.id ? (
                        <span className="apq-nte-reject">
                          <input
                            className="fld sm"
                            aria-label="Why it is rejected"
                            placeholder="Why?"
                            value={rejecting.note}
                            onChange={(e) => setRejecting({ ...rejecting, note: e.target.value })}
                          />
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={decide.isPending || rejecting.note.trim() === ''}
                            onClick={() => decide.mutate({ wo: r.wo_number, id: r.id, decision: 'reject', note: rejecting.note })}
                          >
                            Reject
                          </button>
                          <button type="button" className="linkbtn" onClick={() => setRejecting(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={decide.isPending}
                            onClick={() => decide.mutate({ wo: r.wo_number, id: r.id, decision: 'approve' })}
                          >
                            Approve
                          </button>{' '}
                          <button
                            type="button"
                            className="btn btn-sm is-ghost"
                            disabled={decide.isPending}
                            onClick={() => setRejecting({ wo: r.wo_number, id: r.id, note: '' })}
                          >
                            Reject
                          </button>
                        </>
                      )
                    ) : (
                      <span className="chip chip-sm">Waiting</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
