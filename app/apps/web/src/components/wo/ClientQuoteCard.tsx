import { Link } from 'react-router-dom';
import type { Quote as SharedQuote } from '@theone/shared';
import type { WorkOrderDetailV2, QuoteStatus } from '../../api/client';
import { FIELD, field, str } from '../../lib/fields';
import { QUOTE_STATUS } from '../quote/QuoteStatusPill';
import { QuoteDecision } from '../quote/QuoteDecision';
import { ImportTranscriptButton } from '../quote/ImportTranscriptButton';
import { Icon } from '../Icon';
import { useAuth } from '../../auth/AuthProvider';
import { InlineField } from './fieldEdit';

interface ClientQuoteCardProps {
  wo: WorkOrderDetailV2;
  /** S4 entry point: the quote's status when one exists, null when none does,
      undefined while the lookup is still in flight (the button waits rather
      than flickering "Create quote" at a WO that already has one). */
  quoteStatus?: QuoteStatus | null;
  /** 0053 · the quote itself, when one exists: its permissions decide
      whether Approve / Decline draw here (BRD §6.4 — "from this tab or from
      Financials › Quote"). */
  quote?: SharedQuote | null;
}

/** The Client Quote, in full, beside the Finances card — it used to render
    inside it clamped to two lines. The text edits in place; the quote-builder
    entry point lives in this card's footer because both are about the quote. */
export function ClientQuoteCard({ wo, quoteStatus, quote }: ClientQuoteCardProps) {
  const clientQuote = str(field(wo.fields ?? {}, FIELD.clientQuote));
  // 0015 · the entry point follows the quote permissions: no view, no button;
  // no create, no "Create quote" at a WO that has none yet.
  const { can } = useAuth();
  const showEntry =
    quoteStatus !== undefined &&
    can('quotes', 'view') &&
    (quoteStatus !== null || can('quotes', 'create'));

  return (
    <section className="card quote-card">
      <div className="card-head">
        <h2 className="card-title">Client quote</h2>
        {quote?.number && <span className="card-meta mono">{quote.number}</span>}
      </div>
      <div className="quote-card-body">
        <InlineField wo={wo} fieldKey={`fields.${FIELD.clientQuote}`} label="Client quote">
          {clientQuote
            ? <p className="quote-card-text">{clientQuote}</p>
            : <span className="quote-card-none">No client quote text on this work order yet.</span>}
        </InlineField>
      </div>

      {showEntry && (
        <div className="card-foot">
          {quoteStatus === null && wo.actions && !wo.actions['quote.create'].allowed ? (
            // WO-status gate (allowedWoActions): never hidden, rendered locked
            // with the reason — same rule as every other gated control (§3.5).
            <span className="tipwrap">
              <button type="button" className="btn btn-sm btn-locked" tabIndex={0} aria-disabled="true" aria-describedby="lockTipQuoteCreate">
                <Icon name="lock" size={12} />
                Create quote
              </button>
              <span className="tip tip-below" id="lockTipQuoteCreate" role="tooltip">
                <Icon name="lock" size={12} />
                {wo.actions['quote.create'].reason}
              </span>
            </span>
          ) : (
            <Link
              className="btn btn-sm"
              to={`/work-orders/${encodeURIComponent(wo.wo_number)}/quote`}
            >
              <Icon name="file" size={12} />
              {quoteStatus === null ? 'Create quote' : 'Open quote'}
            </Link>
          )}
          {/* 0077 · draft the quote from a meeting / call transcript — while
              there is none yet, or it is still a draft. */}
          {(quoteStatus === null
            ? !wo.actions || wo.actions['quote.create'].allowed
            : quoteStatus === 'draft' && (!wo.actions || wo.actions['quote.edit'].allowed)) && (
            <ImportTranscriptButton woNumber={wo.wo_number} />
          )}
          {quoteStatus !== null && (
            <span className="chip chip-sm">{QUOTE_STATUS[quoteStatus]?.label ?? quoteStatus}</span>
          )}
          {quote && (
            <QuoteDecision
              woNumber={wo.wo_number}
              status={quote.status}
              canApprove={quote.permissions?.can_approve ?? can('quotes', 'approve')}
              nteHold={quote.nte_override_open}
              lockReason={
                quote.permissions?.self_approval
                  ? 'You submitted this quote — someone else has to approve and send it (maker ≠ checker)'
                  : null
              }
              size="card"
            />
          )}
          {quoteStatus !== null && wo.actions && !wo.actions['quote.edit'].allowed && (
            <span className="chip chip-sm chip-outline" title={wo.actions['quote.edit'].reason ?? ''}>
              <Icon name="lock" size={12} />
              Quoting closed
            </span>
          )}
        </div>
      )}
    </section>
  );
}
