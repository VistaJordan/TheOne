import { Fragment } from 'react';
import type { ClientSystem, WoMessage } from '../../../api/client';
import { Icon } from '../../Icon';
import { dayKey, dayLabel } from '../../../lib/quo';
import { WoMessageBubble } from './WoMessageBubble';

interface WoThreadProps {
  items: WoMessage[];
  woId: string;
  queryKey: readonly unknown[];
  clientSystem: ClientSystem | null;
}

/** 0052 · the work order's own conversation, oldest-first with day dividers,
    exactly as the API returns it. */
export function WoThread({ items, woId, queryKey, clientSystem }: WoThreadProps) {
  if (items.length === 0) {
    return (
      <div className="thread">
        <div className="tab-empty">
          <Icon name="msg" size={22} />
          <b>No messages yet</b>
          <span>
            Post the first one below. Internal messages stay with the team; client-visible ones
            go to the client{clientSystem ? ` on ${clientSystem.label}` : ''}.
          </span>
        </div>
      </div>
    );
  }

  let prevDay: string | null = null;

  return (
    <div className="thread">
      <ol className="msgs">
        {items.map((m) => {
          const key = dayKey(m.created_at);
          const showDay = prevDay !== null && key !== null && key !== prevDay;
          if (key !== null) prevDay = key;
          return (
            <Fragment key={m.id}>
              {showDay && (
                <li className="daydiv" role="separator">
                  <span>{dayLabel(m.created_at)}</span>
                </li>
              )}
              <WoMessageBubble message={m} woId={woId} queryKey={queryKey} clientSystem={clientSystem} />
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}
