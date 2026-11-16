/* The quote's sales tax, at the top of the builder (Elise, 2026-11-16, UAT
   #27). One percentage for the whole quote; every section then shows its tax
   as a dollar amount at its foot (`sectionTax`), and the Money rail keeps the
   totals. Before, the % sat in the Money rail and each line had its own Tax %
   column — the column now shows only on a section whose lines already carry
   one. Only SFM quotes carry tax: the bar is not drawn otherwise. */

import type { SalesTaxLookup } from '../../api/client';
import { TaxRatePicker } from '../../pages/admin/FinanceSetupCards';
import { parsePct } from '../../lib/quoteTotals';
import { Icon } from '../Icon';

interface QuoteTaxBarProps {
  salesTaxPct: string;
  editable: boolean;
  /** The derived rate for this work order, when the lookup has answered. */
  derived?: SalesTaxLookup | null;
  onChange: (v: string) => void;
}

/** A section's sales tax in dollars: its lines' total × the quote's %. */
export function sectionTax(linesTotal: number, pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0 || !Number.isFinite(linesTotal)) return 0;
  return Math.round(linesTotal * pct) / 100;
}

export function QuoteTaxBar({ salesTaxPct, editable, derived, onChange }: QuoteTaxBarProps) {
  const pct = parsePct(salesTaxPct);
  const err = Number.isNaN(pct);
  const differs = derived && derived.required && !err && Math.abs(derived.pct - (pct || 0)) > 0.0005;
  return (
    <section className="card qtax-bar" aria-label="Sales tax">
      <div className="qtax-row">
        <label className="qtax-lbl" htmlFor="sales-tax">
          <Icon name="dollar" size={14} />
          Sales tax
        </label>
        {editable ? (
          <span className="money-in tax-in">
            <input
              className={`fld${err ? ' is-err' : ''}`}
              id="sales-tax"
              inputMode="decimal"
              placeholder="0"
              aria-label="Sales tax percent"
              aria-invalid={err ? true : undefined}
              value={salesTaxPct}
              onChange={(e) => onChange(e.target.value)}
            />
            <span className="cur" aria-hidden="true">%</span>
          </span>
        ) : (
          <b className="num">{err ? '—' : `${pct || 0}%`}</b>
        )}
        <span className="qtax-note">
          {derived
            ? derived.required
              ? `Derived ${derived.pct}%${derived.zip ? ` · ZIP ${derived.zip}` : ''}`
              : 'No sales tax required for this Comp × FM × Trade'
            : 'Added in dollars under Incurred and each option'}
        </span>
        {editable && differs && (
          <button type="button" className="linkbtn" onClick={() => onChange(String(derived.pct))}>
            Use {derived.pct}%
          </button>
        )}
        {editable && (
          <span className="qtax-pick">
            <TaxRatePicker base={100} onPick={(rate) => onChange(String(rate))} />
          </span>
        )}
      </div>
      {err && (
        <span className="err" role="alert">
          <Icon name="alert" size={12} />
          Type the tax as a percentage, e.g. 8.25
        </span>
      )}
    </section>
  );
}
