import { useState } from 'react';
import type { ThreadCall } from '../../../api/client';
import { Icon } from '../../Icon';
import { feedTime } from '../../../lib/fields';
import { callDuration } from '../../../lib/quo';

/** How many transcript lines show before the "Expand transcript" toggle. */
const PREVIEW_LINES = 2;

interface CallEntryProps {
  call: ThreadCall;
  /** Vendor name — the tech side of the conversation. */
  techName: string;
  /** Whoever claimed the Quo line — the dispatcher side. */
  dispatcherName: string;
}

/** A logged Quo call: direction icon, duration, AI summary, transcript preview
    with an expand toggle for the remaining lines. */
export function CallEntry({ call, techName, dispatcherName }: CallEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const inbound = call.direction === 'in';
  const lines = call.transcript ?? [];
  const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const hidden = Math.max(0, lines.length - PREVIEW_LINES);

  const from = inbound ? techName : dispatcherName;
  const to = inbound ? dispatcherName : techName;

  return (
    <li className="msg-call">
      <div className="call">
        <span className="call-ic" aria-hidden="true">
          <Icon name={inbound ? 'phone-in' : 'phone-out'} size={18} />
        </span>
        <div>
          <div className="call-head">
            <span className="call-title">
              Call <span className="sep-dot">·</span>{' '}
              <span className="num">{callDuration(call.duration_seconds)}</span>
            </span>
            <span className="chip chip-sm">{inbound ? 'Inbound' : 'Outbound'}</span>
            <span className="call-who">
              {from}
              <Icon name="arrow-r" size={12} />
              {to}
            </span>
            <time className="msg-time" dateTime={call.occurred_at}>{feedTime(call.occurred_at)}</time>
          </div>

          {call.ai_summary && (
            <p className="call-sum">
              <span className="chip chip-accent chip-sm"><Icon name="zap" size={12} />AI summary</span>
              {call.ai_summary}
            </p>
          )}

          {lines.length > 0 && (
            <div className="tr">
              {shown.map((l, i) => (
                <p className="tr-line" key={`${call.id}-${i}`}>
                  <span className="tr-who">{l.speaker}</span>
                  <span>{l.line}</span>
                </p>
              ))}
              {hidden > 0 && (
                <button
                  type="button"
                  className="tr-more"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? 'Collapse transcript' : 'Expand transcript'}
                  <Icon name="chev-d" size={12} />
                  {!expanded && <span className="n">{hidden} more line{hidden === 1 ? '' : 's'}</span>}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
