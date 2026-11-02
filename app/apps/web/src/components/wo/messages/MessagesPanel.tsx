import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { WoMessagesResponse } from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
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

type Lane = 'internal' | 'client';

/** 0052 · the Messages tab: the work order's own thread (internal and
    client-visible, on every work order) with its composer. The Quo technician
    thread moved to Tech Hub (0095, `TechTextsCard`).
    0114 · two tabs: **Internal** (the team's notes, one under the other) and
    **Client visible** (what the client wrote — on their portal, e.g. Ecotrak
    comments — with our replies in between). The tab also decides how the
    composer posts. A ?msg= link opens the tab that holds the message. */
export function MessagesPanel({ woId, woNumber, data, loading, error, queryKey }: MessagesPanelProps) {
  const [params] = useSearchParams();
  const { can } = useAuth();
  const canMessageClient = can('work_orders/comments/client', 'create');
  const [picked, setPicked] = useState<Lane | null>(null);
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

  const { items: all, client_system: clientSystem } = data;
  const linked = params.get('msg') ? all.find((m) => m.id === params.get('msg')) : undefined;
  const lane: Lane = picked ?? (linked?.client_visible ? 'client' : 'internal');
  const clientItems = all.filter((m) => m.client_visible);
  const internalItems = all.filter((m) => !m.client_visible);
  const items = lane === 'client' ? clientItems : internalItems;
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
          <div className="seg msg-lanes" role="tablist" aria-label="Which messages">
            <button
              type="button"
              role="tab"
              className={`seg-btn${lane === 'internal' ? ' is-on' : ''}`}
              aria-selected={lane === 'internal'}
              onClick={() => setPicked('internal')}
            >
              <Icon name="lock" size={12} />
              Internal <span className="msg-lane-count">{internalItems.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              className={`seg-btn${lane === 'client' ? ' is-on' : ''}`}
              aria-selected={lane === 'client'}
              onClick={() => setPicked('client')}
            >
              <Icon name="globe" size={12} />
              Client visible <span className="msg-lane-count">{clientItems.length}</span>
            </button>
          </div>
          <span className="card-meta">
            {items.length} message{items.length === 1 ? '' : 's'}
            {last ? ` · last ${feedTime(last)}` : ' · oldest first'}
          </span>
        </div>

        <WoThread items={items} woId={woId} queryKey={queryKey} clientSystem={clientSystem} lane={lane} />

        {lane === 'client' && !canMessageClient ? (
          <p className="composer-locked">
            <Icon name="lock" size={12} /> Your role cannot message the client. Post on the Internal tab instead.
          </p>
        ) : (
          <MessageComposer
            woId={woId}
            woNumber={woNumber}
            queryKey={queryKey}
            clientSystem={clientSystem}
            clientVisible={lane === 'client'}
          />
        )}
      </section>
    </div>
  );
}
