import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getWorkOrderNotifications } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { feedTime, initials } from '../../lib/fields';
import { Icon } from '../Icon';

/** 2026-11-02 · the work order's Notifications tab: every notice raised about
    it (the bell's "For you" rows: assigned, mentioned, a bill, a note from the
    vendor portal…) and every Pulse escalation ping, to whoever got it, newest
    first, with whether they have read it. A notice pointing at a tab this
    person may not open is left out by the API. */
export function NotificationsTab({ woId }: { woId: string }) {
  const { actingAs } = useAuth();
  const [mine, setMine] = useState(false);
  const q = useQuery({
    queryKey: ['wo-notifications', woId],
    queryFn: () => getWorkOrderNotifications(woId),
  });
  const all = q.data?.items ?? [];
  const items = mine ? all.filter((n) => n.recipient.id === actingAs?.id) : all;
  const unread = items.filter((n) => !n.read).length;

  return (
    <div className="card audit-card wo-notices" role="tabpanel" aria-label="Notifications">
      <div className="card-head">
        <h2 className="card-title">Notifications</h2>
        <div className="wo-notices-tools">
          <div className="seg" role="group" aria-label="Whose notifications">
            <button type="button" className={`seg-btn${mine ? '' : ' is-on'}`} aria-pressed={!mine} onClick={() => setMine(false)}>
              Everyone
            </button>
            <button type="button" className={`seg-btn${mine ? ' is-on' : ''}`} aria-pressed={mine} onClick={() => setMine(true)}>
              Only mine
            </button>
          </div>
          <span className="card-meta">
            {q.isLoading ? '—' : `${items.length} sent${unread ? ` · ${unread} unread` : ''}`}
          </span>
        </div>
      </div>

      {q.isLoading && <div className="obl-note">Loading…</div>}
      {q.isError && (
        <div className="tab-empty">
          <Icon name="alert" size={22} />
          <b>Notifications unavailable</b>
          <span>They could not be read right now.</span>
        </div>
      )}
      {!q.isLoading && !q.isError && items.length === 0 && (
        <div className="tab-empty">
          <Icon name="bell" size={22} />
          <b>{mine ? 'Nothing sent to you' : 'No notifications yet'}</b>
          <span>Every notification sent about this work order is listed here.</span>
        </div>
      )}

      {items.length > 0 && (
        <ol className="audit">
          {items.map((n) => {
            const target = n.link && n.link.includes('?') ? n.link : null;
            return (
              <li className={`audit-row${n.read ? '' : ' is-unread'}`} key={`${n.source}:${n.id}`}>
                <span className="audit-av" title={n.recipient.name} aria-hidden="true">
                  {initials(n.recipient.name)}
                </span>
                <div className="audit-text">
                  <div>
                    To <b>{n.recipient.name}</b>
                    {n.source === 'pulse' && <span className="audit-via">Pulse</span>}
                    <span className={`wo-notice-read${n.read ? '' : ' is-unread'}`}>
                      {n.read ? `Read ${n.read_at ? feedTime(n.read_at) : ''}` : 'Unread'}
                    </span>
                  </div>
                  <div className="wo-notice-title">
                    {target ? <Link to={target}>{n.title}</Link> : n.title}
                  </div>
                  {n.body && <div className="wo-notice-body">{n.body}</div>}
                </div>
                <time className="audit-time" dateTime={n.created_at}>{feedTime(n.created_at)}</time>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
