/* 0078 · ClickUp's own panel, under its row in Admin › Integrations.
 *
 * Three things to set and watch: the List new work orders land in (pasted
 * from ClickUp), which of our fields goes to which ClickUp field (matched by
 * name to start with — our field keys ARE the old ClickUp names), and the
 * queue (how many are linked, waiting, failing, with a retry per work order).
 * One-way: The One is the source of truth.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLICKUP_NATIVE_TARGETS, clickUpFits } from '@theone/shared';
import type { ClickUpMapRow, ClickUpOverview } from '@theone/shared';
import { getClickUp, refreshClickUp, retryClickUpTask, saveClickUpMap, setClickUpList, syncClickUpNow } from '../../api/client';
import { Icon } from '../../components/Icon';
import { errText } from '../../components/ui/Sheet';

const KEY = ['admin', 'integrations', 'clickup'];

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

/** 'none' | native target | 'cf:<id>' — one select value per row. */
const valueOf = (r: Pick<ClickUpMapRow, 'target' | 'cu_field_id'>) => (r.target === 'custom' ? `cf:${r.cu_field_id}` : r.target);

export function ClickUpPanel({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: getClickUp, retry: false });
  const [list, setList] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [showMap, setShowMap] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const done = (res: ClickUpOverview) => {
    qc.setQueryData(KEY, res);
    void qc.invalidateQueries({ queryKey: ['admin', 'integrations'], exact: true });
  };
  const m = useMutation({
    mutationFn: (fn: () => Promise<ClickUpOverview>) => fn(),
    onMutate: () => setError(null),
    onSuccess: done,
    onError: (e) => setError(errText(e, 'ClickUp did not answer.')),
  });

  const d = q.data;
  const sent = useMemo(() => (d?.map ?? []).filter((r) => r.target !== 'none').length, [d]);
  const changed = useMemo(
    () => (d?.map ?? []).filter((r) => draft[r.source] !== undefined && draft[r.source] !== valueOf(r)),
    [d, draft],
  );

  if (q.isError && !d) {
    return <p className="intg-note is-warn cu-panel">{errText(q.error, 'Could not load the ClickUp settings.')}</p>;
  }
  if (!d) return <p className="intg-note cu-panel">Loading ClickUp…</p>;

  const busy = m.isPending;
  const saveMap = () =>
    m.mutate(async () => {
      const rows = changed.map((r) => {
        const v = draft[r.source];
        return v.startsWith('cf:')
          ? { source: r.source, target: 'custom', cu_field_id: v.slice(3) }
          : { source: r.source, target: v, cu_field_id: null };
      });
      const res = await saveClickUpMap(rows);
      setDraft({});
      return res;
    });

  return (
    <div className="cu-panel">
      {error && (
        <div className="callout intg-err" role="alert">
          <Icon name="alert-circle" size={14} /> {error}
        </div>
      )}

      {!d.token_set && (
        <p className="intg-note is-warn">
          Waiting for the API token: add <code>CLICKUP_API_TOKEN</code> to the server (Vercel › Settings › Environment
          Variables), redeploy, then pick the List here.
        </p>
      )}

      <div className="cu-line">
        <span className="lbl">New work orders go to</span>
        {d.list ? (
          <span className="cu-list">
            <b>{d.list.name ?? d.list.id}</b>
            {d.list.url && (
              <a href={d.list.url} target="_blank" rel="noreferrer" className="cu-ext">
                Open in ClickUp <Icon name="ext" size={12} />
              </a>
            )}
          </span>
        ) : (
          <span className="intg-note">No List chosen yet.</span>
        )}
      </div>
      {canEdit && d.token_set && (
        <form
          className="cu-line"
          onSubmit={(e) => {
            e.preventDefault();
            if (list.trim()) m.mutate(() => setClickUpList(list.trim()).then((r) => (setList(''), r)));
          }}
        >
          <input
            className="fld cu-input"
            value={list}
            onChange={(e) => setList(e.target.value)}
            placeholder="Paste the List link from ClickUp (…/v/li/901…)"
            aria-label="ClickUp List link"
          />
          <button type="submit" className="btn btn-sm" disabled={busy || !list.trim()}>
            {d.list ? 'Change List' : 'Use this List'}
          </button>
          {d.list && (
            <button type="button" className="btn btn-sm is-ghost" disabled={busy} onClick={() => m.mutate(refreshClickUp)} title="Read the List's fields, statuses and members again">
              <Icon name="refresh" size={14} /> Re-read ClickUp
            </button>
          )}
        </form>
      )}

      {d.list && (
        <>
          <div className="cu-stats">
            <span><b>{d.counts.linked}</b> in ClickUp</span>
            <span><b>{d.counts.waiting}</b> waiting</span>
            <span className={d.counts.failing ? 'is-warn' : ''}><b>{d.counts.failing}</b> with a problem</span>
            <span className="cu-run">
              Last run {when(d.last_run_at)}
              {d.last_run_note ? ` · ${d.last_run_note}` : ''}
            </span>
            {canEdit && d.enabled && d.token_set && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => m.mutate(syncClickUpNow)}>
                <Icon name="send" size={14} /> Sync now
              </button>
            )}
          </div>
          <p className="intg-note">
            {d.sync_from
              ? `Sending every work order created since ${when(d.sync_from)}, and every change made to them.`
              : 'Nothing has been sent yet. Work orders created after you turn it on are sent; the ones already here are not.'}{' '}
            One-way: a change made in ClickUp is overwritten by the next change here.
          </p>

          {d.missing_statuses.length > 0 && (
            <p className="intg-note is-warn">
              Not statuses of the ClickUp List (a move to one of these will not reach ClickUp until it is added there):{' '}
              {d.missing_statuses.join(', ')}.
            </p>
          )}
          {d.unmatched_people.length > 0 && (
            <details className="cu-details">
              <summary className="intg-note is-warn">
                {d.unmatched_people.length} of our people have no ClickUp account with the same email, so they cannot be
                set as assignees there
              </summary>
              <p className="intg-note">{d.unmatched_people.join(', ')}</p>
            </details>
          )}

          {d.problems.length > 0 && (
            <div className="cu-scroll">
            <table className="ct cu-problems">
              <thead>
                <tr>
                  <th>Work order</th>
                  <th>What ClickUp did not take</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.problems.map((p) => (
                  <tr key={p.task_id}>
                    <td>
                      <Link to={`/work-orders/${encodeURIComponent(p.wo_number)}`}>{p.wo_number}</Link>
                    </td>
                    <td className="cu-err">{p.error}</td>
                    <td className="col-date">{when(p.at)}</td>
                    <td>
                      {canEdit && (
                        <button type="button" className="btn btn-sm is-ghost" disabled={busy} onClick={() => m.mutate(() => retryClickUpTask(p.task_id))}>
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}

          <button type="button" className="btn btn-sm is-ghost cu-toggle" onClick={() => setShowMap((v) => !v)} aria-expanded={showMap}>
            <Icon name={showMap ? 'chev-u' : 'chev-d'} size={14} /> Fields · {sent} of {d.map.length} sent to ClickUp
          </button>
          {showMap && (
            <>
              <div className="cu-scroll">
              <table className="ct cu-map">
                <thead>
                  <tr>
                    <th>Field in The One</th>
                    <th>Goes to in ClickUp</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.map.map((r) => {
                    const v = draft[r.source] ?? valueOf(r);
                    return (
                      <tr key={r.source} className={v === 'none' ? 'is-off' : ''}>
                        <td>{r.label}</td>
                        <td>
                          <select
                            className="fld"
                            value={v}
                            disabled={!canEdit || busy}
                            aria-label={`Where "${r.label}" goes in ClickUp`}
                            onChange={(e) => setDraft((cur) => ({ ...cur, [r.source]: e.target.value }))}
                          >
                            <option value="none">Not sent</option>
                            <optgroup label="The task itself">
                              {CLICKUP_NATIVE_TARGETS.map((t) => (
                                <option key={t.value} value={t.value}>
                                  {t.label}
                                </option>
                              ))}
                            </optgroup>
                            <optgroup label="ClickUp custom fields">
                              {d.cu_fields
                                .filter((f) => clickUpFits(r.type, f.type) || valueOf(r) === `cf:${f.id}`)
                                .map((f) => (
                                  <option key={f.id} value={`cf:${f.id}`}>
                                    {f.name}
                                  </option>
                                ))}
                            </optgroup>
                          </select>
                        </td>
                        <td className="cu-note">
                          {r.warning ? <span className="is-warn">{r.warning}</span> : r.automatic && v !== 'none' && draft[r.source] === undefined ? 'matched by name' : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
              {canEdit && (
                <div className="cu-line">
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy || changed.length === 0} onClick={saveMap}>
                    Save {changed.length > 0 ? `${changed.length} change${changed.length === 1 ? '' : 's'}` : 'fields'}
                  </button>
                  {changed.length > 0 && (
                    <button type="button" className="btn btn-sm is-ghost" onClick={() => setDraft({})}>
                      Discard
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
