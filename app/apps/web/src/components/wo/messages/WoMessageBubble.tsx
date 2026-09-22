import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { WO_MESSAGE_MAX } from '@theone/shared';
import type { ClientSystem, MessageDelivery, WoMessage, WoMessagesResponse } from '../../../api/client';
import { patchWorkOrderMessage } from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
import { Icon } from '../../Icon';
import { feedTime, initials } from '../../../lib/fields';

interface WoMessageBubbleProps {
  message: WoMessage;
  woId: string;
  queryKey: readonly unknown[];
  clientSystem: ClientSystem | null;
}

type IconName = Parameters<typeof Icon>[0]['name'];

interface Foot {
  icon: IconName;
  label: string;
  tone: 'internal' | 'pending' | 'sent' | 'failed' | 'unlinked';
}

const LABELS: Record<MessageDelivery['target'], string> = {
  ecotrak: 'Ecotrak',
  corrigo: 'Corrigo',
  servicechannel: 'ServiceChannel',
};

/** What a message's delivery line says. One line per client system it was
    queued for; an internal message says so; a client-visible one on a work
    order with no client system says that too, honestly. */
function footFor(m: WoMessage, clientSystem: ClientSystem | null): Foot[] {
  if (m.source === 'client') return [];
  if (!m.client_visible) return [{ icon: 'lock', label: 'Internal · the team only', tone: 'internal' }];
  if (m.deliveries.length === 0) {
    return [{
      icon: 'ext',
      label: clientSystem
        ? `Visible to the client · not queued for ${clientSystem.label} (linked after this was posted)`
        : 'Visible to the client · no client system linked to this work order',
      tone: 'unlinked',
    }];
  }
  return m.deliveries.map((d) => {
    const sys = LABELS[d.target] ?? d.target;
    if (d.status === 'sent') {
      return { icon: 'check-check', label: `Sent to ${sys}${d.sent_at ? ` · ${feedTime(d.sent_at)}` : ''}`, tone: 'sent' };
    }
    if (d.status === 'failed') {
      return { icon: 'alert-circle', label: `Could not send to ${sys}${d.error ? `: ${d.error}` : ''}`, tone: 'failed' };
    }
    const live = clientSystem?.target === d.target ? clientSystem.write_enabled : false;
    return {
      icon: 'clock',
      label: live ? `Queued for ${sys}` : `Queued for ${sys} · sends once that integration is live`,
      tone: 'pending',
    };
  });
}

/** 0052 · one message in the work order's thread. Ours sit on the right:
    client-visible ones accent-tinted, internal ones dashed and neutral. A
    message that came in from the client's CMMS sits on the left. The author
    may edit their own message until a client system has accepted it. */
export function WoMessageBubble({ message: m, woId, queryKey, clientSystem }: WoMessageBubbleProps) {
  const fromClient = m.source === 'client';
  const who = fromClient ? (m.external_author ?? 'Client') : (m.author?.name ?? 'Unknown');
  const cls = [
    'msg',
    fromClient ? 'msg-from-client' : 'msg-out',
    !fromClient && !m.client_visible ? 'msg-internal' : '',
  ].filter(Boolean).join(' ');

  const { can } = useAuth();
  const canMessageClient = can('work_orders/comments/client', 'create');
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [draftClient, setDraftClient] = useState(m.client_visible);

  const save = useMutation({
    mutationFn: () =>
      patchWorkOrderMessage(woId, m.id, {
        ...(draft.trim() !== m.body ? { body: draft.trim() } : {}),
        ...(draftClient !== m.client_visible ? { client_visible: draftClient } : {}),
      }),
    onSuccess: (res) => {
      qc.setQueryData<WoMessagesResponse>(queryKey, (curr) =>
        curr ? { ...curr, items: curr.items.map((i) => (i.id === res.item.id ? res.item : i)) } : curr,
      );
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ['wo-feed', woId] });
      qc.invalidateQueries({ queryKey: ['wo-activity', woId] });
      setEditing(false);
    },
  });

  const startEdit = () => {
    setDraft(m.body);
    setDraftClient(m.client_visible);
    save.reset();
    setEditing(true);
  };

  const trimmed = draft.trim();
  const changed = trimmed !== m.body || draftClient !== m.client_visible;
  const canSave = trimmed.length > 0 && trimmed.length <= WO_MESSAGE_MAX && changed && !save.isPending;

  return (
    <li className={cls}>
      <span className="msg-av" aria-hidden="true">{initials(who)}</span>
      <div className="bubble">
        <div className="msg-head">
          <span className="msg-who">{who}</span>
          {fromClient ? (
            <span className="tag tag-client">
              <Icon name="ext" size={12} />
              From client
            </span>
          ) : m.client_visible ? (
            <span className="tag tag-client">
              <Icon name="globe" size={12} />
              Client
            </span>
          ) : (
            <span className="tag">
              <Icon name="lock" size={12} />
              Internal
            </span>
          )}
          {m.edited_at && !editing && (
            <span className="msg-edited" title={`Edited ${feedTime(m.edited_at)}`}>edited</span>
          )}
          <time className="msg-time" dateTime={m.created_at}>{feedTime(m.created_at)}</time>
        </div>

        {editing ? (
          <div className="msg-editing">
            <textarea
              className="composer-input"
              aria-label="Edit message"
              maxLength={WO_MESSAGE_MAX}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <div className="msg-edit-actions">
              <div className="seg" role="group" aria-label="Message visibility">
                <button
                  type="button"
                  className={`seg-btn${draftClient ? '' : ' is-on'}`}
                  aria-pressed={!draftClient}
                  onClick={() => setDraftClient(false)}
                >
                  <Icon name="lock" size={12} />
                  Internal
                </button>
                <button
                  type="button"
                  className={`seg-btn${draftClient ? ' is-on' : ''}`}
                  aria-pressed={draftClient}
                  disabled={!canMessageClient}
                  title={canMessageClient ? undefined : 'Your role cannot message the client'}
                  onClick={() => setDraftClient(true)}
                >
                  <Icon name="globe" size={12} />
                  Client-visible
                </button>
              </div>
              {save.isError && (
                <span className="composer-err" role="alert">
                  {(save.error as Error).message || 'Could not save the change.'}
                </span>
              )}
              <button type="button" className="btn btn-sm" onClick={() => setEditing(false)} disabled={save.isPending}>
                Cancel
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={!canSave} onClick={() => save.mutate()}>
                <Icon name="check" size={12} />
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <p className="msg-txt">{m.body}</p>
        )}

        {!editing && footFor(m, clientSystem).map((f, i) => (
          <div key={i} className={`msg-foot is-${f.tone}`}>
            <Icon name={f.icon} size={12} />
            {f.label}
            {i === 0 && m.editable && (
              <button type="button" className="msg-edit-btn" onClick={startEdit} title="Edit this message">
                <Icon name="pencil" size={12} />
                Edit
              </button>
            )}
            {i === 0 && !m.editable && m.sent && m.author && (
              <span className="msg-locked" title="Sent to the client — it can no longer be edited">
                <Icon name="lock" size={12} />
              </span>
            )}
          </div>
        ))}
      </div>
    </li>
  );
}
