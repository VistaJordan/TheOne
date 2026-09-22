import type { WoMessagesResponse } from '../../../api/client';
import { Icon } from '../../Icon';
import { feedTime } from '../../../lib/fields';
import { ChannelHeader } from './ChannelHeader';
import { MessageThread } from './MessageThread';
import { TextComposer } from './TextComposer';
import { WoThread } from './WoThread';
import { MessageComposer } from './MessageComposer';

interface MessagesPanelProps {
  woId: string;
  woNumber: string;
  data: WoMessagesResponse | undefined;
  loading: boolean;
  error: boolean;
  /** Cleaned WO status name for the Quo thread foot ("— Waiting for Approval"). */
  waitingOn: string | null;
  queryKey: readonly unknown[];
}

/** 0052 · the Messages tab: the work order's own thread (internal and
    client-visible, on every work order) with its composer, and below it the
    Quo technician thread when a line is linked to this work order. */
export function MessagesPanel({ woId, woNumber, data, loading, error, waitingOn, queryKey }: MessagesPanelProps) {
  if (loading) {
    return (
      <div className="card" role="tabpanel" aria-label="Messages">
        <div className="tab-empty"><b>Loading messages…</b></div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card" role="tabpanel" aria-label="Messages">
        <div className="tab-empty">
          <Icon name="alert" size={22} />
          <b>Could not load the messages</b>
          <span>Is the API running on :5174?</span>
        </div>
      </div>
    );
  }

  const { items, client_system: clientSystem, quo } = data;
  const conversation = quo.conversation;
  const last = items.length > 0 ? items[items.length - 1].created_at : null;

  return (
    <div role="tabpanel" aria-label="Messages">
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Messages</h2>
          {clientSystem ? (
            <span
              className="chip chip-sm"
              title={
                clientSystem.write_enabled
                  ? `Client-visible messages go to ${clientSystem.label}`
                  : `Client-visible messages queue for ${clientSystem.label} until that integration is live`
              }
            >
              <Icon name="ext" size={12} />
              Client on {clientSystem.label}
              {!clientSystem.write_enabled && ' · sending off'}
            </span>
          ) : (
            <span className="chip chip-sm" title="Set Client Portal Type on the work order to link one">
              <Icon name="lock" size={12} />
              No client system linked
            </span>
          )}
          <span className="card-meta">
            {items.length} message{items.length === 1 ? '' : 's'}
            {last ? ` · last ${feedTime(last)}` : ' · oldest first'}
          </span>
        </div>

        <WoThread items={items} woId={woId} queryKey={queryKey} clientSystem={clientSystem} />

        <MessageComposer woId={woId} woNumber={woNumber} queryKey={queryKey} clientSystem={clientSystem} />
      </section>

      {conversation && (
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
              items={quo.items}
              techName={conversation.vendor.name}
              dispatcherName={conversation.claimed_by ?? 'Dispatcher'}
              waitingOn={waitingOn}
            />

            <TextComposer woId={woId} conversation={conversation} queryKey={queryKey} />
          </section>
        </>
      )}
    </div>
  );
}
