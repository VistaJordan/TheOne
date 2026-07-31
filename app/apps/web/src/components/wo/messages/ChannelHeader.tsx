import type { QuoConversation } from '../../../api/client';
import { Icon } from '../../Icon';
import { initials, shortDate } from '../../../lib/fields';
import { dialHref } from '../../../lib/quo';

/** The title on both Quo actions. They are plain links (`tel:`/`sms:`) that
    hand off to the OS/Quo handler — the in-app dialer is a later sprint. */
const QUO_TITLE = 'Opens Quo (OpenPhone) — built-in dialer coming later';

interface ChannelHeaderProps {
  conversation: QuoConversation;
}

/** C1 · the vendor identity card + the two Quo hand-off actions. */
export function ChannelHeader({ conversation }: ChannelHeaderProps) {
  const { vendor } = conversation;
  const trade = vendor.trades?.[0] ?? null;
  // "assigned <date>" — the channel's own creation date when the API carries
  // it, otherwise the first contact on the line. Never a fabricated date.
  const assigned = shortDate(conversation.created_at ?? conversation.first_contact);
  const tel = dialHref('tel', vendor.phone);
  const sms = dialHref('sms', vendor.phone);

  return (
    <section className="card chan">
      <div className="chan-row">
        <span className="chan-avatar" aria-hidden="true">{initials(vendor.name)}</span>

        <div className="chan-id">
          <div className="chan-tags">
            <span className="chip chip-outline"><Icon name="truck" size={12} />External vendor</span>
            {trade && <span className="chip chip-sm"><Icon name="snow" size={12} />{trade}</span>}
          </div>

          <div className="chan-name">{vendor.name}</div>

          <div className="chan-sub">
            {vendor.phone && <span className="mono">{vendor.phone}</span>}
            {vendor.phone && (trade || assigned) && <span className="sep-dot">·</span>}
            {(trade || assigned) && (
              <span>
                {trade ? `${trade} tech` : 'Technician'}
                {assigned ? ` · assigned ${assigned}` : ''}
              </span>
            )}
          </div>

          <div className="chan-via">
            <Icon name="radio" size={12} />
            via Quo
            {conversation.quo_line_label && (
              <>
                <span className="sep-dot">·</span>
                <span>line: <b>{conversation.quo_line_label}</b></span>
              </>
            )}
            {conversation.claimed_by && (
              <>
                <span className="sep-dot">·</span>
                <span>claimed by {conversation.claimed_by}</span>
              </>
            )}
          </div>
        </div>

        <div className="chan-actions">
          <div className="chan-btns">
            <a
              className="btn btn-primary"
              href={tel ?? undefined}
              title={QUO_TITLE}
              aria-disabled={tel ? undefined : true}
            >
              <Icon name="phone" size={14} />
              Call via Quo
            </a>
            <a
              className="btn"
              href={sms ?? undefined}
              title={QUO_TITLE}
              aria-disabled={sms ? undefined : true}
            >
              <Icon name="msg" size={14} />
              Text via Quo
            </a>
          </div>
          <span className="chan-help">
            <Icon name="ext" size={12} />
            {QUO_TITLE}
          </span>
        </div>
      </div>
    </section>
  );
}
