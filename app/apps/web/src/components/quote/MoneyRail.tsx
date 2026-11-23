/* The quote's money card (comp: right rail #1) — NTE meter, the per-option
   rows, the sales-tax % input and the grand total.

   Under the Yoda rule (D1) every option is priced as (incurred + option) × (1 +
   tax%), so each option row shows ITS client price and the caption names which
   option the Grand Total is. RULE B keeps its original caption. */

import type { QuoteRates } from '@theone/shared';
import type { QuoteTotals } from '../../lib/quoteTotals';
import { NTE_WARN_PCT, OT_MULTIPLIER, usd, usd0 } from '../../lib/quoteTotals';
import { Icon } from '../Icon';
import { QuoteTerms } from './QuoteTerms';

interface MoneyRailProps {
  totals: QuoteTotals;
  nte: number | null;
  editable: boolean;
  comp: string | null;
  isCostTbd: boolean;
  onCostTbdChange: (v: boolean) => void;
  /** 0046 · the rates the quote is priced with, and the contract they came from. */
  rates?: QuoteRates | null;
  /** 2026-11-04 · false = the quote carries no tax (only SFM's do): the tax
      rows are not drawn. */
  taxApplies?: boolean;
}

export function MoneyRail({
  totals,
  nte,
  editable,
  comp,
  isCostTbd,
  onCostTbdChange,
  rates,
  taxApplies = true,
}: MoneyRailProps) {
  const pct = nte != null && nte > 0 ? (totals.grandTotal / nte) * 100 : null;
  const warn = pct != null && pct >= NTE_WARN_PCT;
  const over = pct != null && pct > 100;
  const headroom = nte == null ? null : nte - totals.grandTotal;
  const mult = rates?.ot_multiplier ?? OT_MULTIPLIER;
  const yoda = totals.totalRule !== 'options_only';
  const priced = totals.options.find((o) => o.key === totals.pricedKey) ?? null;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Money</h2>
        {comp && <span className="card-meta">Comp {comp}</span>}
      </div>

      {/* 0046 · where the price comes from. A contract names itself; with
          none, nothing is said (Elise, 2026-11-03). */}
      {rates?.contract && (
        <p className="money-basis">
          <Icon name="briefcase" size={12} />
          <span>
            Priced under <b>{rates.contract.name}</b>
            {rates.standard != null && ` · ${usd(rates.standard)}/h`}
            {rates.trip_charge != null && rates.trip_charge > 0 && ` · trip ${usd(rates.trip_charge)}`}
            {` · OT ${mult}×`}
          </span>
        </p>
      )}

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
            {/* No percentage beside the quote (Elise, 2026-11-23): the bar and
                the two figures say it. */}
            <span>Quote {usd0(totals.grandTotal)}</span>
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
          <dt>Total incurred</dt>
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
              {yoda && taxApplies && <span className="kv-sub">lines {usd(opt.total)} · tax {usd(opt.tax)}</span>}
            </dt>
            <dd>{usd(yoda ? opt.grandTotal : opt.total)}</dd>
          </div>
        ))}

        {taxApplies ? (
        <>
        {/* 2026-11-16 (Elise, UAT #27) · the % is typed in the Sales tax bar at
            the top of the builder; here it is the total it adds. */}
        <div className="kvrow is-muted">
          <dt>Sales tax{totals.salesTaxPct > 0 ? ` (${totals.salesTaxPct}%)` : ''}</dt>
          <dd>{usd(totals.salesTax)}</dd>
        </div>

        {totals.lineTax > 0 && (
          <div className="kvrow">
            <dt>Line tax</dt>
            <dd>{usd(totals.lineTax)}</dd>
          </div>
        )}
        </>
        ) : (
          <div className="kvrow is-muted kv-note">
            <dt>No tax — only SFM quotes carry tax</dt>
            <dd />
          </div>
        )}

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

      {/* #9 (Wave D): every term the Grand Total is made of, so it adds up on screen. */}
      <QuoteTerms
        input={{
          rule: totals.totalRule,
          incurred: totals.incurredSubtotal,
          options: totals.options.map((o) => ({ id: o.key, label: o.label, total: o.total, included: o.include_in_summary })),
          priced_id: totals.pricedKey,
          sales_tax: totals.salesTax,
          sales_tax_pct: totals.salesTaxPct,
          line_tax: totals.lineTax,
          grand_total: totals.grandTotal,
        }}
      />

      <p className="money-cap">
        {yoda
          ? `Each option is priced as incurred work + that option${taxApplies ? ', plus sales tax' : ''}. Grand Total is the approved option’s price — or the first included option’s until the client decides.`
          : 'Grand Total is the price of the options included in the summary. Incurred lines are already on the WO and bill with the job — they are shown here for context, not added twice.'}
      </p>
    </section>
  );
}
