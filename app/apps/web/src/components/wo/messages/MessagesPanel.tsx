import type { WoMessagesResponse } from '../../../api/client';
import { Icon } from '../../Icon';
import { feedTime } from '../../../lib/fields';
import { WoThread } from './WoThread';
import { MessageComposer } from './MessageComposer';

interface MessagesPanelProps {
  woId: string;
  woNumber: string;
  data: WoMessagesResponse | undefined;
  loading: boolean;
  error: boolean;
  queryKey: readonly unknown[];
}

/** 0052 · the Messages tab: the work order's own thread (internal and
    client-visible, on every work order) with its composer. The Quo technician
    thread moved to Tech Hub (0095, `TechTextsCard`). */
export function MessagesPanel({ woId, woNumber, data, loading, error, queryKey }: MessagesPanelProps) {
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

  const { items, client_system: clientSystem } = data;
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
    </div>
  );
}
