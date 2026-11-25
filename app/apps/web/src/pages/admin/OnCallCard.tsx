// 0155 · Admin › Settings › On call (Elise, 2026-11-17). The Google Sheet that
// says who is on call on which day (the Vista calendar since 2026-11-23: Night
// Manager = AM, Night Dispatcher 1–4 = OM / Senior OM, Night Admin = OP
// Admin, dates across the top; or one row per date), the hours of a
// shift, what OBI read from it, and who switched After hours when. The person
// on call gets the After hours button in the header during their shift
// (components/AfterHoursToggle.tsx; services/afterHours.ts on the API).

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminPermKey, hourLabel } from '@theone/shared';
import { Icon } from '../../components/Icon';
import { AfterHoursLog } from '../../components/AfterHoursToggle';
import { useAuth } from '../../auth/AuthProvider';
import { ApiRequestError, getOnCall, saveOnCall, syncOnCallNow } from '../../api/client';

const ROLE_LABEL: Record<string, string> = { am: 'AM', tl: 'TL', atl: 'ATL', oa: 'OP Admin' };

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const HOURS = Array.from({ length: 25 }, (_, h) => h);

export function OnCallCard() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canEdit = can(adminPermKey('settings'), 'edit');
  const mayReadLog = can(adminPermKey('audit'), 'view');
  const q = useQuery({ queryKey: ['admin-on-call'], queryFn: getOnCall, retry: 0 });
  const o = q.data;
  const s = o?.settings;

  const [sheet, setSheet] = useState('');
  const [tab, setTab] = useState('');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(15);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    if (!s) return;
    setSheet(s.sheet_id ? `https://docs.google.com/spreadsheets/d/${s.sheet_id}/edit${s.gid ? `#gid=${s.gid}` : ''}` : '');
    setTab(s.tab ?? '');
    setStart(s.start_hour);
    setEnd(s.end_hour);
  }, [s]);

  const done = (next: Awaited<ReturnType<typeof getOnCall>>) => {
    setError(null);
    qc.setQueryData(['admin-on-call'], next);
    void qc.invalidateQueries({ queryKey: ['after-hours'] });
  };
  const fail = (err: unknown) => setError(err instanceof ApiRequestError ? err.message : 'The change did not save');
  const save = useMutation({
    mutationFn: () => saveOnCall({ sheet: sheet.trim() || null, tab: tab.trim() || null, start_hour: start, end_hour: end }),
    onSuccess: done,
    onError: fail,
  });
  const sync = useMutation({ mutationFn: syncOnCallNow, onSuccess: done, onError: fail });
  const busy = save.isPending || sync.isPending;
  const last = o?.last_sync;

  return (
    <section className="card adm-cico sp-card">
      <div className="card-head">
        <Icon name="moon" size={14} />
        <h3 className="card-title">On call</h3>
        <span className="card-meta">{!s?.sheet_id ? 'no sheet yet' : last?.ok ? `read ${when(last.at)}` : last ? 'last read failed' : 'not read yet'}</span>
      </div>
      <p className="adm-cico-note">
        The Google Sheet that says who is on call each night. On the Vista calendar the dates run across the top and OBI
        reads three duty rows: Night Manager (an AM), Night Dispatcher 1 to 4 (an OM or Senior OM) and Night Admin (an OP
        Admin); a name is looked for among that role only. During their shift, the person on call
        gets an <b>After hours</b> button in the header. It starts on all work orders, approvals and notifications, and
        one click goes back to their own jobs. Their role still decides what they can approve. Each click is logged.
        OBI reads the sheet every 15 minutes. A sheet with one row per day works too: a date (or a start and end date)
        and the names of the AM, TL, ATL, OP Admin, OM or Senior OM on call. Names as they appear in OBI; a first name
        is enough when only one person of that role has it.
      </p>

      {q.isLoading && <div className="empty-flat">Loading…</div>}
      {q.isError && <div className="empty-flat">Could not load the on-call settings.</div>}
      {error && (
        <div className="callout adm-cico-err" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      )}

      {o && s && (
        <>
          <dl className="set-list sp-conn">
            <div className="set-row">
              <dt>Google account</dt>
              <dd className={o.service_account ? 'is-ok' : 'is-warn'}>
                {o.service_account ? (
                  <>
                    Share the sheet with <code>{o.service_account}</code> as a Viewer
                  </>
                ) : (
                  'Not set — the Google service account (GMAIL_SERVICE_ACCOUNT_JSON) is not on the server'
                )}
              </dd>
            </div>
            {last && (
              <div className="set-row">
                <dt>Last read</dt>
                <dd className={last.ok ? 'is-ok' : 'is-warn'}>
                  {last.ok ? `${when(last.at)} · ${last.shifts} shift${last.shifts === 1 ? '' : 's'} from yesterday on` : `${when(last.at)} · ${last.error}`}
                </dd>
              </div>
            )}
          </dl>

          <form
            className="sp-form"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <label className="field">
              <span className="lbl">Sheet link</span>
              <input className="fld mono" value={sheet} disabled={busy || !canEdit} placeholder="Link to the Google Sheet" onChange={(e) => setSheet(e.target.value)} />
              <span className="hint">Paste the link from the browser. The tab open in the link is the one read.</span>
            </label>
            <label className="field">
              <span className="lbl">Tab name</span>
              <input className="fld" value={tab} disabled={busy || !canEdit} placeholder="Leave blank to use the tab in the link" onChange={(e) => setTab(e.target.value)} />
              <span className="hint">Only needed when the roster is not the tab in the link.</span>
            </label>
            <label className="field">
              <span className="lbl">Shift starts</span>
              <select className="fld" value={start} disabled={busy || !canEdit} onChange={(e) => setStart(Number(e.target.value))}>
                {HOURS.filter((h) => h < 24).map((h) => (
                  <option key={h} value={h}>{hourLabel(h)}</option>
                ))}
              </select>
              <span className="hint">Chicago time, on the date in the sheet.</span>
            </label>
            <label className="field">
              <span className="lbl">Shift ends</span>
              <select className="fld" value={end} disabled={busy || !canEdit} onChange={(e) => setEnd(Number(e.target.value))}>
                {HOURS.filter((h) => h > 0).map((h) => (
                  <option key={h} value={h}>{h === 24 ? '12 AM (midnight)' : hourLabel(h)}</option>
                ))}
              </select>
              <span className="hint">An end at or before the start runs into the next morning.</span>
            </label>
            <div className="sp-form-actions">
              <button type="submit" className="btn btn-primary" disabled={busy || !canEdit}>
                <Icon name="check" size={14} />
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="btn" disabled={busy || !canEdit || !s.sheet_id} onClick={() => sync.mutate()}>
                <Icon name="refresh" size={14} />
                {sync.isPending ? 'Reading…' : 'Sync now'}
              </button>
              {mayReadLog && (
                <button type="button" className="btn" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
                  {showLog ? 'Hide who switched' : 'Who switched After hours'}
                </button>
              )}
            </div>
          </form>

          {last?.ok && last.unmatched.length > 0 && (
            <div className="callout adm-cico-err" role="status">
              <Icon name="alert" size={14} />
              <span>
                Names OBI could not match to one active person of that role:{' '}
                {last.unmatched.slice(0, 12).map((u) => `“${u.text}” (row ${u.row})`).join(', ')}
                {last.unmatched.length > 12 ? `, and ${last.unmatched.length - 12} more` : ''}.
              </span>
            </div>
          )}

          <h4 className="oncall-sub">Next two weeks · {hourLabel(s.start_hour)} to {s.end_hour === 24 ? '12 AM' : hourLabel(s.end_hour)}</h4>
          {o.upcoming.length === 0 ? (
            <p className="hint">Nobody on call in the next two weeks.</p>
          ) : (
            <dl className="oncall-days">
              {o.upcoming.map((d) => (
                <div key={d.day} style={{ display: 'contents' }}>
                  <dt>{dayLabel(d.day)}</dt>
                  <dd>{d.people.map((p) => `${p.name}${p.role && ROLE_LABEL[p.role] ? ` (${ROLE_LABEL[p.role]})` : ''}`).join(', ')}</dd>
                </div>
              ))}
            </dl>
          )}

          {showLog && mayReadLog && <AfterHoursLog />}
        </>
      )}
    </section>
  );
}
