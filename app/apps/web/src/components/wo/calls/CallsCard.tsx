/* 0054 · The call log on a work order (Messages tab): every call placed from
 * it through Quo, with Quo's summary and the transcript once they land, and
 * the way into the AI quote draft. Polls while a call is still waiting on
 * Quo, so a transcript appears without a refresh. */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CALL_PERM_KEY, WO_CALL_CONTACT_LABELS } from '@theone/shared';
import type { WoCall } from '@theone/shared';
import { ApiRequestError, listWoCalls, pasteCallTranscript } from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
import { feedTime } from '../../../lib/fields';
import { callDuration } from '../../../lib/quo';
import { Icon } from '../../Icon';

const PREVIEW_LINES = 3;

/** A call still waiting on Quo keeps the list polling. */
const waiting = (c: WoCall) => c.status === 'dialing' || c.status === 'completed';

export function CallsCard({ woId, woNumber }: { woId: string; woNumber: string }) {
  const { can } = useAuth();
  const allowed = can(CALL_PERM_KEY, 'view');
  const query = useQuery({
    queryKey: ['wo-calls', woId],
    queryFn: () => listWoCalls(woId),
    enabled: allowed,
    refetchInterval: (q) => (q.state.data?.calls.some(waiting) ? 15_000 : false),
  });
  if (!allowed) return null;
  const calls = query.data?.calls ?? [];

  return (
    <section className="card calls-card">
      <div className="card-head">
        <h2 className="card-title grow">Calls</h2>
        <span className="chip chip-sm">
          <Icon name="phone" size={12} />
          Through Quo
        </span>
      </div>
      {query.isLoading && <div className="empty-flat">Loading calls…</div>}
      {query.isError && <div className="empty-flat">Could not load the calls on this work order.</div>}
      {!query.isLoading && !query.isError && calls.length === 0 && (
        <div className="empty-flat">
          No calls yet. Use <b>Call</b> at the top of the work order to call the technician through
          Quo — the transcript lands here, and a quote can be drafted from it.
        </div>
      )}
      {calls.length > 0 && (
        <ul className="calls-list">
          {calls.map((c) => (
            <CallRow key={c.id} call={c} woId={woId} woNumber={woNumber} />
          ))}
        </ul>
      )}
    </section>
  );
}

const STATUS_TEXT: Record<WoCall['status'], string> = {
  dialing: 'Waiting for Quo',
  completed: 'Transcript on its way',
  missed: 'No answer',
  transcribed: 'Transcribed',
  expired: 'Quo never reported this call',
};

function CallRow({ call, woId, woNumber }: { call: WoCall; woId: string; woNumber: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');

  const paste = useMutation({
    mutationFn: () => pasteCallTranscript(woId, call.id, text),
    onSuccess: () => {
      setPasting(false);
      setText('');
      void qc.invalidateQueries({ queryKey: ['wo-calls', woId] });
    },
  });

  const lines = call.transcript ?? [];
  const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const hidden = Math.max(0, lines.length - PREVIEW_LINES);
  const canPaste = can(CALL_PERM_KEY, 'create') && call.transcript_source !== 'quo';
  const canDraft = can('quotes', 'edit') && lines.length > 0;
  const draftHref = `/work-orders/${encodeURIComponent(woNumber)}/calls/${call.id}/quote`;
  const who = call.contact_name ?? call.phone;

  return (
    <li className={`call-row${call.purpose === 'quote' ? ' is-quote' : ''}`}>
      <div className="call">
        <span className="call-ic" aria-hidden="true">
          <Icon name="phone-out" size={18} />
        </span>
        <div className="call-body">
          <div className="call-head">
            <span className="call-title">
              {who}
              {call.duration_seconds != null && (
                <>
                  {' '}<span className="sep-dot">·</span>{' '}
                  <span className="num">{callDuration(call.duration_seconds)}</span>
                </>
              )}
            </span>
            <span className="chip chip-sm">{WO_CALL_CONTACT_LABELS[call.contact_role]}</span>
            {call.purpose === 'quote' && (
              <span className="chip chip-accent chip-sm">
                <Icon name="zap" size={12} />
                For a quote
              </span>
            )}
            <span className={`call-state is-${call.status}`}>{STATUS_TEXT[call.status]}</span>
            <time className="msg-time" dateTime={call.created_at}>{feedTime(call.created_at)}</time>
          </div>
          <div className="call-meta">
            {call.placed_by.name} <Icon name="arrow-r" size={12} /> <span className="mono">{call.phone}</span>
            {call.transcript_source === 'pasted' && <span> · transcript pasted by hand</span>}
          </div>

          {call.summary && (call.summary.summary.length > 0 || call.summary.next_steps.length > 0) && (
            <div className="call-sum">
              <span className="chip chip-accent chip-sm"><Icon name="zap" size={12} />Quo summary</span>
              <ul className="call-sum-list">
                {call.summary.summary.map((s, i) => <li key={`s${i}`}>{s}</li>)}
                {call.summary.next_steps.map((s, i) => <li key={`n${i}`}><b>Next:</b> {s}</li>)}
              </ul>
            </div>
          )}

          {lines.length > 0 && (
            <div className="tr">
              {shown.map((l, i) => (
                <p className="tr-line" key={`${call.id}-${i}`}>
                  <span className="tr-who">{l.speaker}</span>
                  <span>{l.line}</span>
                </p>
              ))}
              {hidden > 0 && (
                <button type="button" className="tr-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                  {expanded ? 'Collapse transcript' : 'Expand transcript'}
                  <Icon name="chev-d" size={12} />
                  {!expanded && <span className="n">{hidden} more line{hidden === 1 ? '' : 's'}</span>}
                </button>
              )}
            </div>
          )}

          {pasting && (
            <div className="call-paste">
              <label className="lbl" htmlFor={`paste-${call.id}`}>Transcript</label>
              <textarea
                id={`paste-${call.id}`}
                className="fld"
                rows={6}
                autoFocus
                value={text}
                placeholder={'Matt: What did you find?\nGulf Coast: The condenser fan motor is seized…'}
                onChange={(e) => setText(e.target.value)}
              />
              <span className="hint">One line per turn, as “Name: what they said”. Copy it from the call in the Quo app.</span>
              {paste.isError && (
                <span className="err">
                  <Icon name="alert" size={12} />
                  {paste.error instanceof ApiRequestError ? paste.error.message : 'Could not save the transcript.'}
                </span>
              )}
              <div className="call-actions">
                <button type="button" className="btn btn-sm" onClick={() => setPasting(false)}>Cancel</button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={text.trim() === '' || paste.isPending}
                  onClick={() => paste.mutate()}
                >
                  {paste.isPending ? 'Saving…' : 'Save transcript'}
                </button>
              </div>
            </div>
          )}

          {!pasting && (
            <div className="call-actions">
              {canDraft && <DraftAction call={call} href={draftHref} woNumber={woNumber} />}
              {canPaste && lines.length === 0 && (
                <button type="button" className="btn btn-sm" onClick={() => setPasting(true)}>
                  <Icon name="pencil" size={12} />
                  Paste transcript
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function DraftAction({ call, href, woNumber }: { call: WoCall; href: string; woNumber: string }) {
  const d = call.draft;
  if (d?.status === 'submitted') {
    return (
      <Link className="btn btn-sm" to={`/work-orders/${encodeURIComponent(woNumber)}/quote`}>
        <Icon name="check-circle" size={12} />
        On the quote — open it
      </Link>
    );
  }
  if (d?.status === 'ready') {
    return (
      <Link className="btn btn-sm btn-primary" to={href}>
        <Icon name="file" size={12} />
        Review the AI quote
      </Link>
    );
  }
  return (
    <Link className={`btn btn-sm${call.purpose === 'quote' ? ' btn-primary' : ''}`} to={href}>
      <Icon name="zap" size={12} />
      {d?.status === 'discarded' ? 'Draft a quote again' : 'Draft a quote with AI'}
    </Link>
  );
}
