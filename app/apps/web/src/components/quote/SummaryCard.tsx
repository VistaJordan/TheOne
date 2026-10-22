/* The client-facing summary block (comp: right rail #4).

   The text is AUTO — regenerated server-side from the narratives, the
   included lines and the totals on every read — and since 2026-10-22 (Elise)
   it cannot be edited here: what the client reads is always what the quote
   says. A quote pinned under the old "Edit text" still shows its pinned text
   and keeps one control, the refresh, to go back to the generated version. */

import { usd } from '../../lib/quoteTotals';
import { Icon } from '../Icon';

interface SummaryCardProps {
  /** The API's generated text. */
  auto: string;
  /** Non-null on a quote pinned before the editor was removed. */
  pinned: string | null;
  grandTotal: number;
  editable: boolean;
  onPinnedChange: (next: string | null) => void;
}

export function SummaryCard({ auto, pinned, grandTotal, editable, onPinnedChange }: SummaryCardProps) {
  const text = pinned ?? auto;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Summary</h2>
        {editable && pinned !== null && (
          <button
            type="button"
            className="btn btn-sm btn-icon"
            aria-label="Discard the pinned text and resume auto-generating this summary"
            title="Resume auto-generating this summary"
            onClick={() => onPinnedChange(null)}
          >
            <Icon name="refresh" size={14} />
          </button>
        )}
      </div>

      <div className="sum-body">
        <div
          className={`sum-text${text.trim() === '' ? ' is-none' : ''}`}
          role="document"
          aria-label={pinned === null ? 'Auto-generated client summary' : 'Pinned client summary'}
        >
          {text.trim() === ''
            ? 'The summary is generated from the narratives and line items — it fills in as you build the quote.'
            : text}
        </div>

        <div className="sum-foot">
          <span className="k">Grand total to client</span>
          <span className="v">{usd(grandTotal)}</span>
        </div>

        <p className="sum-cap">
          <Icon name="globe" size={12} />
          <span>
            This text syncs to the client&rsquo;s CMMS.{' '}
            {pinned === null ? (
              <>Generated from the narratives and line items — it follows the quote as you build it.</>
            ) : (
              <>
                <b>Pinned</b> — this is a manual version and no longer tracks the narratives or line
                items. Use the refresh control to resume auto-generating it.
              </>
            )}
          </span>
        </p>
      </div>
    </section>
  );
}
