import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PulseNotification } from '../../api/client';
import { markAllNotificationsRead, markNotificationRead } from '../../api/client';
import { NOTIFICATIONS_KEY, useNotifications } from '../../hooks/useObligations';
import { useNow } from '../../hooks/useNow';
import { TIER_LABEL, tierClass, tierOf } from '../../lib/obligations';
import { Icon } from '../Icon';

/** How many entries the dropdown shows before deferring to the Pulse page. */
const MAX_ROWS = 12;

/**
 * The topbar bell, now live: the unread count is the number of tier transitions
 * the engine pinged and nobody has looked at. Each ping happens ONCE per tier
 * per obligation (the escalation bot's no-respam rule), so this badge counts
 * events, never re-nags.
 */
export function PulseBell() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const now = useNow(30_000);

  const query = useNotifications();
  const items = (query.data?.items ?? []).slice(0, MAX_ROWS);
  const unread = query.data?.unread ?? 0;

  const readOne = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSettled: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });

  const readAll = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSettled: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openItem = (n: PulseNotification) => {
    if (!n.read_at) readOne.mutate(n.id);
    setOpen(false);
    if (n.wo_number) navigate(`/work-orders/${encodeURIComponent(n.wo_number)}`);
    else navigate('/pulse');
  };

  return (
    <div className="pulse-bell-wrap" ref={rootRef}>
      <button
        type="button"
        className="topbar-bell"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span className="pulse-badge" aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="pulse-pop" role="menu" aria-label="Notifications">
          <div className="pulse-pop-head">
            <span className="overline">The Pulse</span>
            <button
              type="button"
              className="pulse-linkbtn"
              disabled={unread === 0 || readAll.isPending}
              onClick={() => readAll.mutate()}
            >
              Mark all read
            </button>
          </div>

          {query.isLoading && <div className="pulse-pop-note">Loading…</div>}
          {query.isError && !query.isLoading && (
            <div className="pulse-pop-note">Notifications are unavailable right now.</div>
          )}
          {!query.isLoading && !query.isError && items.length === 0 && (
            <div className="pulse-pop-note">All clear — nothing has escalated.</div>
          )}

          {items.map((n) => {
            const tier = tierOf(n);
            return (
              <button
                type="button"
                role="menuitem"
                key={n.id}
                className={`pulse-row ${tierClass(tier)}${n.read_at ? '' : ' is-unread'}`}
                onClick={() => openItem(n)}
              >
                <span className="pulse-row-stripe" aria-hidden="true" />
                <span className="pulse-row-body">
                  <span className="pulse-row-title">{n.title}</span>
                  <span className="pulse-row-meta">
                    {n.wo_number && <span className="pulse-row-wo">{n.wo_number}</span>}
                    <span className={`pulse-row-tier ${tierClass(tier)}`}>{TIER_LABEL[tier]}</span>
                    <span className="pulse-row-ago">{timeAgo(n.created_at, now)}</span>
                  </span>
                </span>
                {!n.read_at && <span className="pulse-row-dot" aria-hidden="true" />}
              </button>
            );
          })}

          <div className="pulse-pop-foot">
            <button
              type="button"
              className="pulse-linkbtn"
              onClick={() => {
                setOpen(false);
                navigate('/pulse');
              }}
            >
              Open the Pulse
              <Icon name="chev-r" size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "4m" / "3h" / "2d" — compact enough for a dropdown row. */
function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const mins = Math.max(0, Math.floor((now - at) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
