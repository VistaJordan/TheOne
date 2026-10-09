/* The quote's money card (comp: right rail #1) — NTE meter, the per-option
   rows, the sales-tax % input and the grand total.

   Under the Yoda rule (D1) every option is priced as (incurred + option) × (1 +
   tax%), so each option row shows ITS client price and the caption names which
   option the Grand Total is. RULE B keeps its original caption. */

import type { QuoteTotals } from '../../lib/quoteTotals';
import { NTE_WARN_PCT, parsePct, usd, usd0 } from '../../lib/quoteTotals';
import type { SalesTaxLookup } from '../../api/client';
import { Icon } from '../Icon';

interface MoneyRailProps {
  totals: QuoteTotals;
  nte: number | null;
  salesTaxPct: string;
  editable: boolean;
  comp: string | null;
  /** The derived rate for this WO, when the lookup has answered. */
  derived?: SalesTaxLookup | null;
  isCostTbd: boolean;
  onSalesTaxPctChange: (v: string) => void;
  onCostTbdChange: (v: boolean) => void;
}

export function MoneyRail({
  totals,
  nte,
  salesTaxPct,
  editable,
  comp,
  derived,
  isCostTbd,
  onSalesTaxPctChange,
  onCostTbdChange,
}: MoneyRailProps) {
  const pct = nte != null && nte > 0 ? (totals.grandTotal / nte) * 100 : null;
  const warn = pct != null && pct >= NTE_WARN_PCT;
  const over = pct != null && pct > 100;
  const headroom = nte == null ? null : nte - totals.grandTotal;
  const taxErr = Number.isNaN(parsePct(salesTaxPct));
  const yoda = totals.totalRule !== 'options_only';
  const priced = totals.options.find((o) => o.key === totals.pricedKey) ?? null;
  const derivedDiffers =
    derived && derived.required && !taxErr && Math.abs(derived.pct - (parsePct(salesTaxPct) || 0)) > 0.0005;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Money</h2>
        {comp && <span className="card-meta">Comp {comp}</span>}
      </div>

      <div className="nte-row">
        <span className="nte-k">Client NTE</span>
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
            <span>
              Quote {usd0(totals.grandTotal)}
              <span className={`ntemeter-pct${over ? ' is-over' : warn ? ' is-warn' : ''}`}>
                {Math.round(pct)}%
              </span>
            </span>
            <span>NTE {usd0(nte)}</span>
          </div>
          {warn && (
            <div className={`ntemeter-cap${over ? ' is-over' : ''}`}>
              <Icon name="alert" size={12} />
              <span>
                {over
                  ? `${usd0(Math.abs(headroom ?? 0))} over the client NTE`
                  : `Past the ${NTE_WARN_PCT}% mark — ${usd0(headroom ?? 0)} of headroom`}
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
          <div className={`kvrow${opt.key === totals.pricedKey ? ' is-priced' : ''}`} key={opt.key}>
            <dt>
              {opt.label}
              {opt.approved && (
                <span className="chip chip-sm chip-accent">
                  <Icon name="check" size={12} />
                  Approved
                </span>
              )}
              {!opt.approved && opt.include_in_summary && <span className="chip chip-sm chip-accent">Included</span>}
              {yoda && <span className="kv-sub">lines {usd(opt.total)} · tax {usd(opt.tax)}</span>}
            </dt>
            <dd>{usd(yoda ? opt.grandTotal : opt.total)}</dd>
          </div>
        ))}

        <div className="kvrow">
          <dt>
            <label htmlFor="sales-tax">Sales tax %</label>
            <button
              type="button"
              className="qmk"
              title="Derived from the labor-rate card (Comp × FM × Trade) and the site ZIP; override here when needed"
              aria-label="About Sales tax: derived from the labor-rate card and the site ZIP; override here when needed"
            >
              ?
            </button>
          </dt>
          <dd>
            {editable ? (
              <span className="money-in tax-in">
                <input
                  className={`fld${taxErr ? ' is-err' : ''}`}
                  id="sales-tax"
                  inputMode="decimal"
                  placeholder="0"
                  aria-label="Sales tax percent"
                  aria-invalid={taxErr ? true : undefined}
                  value={salesTaxPct}
                  onChange={(e) => onSalesTaxPctChange(e.target.value)}
                />
                <span className="cur" aria-hidden="true">%</span>
              </span>
            ) : (
              `${totals.salesTaxPct}%`
            )}
          </dd>
        </div>
        {derived && (
          <div className="kvrow is-muted kv-note">
            <dt>
              {derived.required
                ? `Derived ${derived.pct}%${derived.zip ? ` · ZIP ${derived.zip}` : ''}`
                : 'No sales tax required for this Comp × FM × Trade'}
            </dt>
            <dd>
              {editable && derivedDiffers && (
                <button type="button" className="linkbtn" onClick={() => onSalesTaxPctChange(String(derived.pct))}>
                  Use {derived.pct}%
                </button>
              )}
            </dd>
          </div>
        )}
        <div className="kvrow is-muted">
          <dt>Sales tax</dt>
          <dd>{usd(totals.salesTax)}</dd>
        </div>

        <div className="kvrow is-total">
          <dt>Grand Total{yoda && priced ? <span className="kv-sub">{priced.label}</span> : null}</dt>
          <dd>{usd(totals.grandTotal)}</dd>
        </div>

        <div className="kvblock">
          <div className="kvrow">
            <dt>
              Total Cost
              {editable && (
                <label className="ck" style={{ marginLeft: 8 }}>
                  <input type="checkbox" checked={isCostTbd} onChange={(e) => onCostTbdChange(e.target.checked)} />
                  <span>TBD</span>
                </label>
              )}
            </dt>
            <dd className={totals.totalCost == null ? 'is-none' : undefined}>
              {isCostTbd ? 'TBD' : totals.totalCost == null ? '—' : usd(totals.totalCost)}
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

      <p className="money-cap">
        {yoda
          ? 'Each option is priced as incurred work + that option, plus sales tax. Grand Total is the approved option’s price — or the first included option’s until the client decides.'
          : 'Grand Total is the price of the options included in the summary. Incurred lines are already on the WO and bill with the job — they are shown here for context, not added twice.'}
      </p>
    </section>
  );
}
