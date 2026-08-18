/* /work-orders/:woNumber/quote — the quote builder (Sprint 4).
   Ported from the approved comp, scratchpad/quote-comp.tpl.html.

   Three things the comp encodes that are easy to lose in a port:

   1. ROLE GATES ARE VISIBLE, NEVER HIDDEN (§3.5). A control the actor may not
      use renders locked, focusable and tooltipped — hiding it means nobody ever
      learns the action exists or who to ask.
   2. THE BLOCKED CTA EXPLAINS ITSELF (§3.3). The reason sits adjacent to the
      button, is what the button is aria-describedby, and clicking it jumps to
      the offending field.
   3. INVALID LINES ARE EXCLUDED, NOT ZEROED (§4). A half-typed line drops out of
      its subtotal and the footer says which — silently pricing it at $0 is how a
      quote goes out under-priced.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiRequestError,
  approveQuote,
  createWorkOrderQuote,
  getWorkOrder,
  getWorkOrderQuote,
  putWorkOrderQuote,
  rejectQuote,
  sendQuote,
  submitQuote,
} from '../api/client';
import type { Quote, QuotePermissions } from '../api/client';
import { AppShell } from '../components/AppShell';
import { CopyButton } from '../components/CopyButton';
import { Icon } from '../components/Icon';
import { LineItemsTable, AddLineButton } from '../components/quote/LineItemsTable';
import { MoneyRail } from '../components/quote/MoneyRail';
import { OptionCard } from '../components/quote/OptionCard';
import { QUOTE_STATUS, QuotePipeline, QuoteStatusPill } from '../components/quote/QuoteStatusPill';
import { ScopeList } from '../components/quote/ScopeList';
import { SummaryCard } from '../components/quote/SummaryCard';
import type { DraftLine, DraftQuote, DraftSection } from '../lib/quoteDraft';
import { blankOption, fromQuote, removeAt, replaceAt, toUpdateInput } from '../lib/quoteDraft';
import {
  computeQuoteTotals,
  excludedNote,
  problemChipText,
  quoteProblems,
  sumLines,
  usd,
} from '../lib/quoteTotals';
import { FIELD, field, str } from '../lib/fields';
import { deriveSite } from '../lib/woDerive';
import { useInvalidateObligations } from '../hooks/useObligations';

/** How long the form sits still before the draft is flushed (§3.9 autosave). */
const AUTOSAVE_MS = 900;

export function QuoteBuilderPage() {
  const { woNumber = '' } = useParams<{ woNumber: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invalidateObligations = useInvalidateObligations();

  const woQuery = useQuery({
    queryKey: ['work-orders', 'detail', woNumber],
    queryFn: () => getWorkOrder(woNumber),
    enabled: woNumber.length > 0,
  });

  const quoteKey = ['wo-quote', woNumber] as const;
  const quoteQuery = useQuery({
    queryKey: quoteKey,
    queryFn: () => getWorkOrderQuote(woNumber),
    enabled: woNumber.length > 0,
  });

  const quote = quoteQuery.data?.quote ?? null;
  const permissions: QuotePermissions | null =
    quote?.permissions ?? quoteQuery.data?.permissions ?? null;

  // ── Draft state ────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState<DraftQuote | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [leaveTo, setLeaveTo] = useState<string | null>(null);

  // Re-seed the form from the server only when the quote's IDENTITY changes —
  // its id, its status or its revision. An autosave round-trip changes none of
  // those, so nothing the operator is typing is ever clobbered by a response.
  const signature = quote ? `${quote.id}:${quote.status}:${quote.rev}` : null;
  const loadedSignature = useRef<string | null>(null);
  useEffect(() => {
    if (!quote || signature === loadedSignature.current) return;
    loadedSignature.current = signature;
    setDraft(fromQuote(quote));
    setDirty(false);
    // Seed the chip from the quote's own updated_at, so a saved quote does not
    // greet its author with "not saved yet".
    const t = Date.parse(quote.updated_at);
    setSavedAt(Number.isNaN(t) ? null : t);
  }, [quote, signature]);

  const status = quote?.status ?? 'draft';
  const canEdit = permissions?.can_edit ?? false;
  const canApprove = permissions?.can_approve ?? false;
  /** Edits stop once a quote is approved (§1) — approved/sent render read-only. */
  const editable = canEdit && (status === 'draft' || status === 'pending_approval');

  const totalCost = quote?.totals.total_cost ?? null;
  const nte = quote?.totals.nte ?? woQuery.data?.money?.nte ?? woQuery.data?.nte ?? null;

  const totals = useMemo(
    () => (draft ? computeQuoteTotals(draft, totalCost) : null),
    [draft, totalCost],
  );
  const problems = useMemo(() => (draft ? quoteProblems(draft) : []), [draft]);

  // ── Autosave ───────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: (next: DraftQuote) => putWorkOrderQuote(woNumber, toUpdateInput(next)),
    onSuccess: (res) => {
      // Keep the server's canonical numbers/summary, but do NOT let the response
      // re-seed the form (see loadedSignature above).
      loadedSignature.current = `${res.quote.id}:${res.quote.status}:${res.quote.rev}`;
      queryClient.setQueryData(quoteKey, { quote: res.quote, permissions });
      setSavedAt(Date.now());
      setDirty(false);
    },
    onError: (err) => setActionError(errorText(err, 'Could not save the draft.')),
  });

  const saveRef = useRef(saveMutation.mutate);
  saveRef.current = saveMutation.mutate;

  useEffect(() => {
    if (!draft || !editable || !dirty) return;
    const t = setTimeout(() => saveRef.current(draft), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [draft, editable, dirty]);

  const update = useCallback((next: DraftQuote) => {
    setDraft(next);
    setDirty(true);
  }, []);

  const setSection = useCallback(
    (index: number, next: DraftSection) => {
      setDraft((cur) => (cur ? { ...cur, sections: replaceAt(cur.sections, index, next) } : cur));
      setDirty(true);
    },
    [],
  );

  // ── Lifecycle actions ──────────────────────────────────────────────────────
  const runAction = (fn: () => Promise<{ quote: Quote }>) => {
    setActionError(null);
    return fn()
      .then((res) => {
        queryClient.setQueryData(quoteKey, { quote: res.quote, permissions });
        // A transition changes status (and reject bumps rev) → the effect above
        // re-seeds the form from the returned quote.
        void queryClient.invalidateQueries({ queryKey: ['work-orders', 'detail', woNumber] });
        // S5: submit starts quote_review_owed; approve/reject silences it; send
        // silences quote_owed. One re-read covers every transition.
        invalidateObligations();
      })
      .catch((err) => setActionError(errorText(err, 'The action failed.')));
  };

  const flushThen = async (fn: () => Promise<{ quote: Quote }>) => {
    if (draft && dirty) {
      try {
        await putWorkOrderQuote(woNumber, toUpdateInput(draft));
        setDirty(false);
        setSavedAt(Date.now());
      } catch (err) {
        setActionError(errorText(err, 'Could not save the draft before submitting.'));
        return;
      }
    }
    await runAction(fn);
  };

  const submitMutation = useMutation({ mutationFn: () => flushThen(() => submitQuote(woNumber)) });
  const approveMutation = useMutation({
    // The comp's single "Approve & Send to CMMS" CTA is two server transitions:
    // approve fills money.quote, send stamps sent_at and posts the client-visible
    // feed update. Approve first — if send fails the quote is still approved and
    // the CTA becomes "Send to CMMS".
    mutationFn: async () => {
      await flushThen(() => approveQuote(woNumber));
      await runAction(() => sendQuote(woNumber));
    },
  });
  const sendMutation = useMutation({ mutationFn: () => runAction(() => sendQuote(woNumber)) });
  const rejectMutation = useMutation({
    mutationFn: () => runAction(() => rejectQuote(woNumber, rejectNote.trim())),
    onSuccess: () => {
      setRejectOpen(false);
      setRejectNote('');
    },
  });
  const createMutation = useMutation({
    mutationFn: () => createWorkOrderQuote(woNumber),
    onSuccess: (res) => queryClient.setQueryData(quoteKey, { quote: res.quote, permissions }),
    onError: (err) => setActionError(errorText(err, 'Could not create the quote.')),
  });

  // ── Chrome ─────────────────────────────────────────────────────────────────
  const guard = (to: string) => (e: { preventDefault: () => void }) => {
    // §3.9 — anything typed since the last flush is not on the quote yet.
    if (dirty) {
      e.preventDefault();
      setLeaveTo(to);
    }
  };

  const woHref = `/work-orders/${encodeURIComponent(woNumber)}`;
  const breadcrumb = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button
        type="button"
        className="crumb-back"
        aria-label={`Back to ${woNumber}`}
        onClick={(e) => {
          if (dirty) guard(woHref)(e);
          else navigate(woHref);
        }}
      >
        <Icon name="arrow-l" size={14} />
      </button>
      <Link className="crumb" to="/" onClick={guard('/')}>Work Orders</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <Link className="crumb is-id" to={woHref} onClick={guard(woHref)}>{woNumber}</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <span className="crumb-cur" aria-current="page">Quote</span>
    </nav>
  );

  const shell = (children: ReactNode) => (
    <AppShell active="Work Orders" breadcrumb={breadcrumb}>
      <div className="canvas-inner qb">{children}</div>
      {leaveTo && (
        <DismissSheet
          onStay={() => setLeaveTo(null)}
          onLeave={() => {
            setLeaveTo(null);
            navigate(leaveTo);
          }}
        />
      )}
    </AppShell>
  );

  if (quoteQuery.isLoading || woQuery.isLoading) {
    return shell(<div className="wo-state"><b>Loading the quote for {woNumber}…</b></div>);
  }

  if (quoteQuery.isError) {
    return shell(
      <div className="wo-state">
        <Icon name="alert" size={22} />
        <b>Could not load this quote</b>
        <span>{errorText(quoteQuery.error, 'Is the API running on :5174?')}</span>
        <Link className="btn" to={woHref}>Back to {woNumber}</Link>
      </div>,
    );
  }

  // ── No quote yet ───────────────────────────────────────────────────────────
  if (!quote || !draft || !totals) {
    return shell(
      <div className="wo-state">
        <Icon name="file" size={22} />
        <b>No quote on {woNumber} yet</b>
        <span>
          A quote opens with the INCURRED section — the work already performed — and one proposed
          option.
        </span>
        {actionError && <span className="err"><Icon name="alert" size={12} />{actionError}</span>}
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          <Icon name="plus" size={14} />
          {createMutation.isPending ? 'Creating…' : 'Create quote'}
        </button>
      </div>,
    );
  }

  const wo = woQuery.data;
  const site = wo ? deriveSite(wo) : null;
  const fields = wo?.fields ?? {};
  const incurred = draft.sections[0];
  const options = draft.sections.slice(1);
  const incurredTotals = sumLines(incurred.lines);
  const incurredNote = excludedNote(incurredTotals.excluded);
  const includedCount = options.filter((o) => o.include_in_summary).length;

  const blocked = problems.length > 0;
  const busy =
    submitMutation.isPending || approveMutation.isPending || sendMutation.isPending || rejectMutation.isPending;

  const focusFirstProblem = () => {
    setShowErrors(true);
    const first = problems[0];
    if (!first) return;
    window.requestAnimationFrame(() => {
      const el = document.getElementById(first.fieldId);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (el as HTMLElement | null)?.focus();
    });
  };

  /** Every primary CTA is blocked-until-valid the same way (§3.3): aria-disabled,
      never `disabled`, so the button stays reachable and announces its reason. */
  const primary = (label: string, icon: 'send' | 'check', run: () => void) => (
    <button
      type="button"
      className={`btn btn-lg btn-primary${busy ? ' is-busy' : ''}`}
      aria-disabled={blocked || busy ? true : undefined}
      aria-describedby={blocked ? 'errChip' : undefined}
      onClick={() => (blocked ? focusFirstProblem() : run())}
    >
      <Icon name={icon} size={14} className="btn-ic" />
      <span className="spin" aria-hidden="true" />
      <span className="btn-txt">{label}</span>
    </button>
  );

  const lockedButton = (label: string, tip: string, tipId: string) => (
    <span className="tipwrap">
      <button
        type="button"
        className="btn btn-lg btn-locked"
        tabIndex={0}
        aria-disabled="true"
        aria-describedby={tipId}
      >
        <Icon name="lock" size={14} />
        {label}
      </button>
      <span className="tip tip-below" id={tipId} role="tooltip">
        <Icon name="lock" size={12} />
        {tip}
      </span>
    </span>
  );

  return shell(
    <>
      {/* ══ Header band ══════════════════════════════════════════════════ */}
      <section className="card qhead">
        <div className="qhead-top">
          <div className="qhead-idline">
            <h1 className="q-title">Quote</h1>
            <span className="q-wo">
              <span className="q-wo-v">{quote.wo_number}</span>
              <CopyButton value={quote.wo_number} label="Copy work order number" size={12} />
            </span>
            {wo?.ext_name && (
              <span className="extref">
                <span className="extref-k">TaskId</span>
                <span className="extref-v">{wo.ext_name}</span>
              </span>
            )}
            <span className="chip chip-sm">Rev {quote.rev}</span>
          </div>
          <div className="qhead-right">
            <AutosaveChip
              editable={editable}
              saving={saveMutation.isPending}
              dirty={dirty}
              savedAt={savedAt}
              failed={saveMutation.isError}
            />
            <QuoteStatusPill status={status} />
          </div>
        </div>

        {editable && (
          <p className="dismiss-note">
            <Icon name="info" size={12} />
            Every edit autosaves to the draft. Leaving this screen with unsaved edits asks you to
            confirm first.
          </p>
        )}

        <QuotePipeline status={status} />

        <div className="actionbar">
          <span className="actor-note">
            {editable
              ? 'You can build and revise this quote.'
              : canEdit
                ? `This quote is ${QUOTE_STATUS[status].label.toLowerCase()} — its line items are read-only.`
                : 'You can read this quote. Building and revising it is Senior OM and above.'}
          </span>

          <div className="ctas">
            {blocked && (status === 'draft' || status === 'pending_approval') && (
              <button type="button" className="chip chip-danger" id="errChip" onClick={focusFirstProblem}>
                <Icon name="alert" size={12} />
                {problemChipText(problems.length)}
              </button>
            )}

            {status === 'draft' && (
              <>
                {!canApprove && lockedButton('Approve & Send to CMMS', 'Requires ATL or above', 'lockTipApprove')}
                {canEdit
                  ? primary('Submit for approval', 'send', () => submitMutation.mutate())
                  : lockedButton('Submit for approval', 'Requires Senior OM or above', 'lockTipSubmit')}
              </>
            )}

            {status === 'pending_approval' && (
              <>
                {canApprove ? (
                  <>
                    <button type="button" className="btn btn-lg btn-danger" onClick={() => setRejectOpen(true)}>
                      <Icon name="x" size={14} />
                      Reject with note
                    </button>
                    {primary('Approve & Send to CMMS', 'check', () => approveMutation.mutate())}
                  </>
                ) : (
                  lockedButton('Approve & Send to CMMS', 'Requires ATL or above', 'lockTipApprove')
                )}
              </>
            )}

            {status === 'approved' &&
              (canApprove
                ? primary('Send to CMMS', 'send', () => sendMutation.mutate())
                : lockedButton('Send to CMMS', 'Requires ATL or above', 'lockTipSend'))}

            {status === 'sent' && (
              <span className="chip chip-accent">
                <Icon name="check-circle" size={12} />
                Sent to the client&rsquo;s CMMS
              </span>
            )}
          </div>
        </div>

        {actionError && (
          <div className="callout" style={{ marginTop: 12 }}>
            <Icon name="alert" size={14} />
            <span>{actionError}</span>
          </div>
        )}

        {status === 'draft' && !canApprove && (
          <div className="callout callout-lock">
            <Icon name="lock" size={14} />
            <span>
              <b>Requires ATL or above.</b> Dispatchers build and revise quotes; approving and
              pushing the summary to the client&rsquo;s CMMS is reserved for ATL, TL, AM and admin.
              Submit for approval and an ATL picks it up — the control stays visible so you always
              know it exists.
            </span>
          </div>
        )}
        {status === 'pending_approval' && canApprove && (
          <div className="callout">
            <Icon name="check-circle" size={14} />
            <span>
              <b>You can approve this quote.</b> Approving fills <span className="mono">money.quote</span>{' '}
              on {quote.wo_number}, writes the state change to the activity log and queues the summary
              text for the client&rsquo;s CMMS. Rejecting returns it to <b>Draft</b> with your note
              attached.
            </span>
          </div>
        )}

        {rejectOpen && (
          <div className="callout" style={{ marginTop: 12, flexDirection: 'column', alignItems: 'stretch' }}>
            <div className="field">
              <label className="lbl" htmlFor="reject-note">
                Why is this going back to draft? <span className="req" aria-hidden="true">*</span>
              </label>
              <textarea
                className="fld"
                id="reject-note"
                rows={3}
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
              />
              <span className="hint">
                Posted as an internal comment on {quote.wo_number} — feedback for the dispatcher,
                never for the client.
              </span>
            </div>
            <div className="sheet-f">
              <button type="button" className="btn" onClick={() => setRejectOpen(false)}>Cancel</button>
              <button
                type="button"
                className="btn btn-danger"
                aria-disabled={rejectNote.trim() === '' ? true : undefined}
                onClick={() => rejectNote.trim() !== '' && rejectMutation.mutate()}
              >
                Reject with note
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ══ Work order context (read-only) ═══════════════════════════════ */}
      <section className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <h2 className="card-title grow">Work order context</h2>
          <span className="chip chip-outline chip-sm">
            <Icon name="lock" size={12} />
            Read-only
          </span>
          <Link className="chip chip-sm" to={woHref} onClick={guard(woHref)} style={{ textDecoration: 'none' }}>
            <Icon name="ext" size={12} />
            Open {quote.wo_number}
          </Link>
        </div>
        <div className="ctx">
          <CtxCell k="Work order" v={quote.wo_number} sub={wo?.title ?? null} mono />
          <CtxCell k="Comp · billing entity" v={wo?.billing_entity ?? str(field(fields, FIELD.comp))} />
          <CtxCell
            k="FM company"
            v={wo?.client ?? site?.fm ?? null}
            sub={site?.fm && site.fm !== wo?.client ? site.fm : null}
          />
          <CtxCell k="Location" v={site?.name ?? null} sub={site?.addressLines.join(', ') ?? null} />
          <CtxCell k="Trade" v={wo?.trade ?? null} />
          <CtxCell k="External TaskId" v={wo?.ext_name ?? null} sub="Client CMMS reference" mono />
        </div>
      </section>

      <div className="q-grid">
        {/* ══ Main column ═══════════════════════════════════════════════ */}
        {/* §3.2 validate-on-blur: inline errors stay quiet while a field is
            being filled in for the first time and light up once focus leaves
            anything in the form (or once a blocked CTA is pressed). */}
        <div className="col-main" onBlur={() => setShowErrors(true)}>
          {/* ── INCURRED ── */}
          <section className="card">
            <div className="card-head">
              <span className="sec-badge is-incurred">Incurred</span>
              <h2 className="card-title">Work already performed</h2>
              <span className="sec-sub">
                {incurred.lines.length} line{incurred.lines.length === 1 ? '' : 's'}
              </span>
              <span className="subtotal-chip push">
                Subtotal <b className="num">{usd(incurredTotals.total)}</b>
              </span>
            </div>

            <div className="narr">
              <div className="field">
                <label className="lbl" htmlFor="inc-report">
                  Tech reported that… <span className="req" aria-hidden="true">*</span>
                  <span className="sr">required</span>
                </label>
                <textarea
                  className={`fld${showErrors && incurred.narrative.trim() === '' ? ' is-err' : ''}`}
                  id="inc-report"
                  rows={5}
                  value={incurred.narrative}
                  disabled={!editable}
                  onChange={(e) => setSection(0, { ...incurred, narrative: e.target.value })}
                />
                {showErrors && incurred.narrative.trim() === '' && (
                  <span className="err"><Icon name="alert" size={12} />Tech report is required</span>
                )}
                <span className="hint">
                  Goes to the client verbatim as the first paragraph of the summary.
                </span>
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
              onChange={(lines: DraftLine[]) => setSection(0, { ...incurred, lines })}
            />

            <div className="lt-foot">
              {editable && (
                <AddLineButton
                  lines={incurred.lines}
                  onChange={(lines) => setSection(0, { ...incurred, lines })}
                />
              )}
              <span className="lt-note">
                <Icon name={incurredNote ? 'alert' : 'info'} size={12} />
                {incurredNote ?? 'Amount is computed (qty × rate, ×1.5 when OT) and read-only.'}
              </span>
              <span className="subtotal-chip" style={{ marginLeft: 'auto' }}>
                Incurred subtotal <b className="num">{usd(incurredTotals.total)}</b>
              </span>
            </div>
          </section>

          {/* ── PROPOSED ── */}
          <section className="card">
            <div className="card-head">
              <span className="sec-badge is-proposed">Proposed</span>
              <h2 className="card-title">Options for the client</h2>
              <span className="sec-sub">
                {options.length} option{options.length === 1 ? '' : 's'} · {includedCount} included in
                summary
              </span>
              {/* Migration 0003 has no column for this yet, so it is shown as the
                  house "later sprint" control rather than a toggle that would
                  silently forget itself on reload. */}
              <label className="sw push" title="Coming in a later sprint">
                <input type="checkbox" checked={draft.separate_quotes} disabled readOnly />
                <span className="sw-track" aria-hidden="true" />
                <span>Show all options as separate quotes</span>
                <span className="sw-state">Off</span>
              </label>
            </div>

            {options.length === 0 && (
              <div className="empty-flat">
                No proposed options yet — the client sees nothing to approve until one is added.
              </div>
            )}

            {options.map((opt, i) => (
              <OptionCard
                key={opt.key}
                section={opt}
                index={i}
                editable={editable}
                showErrors={showErrors}
                onChange={(next) => setSection(i + 1, next)}
                onRemove={() =>
                  update({ ...draft, sections: removeAt(draft.sections, i + 1) })
                }
              />
            ))}

            {editable && (
              <button
                type="button"
                className="addopt"
                onClick={() => update({ ...draft, sections: [...draft.sections, blankOption()] })}
              >
                <Icon name="plus" size={14} />
                Add option
                <span className="hint" style={{ marginLeft: 'auto', fontWeight: 400 }}>
                  Option B, C… each gets its own narrative, lines and include-in-summary toggle
                </span>
              </button>
            )}
          </section>
        </div>

        {/* ══ Right rail ════════════════════════════════════════════════ */}
        <aside className="rail">
          <MoneyRail
            totals={totals}
            nte={nte}
            salesTax={draft.sales_tax}
            editable={editable}
            comp={wo?.billing_entity ?? null}
            onSalesTaxChange={(sales_tax) => update({ ...draft, sales_tax })}
          />

          <section className="card">
            <div className="card-head">
              <h2 className="card-title grow">Specs</h2>
              <span className="card-meta">Internal</span>
            </div>
            <div className="card-pad">
              <div className="field">
                <label className="lbl" htmlFor="specs">
                  Equipment &amp; part specs <span className="opt">optional</span>
                </label>
                <textarea
                  className="fld"
                  id="specs"
                  rows={4}
                  value={draft.specs}
                  disabled={!editable}
                  onChange={(e) => update({ ...draft, specs: e.target.value })}
                />
                <span className="hint">
                  Not sent to the client — kept for the tech and for warranty claims.
                </span>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title grow">Note to Customer</h2>
              <span className="chip chip-sm chip-accent">
                <Icon name="globe" size={12} />
                Client-visible
              </span>
            </div>
            <div className="card-pad">
              <div className="field">
                <label className="lbl" htmlFor="note-to-customer">
                  Message appended to the summary <span className="opt">optional</span>
                </label>
                <textarea
                  className="fld"
                  id="note-to-customer"
                  rows={3}
                  value={draft.note_to_customer}
                  disabled={!editable}
                  onChange={(e) => update({ ...draft, note_to_customer: e.target.value })}
                />
                <span className="hint">Appears under the totals in the text your client sees.</span>
              </div>
            </div>
          </section>

          <SummaryCard
            auto={quote.summary.auto}
            pinned={draft.summary_pinned}
            grandTotal={totals.grandTotal}
            editable={editable}
            onPinnedChange={(summary_pinned) => update({ ...draft, summary_pinned })}
          />
        </aside>
      </div>
    </>,
  );
}

// ── Small local pieces ───────────────────────────────────────────────────────

function CtxCell({ k, v, sub, mono }: { k: string; v: string | null; sub?: string | null; mono?: boolean }) {
  return (
    <div className="ctx-cell">
      <span className="ctx-k">{k}</span>
      <span className={`ctx-v${mono ? ' mono' : ''}`}>{v ?? '—'}</span>
      {sub && <span className="ctx-v sub">{sub}</span>}
    </div>
  );
}

function AutosaveChip({
  editable,
  saving,
  dirty,
  savedAt,
  failed,
}: {
  editable: boolean;
  saving: boolean;
  dirty: boolean;
  savedAt: number | null;
  failed: boolean;
}) {
  // Re-render on a slow tick so "just now" ages into "2m ago" on its own.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!editable) return null;
  if (failed) {
    return (
      <span className="autosave" style={{ color: 'var(--danger)' }}>
        <Icon name="alert" size={12} />
        Draft not saved
      </span>
    );
  }
  if (saving) {
    return (
      <span className="autosave">
        <Icon name="refresh" size={12} />
        Saving…
      </span>
    );
  }
  if (dirty || savedAt == null) {
    return (
      <span className="autosave">
        <Icon name="clock" size={12} />
        {savedAt == null ? 'Not saved yet' : 'Unsaved edits'}
      </span>
    );
  }
  return (
    <span className="autosave">
      <Icon name="check-circle" size={12} />
      Draft saved · {ago(savedAt)}
    </span>
  );
}

function ago(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
}

function DismissSheet({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="dismissT" aria-describedby="dismissB">
      <div className="sheet">
        <h2 className="sheet-t" id="dismissT">
          <Icon name="alert" size={18} />
          You have unsaved edits to this quote
        </h2>
        <p className="sheet-b" id="dismissB">
          The draft autosaves a moment after you stop typing, but anything typed since then is not on
          the quote yet. Leaving now discards it.
        </p>
        <div className="sheet-f">
          <button type="button" className="btn btn-danger" onClick={onLeave}>Discard &amp; leave</button>
          <button type="button" className="btn btn-primary" onClick={onStay} autoFocus>Keep editing</button>
        </div>
      </div>
    </div>
  );
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'FORBIDDEN') {
      return `${err.message} — your role does not allow this action.`;
    }
    return err.message;
  }
  return fallback;
}
