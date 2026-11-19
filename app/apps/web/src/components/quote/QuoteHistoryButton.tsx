/* Quote history (Elise, 2026-11-19): every saved version of the work order's
 * quote — submitted, approved, sent, decided by the client — newest first,
 * with its date, who and its total. A click opens that version as the client
 * document (Download PDF beside it). Read-only: the versions come from the
 * activity log and the revision snapshots, nothing here writes.
 *
 * The button sits in the builder's pinned header band, a stacking context,
 * so the dialog portals to the body. */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { QUOTE_HISTORY_EVENT_LABELS, type PrintTemplate, type QuoteHistoryEntry } from '@theone/shared';
import { getQuoteHistory, type Quote } from '../../api/client';
import { Icon } from '../Icon';
import { QuoteDocument, QuotePdfButton, type WoDetail } from '../../pages/QuotePrintPage';
import { usd } from '../../lib/quoteTotals';

const WHEN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function QuoteHistoryButton({ quote, wo, tpl }: { quote: Quote; wo: WoDetail | undefined; tpl: PrintTemplate | null }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<QuoteHistoryEntry | null>(null);
  const history = useQuery({
    queryKey: ['wo-quote-history', quote.wo_number],
    queryFn: () => getQuoteHistory(quote.wo_number),
    enabled: open,
  });
  const items = history.data?.items ?? [];
  const close = () => {
    setOpen(false);
    setPicked(null);
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen(true)}
        title="Every version of this quote that was submitted, sent or decided, with its date"
      >
        <Icon name="history" size={12} />
        History
      </button>
      {open &&
        createPortal(
          <div className="modal-scrim" onClick={close} role="presentation">
            <div
              className={`modal ${picked ? 'is-qhist-doc' : 'is-wide'}`}
              role="dialog"
              aria-modal="true"
              aria-label="Quote history"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-head">
                {picked ? (
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => setPicked(null)}>
                      <Icon name="arrow-l" size={12} /> All versions
                    </button>
                    <h2 className="qhist-doc-title">
                      {QUOTE_HISTORY_EVENT_LABELS[picked.event]} · {WHEN.format(new Date(picked.at))}
                    </h2>
                    <QuotePdfButton quote={picked.quote} wo={wo} tpl={tpl} small fileSuffix={picked.at.slice(0, 10)} />
                  </>
                ) : (
                  <h2>Quote history</h2>
                )}
                <button type="button" className="icon-btn" onClick={close} aria-label="Close">
                  <Icon name="x" size={16} />
                </button>
              </div>
              <div className="modal-body">
                {picked ? (
                  <div className="qhist-doc">
                    <QuoteDocument quote={picked.quote} wo={wo} tpl={tpl} />
                  </div>
                ) : history.isLoading ? (
                  <p className="hint">Loading the versions…</p>
                ) : history.isError ? (
                  <p className="composer-err" role="alert">The history could not be read.</p>
                ) : items.length === 0 ? (
                  <p className="hint">
                    No saved version yet. A version is kept each time the quote is submitted, approved, sent to the
                    client, or approved or declined by the client.
                  </p>
                ) : (
                  <table className="qhist-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>What happened</th>
                        <th>By</th>
                        <th className="num">Total</th>
                        <th aria-label="Open" />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((e) => (
                        <tr key={e.id} onClick={() => setPicked(e)} className="qhist-row">
                          <td>{WHEN.format(new Date(e.at))}</td>
                          <td>{QUOTE_HISTORY_EVENT_LABELS[e.event]}</td>
                          <td>{e.by ?? '—'}</td>
                          <td className="num">{usd(e.grand_total)}</td>
                          <td className="num">
                            <button type="button" className="linkbtn" onClick={() => setPicked(e)}>
                              View
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
