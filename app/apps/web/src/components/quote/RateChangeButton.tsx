/* Request rate change (Elise, 2026-11-19). A dispatcher cannot type another
 * rate on a Labor or Trip line the client's price list prices; here they ask
 * a manager for one. The dialog lists every such line on the quote with the
 * rate it has; they type the rate it should have and why. It lands in
 * Approvals › Manager reviews; approving it writes the rates onto the lines.
 * While one waits, the button reads as a chip instead.
 *
 * Portals to the body: the button sits in the builder's pinned header band. */

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, requestRateChange, type Quote } from '../../api/client';
import { cardRateFor } from '../../lib/quoteDraft';
import { usd } from '../../lib/quoteTotals';
import { Icon } from '../Icon';

const REASON_MIN = 5;

export function RateChangeButton({ quote, beforeOpen }: { quote: Quote; beforeOpen?: () => Promise<unknown> | void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The lines the price list prices, on the sections still being written.
  const lines = useMemo(
    () =>
      quote.sections
        .filter((s) => !s.locked && (s.kind === 'incurred' || (s.round === quote.current_round && s.approved_at === null)))
        .flatMap((s) =>
          s.lines
            .filter((l) => cardRateFor(l, quote.labor_rate) != null)
            .map((l) => ({ line: l, section: s.kind === 'incurred' ? 'Incurred' : s.name?.trim() || s.label })),
        ),
    [quote],
  );

  const ask = useMutation({
    mutationFn: () =>
      requestRateChange(quote.wo_number, {
        lines: lines
          .filter(({ line }) => (rates[line.id] ?? '').trim() !== '' && Number(rates[line.id]) !== line.rate)
          .map(({ line }) => ({ line_id: line.id, requested_rate: Number(rates[line.id]) })),
        reason: reason.trim(),
      }),
    onSuccess: () => {
      setOpen(false);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['wo-quote'] });
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : 'The request did not go through'),
  });

  if (quote.rate_change_request) {
    return (
      <span className="chip chip-accent chip-sm" title="A manager decides it in Approvals › Manager reviews">
        <Icon name="clock" size={12} />
        Rate change waiting for a manager
      </span>
    );
  }
  if (lines.length === 0) return null;

  const changed = lines.filter(({ line }) => {
    const v = (rates[line.id] ?? '').trim();
    return v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) !== line.rate;
  });
  const valid = changed.length > 0 && reason.trim().length >= REASON_MIN;

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={async () => {
          // Ask about the lines as saved: flush a pending autosave first.
          await beforeOpen?.();
          setRates(Object.fromEntries(lines.map(({ line }) => [line.id, line.rate.toFixed(2)])));
          setReason('');
          setError(null);
          setOpen(true);
        }}
        title="Ask a manager for a different rate on a line the price list prices"
      >
        <Icon name="pencil" size={12} />
        Request rate change
      </button>
      {open &&
        createPortal(
          <div className="modal-scrim" onClick={() => !ask.isPending && setOpen(false)} role="presentation">
            <div className="modal is-wide" role="dialog" aria-modal="true" aria-label="Request rate change" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h2>Request rate change</h2>
                <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
                  <Icon name="x" size={16} />
                </button>
              </div>
              <div className="modal-body">
                <p className="hint">
                  These rates come from the client&rsquo;s price list. Type the rate a line should have; a manager approves or
                  rejects it in Approvals › Manager reviews, and an approved rate is written onto the quote.
                </p>
                <table className="qhist-table">
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th className="num">Rate now</th>
                      <th className="num">Rate it should be</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map(({ line, section }) => (
                      <tr key={line.id}>
                        <td>
                          {line.description || line.line_type}
                          <small className="rate-ask-sec"> · {section}</small>
                        </td>
                        <td className="num">{usd(line.rate)}</td>
                        <td className="num">
                          <span className="money-in rate-ask-in">
                            <span className="cur" aria-hidden="true">$</span>
                            <input
                              className="fld"
                              inputMode="decimal"
                              aria-label={`New rate for ${line.description || line.line_type}`}
                              value={rates[line.id] ?? ''}
                              onChange={(e) => setRates((r) => ({ ...r, [line.id]: e.target.value.replace(/[^0-9.]/g, '') }))}
                            />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="field" style={{ marginTop: 12 }}>
                  <label className="lbl" htmlFor="rate-ask-reason">
                    Why should it change? <span className="req" aria-hidden="true">*</span>
                  </label>
                  <textarea
                    id="rate-ask-reason"
                    className="fld"
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why?"
                  />
                </div>
                {error && <p className="composer-err" role="alert">{error}</p>}
              </div>
              <div className="sheet-f">
                <button type="button" className="btn" disabled={ask.isPending} onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" disabled={!valid || ask.isPending} onClick={() => ask.mutate()}>
                  {ask.isPending ? 'Sending…' : changed.length > 1 ? `Send request (${changed.length} lines)` : 'Send request'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
