/* 0077 · Import transcript — draft a quote from a conversation held outside Quo,
 * or from a Quo call the person already had.
 *
 * The Call button drafts a quote from a call placed through Quo. A meeting on
 * Teams or Zoom, a site walk recorded on a phone, a call from a personal line
 * has no Quo call behind it, so this takes the transcript itself: a .txt,
 * .vtt or .srt file (read here in the browser) or the text pasted in. The
 * server stores it as a transcribed, number-less call and the AI quote draft
 * page opens on it and drafts straight away — review, adjust, Submit quote,
 * exactly as after a call.
 *
 * The second way ("From a Quo call"): a call that DID happen on the person's
 * Quo line but was not placed from the work order. They type the other
 * party's number; the API finds their line by the email they sign in with,
 * lists the recent calls with that number (date and time, so the right one
 * can be told apart when there were many), and on the pick fetches the
 * transcript from Quo. One Quo call is one row, however often it is picked. */

import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QUO_CALL_LOOKUP_DAYS, TRANSCRIPT_FILE_ACCEPT, WO_CALL_CONTACT_LABELS, parseTranscriptFile } from '@theone/shared';
import type { QuoCallOption, QuoCallsLookup, WoCallContactRole } from '@theone/shared';
import { ApiRequestError, importQuoCall, importWoTranscript, lookupQuoCalls } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { callDuration } from '../../lib/quo';
import { Icon } from '../Icon';

/** A transcript file larger than this is almost certainly not a transcript. */
const MAX_FILE_BYTES = 2_000_000;

type Mode = 'file' | 'quo';

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
        title="Draft this quote with AI from a meeting or call transcript (Teams, Zoom, a text file, pasted, or a call on your Quo line)"
      >
        <Icon name="upload" size={size === 'lg' ? 14 : 12} />
        Import transcript
      </button>
      {open && createPortal(<ImportTranscriptDialog woNumber={woNumber} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

/** 'Wed, Oct 21 · 3:42 PM' — the year added when it is not this year. The
    date AND the time, because the same number is often called many times. */
function callWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' as const }),
  });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

function ImportTranscriptDialog({ woNumber, onClose }: { woNumber: string; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>('file');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<WoCallContactRole>('tech');

  // From a Quo call
  const [phone, setPhone] = useState('');
  const [lookup, setLookup] = useState<QuoCallsLookup | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

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

  const openDraft = (callId: string) => {
    void qc.invalidateQueries({ queryKey: ['wo-calls'] });
    onClose();
    navigate(`/work-orders/${encodeURIComponent(woNumber)}/calls/${callId}/quote`);
  };

  const fileMutation = useMutation({
    mutationFn: () =>
      importWoTranscript(woNumber, {
        text,
        contact_name: name.trim() || null,
        contact_role: role,
        file_name: fileName,
      }),
    onSuccess: ({ call }) => openDraft(call.id),
  });

  const findMutation = useMutation({
    mutationFn: () => lookupQuoCalls(woNumber, phone),
    onSuccess: (res) => {
      setLookup(res);
      setPicked(null);
    },
  });

  const quoMutation = useMutation({
    mutationFn: () =>
      importQuoCall(woNumber, picked!, {
        phone: lookup?.phone ?? phone,
        contact_name: name.trim() || null,
        contact_role: role,
      }),
    onSuccess: ({ call }) => openDraft(call.id),
  });

  const pickable = (c: QuoCallOption) => c.answered && (c.already_on === null || c.already_on.same_work_order);
  const chosen = lookup?.calls.find((c) => c.quo_call_id === picked) ?? null;
  const multiLine = (lookup?.lines.length ?? 0) > 1;
  const pending = fileMutation.isPending || quoMutation.isPending;
  const error =
    mode === 'file'
      ? fileMutation.error
      : (quoMutation.error ?? findMutation.error);

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
          The AI drafts the quote from the conversation about this job; you review and adjust it,
          then <b>Submit quote</b> fills {woNumber}’s quote.
        </p>

        <div className="call-field">
          <span className="overline">Where is the conversation?</span>
          <div className="seg" role="group" aria-label="Where is the conversation">
            <button
              type="button"
              className={`seg-btn${mode === 'file' ? ' is-on' : ''}`}
              aria-pressed={mode === 'file'}
              onClick={() => setMode('file')}
            >
              <Icon name="upload" size={12} />
              Attach or paste
            </button>
            <button
              type="button"
              className={`seg-btn${mode === 'quo' ? ' is-on' : ''}`}
              aria-pressed={mode === 'quo'}
              onClick={() => setMode('quo')}
            >
              <Icon name="phone" size={12} />
              From a Quo call
            </button>
          </div>
        </div>

        {mode === 'file' ? (
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
        ) : (
          <div className="call-field">
            <span className="overline">Their number</span>
            <div className="call-actions" style={{ marginTop: 0 }}>
              <input
                className="fld"
                id="import-tr-phone"
                type="tel"
                inputMode="tel"
                value={phone}
                maxLength={40}
                placeholder="(409) 555-0143"
                aria-label="The number you spoke with"
                style={{ flex: 1 }}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && phone.trim() !== '' && !findMutation.isPending) {
                    e.preventDefault();
                    findMutation.mutate();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={phone.trim() === '' || findMutation.isPending}
                onClick={() => findMutation.mutate()}
              >
                <Icon name="search" size={12} />
                {findMutation.isPending ? 'Looking…' : 'Find calls'}
              </button>
            </div>
            <span className="hint">
              Your calls with that number over the last {QUO_CALL_LOOKUP_DAYS} days, from the Quo line that belongs to
              the email you signed in with.
            </span>

            {lookup && !lookup.configured && (
              <p className="call-hint" role="status">
                <Icon name="info" size={12} />
                {lookup.reason}
              </p>
            )}
            {lookup && lookup.configured && lookup.reason && (
              <p className="call-hint" role="status">
                <Icon name="info" size={12} />
                {lookup.reason}
              </p>
            )}
            {lookup && lookup.configured && !lookup.reason && lookup.calls.length === 0 && (
              <p className="call-hint" role="status">
                <Icon name="info" size={12} />
                No calls with <span className="mono">{lookup.phone}</span> on your line in the last {QUO_CALL_LOOKUP_DAYS} days.
              </p>
            )}
            {lookup && lookup.calls.length > 0 && (
              <div className="call-contacts" role="radiogroup" aria-label="Which call">
                {lookup.calls.map((c) => {
                  const ok = pickable(c);
                  const on = picked === c.quo_call_id;
                  return (
                    <label
                      key={c.quo_call_id}
                      className={`call-contact${on ? ' is-on' : ''}`}
                      style={ok ? undefined : { opacity: 0.55, cursor: 'not-allowed' }}
                    >
                      <input
                        type="radio"
                        name="quo-call"
                        checked={on}
                        disabled={!ok}
                        onChange={() => setPicked(c.quo_call_id)}
                      />
                      <span className="call-contact-main">
                        <b>{callWhen(c.created_at)}</b>
                        <span>
                          <Icon name={c.direction === 'incoming' ? 'phone-in' : 'phone-out'} size={12} />{' '}
                          {c.direction === 'incoming' ? 'They called' : 'You called'}
                          {c.answered && c.duration_seconds != null && (
                            <> · <span className="num">{callDuration(c.duration_seconds)}</span></>
                          )}
                          {multiLine && c.line.name && <> · {c.line.name}</>}
                        </span>
                      </span>
                      {!c.answered ? (
                        <span className="chip chip-sm">Not answered</span>
                      ) : c.already_on && !c.already_on.same_work_order ? (
                        <span className="chip chip-sm">On {c.already_on.wo_number}</span>
                      ) : c.already_on ? (
                        <span className="chip chip-accent chip-sm">Already on this work order</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

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

        {error && (
          <p className="snooze-err" role="alert">
            <Icon name="alert-circle" size={12} />
            {error instanceof ApiRequestError
              ? error.message
              : mode === 'file'
                ? 'Could not import the transcript.'
                : 'Could not reach Quo.'}
          </p>
        )}

        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {mode === 'file' ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={parsed.length === 0 || pending}
              title={parsed.length === 0 ? 'Choose a file or paste the transcript' : undefined}
              onClick={() => fileMutation.mutate()}
            >
              <Icon name="zap" size={14} />
              {fileMutation.isPending ? 'Importing…' : 'Import and draft the quote'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={chosen === null || pending}
              title={chosen === null ? 'Find your calls with the number and pick one' : undefined}
              onClick={() => quoMutation.mutate()}
            >
              <Icon name="zap" size={14} />
              {quoMutation.isPending
                ? 'Fetching the transcript…'
                : chosen?.already_on
                  ? 'Open its draft'
                  : 'Use this call and draft the quote'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
