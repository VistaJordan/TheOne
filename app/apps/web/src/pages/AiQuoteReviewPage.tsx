/* /work-orders/:woNumber/calls/:callId/quote — the AI quote draft (0054).
 *
 * Claude read the call's transcript and drafted a quote in the builder's own
 * shape. This page shows the transcript beside the draft, lists what the AI
 * assumed and what it could not find out, and lets the reviewer adjust
 * anything with the builder's own editors. Edits autosave to the DRAFT; the
 * real quote is untouched until Submit quote, which fills it through the
 * ordinary builder save — the result is the same quote typing it in would
 * have produced, and the builder takes it from there (submit for approval…).
 *
 * Opening the page for a call with a transcript and no draft yet drafts it
 * straight away — "Call and draft a quote" promised exactly that. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WO_CALL_CONTACT_LABELS } from '@theone/shared';
import type { AiQuoteDraftResponse } from '@theone/shared';
import {
  ApiRequestError,
  discardAiQuoteDraft,
  generateAiQuoteDraft,
  getAiQuoteDraft,
  saveAiQuoteDraft,
  submitAiQuoteDraft,
} from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { LineItemsTable, AddLineButton } from '../components/quote/LineItemsTable';
import { OptionCard } from '../components/quote/OptionCard';
import { ScopeList } from '../components/quote/ScopeList';
import { useAuth } from '../auth/AuthProvider';
import type { DraftLine, DraftQuote, DraftSection } from '../lib/quoteDraft';
import { blankOption, fromDraftBody, removeAt, replaceAt, toDraftBody } from '../lib/quoteDraft';
import { quoteProblems, sumLines, usd } from '../lib/quoteTotals';
import { feedTime } from '../lib/fields';
import { callDuration } from '../lib/quo';

const AUTOSAVE_MS = 900;
/** The house OT multiplier; the quote applies its contract's own once submitted. */
const OT_MULT = 1.5;

export function AiQuoteReviewPage() {
  const { woNumber = '', callId = '' } = useParams<{ woNumber: string; callId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canEdit = can('quotes', 'edit');
  const key = ['ai-quote-draft', woNumber, callId] as const;

  const query = useQuery({
    queryKey: key,
    queryFn: () => getAiQuoteDraft(woNumber, callId),
    enabled: woNumber !== '' && callId !== '',
  });
  const data = query.data;
  const server = data?.draft ?? null;
  const editable = canEdit && server?.status === 'ready';

  // ── Local form, seeded when the draft's identity changes (a (re)draft) ────
  const [draft, setDraft] = useState<DraftQuote | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!server) return;
    const sig = `${server.id}:${server.created_at}:${server.status}`;
    if (seeded.current === sig) return;
    seeded.current = sig;
    setDraft(fromDraftBody(server.draft));
    setDirty(false);
  }, [server]);

  const setDraftResponse = (res: AiQuoteDraftResponse) => qc.setQueryData(key, res);

  // ── Generate ──────────────────────────────────────────────────────────────
  const generate = useMutation({
    mutationFn: () => generateAiQuoteDraft(woNumber, callId),
    onMutate: () => setError(null),
    onSuccess: (res) => {
      setDraftResponse(res);
      void qc.invalidateQueries({ queryKey: ['wo-calls'] });
    },
    onError: (err) => setError(errorText(err, 'The AI could not draft this quote.')),
  });
  // "Call and draft a quote" promised a draft: make it as soon as there is a
  // transcript to make it from. Once per page visit, never over an error.
  const autoTried = useRef(false);
  useEffect(() => {
    if (!data || autoTried.current) return;
    if (data.draft === null && data.ai_configured && canEdit && (data.call.transcript?.length ?? 0) > 0) {
      autoTried.current = true;
      generate.mutate();
    }
  }, [data, canEdit, generate]);

  // ── Autosave the reviewer's edits to the draft ────────────────────────────
  const save = useMutation({
    mutationFn: (d: DraftQuote) => saveAiQuoteDraft(woNumber, callId, toDraftBody(d)),
    onSuccess: () => setDirty(false),
  });
  useEffect(() => {
    if (!draft || !dirty || !editable) return;
    const t = window.setTimeout(() => save.mutate(draft), AUTOSAVE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty, editable]);

  const update = useCallback((next: DraftQuote) => {
    setDraft(next);
    setDirty(true);
  }, []);
  const setSection = useCallback((index: number, next: DraftSection) => {
    setDraft((cur) => (cur ? { ...cur, sections: replaceAt(cur.sections, index, next) } : cur));
    setDirty(true);
  }, []);

  // ── Submit / discard ──────────────────────────────────────────────────────
  const submit = useMutation({
    mutationFn: (replace: boolean) => submitAiQuoteDraft(woNumber, callId, toDraftBody(draft!), replace),
    onMutate: () => setError(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wo-quote', woNumber] });
      void qc.invalidateQueries({ queryKey: ['wo-calls'] });
      void qc.invalidateQueries({ queryKey: key });
      navigate(`/work-orders/${encodeURIComponent(woNumber)}/quote`);
    },
    onError: (err) => {
      const details = err instanceof ApiRequestError ? (err.details as { code?: string } | null) : null;
      if (details?.code === 'QUOTE_HAS_CONTENT') setConfirmReplace(true);
      else setError(errorText(err, 'Could not submit the quote.'));
    },
  });
  const discard = useMutation({
    mutationFn: () => discardAiQuoteDraft(woNumber, callId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wo-calls'] });
      navigate(`/work-orders/${encodeURIComponent(woNumber)}?tab=messages`);
    },
    onError: (err) => setError(errorText(err, 'Could not discard the draft.')),
  });

  const problems = useMemo(() => (draft ? quoteProblems(draft) : []), [draft]);

  // ── Chrome ────────────────────────────────────────────────────────────────
  const woHref = `/work-orders/${encodeURIComponent(woNumber)}`;
  const breadcrumb = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button type="button" className="crumb-back" aria-label={`Back to ${woNumber}`} onClick={() => navigate(`${woHref}?tab=messages`)}>
        <Icon name="arrow-l" size={14} />
      </button>
      <Link className="crumb" to="/">Work Orders</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <Link className="crumb is-id" to={woHref}>{woNumber}</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <span className="crumb-cur" aria-current="page">AI quote draft</span>
    </nav>
  );
  const shell = (children: ReactNode) => (
    <AppShell active="Work Orders" breadcrumb={breadcrumb}>
      <div className="canvas-inner qb aiq">{children}</div>
    </AppShell>
  );

  if (query.isLoading) return shell(<div className="wo-state"><b>Loading the call…</b></div>);
  if (query.isError || !data) {
    return shell(
      <div className="wo-state">
        <Icon name="alert" size={22} />
        <b>Could not load this call</b>
        <span>{errorText(query.error, 'Try again in a moment.')}</span>
        <Link className="btn" to={`${woHref}?tab=messages`}>Back to {woNumber}</Link>
      </div>,
    );
  }

  const call = data.call;
  const hasTranscript = (call.transcript?.length ?? 0) > 0;
  const quote = data.quote;
  const quoteLocked = quote !== null && quote.status !== 'draft' && quote.status !== 'pending_approval';

  // ── States before there is a draft to review ──────────────────────────────
  let blocker: ReactNode = null;
  if (!hasTranscript) {
    blocker = (
      <div className="wo-state">
        <Icon name="clock" size={22} />
        <b>No transcript yet</b>
        <span>
          Quo sends the transcript a minute or two after the call ends. If the call was made outside
          Quo’s webhook, paste the transcript onto the call in the call log.
        </span>
        <Link className="btn" to={`${woHref}?tab=messages`}>Open the call log</Link>
      </div>
    );
  } else if (!server && !data.ai_configured) {
    blocker = (
      <div className="wo-state">
        <Icon name="lock" size={22} />
        <b>AI drafting is not configured</b>
        <span>The server has no Claude API key (ANTHROPIC_API_KEY). Ask an admin to set it, then come back.</span>
      </div>
    );
  } else if (!server && !canEdit) {
    blocker = (
      <div className="wo-state">
        <Icon name="lock" size={22} />
        <b>Drafting a quote needs the Quotes edit permission</b>
      </div>
    );
  } else if (!server || generate.isPending) {
    blocker = generate.isPending ? (
      <div className="wo-state aiq-working">
        <span className="aiq-spinner" aria-hidden="true" />
        <b>Drafting the quote from the call…</b>
        <span>The AI is reading the transcript, the work order and its contract rates. This usually takes under a minute.</span>
      </div>
    ) : (
      <div className="wo-state">
        <Icon name="alert" size={22} />
        <b>No draft yet</b>
        {error && <span className="err"><Icon name="alert" size={12} />{error}</span>}
        <button type="button" className="btn btn-primary" onClick={() => generate.mutate()}>
          <Icon name="zap" size={14} />
          Draft the quote
        </button>
      </div>
    );
  }

  const transcriptCard = (
    <section className="card aiq-transcript">
      <div className="card-head">
        <h2 className="card-title grow">The call</h2>
        {call.duration_seconds != null && <span className="card-meta num">{callDuration(call.duration_seconds)}</span>}
      </div>
      <div className="card-pad">
        <p className="aiq-callmeta">
          {call.placed_by.name} <Icon name="arrow-r" size={12} /> <b>{call.contact_name ?? call.phone}</b>{' '}
          <span className="chip chip-sm">{WO_CALL_CONTACT_LABELS[call.contact_role]}</span>
          <br />
          <span className="hint">{feedTime(call.created_at)}{call.transcript_source === 'pasted' ? ' · pasted by hand' : ' · from Quo'}</span>
        </p>
        {call.summary && call.summary.summary.length > 0 && (
          <ul className="call-sum-list">
            {call.summary.summary.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        )}
        <div className="tr aiq-tr">
          {(call.transcript ?? []).map((l, i) => (
            <p className="tr-line" key={i}>
              <span className="tr-who">{l.speaker}</span>
              <span>{l.line}</span>
            </p>
          ))}
        </div>
      </div>
    </section>
  );

  if (blocker || !draft || !server) {
    return shell(
      <div className="q-grid">
        <div className="col-main">{blocker ?? <div className="wo-state"><b>Loading the draft…</b></div>}</div>
        <aside className="rail">{transcriptCard}</aside>
      </div>,
    );
  }

  // ── The draft ─────────────────────────────────────────────────────────────
  const incurred = draft.sections[0];
  const options = draft.sections.slice(1);
  const incurredTotals = sumLines(incurred.lines, OT_MULT);
  const submitted = server.status === 'submitted';
  const discarded = server.status === 'discarded';
  const busy = submit.isPending || discard.isPending || generate.isPending;

  return shell(
    <>
      <section className="card qhead">
        <div className="qhead-top">
          <div className="qhead-idline">
            <h1 className="q-title">AI quote draft</h1>
            <span className="q-wo"><span className="q-wo-v">{woNumber}</span></span>
            <span className="chip chip-accent chip-sm"><Icon name="zap" size={12} />From the call with {call.contact_name ?? call.phone}</span>
          </div>
          <div className="qhead-right">
            <span className="autosave">
              {editable ? (save.isPending ? 'Saving…' : dirty ? 'Unsaved edits' : 'Draft saved') : submitted ? 'Submitted' : discarded ? 'Discarded' : 'Read-only'}
            </span>
          </div>
        </div>

        <p className="dismiss-note">
          <Icon name="info" size={12} />
          Nothing here is on the work order’s quote yet. Adjust anything, then <b>Submit quote</b> fills the
          quote exactly as if you had typed it — you finish and send it from the quote builder.
        </p>

        <div className="actionbar">
          <span className="actor-note">
            Drafted by {server.model ?? 'the AI'} for {server.created_by.name} · {feedTime(server.created_at)}
          </span>
          <div className="ctas">
            {problems.length > 0 && editable && (
              <span className="chip chip-danger" title="These do not stop Submit quote, but they will stop Submit for approval in the builder">
                <Icon name="alert" size={12} />
                {problems.length} to fix before approval
              </span>
            )}
            {editable && (
              <>
                <button type="button" className="btn btn-lg" disabled={busy} onClick={() => discard.mutate()}>
                  <Icon name="trash" size={14} />
                  Discard
                </button>
                <button
                  type="button"
                  className="btn btn-lg"
                  disabled={busy}
                  title="Throw these edits away and draft again from the transcript"
                  onClick={() => generate.mutate()}
                >
                  <Icon name="refresh" size={14} />
                  Redraft
                </button>
                {quoteLocked ? (
                  <span className="tipwrap">
                    <button type="button" className="btn btn-lg btn-locked" aria-disabled="true" aria-describedby="aiqLock">
                      <Icon name="lock" size={14} />
                      Submit quote
                    </button>
                    <span className="tip tip-below" id="aiqLock" role="tooltip">
                      The quote is {quote!.status} — reject it back to draft in the builder first
                    </span>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-lg btn-primary"
                    disabled={busy}
                    onClick={() => (quote?.has_content ? setConfirmReplace(true) : submit.mutate(false))}
                  >
                    <Icon name="send" size={14} />
                    {submit.isPending ? 'Submitting…' : 'Submit quote'}
                  </button>
                )}
              </>
            )}
            {submitted && (
              <Link className="btn btn-lg btn-primary" to={`${woHref}/quote`}>
                <Icon name="file" size={14} />
                Open the quote
              </Link>
            )}
            {discarded && canEdit && (
              <button type="button" className="btn btn-lg btn-primary" disabled={busy} onClick={() => generate.mutate()}>
                <Icon name="zap" size={14} />
                Draft again
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="callout" style={{ marginTop: 12 }}>
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </div>
        )}

        {confirmReplace && (
          <div className="callout aiq-confirm" role="alertdialog" aria-labelledby="aiqReplaceT">
            <Icon name="alert" size={14} />
            <span id="aiqReplaceT">
              <b>{woNumber} already has a quote with line items or scope.</b> Submitting replaces its
              sections, scope lines, line items, specs and note to customer with this draft. Its number,
              sales tax and document fields stay. The previous version stays in the audit trail.
            </span>
            <div className="sheet-f">
              <button type="button" className="btn" onClick={() => setConfirmReplace(false)}>Keep the current quote</button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={submit.isPending}
                onClick={() => {
                  setConfirmReplace(false);
                  submit.mutate(true);
                }}
              >
                Replace it with this draft
              </button>
            </div>
          </div>
        )}
      </section>

      {(server.missing_info.length > 0 || server.assumptions.length > 0) && (
        <section className="card aiq-notes">
          {server.missing_info.length > 0 && (
            <div className="aiq-note is-missing">
              <h2 className="overline"><Icon name="alert" size={12} /> Check before submitting</h2>
              <ul>{server.missing_info.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
          {server.assumptions.length > 0 && (
            <div className="aiq-note">
              <h2 className="overline"><Icon name="info" size={12} /> What the AI assumed</h2>
              <ul>{server.assumptions.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
        </section>
      )}

      <div className="q-grid">
        <div className="col-main" onBlur={() => setShowErrors(true)}>
          <section className="card">
            <div className="card-head">
              <span className="sec-badge is-incurred">Incurred</span>
              <h2 className="card-title">Work already performed</h2>
              <span className="subtotal-chip push">Subtotal <b className="num">{usd(incurredTotals.total)}</b></span>
            </div>
            <div className="narr">
              <div className="field">
                <label className="lbl" htmlFor="inc-report">Tech reported that…</label>
                <textarea
                  className={`fld${showErrors && incurred.narrative.trim() === '' ? ' is-err' : ''}`}
                  id="inc-report"
                  rows={4}
                  value={incurred.narrative}
                  disabled={!editable}
                  onChange={(e) => setSection(0, { ...incurred, narrative: e.target.value })}
                />
              </div>
              <ScopeList
                sectionKey={incurred.key}
                lines={incurred.scope_lines}
                editable={editable}
                onChange={(scope_lines) => setSection(0, { ...incurred, scope_lines })}
              />
            </div>
            <LineItemsTable
              label="Incurred"
              lines={incurred.lines}
              editable={editable}
              showErrors={showErrors}
              otMultiplier={OT_MULT}
              onChange={(lines: DraftLine[]) => setSection(0, { ...incurred, lines })}
            />
            <div className="lt-foot">
              {editable && <AddLineButton lines={incurred.lines} onChange={(lines) => setSection(0, { ...incurred, lines })} />}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <span className="sec-badge is-proposed">Proposed</span>
              <h2 className="card-title">Options for the client</h2>
              <span className="sec-sub">{options.length} option{options.length === 1 ? '' : 's'}</span>
            </div>
            {options.length === 0 && (
              <div className="empty-flat">The AI proposed no repair — add an option if the call agreed one.</div>
            )}
            {options.map((opt, i) => (
              <OptionCard
                key={opt.key}
                section={opt}
                index={i}
                editable={editable}
                showErrors={showErrors}
                otMultiplier={OT_MULT}
                onChange={(next) => setSection(i + 1, next)}
                onRemove={() => update({ ...draft, sections: removeAt(draft.sections, i + 1) })}
              />
            ))}
            {editable && (
              <button type="button" className="addopt" onClick={() => update({ ...draft, sections: [...draft.sections, blankOption()] })}>
                <Icon name="plus" size={14} />
                Add option
              </button>
            )}
          </section>
        </div>

        <aside className="rail">
          <section className="card">
            <div className="card-head"><h2 className="card-title grow">Totals</h2></div>
            <div className="card-pad aiq-totals">
              <div><span>Incurred</span><b className="num">{usd(incurredTotals.total)}</b></div>
              {options.map((o, i) => (
                <div key={o.key}>
                  <span>Option {String.fromCharCode(65 + i)}</span>
                  <b className="num">{usd(sumLines(o.lines, OT_MULT).total)}</b>
                </div>
              ))}
              <span className="hint">Overtime at ×{OT_MULT} here; the quote applies its contract’s own multiplier.</span>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><h2 className="card-title grow">Specs</h2><span className="chip chip-outline chip-sm">Internal</span></div>
            <div className="card-pad">
              <textarea
                className="fld"
                rows={4}
                aria-label="Specs (internal)"
                value={draft.specs}
                disabled={!editable}
                onChange={(e) => update({ ...draft, specs: e.target.value })}
              />
            </div>
          </section>

          <section className="card">
            <div className="card-head"><h2 className="card-title grow">Note to customer</h2></div>
            <div className="card-pad">
              <textarea
                className="fld"
                rows={3}
                aria-label="Note to customer"
                value={draft.note_to_customer}
                disabled={!editable}
                onChange={(e) => update({ ...draft, note_to_customer: e.target.value })}
              />
            </div>
          </section>

          {transcriptCard}
        </aside>
      </div>
    </>,
  );
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message;
  return fallback;
}
