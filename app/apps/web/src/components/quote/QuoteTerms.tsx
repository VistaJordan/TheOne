/* #9 (UAT round 1, Wave D) · how the Grand Total adds up, term by term.
 *
 * The rail used to show the incurred subtotal, each option's own price (which
 * already holds the incurred work and the tax), the tax and the total — none
 * of which summed to anything on screen. This block lists exactly the terms
 * the Yoda total is made of (quoteTotalTerms in shared; the formula is not
 * changed, D7), so the visible numbers add up to the Grand Total. */

import { quoteTotalTerms, type QuoteTermsInput } from '@theone/shared';
import { usd } from '../../lib/quoteTotals';

export function QuoteTerms({ input, className }: { input: QuoteTermsInput; className?: string }) {
  const { terms, adds_up } = quoteTotalTerms(input);
  if (terms.length === 0) return null;
  return (
    <dl className={`kvlist qterms${className ? ` ${className}` : ''}`} aria-label="How the Grand Total adds up">
      {terms.map((t, i) => (
        <div className="kvrow is-muted" key={t.label}>
          <dt>
            {i > 0 ? '+ ' : ''}
            {t.label}
          </dt>
          <dd>{usd(t.amount)}</dd>
        </div>
      ))}
      <div className="kvrow is-total">
        <dt>= Grand Total</dt>
        <dd>{usd(input.grand_total)}</dd>
      </div>
      {!adds_up && <p className="hint">Rounding: the terms are shown to the cent.</p>}
    </dl>
  );
}
