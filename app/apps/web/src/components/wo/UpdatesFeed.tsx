import type { FeedItem, StatusWithPhase } from '../../api/client';
import { feedTime, initials } from '../../lib/fields';
import { Icon } from '../Icon';
import { StatusPill } from '../StatusPill';

/** Statuses that vanished from the set still need a swatch — neutral grey. */
const UNKNOWN_STATUS_COLOR = '#656f7d';

interface UpdatesFeedProps {
  items: FeedItem[];
  statuses: StatusWithPhase[];
  loading?: boolean;
  error?: boolean;
}

/** GET /api/work-orders/:id/feed rendered newest-first. Client-visible
    comments get the accent card + CLIENT chip (the client-visibility boundary
    is the one thing an operator must never misread). */
export function UpdatesFeed({ items, statuses, loading, error }: UpdatesFeedProps) {
  const colorOf = (name: string | undefined | null) =>
    statuses.find((s) => s.name === name)?.color ?? UNKNOWN_STATUS_COLOR;

  if (loading) {
    return <div className="tab-empty"><span>Loading updates…</span></div>;
  }

  if (error) {
    return (
      <div className="tab-empty">
        <Icon name="alert" size={22} />
        <b>Updates unavailable</b>
        <span>The feed endpoint did not respond. Is the API running on :5174?</span>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="tab-empty">
        <Icon name="inbox" size={22} />
        <b>No updates yet</b>
        <span>Post the first update below — it becomes this WO's paper trail.</span>
      </div>
    );
  }

  return (
    <ol className="feed">
      {items.map((item) => {
        const key = `${item.type}-${item.id}`;

        if (item.type === 'comment') {
          const client = item.client_visible;
          return (
            <li className="fi" key={key}>
              <span className={`fi-node ${client ? 'is-client' : 'is-avatar'}`} aria-hidden="true">
                {client ? <Icon name="globe" size={14} /> : initials(item.author?.name)}
              </span>
              <div className="fi-body">
                <div className={`fi-card${client ? ' fi-client-card' : ''}`}>
                  <div className="fi-meta">
                    <span className="fi-who">{item.author?.name ?? 'Unknown'}</span>
                    <span className={`tag${client ? ' tag-client' : ''}`}>
                      <Icon name={client ? 'globe' : 'lock'} size={12} />
                      {client ? 'Client' : 'Internal'}
                    </span>
                    <time className="fi-time">{feedTime(item.created_at)}</time>
                  </div>
                  <p className="fi-text">{item.body}</p>
                  {client && (
                    <span className="fi-sync">
                      <Icon name="ext" size={12} />
                      Visible to the client · syncs to their CMMS
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        }

        if (item.type === 'status_changed') {
          return (
            <li className="fi fi-sys" key={key}>
              <span className="fi-node" aria-hidden="true"><Icon name="swap" size={12} /></span>
              <div className="fi-body">
                <div className="fi-line">
                  <strong>Status changed</strong>
                  {item.before?.status_name && (
                    <StatusPill
                      className="pill-sm"
                      status={{ name: item.before.status_name, color: colorOf(item.before.status_name) }}
                    />
                  )}
                  <Icon name="arrow-r" size={12} />
                  {item.after?.status_name && (
                    <StatusPill
                      className="pill-sm"
                      status={{ name: item.after.status_name, color: colorOf(item.after.status_name) }}
                    />
                  )}
                  {item.actor?.name && <span>by {item.actor.name}</span>}
                  <time className="fi-time">{feedTime(item.created_at)}</time>
                </div>
              </div>
            </li>
          );
        }

        return (
          <li className="fi fi-sys" key={key}>
            <span className="fi-node" aria-hidden="true"><Icon name="inbox" size={12} /></span>
            <div className="fi-body">
              <div className="fi-line">
                <strong>Work order received</strong>
                {item.via && <span className="chip chip-sm">{item.via}</span>}
                {item.actor?.name && <span>routed to {item.actor.name}</span>}
                <time className="fi-time">{feedTime(item.created_at)}</time>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
