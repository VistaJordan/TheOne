/* /work-orders/:woNumber/quote/print — the quote as a DOCUMENT (0048).
 *
 * What the client is sent: the entity's name and the document type at the
 * top, the number, the date, bill-to and ship-to, the incurred work and the
 * included options as line tables with UOM / unit price / markup / tax, the
 * totals, the client summary text and the note to customer. Internal
 * things — specs, cost, profit, the NTE meter — are deliberately absent.
 *
 * "PDF output" is the browser's print dialog: this page carries its own
 * print stylesheet (quote.css, @media print) and the button calls
 * window.print(), which every browser offers to save as PDF. No server-side
 * renderer, no template engine, nothing to keep in step with the builder —
 * the document is the same React tree the builder's numbers come from. */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { QUOTE_DOCUMENT_TYPE_LABELS, type QuoteSection } from '@theone/shared';
import { getWorkOrder, getWorkOrderQuote } from '../api/client';
import { Icon } from '../components/Icon';
import { deriveSite } from '../lib/woDerive';
import { usd } from '../lib/quoteTotals';
import { DocLetterhead, DocTerms, usePrintTemplate } from './DocPrintPages';

export function QuotePrintPage() {
  const { woNumber = '' } = useParams<{ woNumber: string }>();
  const woQuery = useQuery({
    queryKey: ['work-orders', 'detail', woNumber],
    queryFn: () => getWorkOrder(woNumber),
    enabled: woNumber.length > 0,
  });
  const quoteQuery = useQuery({
    queryKey: ['wo-quote', woNumber],
    queryFn: () => getWorkOrderQuote(woNumber),
    enabled: woNumber.length > 0,
  });
  // 0067 · the quote template, when one is set: letterhead, terms, footer.
  const tpl = usePrintTemplate('quote');
  const quote = quoteQuery.data?.quote ?? null;
  const wo = woQuery.data;

  useEffect(() => {
    if (quote) document.title = `${quote.number ?? 'Quote'} · ${quote.wo_number}`;
    return () => {
      document.title = 'The One';
    };
  }, [quote]);

  if (quoteQuery.isLoading || woQuery.isLoading) {
    return <div className="qprint qprint-state">Preparing the document…</div>;
  }
  if (!quote) {
    return (
      <div className="qprint qprint-state">
        <b>No quote on {woNumber}</b>
        <Link className="btn" to={`/work-orders/${encodeURIComponent(woNumber)}/quote`}>
          Open the builder
        </Link>
      </div>
    );
  }

  const site = wo ? deriveSite(wo) : null;
  const title = QUOTE_DOCUMENT_TYPE_LABELS[quote.document_type] ?? 'Quote';
  const entity = wo?.billing_entity ?? '';
  const issued = (quote.sent_at ?? quote.updated_at).slice(0, 10);
  const incurred = quote.sections.find((s) => s.kind === 'incurred') ?? null;
  // 0076 · rounds: an option the client approved in an earlier round is work
  // already performed; the document offers only the current round's options.
  const approvedEarlier = quote.sections.filter(
    (s) => s.kind === 'option' && s.round < quote.current_round && s.approved_at !== null,
  );
  const options = quote.sections.filter(
    (s) => s.kind === 'option' && s.round === quote.current_round && s.include_in_summary,
  );
  const yoda = quote.totals.total_rule !== 'options_only';
  const priced = quote.totals.option_totals.find((o) => o.section_id === quote.totals.priced_section_id) ?? null;
  const offered = quote.totals.option_totals.filter((o) => o.include_in_summary && options.some((s) => s.id === o.section_id));
  const summaryText = quote.summary.pinned ?? quote.summary.auto;
  const backHref = `/work-orders/${encodeURIComponent(quote.wo_number)}/quote`;

  return (
    <div className="qprint">
      <div className="qprint-bar no-print">
        <Link className="btn" to={backHref}>
          <Icon name="arrow-l" size={14} /> Back to the builder
        </Link>
        <span className="hint">Save as PDF from the print dialog.</span>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          <Icon name="file" size={14} /> Print / Save as PDF
        </button>
      </div>

      <article className="qdoc">
        <header className="qdoc-head">
          <div>
            <div className="qdoc-entity">{tpl?.company_name || entity || 'Seamless FM'}</div>
            <div className="qdoc-kind">{title}</div>
            <DocLetterhead template={tpl} />
          </div>
          <table className="qdoc-meta">
            <tbody>
              <tr><th>{title} #</th><td className="mono">{quote.number ?? '—'}</td></tr>
              <tr><th>Date</th><td>{issued}</td></tr>
              <tr><th>Work order</th><td className="mono">{quote.wo_number}</td></tr>
              {wo?.ext_name && <tr><th>Client ref</th><td className="mono">{wo.ext_name}</td></tr>}
              <tr><th>Revision</th><td>{quote.rev}</td></tr>
              <tr><th>Currency</th><td>{quote.currency}</td></tr>
            </tbody>
          </table>
        </header>

        <section className="qdoc-parties">
          <div>
            <h3>Bill to</h3>
            <p>{quote.bill_to?.trim() || wo?.client || '—'}</p>
          </div>
          <div>
            <h3>Ship to / site</h3>
            <p>
              {quote.ship_to?.trim() ||
                [site?.name, ...(site?.addressLines ?? [])].filter(Boolean).join('\n') ||
                '—'}
            </p>
          </div>
          {wo?.title && (
            <div className="qdoc-wide">
              <h3>Subject</h3>
              <p>{wo.title}</p>
            </div>
          )}
        </section>

        {incurred && incurred.lines.length > 0 && (
          <LinesBlock section={incurred} heading="Work performed" note="Billed with the work order" />
        )}

        {approvedEarlier.map((s) => (
          <LinesBlock
            key={s.id}
            section={s}
            heading={`${s.name ?? 'Approved work'} (approved, round ${s.round})`}
            note="Billed with the work order"
          />
        ))}

        {options.map((s) => (
          <LinesBlock key={s.id} section={s} heading={`${s.label}${s.name ? ` — ${s.name}` : ''}`} />
        ))}

        {/* The Yoda rule (0076): each option is priced as the work performed +
            that option, plus sales tax; the Total is the approved option's
            price, or the first offered one's until the client decides. */}
        <section className="qdoc-totals">
          <table>
            <tbody>
              {yoda && quote.totals.incurred_subtotal !== 0 && (
                <tr><th>Work performed</th><td>{usd(quote.totals.incurred_subtotal)}</td></tr>
              )}
              {offered.map((o) => (
                <tr key={o.section_id}>
                  <th>{o.label}{o.name ? ` — ${o.name}` : ''}</th>
                  <td>{usd(o.total)}</td>
                </tr>
              ))}
              {quote.totals.line_tax > 0 && (
                <tr><th>Tax</th><td>{usd(quote.totals.line_tax)}</td></tr>
              )}
              {quote.totals.sales_tax > 0 && (
                <tr><th>Sales tax ({quote.totals.sales_tax_pct}%)</th><td>{usd(quote.totals.sales_tax)}</td></tr>
              )}
              <tr className="qdoc-grand">
                <th>Total{yoda && priced && offered.length > 1 ? ` — ${priced.label}` : ''}</th>
                <td>{usd(quote.totals.grand_total)}</td>
              </tr>
              {yoda &&
                offered.length > 1 &&
                offered
                  .filter((o) => o.section_id !== priced?.section_id)
                  .map((o) => (
                    <tr key={`alt-${o.section_id}`}>
                      <th>Total with {o.label} instead</th>
                      <td>{usd(o.grand_total)}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </section>

        {summaryText.trim() !== '' && (
          <section className="qdoc-summary">
            <h3>Summary</h3>
            <pre>{summaryText}</pre>
          </section>
        )}

        {quote.note_to_customer && (
          <section className="qdoc-note">
            <h3>Note</h3>
            <p>{quote.note_to_customer}</p>
          </section>
        )}

        <footer className="qdoc-foot">
          {quote.rates.contract
            ? `Priced under ${quote.rates.contract.name}.`
            : ''}
          {' '}
          This {title.toLowerCase()} is valid for 30 days from the date above.
        </footer>
        <DocTerms template={tpl} />
      </article>
    </div>
  );
}

function LinesBlock({ section, heading, note }: { section: QuoteSection; heading: string; note?: string }) {
  const anyTax = section.lines.some((l) => l.tax > 0);
  const anyMarkup = section.lines.some((l) => l.markup_pct > 0);
  return (
    <section className="qdoc-lines">
      <h3>
        {heading}
        {note && <small> · {note}</small>}
      </h3>
      {section.narrative_reported && <p className="qdoc-narr">{section.narrative_reported}</p>}
      {section.scope_lines.length > 0 && (
        <ul className="qdoc-scope">
          {section.scope_lines.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      <table className="qdoc-table">
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Qty</th>
            <th>UOM</th>
            <th className="num">Unit price</th>
            {anyMarkup && <th className="num">Markup</th>}
            {anyTax && <th className="num">Tax</th>}
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {section.lines.map((l) => (
            <tr key={l.id}>
              <td>
                {l.description}
                {l.ot && <small> (overtime)</small>}
              </td>
              <td className="num">{l.qty}</td>
              <td>{l.uom ?? ''}</td>
              <td className="num">{usd(l.rate)}</td>
              {anyMarkup && <td className="num">{l.markup_pct > 0 ? `${l.markup_pct}%` : ''}</td>}
              {anyTax && <td className="num">{l.tax > 0 ? usd(l.tax) : ''}</td>}
              <td className="num">{usd(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={anyMarkup && anyTax ? 6 : anyMarkup || anyTax ? 5 : 4}>Subtotal</th>
            <td className="num">{usd(section.subtotal)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
