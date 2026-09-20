import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ATTACHMENT_ALLOWED_TYPES, ATTACHMENT_MAX_BYTES, formatBytes } from '@theone/shared';
import { listAttachments, postWorkOrderComment, uploadAttachment } from '../../api/client';
import { useInvalidateObligations } from '../../hooks/useObligations';
import { useAuth } from '../../auth/AuthProvider';
import { prepareFile } from '../../lib/upload';
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
  const invalidateObligations = useInvalidateObligations();

  const mutation = useMutation({
    mutationFn: () => postWorkOrderComment(woId, { body: body.trim(), client_visible: clientVisible }),
    onSuccess: () => {
      setBody('');
      setClientVisible(false);
      qc.invalidateQueries({ queryKey: ['wo-feed', woId] });
      qc.invalidateQueries({ queryKey: ['wo-activity', woId] });
      // S5: a comment is EVIDENCE — it silences emergency_ack, and a
      // client-visible one silences approval_followup.
      invalidateObligations();
    },
  });

  // 0043 · photos and files. The two tool buttons below were disabled until
  // there was somewhere to put a file. The photo one asks a phone for its
  // camera; the clip one takes anything on the allowed list. A photo is
  // shrunk in the browser first — a phone picture is several times the size
  // the API will accept, and 2000px is more than a work order ever needs.
  const { can } = useAuth();
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
      // One at a time: the size limit is per request, and a failure should
      // name the file that caused it rather than losing the whole batch.
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
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ATTACHMENT_ALLOWED_TYPES.join(',')}
            style={{ display: 'none' }}
            onChange={(e) => void sendFiles(e.target.files)}
          />
          <input
            ref={photoInput}
            type="file"
            multiple
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => void sendFiles(e.target.files)}
          />
          <button
            type="button"
            className="tool-btn"
            aria-label="Attach file"
            disabled={!canAttach || !storageReady || uploading > 0}
            title={
              !canAttach ? 'You cannot add files to work orders'
              : !storageReady ? 'File storage is not connected to this environment yet'
              : `Attach a file (up to ${formatBytes(ATTACHMENT_MAX_BYTES)})`
            }
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="clip" size={14} />
          </button>
          <button
            type="button"
            className="tool-btn"
            aria-label="Add photo"
            disabled={!canAttach || !storageReady || uploading > 0}
            title={
              !canAttach ? 'You cannot add photos to work orders'
              : !storageReady ? 'File storage is not connected to this environment yet'
              : 'Add a photo — a large one is shrunk before it is sent'
            }
            onClick={() => photoInput.current?.click()}
          >
            <Icon name="image" size={14} />
          </button>
          {uploading > 0 && (
            <span className="composer-count">
              Uploading {uploading === 1 ? 'a file' : `${uploading} files`}…
            </span>
          )}
        </div>
        {uploadError && (
          <span className="composer-err" role="alert">{uploadError}</span>
        )}
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
