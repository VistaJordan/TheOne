import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { WoMessage } from '@theone/shared';
import { getWorkOrderNotifications } from '../../api/client';
import { feedTime, initials } from '../../lib/fields';
import { Icon } from '../Icon';

/** How many messages the Overview shows (Elise, 2026-11-16, #43). */
export const OVERVIEW_MESSAGE_COUNT = 3;

const PREVIEW_CHARS = 220;

function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

function authorName(m: WoMessage): string {
  if (m.source === 'client') return m.external_author ?? 'Client';
  return m.author?.name ?? 'Someone';
}

/** Elise, 2026-11-16 (#43) · the Overview says what was last said and the
    last notification sent about the work order, so nobody has to open the
    Messages or Notifications tab to know where the job stands. Each card is
    drawn only for someone who may open the tab behind it; the messages come
    from the page's own Messages query (the same rows the tab shows, client
    visible ones only for someone who may read them). */
export function OverviewLatestCards({
  woId,
  woNumber,
  messages,
  messagesLoading,
  showMessages,
  showNotifications,
}: {
  woId: string;
  woNumber: string;
  messages: WoMessage[] | undefined;
  messagesLoading: boolean;
  showMessages: boolean;
  showNotifications: boolean;
}) {
  const notices = useQuery({
    queryKey: ['wo-notifications', woId],
    queryFn: () => getWorkOrderNotifications(woId),
    enabled: showNotifications,
  });
  if (!showMessages && !showNotifications) return null;

  const base = `/work-orders/${encodeURIComponent(woNumber)}`;
  const latest = (messages ?? []).slice(-OVERVIEW_MESSAGE_COUNT).reverse();
  const notice = notices.data?.items[0] ?? null;

  return (
    <div className="wo-overview-facts ov-latest">
      {showMessages && (
        <section className="card ov-latest-card" aria-label="Latest messages">
          <div className="card-head">
            <h2 className="card-title">Latest messages</h2>
            <Link className="card-meta" to={`${base}?tab=messages`}>
              Open Messages
            </Link>
          </div>
          {messagesLoading && <div className="obl-note">Loading…</div>}
          {!messagesLoading && latest.length === 0 && <div className="obl-note">No messages yet.</div>}
          {latest.length > 0 && (
            <ol className="ov-latest-list">
              {latest.map((m) => (
                <li key={m.id} className="ov-latest-item">
                  <span className="audit-av" aria-hidden="true">{initials(authorName(m))}</span>
                  <div className="ov-latest-text">
                    <div className="ov-latest-head">
                      <b>{authorName(m)}</b>
                      <span className={`chip chip-sm${m.client_visible ? ' ov-chip-client' : ' chip-outline'}`}>
                        {m.client_visible ? 'Client visible' : 'Internal'}
                      </span>
                      <time className="ov-latest-time" dateTime={m.created_at}>{feedTime(m.created_at)}</time>
                    </div>
                    <Link className="ov-latest-body" to={`${base}?tab=messages&msg=${encodeURIComponent(m.id)}`}>
                      {preview(m.body)}
                    </Link>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {showNotifications && (
        <section className="card ov-latest-card" aria-label="Latest notification">
          <div className="card-head">
            <h2 className="card-title">Latest notification</h2>
            <Link className="card-meta" to={`${base}?tab=notifications`}>
              All notifications
            </Link>
          </div>
          {notices.isLoading && <div className="obl-note">Loading…</div>}
          {notices.isError && <div className="obl-note">Notifications could not be read right now.</div>}
          {notices.isSuccess && !notice && <div className="obl-note">No notifications yet.</div>}
          {notice && (
            <div className="ov-latest-item">
              <span className="audit-av" aria-hidden="true">
                <Icon name="bell" size={12} />
              </span>
              <div className="ov-latest-text">
                <div className="ov-latest-head">
                  <span>
                    To <b>{notice.recipient.name}</b>
                  </span>
                  <time className="ov-latest-time" dateTime={notice.created_at}>{feedTime(notice.created_at)}</time>
                </div>
                <div className="ov-latest-title">
                  {notice.link && notice.link.includes('?') ? <Link to={notice.link}>{notice.title}</Link> : notice.title}
                </div>
                {notice.body && <div className="ov-latest-body is-plain">{preview(notice.body)}</div>}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
