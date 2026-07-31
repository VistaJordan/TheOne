import type { ThreadMessage } from '../../../api/client';
import { Icon } from '../../Icon';
import { feedTime, initials } from '../../../lib/fields';
import { receiptFor } from '../../../lib/quo';

/** The placeholder gradients already used by the WO photos card. MMS thumbs
    reuse them (no real media pipe yet) so the two surfaces read as one system. */
const GRADIENTS = ['g1', 'g2', 'g3'] as const;

interface MessageBubbleProps {
  message: ThreadMessage;
  techName: string;
  dispatcherName: string;
}

/** A text/MMS bubble: tech on the LEFT, dispatcher on the RIGHT (accent-tinted). */
export function MessageBubble({ message, techName, dispatcherName }: MessageBubbleProps) {
  const out = message.direction === 'out';
  const who = out ? dispatcherName : techName;
  const media = message.media ?? [];
  const receipt = receiptFor(message);

  return (
    <li className={`msg${out ? ' msg-out' : ''}${message.pending_sync ? ' is-pending' : ''}`}>
      <span className="msg-av" aria-hidden="true">{initials(who)}</span>
      <div className="bubble">
        <div className="msg-head">
          <span className="msg-who">{who}</span>
          {media.length > 0 && (
            <span className="chip chip-sm">
              <Icon name="image" size={12} />
              MMS · {media.length} photo{media.length === 1 ? '' : 's'}
            </span>
          )}
          <time className="msg-time" dateTime={message.occurred_at}>{feedTime(message.occurred_at)}</time>
        </div>

        {media.length > 0 && (
          <div className="mms">
            {media.map((m, i) => (
              <figure key={`${message.id}-${m.name}-${i}`}>
                <span className={`thumb ${GRADIENTS[i % GRADIENTS.length]}`} aria-hidden="true">
                  {m.label && <span className="mms-badge">{m.label}</span>}
                </span>
                <figcaption>{m.name}</figcaption>
              </figure>
            ))}
          </div>
        )}

        {message.body && <p className="msg-txt">{message.body}</p>}

        {receipt && (
          <div className={`msg-foot${receipt.pending ? ' is-pending' : ''}`}>
            <Icon name={receipt.icon} size={12} />
            {receipt.label}
          </div>
        )}
      </div>
    </li>
  );
}
