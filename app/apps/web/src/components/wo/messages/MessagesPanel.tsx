import type { MessagesResponse } from '../../../api/client';
import { Icon } from '../../Icon';
import { feedTime } from '../../../lib/fields';
import { ChannelHeader } from './ChannelHeader';
import { MessageThread } from './MessageThread';
import { TextComposer } from './TextComposer';

interface MessagesPanelProps {
  woId: string;
  data: MessagesResponse | undefined;
  loading: boolean;
  error: boolean;
  /** Cleaned WO status name for the thread foot ("— Waiting for Approval"). */
  waitingOn: string | null;
  queryKey: readonly unknown[];
}

/** C · the Messages tab's main column: channel header, conversation, composer. */
export function MessagesPanel({ woId, data, loading, error, waitingOn, queryKey }: MessagesPanelProps) {
  if (loading) {
    return (
      <div className="card" role="tabpanel" aria-label="Messages">
        <div className="tab-empty"><b>Loading the Quo thread…</b></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" role="tabpanel" aria-label="Messages">
        <div className="tab-empty">
          <Icon name="alert" size={22} />
          <b>Could not load the conversation</b>
          <span>Is the API running on :5174?</span>
        </div>
      </div>
    );
  }

  const conversation = data?.conversation ?? null;

  // Contract: `conversation: null` → nothing is correlated to this WO yet.
  if (!conversation) {
    return (
      <div className="card" role="tabpanel" aria-label="Messages">
        <div className="tab-empty">
          <Icon name="msg" size={22} />
          <b>No Quo conversation linked yet</b>
          <span>
            Messages mirror the dispatcher↔technician thread in Quo. One appears here once a
            technician vendor with a Quo number is assigned to this work order.
          </span>
        </div>
      </div>
    );
  }

  const items = data?.items ?? [];
  const techName = conversation.vendor.name;
  const dispatcherName = conversation.claimed_by ?? 'Dispatcher';

  return (
    <div role="tabpanel" aria-label="Messages">
      <ChannelHeader conversation={conversation} />

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Conversation</h2>
          <span className="chip chip-sm"><Icon name="lock" size={12} />Not client-visible</span>
          <span className="card-meta">
            Synced from Quo
            {conversation.last_activity ? ` · ${feedTime(conversation.last_activity)}` : ''}
          </span>
        </div>

        <MessageThread
          items={items}
          techName={techName}
          dispatcherName={dispatcherName}
          waitingOn={waitingOn}
        />

        <TextComposer woId={woId} conversation={conversation} queryKey={queryKey} />
      </section>
    </div>
  );
}
