import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postWorkOrderComment } from '../../api/client';
import { Icon } from '../Icon';

/** Matches the API's Zod bound (body: string 1..4000). */
const MAX_BODY = 4000;

interface UpdateComposerProps {
  woId: string;
  woNumber: string;
}

/** The comp's composer. The visibility segment DEFAULTS TO INTERNAL — an
    accidental client-visible post is the expensive mistake, so the safe
    option is the one you get by not choosing. */
export function UpdateComposer({ woId, woNumber }: UpdateComposerProps) {
  const [clientVisible, setClientVisible] = useState(false);
  const [body, setBody] = useState('');
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => postWorkOrderComment(woId, { body: body.trim(), client_visible: clientVisible }),
    onSuccess: () => {
      setBody('');
      setClientVisible(false);
      qc.invalidateQueries({ queryKey: ['wo-feed', woId] });
      qc.invalidateQueries({ queryKey: ['wo-activity', woId] });
    },
  });

  const trimmed = body.trim();
  const tooLong = trimmed.length > MAX_BODY;
  const canSend = trimmed.length > 0 && !tooLong && !mutation.isPending;

  return (
    <div className={`composer${clientVisible ? ' is-client' : ''}`}>
      <div className="composer-head">
        <div className="seg" role="group" aria-label="Update visibility">
          <button
            type="button"
            className={`seg-btn${clientVisible ? '' : ' is-on'}`}
            aria-pressed={!clientVisible}
            onClick={() => setClientVisible(false)}
          >
            <Icon name="lock" size={12} />
            Internal
          </button>
          <button
            type="button"
            className={`seg-btn${clientVisible ? ' is-on' : ''}`}
            aria-pressed={clientVisible}
            onClick={() => setClientVisible(true)}
          >
            <Icon name="globe" size={12} />
            Client-visible
          </button>
        </div>
        <span className="composer-help">
          <Icon name="ext" size={12} />
          Client-visible updates sync to the client's CMMS
        </span>
      </div>

      <textarea
        className="composer-input"
        placeholder={`Add an update for ${woNumber}…`}
        aria-label="Update text"
        maxLength={MAX_BODY}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      <div className="composer-foot">
        <div className="composer-tools">
          <button type="button" className="tool-btn" aria-label="Attach file" disabled title="Attachments land in a later sprint">
            <Icon name="clip" size={14} />
          </button>
          <button type="button" className="tool-btn" aria-label="Add photo" disabled title="Photo upload lands in a later sprint">
            <Icon name="image" size={14} />
          </button>
        </div>
        {mutation.isError && (
          <span className="composer-err" role="alert">
            {(mutation.error as Error).message || 'Could not post the update.'}
          </span>
        )}
        {trimmed.length > MAX_BODY - 200 && (
          <span className="composer-count">{trimmed.length}/{MAX_BODY}</span>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSend}
          onClick={() => mutation.mutate()}
        >
          <Icon name="send" size={14} />
          {mutation.isPending ? 'Sending…' : 'Send update'}
        </button>
      </div>
    </div>
  );
}
