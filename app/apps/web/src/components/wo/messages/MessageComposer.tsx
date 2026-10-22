import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ATTACHMENT_ALLOWED_TYPES, ATTACHMENT_MAX_BYTES, WO_MESSAGE_MAX, formatBytes, mentionsInBody } from '@theone/shared';
import type { ClientSystem, MentionCandidate, WoMessagesResponse } from '../../../api/client';
import { listAttachments, postWorkOrderMessage, uploadAttachment } from '../../../api/client';
import { useInvalidateObligations } from '../../../hooks/useObligations';
import { useAuth } from '../../../auth/AuthProvider';
import { prepareFile } from '../../../lib/upload';
import { Icon } from '../../Icon';
import { MentionTextarea, useMentionCandidates } from './MentionTextarea';

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

  // 0089 · @mentions: the people picked from the list; only those whose
  // "@Name" is still in the text are sent.
  const candidates = useMentionCandidates(woId, can('work_orders/comments', 'create'));
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const mentioned = mentionsInBody(body, picked);

  const mutation = useMutation({
    mutationFn: () =>
      postWorkOrderMessage(woId, {
        body: body.trim(),
        client_visible: clientVisible,
        ...(mentioned.length > 0 ? { mentions: mentioned.map((m) => m.id) } : {}),
      }),
    onSuccess: (res) => {
      setBody('');
      setPicked([]);
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
  // Drag depth, not a boolean: dragenter / dragleave fire for every child the
  // pointer crosses, so only a counter back at zero means "left the composer".
  const [dragDepth, setDragDepth] = useState(0);

  const attachments = useQuery({
    queryKey: ['wo-attachments', woId],
    queryFn: () => listAttachments(woId),
    enabled: canAttach,
    retry: 0,
  });
  const storageReady = attachments.data?.storage_ready ?? true;
  // Why paste and drop are refused, or null when they would work. The two
  // buttons keep their own titles; this is the sentence a paste or a drop
  // gets instead of silently doing nothing.
  const uploadsClosed = !canAttach
    ? 'Your role cannot add photos'
    : !storageReady
      ? 'File storage is not configured on this server'
      : null;

  const sendFiles = async (files: FileList | File[] | null) => {
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

  // Paste: a screenshot (or a file copied in Explorer / Finder) on the
  // clipboard goes up like a click on Attach file; text pastes as text. The
  // clipboard names a screenshot "image.png", so it is renamed with a stamp
  // before the list fills with identical names.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFrom(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    if (uploadsClosed) {
      setUploadError(uploadsClosed);
      return;
    }
    void sendFiles(files.map(nameClipboardFile));
  };

  // Drag and drop: a file dragged from a folder onto any part of the composer
  // (the text box included — the browser would otherwise open it) uploads
  // with the visibility the segment says. Nothing else dragged (text, a link)
  // is touched, so selecting text and dragging it still works.
  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = uploadsClosed || uploading > 0 ? 'none' : 'copy';
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    setDragDepth((d) => Math.max(0, d - 1));
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragDepth(0);
    const files = filesFrom(e.dataTransfer);
    if (files.length === 0) return;
    if (uploadsClosed) {
      setUploadError(uploadsClosed);
      return;
    }
    if (uploading > 0) return;
    void sendFiles(files);
  };
  const dragging = dragDepth > 0;

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
    <div
      className={`composer${clientVisible ? ' is-client' : ''}${dragging ? ' is-dragging' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="composer-drop" aria-hidden="true">
          <Icon name={uploadsClosed ? 'alert' : 'clip'} size={16} />
          {uploadsClosed ?? `Drop to attach (${clientVisible ? 'client-visible' : 'internal'})`}
        </div>
      )}
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

      <MentionTextarea
        className="composer-input"
        placeholder={
          clientVisible
            ? `Message the client about ${woNumber}…`
            : `Add an internal message on ${woNumber}… Type @ to mention someone`
        }
        aria-label="Message text"
        maxLength={WO_MESSAGE_MAX}
        value={body}
        onChange={setBody}
        onPaste={onPaste}
        candidates={candidates}
        onMention={(person) => setPicked((curr) => (curr.some((c) => c.id === person.id) ? curr : [...curr, person]))}
      />
      {mentioned.length > 0 && (
        <div className="composer-mentions">
          <Icon name="bell" size={12} />
          {mentioned.length === 1 ? `${mentioned[0].name} will be notified` : `${mentioned.map((m) => m.name).join(', ')} will be notified`}
          {clientVisible && <span className="composer-mentions-warn"> · the client sees the @names too</span>}
        </div>
      )}

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
          {uploading > 0 ? (
            <span className="composer-count">Uploading {uploading}…</span>
          ) : (
            !uploadsClosed && <span className="composer-hint">or paste / drop a file here</span>
          )}
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

/** The files on a clipboard or a drag, whichever way the browser offers them
    (`files` on most; some only list `items` of kind "file"). */
function filesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const direct = Array.from(dt.files ?? []);
  if (direct.length > 0) return direct;
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

/** True while what is being dragged includes a file (not text or a link). */
function dragHasFiles(dt: DataTransfer | null): boolean {
  return dt !== null && Array.from(dt.types).includes('Files');
}

/** A pasted screenshot arrives as "image.png" every time; give it a name
    that says when it was taken so the Photos card can tell them apart. */
function nameClipboardFile(file: File): File {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.png';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return new File([file], `pasted-${stamp}${ext}`, { type: file.type, lastModified: file.lastModified });
}
