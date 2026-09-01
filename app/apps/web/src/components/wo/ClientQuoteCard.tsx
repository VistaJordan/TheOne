import { Link } from 'react-router-dom';
import type { WorkOrderDetailV2, QuoteStatus } from '../../api/client';
import { FIELD, field, str } from '../../lib/fields';
import { QUOTE_STATUS } from '../quote/QuoteStatusPill';
import { Icon } from '../Icon';
import { InlineField } from './fieldEdit';

interface ClientQuoteCardProps {
  wo: WorkOrderDetailV2;
  /** S4 entry point: the quote's status when one exists, null when none does,
      undefined while the lookup is still in flight (the button waits rather
      than flickering "Create quote" at a WO that already has one). */
  quoteStatus?: QuoteStatus | null;
}

/** The Client Quote, in full, beside the Finances card — it used to render
    inside it clamped to two lines. The text edits in place; the quote-builder
    entry point lives in this card's footer because both are about the quote. */
export function ClientQuoteCard({ wo, quoteStatus }: ClientQuoteCardProps) {
  const clientQuote = str(field(wo.fields ?? {}, FIELD.clientQuote));

  return (
    <section className="card quote-card">
      <div className="card-head">
        <h2 className="card-title">Client quote</h2>
      </div>
      <div className="quote-card-body">
        <InlineField wo={wo} fieldKey={`fields.${FIELD.clientQuote}`} label="Client quote">
          {clientQuote
            ? <p className="quote-card-text">{clientQuote}</p>
            : <span className="quote-card-none">No client quote text on this work order yet.</span>}
        </InlineField>
      </div>

      {quoteStatus !== undefined && (
        <div className="card-foot">
          <Link
            className="btn btn-sm"
            to={`/work-orders/${encodeURIComponent(wo.wo_number)}/quote`}
          >
            <Icon name="file" size={12} />
            {quoteStatus === null ? 'Create quote' : 'Open quote'}
          </Link>
          {quoteStatus !== null && (
            <span className="chip chip-sm">{QUOTE_STATUS[quoteStatus]?.label ?? quoteStatus}</span>
          )}
        </div>
      )}
    </section>
  );
}
