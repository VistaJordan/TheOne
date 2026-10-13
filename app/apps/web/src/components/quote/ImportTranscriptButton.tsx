/* 0077 · Import transcript — draft a quote from a conversation held outside Quo.
 *
 * The Call button drafts a quote from a call placed through Quo. A meeting on
 * Teams or Zoom, a site walk recorded on a phone, a call from a personal line
 * has no Quo call behind it, so this takes the transcript itself: a .txt,
 * .vtt or .srt file (read here in the browser) or the text pasted in. The
 * server stores it as a transcribed, number-less call and the AI quote draft
 * page opens on it and drafts straight away — review, adjust, Submit quote,
 * exactly as after a call. */

import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TRANSCRIPT_FILE_ACCEPT, WO_CALL_CONTACT_LABELS, parseTranscriptFile } from '@theone/shared';
import type { WoCallContactRole } from '@theone/shared';
import { ApiRequestError, importWoTranscript } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../Icon';

/** A transcript file larger than this is almost certainly not a transcript. */
const MAX_FILE_BYTES = 2_000_000;

export function ImportTranscriptButton({
  woNumber,
  size = 'sm',
  disabledReason,
}: {
  woNumber: string;
  size?: 'sm' | 'lg';
  /** The WO-status gate's reason when quoting is closed: drawn locked. */
  disabledReason?: string | null;
}) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can('quotes', 'edit')) return null;
  const cls = `btn${size === 'lg' ? ' btn-lg' : ' btn-sm'}`;
  if (disabledReason) {
    return (
      <button type="button" className={`${cls} btn-locked`} aria-disabled="true" title={disabledReason}>
        <Icon name="lock" size={12} />
        Import transcript
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className={cls}
        onClick={() => setOpen(true)}
        title="Draft this quote with AI from a meeting or call transcript (Teams, Zoom, a text file, or pasted)"
      >
        <Icon name="upload" size={size === 'lg' ? 14 : 12} />
        Import transcript
      </button>
      {open && createPortal(<ImportTranscriptDialog woNumber={woNumber} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function ImportTranscriptDialog({ woNumber, onClose }: { woNumber: string; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<WoCallContactRole>('tech');

  const parsed = useMemo(() => (text.trim() === '' ? [] : parseTranscriptFile(text)), [text]);
  const speakers = useMemo(() => new Set(parsed.map((l) => l.speaker)).size, [parsed]);

  const readFile = (file: File) => {
    setFileError(null);
    if (file.size > MAX_FILE_BYTES) {
      setFileError('That file is too large to be a transcript (2 MB at most).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ''));
      setFileName(file.name);
    };
    reader.onerror = () => setFileError('Could not read that file.');
    reader.readAsText(file);
  };

  const mutation = useMutation({
    mutationFn: () =>
      importWoTranscript(woNumber, {
        text,
        contact_name: name.trim() || null,
        contact_role: role,
        file_name: fileName,
      }),
    onSuccess: ({ call }) => {
      void qc.invalidateQueries({ queryKey: ['wo-calls'] });
      onClose();
      navigate(`/work-orders/${encodeURIComponent(woNumber)}/calls/${call.id}/quote`);
    },
  });

  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="importTrT"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="sheet call-sheet">
        <h2 className="sheet-t" id="importTrT">
          <Icon name="zap" size={18} />
          Draft the quote from a transcript
        </h2>
        <p className="sheet-b">
          Import the transcript of the conversation about this job — a Teams or Zoom meeting, a recorded
          site walk, a call from another phone. The AI drafts the quote from it; you review and adjust it,
          then <b>Submit quote</b> fills {woNumber}’s quote.
        </p>

        <div className="call-field">
          <span className="overline">Transcript</span>
          <div className="call-actions" style={{ marginTop: 0 }}>
            <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()}>
              <Icon name="upload" size={12} />
              {fileName ? 'Choose another file' : 'Choose a file'}
            </button>
            {fileName && <span className="chip chip-sm"><Icon name="file" size={12} />{fileName}</span>}
            <input
              ref={fileInput}
              type="file"
              accept={TRANSCRIPT_FILE_ACCEPT}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) readFile(f);
                e.target.value = '';
              }}
            />
          </div>
          <div className="call-paste" style={{ marginTop: 0 }}>
            <label className="lbl" htmlFor="import-tr-text">…or paste it</label>
            <textarea
              id="import-tr-text"
              className="fld"
              rows={8}
              value={text}
              placeholder={'Matt: What did you find?\nGulf Coast: The condenser fan motor is seized…'}
              onChange={(e) => {
                setText(e.target.value);
                if (fileName) setFileName(null);
              }}
            />
            <span className="hint">
              {parsed.length > 0
                ? `${parsed.length} ${parsed.length === 1 ? 'turn' : 'turns'} from ${speakers} ${speakers === 1 ? 'speaker' : 'speakers'}.`
                : '.txt, .vtt or .srt (Teams, Zoom and Meet exports), or one line per turn as “Name: what they said”.'}
            </span>
            {fileError && <span className="err"><Icon name="alert" size={12} />{fileError}</span>}
          </div>
        </div>

        <div className="call-other">
          <div className="field">
            <label className="lbl" htmlFor="import-tr-name">Conversation with</label>
            <input
              className="fld"
              id="import-tr-name"
              value={name}
              maxLength={200}
              placeholder="Optional"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="lbl" htmlFor="import-tr-role">They are the</label>
            <select className="fld" id="import-tr-role" value={role} onChange={(e) => setRole(e.target.value as WoCallContactRole)}>
              {(Object.keys(WO_CALL_CONTACT_LABELS) as WoCallContactRole[]).map((r) => (
                <option key={r} value={r}>{WO_CALL_CONTACT_LABELS[r]}</option>
              ))}
            </select>
          </div>
        </div>

        <p className="call-hint">
          <Icon name="info" size={12} />
          Nothing reaches the quote until you press Submit quote on the draft. The transcript is kept on
          the work order’s call log.
        </p>

        {mutation.isError && (
          <p className="snooze-err" role="alert">
            <Icon name="alert-circle" size={12} />
            {mutation.error instanceof ApiRequestError ? mutation.error.message : 'Could not import the transcript.'}
          </p>
        )}

        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={parsed.length === 0 || mutation.isPending}
            title={parsed.length === 0 ? 'Choose a file or paste the transcript' : undefined}
            onClick={() => mutation.mutate()}
          >
            <Icon name="zap" size={14} />
            {mutation.isPending ? 'Importing…' : 'Import and draft the quote'}
          </button>
        </div>
      </div>
    </div>
  );
}
