import { Fragment } from 'react';
import type { ThreadItem } from '../../../api/client';
import { Icon } from '../../Icon';
import { feedTime, shortDate } from '../../../lib/fields';
import { dayKey, dayLabel, itemTime } from '../../../lib/quo';
import { CallEntry } from './CallEntry';
import { MessageBubble } from './MessageBubble';

interface MessageThreadProps {
  items: ThreadItem[];
  techName: string;
  dispatcherName: string;
  /** Cleaned WO status name — the thread foot says what we are waiting on. */
  waitingOn: string | null;
}

/** C2 · the conversation itself: job-segment dividers, day dividers, call
    cards and text bubbles, oldest-first exactly as the API returns them. */
export function MessageThread({ items, techName, dispatcherName, waitingOn }: MessageThreadProps) {
  if (items.length === 0) {
    return (
      <div className="thread">
        <div className="tab-empty">
          <Icon name="msg" size={22} />
          <b>Nothing on this line yet</b>
          <span>Calls and texts appear here as soon as Quo syncs them.</span>
        </div>
      </div>
    );
  }

  // Day dividers separate calendar days; the first item never gets one (its
  // date is already carried by the segment marker / the card header).
  let prevDay: string | null = null;
  const lastActivity = itemTime(items[items.length - 1]);

  return (
    <div className="thread">
      <ol className="msgs">
        {items.map((item) => {
          const when = itemTime(item);
          const key = dayKey(when);
          const showDay = prevDay !== null && key !== null && key !== prevDay;
          if (key !== null) prevDay = key;

          return (
            <Fragment key={`${item.type}-${item.id}`}>
              {showDay && (
                <li className="daydiv" role="separator">
                  <span>{dayLabel(when)}</span>
                </li>
              )}

              {item.type === 'segment' && (
                <li className="jobseg" role="separator">
                  <span className="jobseg-line" aria-hidden="true" />
                  <span className="jobseg-lbl">
                    <Icon name="briefcase" size={12} />
                    Job · {item.label}
                    {shortDate(item.started_at) ? ` · started ${shortDate(item.started_at)}` : ''}
                  </span>
                  <span className="jobseg-line" aria-hidden="true" />
                </li>
              )}

              {item.type === 'call' && (
                <CallEntry call={item} techName={techName} dispatcherName={dispatcherName} />
              )}

              {item.type === 'message' && (
                <MessageBubble
                  message={item}
                  techName={techName}
                  dispatcherName={dispatcherName}
                />
              )}
            </Fragment>
          );
        })}
      </ol>

      <p className="thread-foot">
        <Icon name="clock" size={12} />
        No new messages since {feedTime(lastActivity)}
        {waitingOn ? ` — ${waitingOn}` : ''}
      </p>
    </div>
  );
}
