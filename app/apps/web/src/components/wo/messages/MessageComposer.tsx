import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ATTACHMENT_ALLOWED_TYPES, ATTACHMENT_MAX_BYTES, WO_MESSAGE_MAX, formatBytes } from '@theone/shared';
import type { ClientSystem, WoMessagesResponse } from '../../../api/client';
import { listAttachments, postWorkOrderMessage, uploadAttachment } from '../../../api/client';
import { useInvalidateObligations } from '../../../hooks/useObligations';
import { useAuth } from '../../../auth/AuthProvider';
import { prepareFile } from '../../../lib/upload';
import { Icon } from '../../Icon';

interface MessageComposerProps {
  woId: string;
  woNumber: string;
  /** The exact key the Messages tab fetches under, so the new message lands
      in the same cache entry the thread renders from. */
  queryKey: readonly unknown[];
  clientSystem: ClientSystem | null;
}

/** 0052 · the Messages tab's composer (the Overview composer, moved). The
    visibility segment DEFAULTS TO INTERNAL — an accidental client-visible post
    is the expensive mistake, so the safe option is the one you get by not
    choosing. Client-visible is its own permission ("Message the client" in
    Admin › Roles); without it the segment is drawn locked. */
export function MessageComposer({ woId, woNumber, queryKey, clientSystem }: MessageComposerProps) {
  const [clientVisible, setClientVisible] = useState(false);
  const [body, setBody] = useState('');
  const qc = useQueryClient();
  const invalidateObligations = useInvalidateObligations();
  const { can } = useAuth();
  const canMessageClient = can('work_orders/comments/client', 'create');

  const mutation = useMutation({
    mutationFn: () => postWorkOrderMessage(woId, { body: body.trim(), client_visible: clientVisible }),
    onSuccess: (res) => {
      setBody('');
      setClientVisible(false);
      qc.setQueryData<WoMessagesResponse>(queryKey, (curr) =>
        curr ? { ...curr, items: [...curr.items, res.item] } : curr,
      );
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ['wo-feed', woId] });
      qc.invalidateQueries({ queryKey: ['wo-activity', woId] });
      // S5: a message is EVIDENCE — it silences emergency_ack, and a
      // client-visible one silences approval_followup.
      invalidateObligations();
    },
  });

  // 0043 · photos and files ride along with the same visibility flag.
  const canAttach = can('work_orders/attachments', 'create');
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);

  const attachments = useQuery({
    queryKey: ['wo-attachments', woId],
    queryFn: () => listAttachments(woId),
    enabled: canAttach,
    retry: 0,
  });
  const storageReady = attachments.data?.storage_ready ?? true;

  const sendFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadError(null);
    setUploading(files.length);
    try {
      for (const file of Array.from(files)) {
        const prepared = await prepareFile(file);
        await uploadAttachment(woId, { ...prepared, client_visible: clientVisible });
      }
      await qc.invalidateQueries({ queryKey: ['wo-attachments', woId] });
      await qc.invalidateQueries({ queryKey: ['wo-activity', woId] });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'That file did not upload');
    } finally {
      setUploading(0);
      if (fileInput.current) fileInput.current.value = '';
      if (photoInput.current) photoInput.current.value = '';
    }
  };

  const trimmed = body.trim();
  const tooLong = trimmed.length > WO_MESSAGE_MAX;
  const canSend = trimmed.length > 0 && !tooLong && !mutation.isPending;

  const help = clientVisible
    ? clientSystem
      ? clientSystem.write_enabled
        ? `Goes to the client on ${clientSystem.label}`
        : `Queued for ${clientSystem.label} — sends once that integration is live`
      : 'Visible to the client — no client system is linked to this work order yet'
    : 'Internal — the team only, never the client';

  return (
    <div className={`composer${clientVisible ? ' is-client' : ''}`}>
      <div className="composer-head">
        <div className="seg" role="group" aria-label="Message visibility">
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
            disabled={!canMessageClient}
            title={canMessageClient ? undefined : 'Your role cannot message the client'}
            onClick={() => setClientVisible(true)}
          >
            <Icon name="globe" size={12} />
            Client-visible
          </button>
        </div>
        <span className="composer-help">
          <Icon name={clientVisible ? 'ext' : 'lock'} size={12} />
          {help}
        </span>
      </div>

      <textarea
        className="composer-input"
        placeholder={clientVisible ? `Message the client about ${woNumber}…` : `Add an internal message on ${woNumber}…`}
        aria-label="Message text"
        maxLength={WO_MESSAGE_MAX}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      <div className="composer-foot">
        <div className="composer-tools">
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => void sendFiles(e.target.files)}
          />
          <input
            ref={fileInput}
            type="file"
            accept={ATTACHMENT_ALLOWED_TYPES.join(',')}
            multiple
            hidden
            onChange={(e) => void sendFiles(e.target.files)}
          />
          <button
            type="button"
            className="tool-btn"
            aria-label="Add photo"
            disabled={!canAttach || !storageReady || uploading > 0}
            title={
              !canAttach
                ? 'Your role cannot add photos'
                : !storageReady
                  ? 'File storage is not configured on this server'
                  : `Add a photo (up to ${formatBytes(ATTACHMENT_MAX_BYTES)})`
            }
            onClick={() => photoInput.current?.click()}
          >
            <Icon name="camera" size={14} />
          </button>
          <button
            type="button"
            className="tool-btn"
            aria-label="Attach file"
            disabled={!canAttach || !storageReady || uploading > 0}
            title={
              !canAttach
                ? 'Your role cannot attach files'
                : !storageReady
                  ? 'File storage is not configured on this server'
                  : `Attach a file (up to ${formatBytes(ATTACHMENT_MAX_BYTES)})`
            }
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="clip" size={14} />
          </button>
          {uploading > 0 && <span className="composer-count">Uploading {uploading}…</span>}
        </div>

        {mutation.isError ? (
          <span className="composer-err" role="alert">
            {(mutation.error as Error).message || 'Could not post the message.'}
          </span>
        ) : uploadError ? (
          <span className="composer-err" role="alert">{uploadError}</span>
        ) : null}

        <span className={`composer-count${tooLong ? ' is-over' : ''}`}>
          {trimmed.length} / {WO_MESSAGE_MAX}
        </span>

        <button type="button" className="btn btn-primary" disabled={!canSend} onClick={() => mutation.mutate()}>
          <Icon name="send" size={14} />
          {mutation.isPending ? 'Posting…' : clientVisible ? 'Send to client' : 'Post internally'}
        </button>
      </div>
    </div>
  );
}
