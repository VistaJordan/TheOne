/* The quote's money card (comp: right rail #1) — NTE meter, the per-option
   rows, the sales-tax input and the grand total.

   The caption under the totals is the RULE B explanation and is not decorative:
   without it "Grand Total $2,890" beside "Incurred subtotal $930" reads like an
   arithmetic bug. */

import type { QuoteTotals } from '../../lib/quoteTotals';
import { NTE_WARN_PCT, parseTax, usd, usd0 } from '../../lib/quoteTotals';
import { Icon } from '../Icon';

interface MoneyRailProps {
  totals: QuoteTotals;
  nte: number | null;
  salesTax: string;
  editable: boolean;
  comp: string | null;
  onSalesTaxChange: (v: string) => void;
}

export function MoneyRail({ totals, nte, salesTax, editable, comp, onSalesTaxChange }: MoneyRailProps) {
  const pct = nte != null && nte > 0 ? (totals.grandTotal / nte) * 100 : null;
  const warn = pct != null && pct >= NTE_WARN_PCT;
  const over = pct != null && pct > 100;
  const headroom = nte == null ? null : nte - totals.grandTotal;
  const taxErr = Number.isNaN(parseTax(salesTax));

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Money</h2>
        {comp && <span className="card-meta">Comp {comp}</span>}
      </div>

      <div className="nte-row">
        <span className="nte-k">
          <span className="reddot" aria-hidden="true" />
          Client NTE
        </span>
        <span className="nte-v">{nte == null ? '—' : usd0(nte)}</span>
      </div>

      {pct != null && (
        <div className="ntemeter">
          <div
            className="ntemeter-track"
            role="img"
            aria-label={`Quote is ${Math.round(pct)} percent of the client NTE`}
          >
            <div
              className={`ntemeter-fill${over ? ' is-over' : warn ? ' is-warn' : ''}`}
              style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }}
            />
            <div className="ntemeter-thresh" title={`${NTE_WARN_PCT}% warning threshold`} />
          </div>
          <div className="ntemeter-scale">
            <span>Quote {usd0(totals.grandTotal)}</span>
            <span>NTE {usd0(nte)}</span>
          </div>
          {warn && (
            <div className={`ntemeter-cap${over ? ' is-over' : ''}`}>
              <Icon name="alert" size={12} />
              <span>
                {over
                  ? `Quote is ${Math.round(pct)}% of NTE — ${usd0(Math.abs(headroom ?? 0))} over`
                  : `Quote is ${Math.round(pct)}% of NTE — ${usd0(headroom ?? 0)} of headroom`}
              </span>
            </div>
          )}
        </div>
      )}

      <dl className="kvlist">
        <div className="kvrow is-muted">
          <dt>Incurred subtotal</dt>
          <dd>{usd(totals.incurredSubtotal)}</dd>
        </div>

        {totals.options.map((opt) => (
          <div className="kvrow" key={opt.key}>
            <dt>
              {opt.label}
              {opt.include_in_summary && <span className="chip chip-sm chip-accent">Included</span>}
            </dt>
            <dd>{usd(opt.total)}</dd>
          </div>
        ))}

        <div className="kvrow">
          <dt>
            <label htmlFor="sales-tax">Sales Tax</label>
            <button
              type="button"
              className="qmk"
              title="Manual entry vs. derived per state — open (requirements §4.2)"
              aria-label="About Sales Tax: manual entry vs. derived per state — open (requirements §4.2)"
            >
              ?
            </button>
          </dt>
          <dd>
            {editable ? (
              <span className="money-in tax-in">
                <span className="cur" aria-hidden="true">$</span>
                <input
                  className={`fld${taxErr ? ' is-err' : ''}`}
                  id="sales-tax"
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-label="Sales tax"
                  aria-invalid={taxErr ? true : undefined}
                  value={salesTax}
                  onChange={(e) => onSalesTaxChange(e.target.value)}
                />
              </span>
            ) : (
              usd(totals.salesTax)
            )}
          </dd>
        </div>

        <div className="kvrow is-total">
          <dt>Grand Total</dt>
          <dd>{usd(totals.grandTotal)}</dd>
        </div>

        <div className="kvblock">
          <div className="kvrow">
            <dt>Total Cost</dt>
            <dd className={totals.totalCost == null ? 'is-none' : undefined}>
              {totals.totalCost == null ? '—' : usd(totals.totalCost)}
            </dd>
          </div>
          <div className="kvrow">
            <dt>Profit</dt>
            <dd className={totals.profit == null ? 'is-none' : undefined}>
              {totals.profit == null ? '—' : usd(totals.profit)}
              {totals.marginPct != null && (
                <span className={`margin-chip${totals.marginPct < 0 ? ' is-neg' : ''}`}>
                  {Math.round(totals.marginPct)}% margin
                </span>
              )}
            </dd>
          </div>
        </div>
      </dl>

      {/* RULE B, in the operator's words. */}
      <p className="money-cap">
        Grand Total is the price of the options included in the summary. Incurred lines are already
        on the WO and bill with the job — they are shown here for context, not added twice.
      </p>
    </section>
  );
}
