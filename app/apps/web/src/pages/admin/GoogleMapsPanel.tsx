/* 0140 · Under the Google Maps row in Admin › Integrations: how much we asked
 * Google — today, this month, last month — and (0141) the daily limit on
 * suggestion requests, typed here. Counts only; what it cost in dollars is on
 * Google's own billing page, linked here. */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ADDRESS_SUGGEST_DAILY_CAP_MAX, type GoogleUsageCounts } from '@theone/shared';
import { fetchGoogleUsage, setGoogleDailyCap } from '../../api/client';
import { errText } from '../../components/ui/Sheet';

const n = (v: number) => v.toLocaleString('en-US');

function Line({ label, c }: { label: string; c: GoogleUsageCounts }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{n(c.place_details)}</td>
      <td className="num">{n(c.autocomplete)}</td>
      <td className="num">{n(c.geocode)}</td>
    </tr>
  );
}

export function GoogleMapsPanel({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const key = ['admin-google-maps', enabled];
  const q = useQuery({ queryKey: key, queryFn: fetchGoogleUsage, retry: false });
  const d = q.data;
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (d) setDraft(String(d.daily_cap));
  }, [d?.daily_cap]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: (cap: number) => setGoogleDailyCap(cap),
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      void qc.invalidateQueries({ queryKey: ['admin', 'integrations'] });
    },
  });

  if (q.isError) return <p className="intg-note is-warn cu-panel">{errText(q.error, 'Could not load the Google Maps use.')}</p>;
  if (!d) return <p className="intg-note cu-panel">Loading Google Maps use…</p>;

  const typed = draft.trim() === '' ? NaN : Number(draft);
  const valid = Number.isInteger(typed) && typed >= 0 && typed <= ADDRESS_SUGGEST_DAILY_CAP_MAX;
  const changed = valid && typed !== d.daily_cap;
  const capReached = d.daily_cap > 0 && d.today.autocomplete >= d.daily_cap;

  return (
    <div className="cu-panel">
      <table className="cu-problems gmaps-use">
        <thead>
          <tr>
            <th>Use</th>
            <th className="num">Addresses picked</th>
            <th className="num">Suggestion requests</th>
            <th className="num">Placed for ClickUp</th>
          </tr>
        </thead>
        <tbody>
          <Line label="Today" c={d.today} />
          <Line label="This month" c={d.month} />
          <Line label="Last month" c={d.last_month} />
        </tbody>
      </table>

      <form
        className="gmaps-limit"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) save.mutate(typed);
        }}
      >
        <label className="lbl" htmlFor="gmaps-daily-limit">Daily limit</label>
        <input
          id="gmaps-daily-limit"
          className="fld"
          inputMode="numeric"
          value={draft}
          disabled={!d.can.edit || save.isPending}
          title={d.can.edit ? undefined : 'Only Admin › Integrations editors can change this'}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <span className="gmaps-limit-unit">suggestion requests a day · 0 = no limit</span>
        {d.can.edit && (
          <button type="submit" className="btn btn-sm" disabled={!changed || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save limit'}
          </button>
        )}
      </form>
      {save.isError && <p className="intg-note is-warn" role="alert">{errText(save.error, 'Could not save the limit.')}</p>}
      <p className={`intg-note${capReached ? ' is-warn' : ''}`}>
        {d.daily_cap === 0
          ? 'No daily limit: the Address box always asks Google.'
          : capReached
            ? `Today’s limit of ${n(d.daily_cap)} is reached: the Address box is plain typing until tomorrow, or until the limit is raised.`
            : `${n(d.today.autocomplete)} of ${n(d.daily_cap)} used today, the whole team together. Past the limit the Address box is plain typing until the next day.`}
      </p>
      <p className="intg-note">
        These are counts. What Google charged is in{' '}
        <a href="https://console.cloud.google.com/billing" target="_blank" rel="noreferrer">
          Google Cloud › Billing › Reports
        </a>
        , filtered to the Places API and the Geocoding API.
      </p>
    </div>
  );
}
