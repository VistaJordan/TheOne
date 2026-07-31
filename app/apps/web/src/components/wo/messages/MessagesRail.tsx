import type { QuoConversation, ThreadItem, ThreadSegment } from '../../../api/client';
import { Icon } from '../../Icon';
import { DASH, feedTime, initials, shortDate } from '../../../lib/fields';
import { dialHref } from '../../../lib/quo';

interface MessagesRailProps {
  conversation: QuoConversation;
  items: ThreadItem[];
}

/** D · the Messages rail: technician card, conversation stats, scope notice. */
export function MessagesRail({ conversation, items }: MessagesRailProps) {
  const { vendor, counts } = conversation;
  const trade = vendor.trades?.[0] ?? null;
  const assigned = shortDate(conversation.created_at ?? conversation.first_contact);
  const tel = dialHref('tel', vendor.phone);

  const segments = items.filter((i): i is ThreadSegment => i.type === 'segment');
  const currentSegment = segments.length > 0 ? segments[segments.length - 1].label : null;

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Technician</h2>
          <span className="card-meta">31. Tech</span>
        </div>
        <div className="people">
          <div className="vendor">
            <div className="vendor-top">
              <span className="chip chip-outline"><Icon name="truck" size={12} />External vendor</span>
              <span className="overline" style={{ marginLeft: 'auto' }}>Tech</span>
            </div>
            <span className="p-name">{vendor.name}</span>
            {vendor.phone && (
              <div className="vendor-phone">
                <span className="mono">{vendor.phone}</span>
                {tel && (
                  <a
                    className="btn-call"
                    href={tel}
                    aria-label={`Call ${vendor.name} via Quo`}
                    title="Opens Quo (OpenPhone) — built-in dialer coming later"
                  >
                    <Icon name="phone" size={14} />
                  </a>
                )}
              </div>
            )}
            {(trade || assigned) && (
              <div className="vendor-trade">
                {trade && <span className="chip chip-sm"><Icon name="snow" size={12} />{trade}</span>}
                {assigned && <span className="p-role">Assigned {assigned}</span>}
              </div>
            )}
          </div>

          {conversation.claimed_by && (
            <div className="person">
              <span className="avatar av-accent" aria-hidden="true">{initials(conversation.claimed_by)}</span>
              <span>
                <span className="p-name">{conversation.claimed_by}</span>
                <span className="p-role">Claimed this Quo line</span>
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Conversation</h2>
          <span className="card-meta">
            {segments.length} job segment{segments.length === 1 ? '' : 's'}
          </span>
        </div>
        <dl className="kvlist">
          <div className="kvrow">
            <dt>First contact</dt>
            <dd className={conversation.first_contact ? undefined : 'is-none'}>
              {conversation.first_contact ? feedTime(conversation.first_contact) : DASH}
            </dd>
          </div>
          <div className="kvrow">
            <dt>Last activity</dt>
            <dd className={conversation.last_activity ? undefined : 'is-none'}>
              {conversation.last_activity ? feedTime(conversation.last_activity) : DASH}
            </dd>
          </div>
          <div className="kvrow">
            <dt>Quo line</dt>
            <dd className={conversation.quo_line_label ? undefined : 'is-none'}>
              {conversation.quo_line_label ?? DASH}
            </dd>
          </div>
          <div className="kvrow">
            <dt>Job segment</dt>
            <dd className={currentSegment ? undefined : 'is-none'}>{currentSegment ?? DASH}</dd>
          </div>
        </dl>
        <div className="stat3">
          <div className="stat">
            <span className="stat-v">{counts.calls}</span>
            <span className="stat-k"><Icon name="phone" size={12} />Calls</span>
          </div>
          <div className="stat">
            <span className="stat-v">{counts.texts}</span>
            <span className="stat-k"><Icon name="msg" size={12} />Texts</span>
          </div>
          <div className="stat">
            <span className="stat-v">{counts.photos}</span>
            <span className="stat-k"><Icon name="image" size={12} />Photos</span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="infocard">
          <span className="info-ic" aria-hidden="true"><Icon name="lock" size={14} /></span>
          <div>
            <div className="info-t">External tech channel</div>
            <p className="info-b">
              Messages are the external tech channel — <b>never client-visible</b>. Client updates
              live in <b>Overview → Updates</b>.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
