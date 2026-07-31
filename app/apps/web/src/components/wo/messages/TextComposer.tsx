import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MessagesResponse, QuoConversation } from '../../../api/client';
import { MESSAGE_MAX, postWorkOrderMessage } from '../../../api/client';
import { Icon } from '../../Icon';
import { optimisticMessage, smsSegments } from '../../../lib/quo';

interface TextComposerProps {
  woId: string;
  conversation: QuoConversation;
  /** The exact key MessagesPanel fetches under, so the optimistic write lands
      in the same cache entry the thread renders from. */
  queryKey: readonly unknown[];
}

/** C3 · the local-send composer. The text is queued in our own mirror
    (pending_sync) — the real Quo pipe (Quotato) connects in a later sprint. */
export function TextComposer({ woId, conversation, queryKey }: TextComposerProps) {
  const [body, setBody] = useState('');
  const qc = useQueryClient();
  const vendor = conversation.vendor;

  const mutation = useMutation({
    mutationFn: (text: string) => postWorkOrderMessage(woId, { body: text }),
    // Optimistic append: the bubble shows immediately with pending-sync
    // styling, which is also its FINAL state (the API stores pending_sync=true).
    onMutate: async (text: string) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<MessagesResponse>(queryKey);
      qc.setQueryData<MessagesResponse>(queryKey, (curr) =>
        curr ? { ...curr, items: [...curr.items, optimisticMessage(text, conversation.id)] } : curr,
      );
      return { previous };
    },
    onError: (_err, _text, ctx) => {
      if (ctx?.previous) qc.setQueryData(queryKey, ctx.previous);
    },
    onSuccess: () => setBody(''),
    onSettled: () => {
      qc.invalidateQueries({ queryKey });
      // The write also lands a `tech_message_sent` activity row.
      qc.invalidateQueries({ queryKey: ['wo-activity', woId] });
      qc.invalidateQueries({ queryKey: ['wo-feed', woId] });
    },
  });

  const trimmed = body.trim();
  const tooLong = trimmed.length > MESSAGE_MAX;
  const canSend = trimmed.length > 0 && !tooLong && !mutation.isPending;
  const segments = smsSegments(trimmed.length);

  return (
    <div className="composer is-sms">
      <div className="composer-head">
        <span className="composer-to">
          <Icon name="msg" size={12} />
          To <b>{vendor.name}</b>
          {vendor.phone && <span className="mono">{vendor.phone}</span>}
        </span>
        <span className="composer-help">
          <Icon name="lock" size={12} />
          External tech channel — not synced to the client
        </span>
      </div>

      <textarea
        className="composer-input"
        placeholder={`Text ${vendor.name}…`}
        aria-label={`Text message to ${vendor.name}`}
        maxLength={MESSAGE_MAX}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      <div className="composer-foot">
        <div className="composer-tools">
          <button
            type="button"
            className="tool-btn"
            aria-label="Attach photo"
            disabled
            title="Photo attachments land in a later sprint"
          >
            <Icon name="image" size={14} />
          </button>
          <button
            type="button"
            className="tool-btn"
            aria-label="Attach file"
            disabled
            title="File attachments land in a later sprint"
          >
            <Icon name="clip" size={14} />
          </button>
        </div>

        {mutation.isError ? (
          <span className="composer-err" role="alert">
            {(mutation.error as Error).message || 'Could not queue the text.'}
          </span>
        ) : (
          <span className="composer-cap">
            <Icon name="radio" size={12} />
            {conversation.quo_line_label
              ? <>Sends from your claimed Quo line <b>{conversation.quo_line_label}</b></>
              : 'Sends from your claimed Quo line'}
          </span>
        )}

        <span className={`sms-count${tooLong ? ' is-over' : ''}`}>
          {trimmed.length} / 160 · {segments} SMS
        </span>

        <button type="button" className="btn btn-primary" disabled={!canSend} onClick={() => mutation.mutate(trimmed)}>
          <Icon name="send" size={14} />
          {mutation.isPending ? 'Sending…' : 'Send text'}
        </button>
      </div>
    </div>
  );
}
