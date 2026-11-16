/* 0145 · Quote templates (Elise, 2026-11-16).
 *
 * The Templates button on the quote builder opens one dialog with two tabs:
 *
 *   Use a template   — the viewer's own templates and every shared one, the
 *                      ones written for this work order's trade first. Use
 *                      replaces what is being typed (asked first when the quote
 *                      already has lines) through `applyTemplate`; the
 *                      autosave then saves it like any other edit.
 *   Save this quote  — the sections being typed (never an earlier round or
 *                      approved incurred work), the specs and the note, under a
 *                      name. Private to whoever saved it; a quote approver may
 *                      tick "Share with everyone".
 *
 * A template's owner (or a quote approver, for a shared one) may share /
 * stop sharing and delete it from its row. Every write is audited by the API.
 */

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  QUOTE_TEMPLATE_DESCRIPTION_MAX,
  QUOTE_TEMPLATE_NAME_MAX,
  quoteTemplateHasContent,
  quoteTemplateSummary,
  type QuoteDraftBody,
  type QuoteTemplate,
  type QuoteTemplatesResponse,
} from '@theone/shared';
import { deleteQuoteTemplate, listQuoteTemplates, saveQuoteTemplate, updateQuoteTemplate } from '../../api/client';
import { Icon } from '../Icon';

const KEY = ['quote-templates'] as const;

type Tab = 'use' | 'save';

export function QuoteTemplatesButton({
  content,
  trade,
  hasContent,
  onApply,
}: {
  /** What Save would keep: the sections being typed, the specs, the note. */
  content: QuoteDraftBody;
  /** The work order's trade: pre-fills Save, puts matching templates first. */
  trade: string | null;
  /** The quote already has lines or scope typed: Use asks before replacing. */
  hasContent: boolean;
  onApply: (body: QuoteDraftBody) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen(true)}
        title="Start this quote from a saved template, or save this quote as a template"
      >
        <Icon name="copy" size={12} />
        Templates
      </button>
      {open &&
        createPortal(
          <TemplatesDialog
            content={content}
            trade={trade}
            hasContent={hasContent}
            onApply={(body) => {
              onApply(body);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}

function TemplatesDialog({
  content,
  trade,
  hasContent,
  onApply,
  onClose,
}: {
  content: QuoteDraftBody;
  trade: string | null;
  hasContent: boolean;
  onApply: (body: QuoteDraftBody) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('use');
  const q = useQuery({ queryKey: KEY, queryFn: listQuoteTemplates, retry: 0 });
  const setList = (data: QuoteTemplatesResponse) => qc.setQueryData(KEY, data);

  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qtplT"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="sheet qtpl-sheet">
        <h2 className="sheet-t" id="qtplT">
          <Icon name="copy" size={18} />
          Quote templates
        </h2>
        <div className="seg qtpl-tabs" role="tablist" aria-label="Templates">
          <button type="button" role="tab" aria-selected={tab === 'use'} className={`seg-btn${tab === 'use' ? ' is-on' : ''}`} onClick={() => setTab('use')}>
            Use a template
          </button>
          <button type="button" role="tab" aria-selected={tab === 'save'} className={`seg-btn${tab === 'save' ? ' is-on' : ''}`} onClick={() => setTab('save')}>
            Save this quote
          </button>
        </div>

        {tab === 'use' ? (
          <UseTab
            data={q.data}
            loading={q.isLoading}
            error={q.error}
            trade={trade}
            hasContent={hasContent}
            onApply={onApply}
            onList={setList}
          />
        ) : (
          <SaveTab
            content={content}
            trade={trade}
            canShare={q.data?.can_share ?? false}
            onSaved={(data) => {
              setList(data);
              setTab('use');
            }}
          />
        )}

        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

type Filter = 'all' | 'mine' | 'shared';

function UseTab({
  data,
  loading,
  error,
  trade,
  hasContent,
  onApply,
  onList,
}: {
  data: QuoteTemplatesResponse | undefined;
  loading: boolean;
  error: unknown;
  trade: string | null;
  hasContent: boolean;
  onApply: (body: QuoteDraftBody) => void;
  onList: (data: QuoteTemplatesResponse) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [confirm, setConfirm] = useState<QuoteTemplate | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const share = useMutation({
    mutationFn: (t: QuoteTemplate) => updateQuoteTemplate(t.id, { shared: !t.shared }),
    onSuccess: (d) => {
      setErr(null);
      onList(d);
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'That change was not saved'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteQuoteTemplate(id),
    onSuccess: (d) => {
      setErr(null);
      setDeleting(null);
      onList(d);
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'That template was not deleted'),
  });

  const tradeKey = (trade ?? '').trim().toLowerCase();
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data?.templates ?? [])
      .filter((t) => (filter === 'mine' ? t.mine : filter === 'shared' ? t.shared : true))
      .filter((t) =>
        needle === ''
          ? true
          : [t.name, t.description ?? '', t.trade ?? '', t.owner ?? ''].some((s) => s.toLowerCase().includes(needle)),
      )
      .map((t) => ({ t, same: tradeKey !== '' && (t.trade ?? '').trim().toLowerCase() === tradeKey }))
      .sort((a, b) => Number(b.same) - Number(a.same));
  }, [data, filter, search, tradeKey]);

  const use = (t: QuoteTemplate) => {
    if (hasContent) setConfirm(t);
    else onApply(t.content);
  };

  if (confirm) {
    return (
      <div className="qtpl-confirm">
        <p className="sheet-b">
          <b>{confirm.name}</b> replaces the lines, options and scope lines you have typed on this quote
          (earlier rounds and approved work stay). The sales tax and bill-to / ship-to are kept.
        </p>
        <div className="qtpl-row-acts">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onApply(confirm.content)} autoFocus>
            Use this template
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setConfirm(null)}>
            Keep my quote
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="qtpl-use">
      <div className="qtpl-tools">
        <input
          className="fld"
          type="search"
          placeholder="Search templates…"
          aria-label="Search templates"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="seg" role="group" aria-label="Which templates">
          {(['all', 'mine', 'shared'] as const).map((f) => (
            <button key={f} type="button" className={`seg-btn${filter === f ? ' is-on' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'mine' ? 'Mine' : 'Shared'}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <p className="snooze-err" role="alert">
          <Icon name="alert" size={12} /> {err}
        </p>
      )}
      {loading && <p className="hint">Loading templates…</p>}
      {error != null && (
        <p className="snooze-err" role="alert">
          <Icon name="alert" size={12} /> {error instanceof Error ? error.message : 'The templates could not be loaded'}
        </p>
      )}
      {data && rows.length === 0 && (
        <p className="hint qtpl-empty">
          {data.templates.length === 0
            ? 'No templates yet. Build a quote, then save it from the “Save this quote” tab.'
            : 'No template matches.'}
        </p>
      )}

      <ul className="qtpl-list">
        {rows.map(({ t, same }) => (
          <li key={t.id} className="qtpl-row">
            <div className="qtpl-main">
              <div className="qtpl-name">
                <b>{t.name}</b>
                {t.shared ? <span className="chip chip-accent chip-sm">Shared</span> : <span className="chip chip-sm">Only you</span>}
                {same && <span className="chip chip-outline chip-sm">Same trade</span>}
              </div>
              <div className="qtpl-meta">
                {[t.trade, quoteTemplateSummary(t.content), t.mine ? 'saved by you' : t.owner ? `by ${t.owner}` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {t.description && <div className="qtpl-desc">{t.description}</div>}
            </div>
            <div className="qtpl-row-acts">
              {deleting === t.id ? (
                <>
                  <span className="hint">Delete it?</span>
                  <button type="button" className="btn btn-danger btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(t.id)}>
                    Delete
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setDeleting(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => use(t)}>
                    Use
                  </button>
                  {t.can_manage && data?.can_share && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={share.isPending}
                      onClick={() => share.mutate(t)}
                      title={t.shared ? 'Only the person who saved it will see it' : 'Everyone who builds quotes will see it'}
                    >
                      {t.shared ? 'Stop sharing' : 'Share with everyone'}
                    </button>
                  )}
                  {t.can_manage && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeleting(t.id)} aria-label={`Delete ${t.name}`}>
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SaveTab({
  content,
  trade,
  canShare,
  onSaved,
}: {
  content: QuoteDraftBody;
  trade: string | null;
  canShare: boolean;
  onSaved: (data: QuoteTemplatesResponse) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tradeValue, setTradeValue] = useState(trade ?? '');
  const [shared, setShared] = useState(false);
  const filled = quoteTemplateHasContent(content);
  const save = useMutation({
    mutationFn: () =>
      saveQuoteTemplate({
        name: name.trim(),
        description: description.trim() || null,
        trade: tradeValue.trim() || null,
        shared: canShare && shared,
        content,
      }),
    onSuccess: onSaved,
  });

  return (
    <div className="qtpl-save">
      <p className="sheet-b">
        Saves this quote’s Incurred and options — scope lines, line items and prices — with the specs and the
        note to the customer ({quoteTemplateSummary(content)}). Nothing about this work order is kept.
      </p>
      <div className="field">
        <label className="lbl" htmlFor="qtpl-name">Name</label>
        <input
          id="qtpl-name"
          className="fld"
          maxLength={QUOTE_TEMPLATE_NAME_MAX}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Walk-in cooler compressor replacement"
          autoFocus
        />
      </div>
      <div className="field">
        <label className="lbl" htmlFor="qtpl-desc">Description <span className="faint">(optional)</span></label>
        <textarea
          id="qtpl-desc"
          className="fld"
          rows={2}
          maxLength={QUOTE_TEMPLATE_DESCRIPTION_MAX}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="lbl" htmlFor="qtpl-trade">Trade <span className="faint">(optional)</span></label>
        <input id="qtpl-trade" className="fld" maxLength={80} value={tradeValue} onChange={(e) => setTradeValue(e.target.value)} />
      </div>
      {canShare ? (
        <label className="qtpl-share">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          Share with everyone who builds quotes
        </label>
      ) : (
        <p className="hint">Only you will see it. A quote approver can share it with everyone.</p>
      )}
      {!filled && <p className="hint">Add a line or a scope line first — an empty quote cannot be a template.</p>}
      {save.isError && (
        <p className="snooze-err" role="alert">
          <Icon name="alert" size={12} /> {save.error instanceof Error ? save.error.message : 'The template was not saved'}
        </p>
      )}
      <div className="qtpl-row-acts">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!filled || name.trim() === '' || save.isPending}
          onClick={() => save.mutate()}
        >
          <Icon name="check" size={12} />
          {save.isPending ? 'Saving…' : 'Save template'}
        </button>
      </div>
    </div>
  );
}
