// After hours (Elise, 2026-11-16): the switch on Notifications and Approvals.
//
// By default both pages show only what is about the work orders the person is
// ON (an assigned seat: Assignee, Support Trainee, TL, ATL, AM, Completion
// Assignee). After hours shows every work order they may open — for whoever
// covers at night. Each press is logged on the API (`after_hours_opened` /
// `after_hours_closed`), and the API only honours the wide view while the
// person's latest press is "on" and less than AFTER_HOURS_HOURS old, so the
// state lives on the server and lapses by itself.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AFTER_HOURS_HOURS, adminPermKey, type AfterHoursPage } from '@theone/shared';
import { ApiRequestError, getAfterHours, getAfterHoursLog, setAfterHours } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from './Icon';

/** Is After hours on for this page? (false while loading) */
export function useAfterHours(page: AfterHoursPage): boolean {
  const q = useQuery({ queryKey: ['after-hours'], queryFn: getAfterHours, retry: 0, staleTime: 30_000 });
  return q.data?.[page] === true;
}

const PAGE_WORD: Record<AfterHoursPage, string> = { notifications: 'notifications', approvals: 'approvals' };

export function AfterHoursToggle({ page }: { page: AfterHoursPage }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const on = useAfterHours(page);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const mayReadLog = can(adminPermKey('audit'), 'view');

  const flip = useMutation({
    mutationFn: (next: boolean) => setAfterHours(page, next),
    onSuccess: (state) => {
      setError(null);
      qc.setQueryData(['after-hours'], state);
      void qc.invalidateQueries({ queryKey: ['after-hours-log'] });
      // Every list on the page re-reads with the new view.
      void qc.invalidateQueries({ queryKey: page === 'notifications' ? ['notices'] : ['approvals'] });
      if (page === 'approvals') {
        for (const k of ['quotes', 'payments', 'purchasing', 'nte-requests']) void qc.invalidateQueries({ queryKey: [k] });
      }
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : 'After hours could not be switched.'),
  });

  return (
    <div className={`afterhours${on ? ' is-on' : ''}`}>
      <button
        type="button"
        className={`btn btn-sm afterhours-btn${on ? ' is-on' : ''}`}
        aria-pressed={on}
        disabled={flip.isPending}
        onClick={() => flip.mutate(!on)}
        title={
          on
            ? `Showing every work order's ${PAGE_WORD[page]}. Click to go back to your jobs only.`
            : `Show every work order's ${PAGE_WORD[page]}, not only the jobs you are on. Each use is logged.`
        }
      >
        <Icon name="moon" size={14} />
        {on ? 'After hours: on' : 'After hours'}
      </button>
      <span className="afterhours-note">
        {on
          ? `Every work order · logged as you · ends after ${AFTER_HOURS_HOURS} h`
          : 'Your jobs only'}
      </span>
      {mayReadLog && (
        <button type="button" className="linkbtn afterhours-loglink" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
          {showLog ? 'Hide log' : 'Who used it'}
        </button>
      )}
      {error && (
        <span className="afterhours-err" role="alert">
          {error}
        </span>
      )}
      {showLog && mayReadLog && <AfterHoursLog />}
    </div>
  );
}

function AfterHoursLog() {
  const q = useQuery({ queryKey: ['after-hours-log'], queryFn: getAfterHoursLog, retry: 0 });
  if (q.isLoading) return <p className="hint afterhours-log">Loading…</p>;
  if (q.isError) return <p className="hint afterhours-log">The log could not be read.</p>;
  const items = q.data?.items ?? [];
  if (items.length === 0) return <p className="hint afterhours-log">Nobody has used After hours yet.</p>;
  return (
    <div className="afterhours-log">
      <table className="afterhours-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Page</th>
            <th>Switched</th>
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
              <td>{r.page === 'notifications' ? 'Notifications' : r.page === 'approvals' ? 'Approvals' : r.page}</td>
              <td>{r.action === 'after_hours_opened' ? 'On' : 'Off'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
