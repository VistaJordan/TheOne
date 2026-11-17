// After hours (Elise, 2026-11-16; in the header since 2026-11-17).
//
// The AM / TL / ATL / OP Admin on call (Admin › Settings › On call, read from
// the team's Google Sheet) gets this button in the header while their shift
// runs — 12 AM to 3 PM Chicago on the shift's day by default. During the shift
// the wide view is ON by default: every work order they may open, every
// approval their role may see, every notification addressed to them. A press
// goes back to their own jobs; another press, everything again. The server
// decides what each request returns (services/afterHours.ts), so the button
// only shows the state and logs the press; the shift ending switches it all
// back on its own.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AfterHoursState } from '@theone/shared';
import { ApiRequestError, getAfterHours, getAfterHoursLog, setAfterHours } from '../api/client';
import { Icon } from './Icon';

const KEY = ['after-hours'] as const;

function useAfterHoursState() {
  return useQuery({
    queryKey: KEY,
    queryFn: getAfterHours,
    retry: 0,
    staleTime: 30_000,
    // The shift starts and ends on the clock: look again every minute.
    refetchInterval: 60_000,
  });
}

/** Is the wide view on for the signed-in person right now? (false while loading) */
export function useAfterHours(): boolean {
  return useAfterHoursState().data?.wide === true;
}

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

/** The header button: drawn only while the person's on-call shift runs. */
export function AfterHoursButton() {
  const qc = useQueryClient();
  const q = useAfterHoursState();
  const [error, setError] = useState<string | null>(null);

  const flip = useMutation({
    mutationFn: (next: boolean) => setAfterHours(next),
    onSuccess: (state: AfterHoursState) => {
      setError(null);
      qc.setQueryData(KEY, state);
      // Every list, queue, badge and work order re-reads with the new scope.
      void qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== KEY[0] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : 'After hours could not be switched.'),
  });

  const s = q.data;
  if (!s?.on_call) return null;
  const on = s.wide;
  const until = s.ends_at ? ` until ${timeLabel(s.ends_at)}` : '';
  return (
    <span className="afterhours-head">
      <button
        type="button"
        className={`btn btn-sm afterhours-btn${on ? ' is-on' : ''}`}
        aria-pressed={on}
        disabled={flip.isPending}
        onClick={() => flip.mutate(!on)}
        title={
          error ??
          (on
            ? `You are on call${until}: showing every work order, approval and notification. Click to see only your own jobs. Each switch is logged.`
            : `You are on call${until}: showing only your own jobs. Click to see every work order, approval and notification. Each switch is logged.`)
        }
      >
        <Icon name="moon" size={14} />
        {on ? 'After hours: all work orders' : 'After hours: my jobs'}
      </button>
      {error && (
        <span className="afterhours-err" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** Everyone's presses, newest first (Admin › Settings › On call). */
export function AfterHoursLog() {
  const q = useQuery({ queryKey: ['after-hours-log'], queryFn: getAfterHoursLog, retry: 0 });
  if (q.isLoading) return <p className="hint afterhours-log">Loading…</p>;
  if (q.isError) return <p className="hint afterhours-log">The log could not be read.</p>;
  const items = q.data?.items ?? [];
  if (items.length === 0) return <p className="hint afterhours-log">Nobody has switched After hours yet.</p>;
  return (
    <div className="afterhours-log">
      <table className="afterhours-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Shift</th>
            <th>Switched to</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r, i) => (
            <tr key={`${r.at}-${i}`}>
              <td>{new Date(r.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
              <td>
                {r.person.name}
                {r.by && <span className="hint"> (by {r.by.name}, viewing as)</span>}
              </td>
              <td>{r.shift ?? (r.page === 'notifications' ? 'Notifications page' : r.page === 'approvals' ? 'Approvals page' : '—')}</td>
              <td>{r.action === 'after_hours_opened' ? 'All work orders' : 'My jobs'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
