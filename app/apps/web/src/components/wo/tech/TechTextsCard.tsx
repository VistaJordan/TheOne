/* 0095 · the Quo technician texts on Tech Hub (they sat under the client
 * thread on Messages until 2026-10-27, which mixed the two conversations).
 * Reads GET /work-orders/:id/messages/quo, gated on the Tech Hub tab. A work
 * order with no Quo line linked draws nothing — the Technicians and call
 * cards above already say how to reach someone. */

import type { MessagesResponse } from '../../../api/client';
import { feedTime } from '../../../lib/fields';
import { Icon } from '../../Icon';
import { ChannelHeader } from '../messages/ChannelHeader';
import { MessageThread } from '../messages/MessageThread';
import { TextComposer } from '../messages/TextComposer';

interface TechTextsCardProps {
  woId: string;
  data: MessagesResponse | undefined;
  /** The key `data` was fetched under, for the composer's optimistic write. */
  queryKey: readonly unknown[];
  /** Cleaned WO status name for the thread foot ("— Waiting for Approval"). */
  waitingOn: string | null;
}

export function TechTextsCard({ woId, data, queryKey, waitingOn }: TechTextsCardProps) {
  const conversation = data?.conversation ?? null;
  if (!data || !conversation) return null;
  return (
    <>
      <ChannelHeader conversation={conversation} />
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Technician texts</h2>
          <span className="chip chip-sm"><Icon name="lock" size={12} />Not client-visible</span>
          <span className="card-meta">
            Synced from Quo
            {conversation.last_activity ? ` · ${feedTime(conversation.last_activity)}` : ''}
          </span>
        </div>

        <MessageThread
          items={data.items}
          techName={conversation.vendor.name}
          dispatcherName={conversation.claimed_by ?? 'Dispatcher'}
          waitingOn={waitingOn}
        />

        <TextComposer woId={woId} conversation={conversation} queryKey={queryKey} />
      </section>
    </>
  );
}
