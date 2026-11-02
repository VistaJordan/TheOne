import { Fragment, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ClientSystem, WoMessage } from '../../../api/client';
import { Icon } from '../../Icon';
import { dayKey, dayLabel } from '../../../lib/quo';
import { WoMessageBubble } from './WoMessageBubble';

interface WoThreadProps {
  items: WoMessage[];
  woId: string;
  queryKey: readonly unknown[];
  clientSystem: ClientSystem | null;
  /** 0114 · which Messages tab this is, for its empty state. */
  lane: 'internal' | 'client';
}

/** 0052 · the work order's own conversation, oldest-first with day dividers,
    exactly as the API returns it. */
export function WoThread({ items, woId, queryKey, clientSystem, lane }: WoThreadProps) {
  // 0089 · a mention notice links to ?tab=messages&msg=<id>: scroll to that
  // message once it is in the list, and draw it highlighted.
  const [params] = useSearchParams();
  const target = params.get('msg');
  const found = target !== null && items.some((m) => m.id === target);
  useEffect(() => {
    if (!found || !target) return;
    document.getElementById(`msg-${target}`)?.scrollIntoView({ block: 'center' });
  }, [found, target]);

  if (items.length === 0) {
    return (
      <div className="thread">
        <div className="tab-empty">
          <Icon name="msg" size={22} />
          {lane === 'internal' ? (
            <>
              <b>No internal messages yet</b>
              <span>Notes posted here stay with the team; the client never sees them.</span>
            </>
          ) : (
            <>
              <b>No client messages yet</b>
              <span>
                What the client writes{clientSystem ? ` on ${clientSystem.label}` : ''} shows here, with our
                replies in between.
              </span>
            </>
          )}
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
              <WoMessageBubble
                message={m}
                woId={woId}
                queryKey={queryKey}
                clientSystem={clientSystem}
                highlighted={m.id === target}
              />
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}
