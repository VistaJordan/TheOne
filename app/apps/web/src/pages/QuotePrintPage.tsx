/* /work-orders/:woNumber/quote/print — the quote as a DOCUMENT (0048).
 *
 * What the client is sent: the entity's name and the document type at the
 * top, the number, the date, bill-to and ship-to, the incurred work and the
 * included options as line tables with UOM / unit price (marked up — the
 * Markup column is not printed for the client, M27) / tax, the
 * totals and the note to customer (the summary text is not printed —
 * Elise, 2026-11-19; it stays the builder's Text view). Internal
 * things — specs, cost, profit, the NTE meter — are deliberately absent.
 *
 * "PDF output" is the browser's print dialog: this page carries its own
 * print stylesheet (quote.css, @media print) and the button calls
 * window.print(), which every browser offers to save as PDF. No server-side
 * renderer, no template engine, nothing to keep in step with the builder —
 * the document is the same React tree the builder's numbers come from.
 *
 * 2026-10-28 (Elise) · the document itself is `QuoteDocument`, so the quote
 * builder (and the work order's Quotes tab) draws the same page at its top,
 * live, as the client would see it.
 *
 * 2026-11-17 (Elise approved the design canvas) · an SFM or BKR quote wears
 * its company's design, the same two the sign-off sheet is drawn in: Seamless
 * "the seam" (black band, the cyan-to-blue line, a black Total bar) and BKR's
 * field service ticket (slate strip, numbered sections, a red-ruled totals
 * box, a tear-off client approval stub). Both end with a client acceptance
 * block (name, signature, date). Any other Comp prints as before. */

import { useEffect } from 'react';
import { lineBillsOt, optionDisplayLabel, signoffLayoutFor, visibleScopeLines } from '@theone/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { QUOTE_DOCUMENT_TYPE_LABELS, type QuoteSection } from '@theone/shared';
import { getWorkOrder, getWorkOrderQuote, type Quote } from '../api/client';
import type { PrintTemplate } from '@theone/shared';
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
  // ?pdf=1 (the builder's PDF button): open the print dialog once the
  // document has drawn, so saving it as a PDF is one more click.
  const [params] = useSearchParams();
  const wantsPdf = params.get('pdf') === '1';
  const ready = quote !== null && !woQuery.isLoading;
  useEffect(() => {
    if (!wantsPdf || !ready) return;
    const t = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(t);
  }, [wantsPdf, ready]);

  useEffect(() => {
    if (quote) document.title = `${quote.number ?? 'Quote'} · ${quote.wo_number}`;
    return () => {
      document.title = 'OBI';
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
      <QuoteDocument quote={quote} wo={wo} tpl={tpl} />
    </div>
  );
}

type WoDetail = Awaited<ReturnType<typeof getWorkOrder>>;

/** Which company design the document wears: by Comp, as the sign-off sheet. */
type QuoteBrand = 'sfm' | 'bkr';
function quoteBrandFor(entity: string | null | undefined): QuoteBrand | null {
  const layout = signoffLayoutFor(entity, null);
  return layout === 'sfm' ? 'sfm' : layout ? 'bkr' : null;
}

/** The quote as the client receives it: the printed page, and the preview at
    the top of the builder. Internal figures never appear here. */
export function QuoteDocument({ quote, wo, tpl }: { quote: Quote; wo: WoDetail | undefined; tpl: PrintTemplate | null }) {
  const site = wo ? deriveSite(wo) : null;
  const title = QUOTE_DOCUMENT_TYPE_LABELS[quote.document_type] ?? 'Quote';
  const entity = wo?.billing_entity ?? '';
  const issued = (quote.sent_at ?? quote.updated_at).slice(0, 10);
  const incurred = quote.sections.find((s) => s.kind === 'incurred') ?? null;
  // 0076 · rounds: an option the client approved is work already performed;
  // the document offers only the current round's undecided options.
  // 2026-11-16 (Elise, #50) · approved work prints under the work performed
  // as Day 1, Day 2… and the original incurred work as Day 0.
  const approvedWork = quote.sections
    .filter((s) => s.kind === 'option' && s.approved_at !== null)
    .sort((a, b) => a.round - b.round);
  const dayed = approvedWork.length > 0;
  const options = quote.sections.filter(
    (s) => s.kind === 'option' && s.round === quote.current_round && s.include_in_summary && s.approved_at === null,
  );
  // An option approved in an earlier round already prices as incurred; one
  // approved in this round is still priced as the option, so add it here.
  const performedTotal =
    Math.round(
      (quote.totals.incurred_subtotal +
        approvedWork.filter((s) => s.round === quote.current_round).reduce((sum, s) => sum + s.subtotal, 0)) *
        100,
    ) / 100;
  const yoda = quote.totals.total_rule !== 'options_only';
  const sectionTaxPct = yoda && quote.tax_applies !== false ? quote.totals.sales_tax_pct : 0;
  const priced = quote.totals.option_totals.find((o) => o.section_id === quote.totals.priced_section_id) ?? null;
  const offered = quote.totals.option_totals.filter((o) => o.include_in_summary && options.some((s) => s.id === o.section_id));
  const brand = quoteBrandFor(entity);
  const billTo = quote.bill_to?.trim() || wo?.client || '—';
  const shipTo = quote.ship_to?.trim() || [site?.name, ...(site?.addressLines ?? [])].filter(Boolean).join('\n') || '—';
  // BKR numbers its sections (01 Work performed, 02 Proposed work…).
  let sectionNo = 0;
  const nextNo = () => (brand === 'bkr' ? String(++sectionNo).padStart(2, '0') : undefined);

  return (
    <article className={`qdoc${brand ? ` qdoc-b qdoc-b-${brand}` : ''}`}>
      {brand ? (
        <BrandHead brand={brand} title={title} quote={quote} issued={issued} extName={wo?.ext_name ?? null} billTo={billTo} shipTo={shipTo} subject={wo?.title ?? null} tpl={tpl} />
      ) : (<>
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
      </>)}

      {incurred && incurred.lines.length > 0 && (
        <LinesBlock num={nextNo()} section={incurred} heading={dayed ? 'Work performed — Day 0' : 'Work performed'} note="Billed with the work order" taxPct={sectionTaxPct} />
      )}
      {incurred && incurred.lines.length === 0 && (incurred.note_to_customer?.trim() || incurred.specs?.trim()) && (
        <section className="qdoc-note">
          <h3>Work performed</h3>
          {incurred.specs?.trim() && (
            <p>
              <b>Specs:</b> {incurred.specs}
            </p>
          )}
          {incurred.note_to_customer?.trim() && <p>{incurred.note_to_customer}</p>}
        </section>
      )}

      {approvedWork.map((s, idx) => (
        <LinesBlock
          key={s.id}
          num={nextNo()}
          section={s}
          heading={`Day ${idx + 1} — ${s.name?.trim() || 'Approved work'}`}
          note="Billed with the work order"
          taxPct={sectionTaxPct}
        />
      ))}

      {/* A lone option is "Proposed work" with no letter and no name (2026-10-22). */}
      {options.map((s) => (
        <LinesBlock
          key={s.id}
          num={nextNo()}
          section={s}
          heading={options.length > 1 ? `${s.label}${s.name ? ` — ${s.name}` : ''}` : 'Proposed work'}
          taxPct={sectionTaxPct}
        />
      ))}

      {/* The Yoda rule (0076): each option is priced as the work performed +
          that option, plus sales tax; the Total is the approved option's
          price, or the first offered one's until the client decides. */}
      <section className="qdoc-totals">
        <table>
          <tbody>
            {yoda && performedTotal !== 0 && (
              <tr><th>Work performed</th><td>{usd(performedTotal)}</td></tr>
            )}
            {offered.map((o) => (
              <tr key={o.section_id}>
                <th>{offered.length > 1 ? `${o.label}${o.name ? ` — ${o.name}` : ''}` : optionDisplayLabel(o.label, 1) + ' work'}</th>
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

      {/* A quote from before 0146 may still hold a quote-wide note. */}
      {quote.note_to_customer && (
        <section className="qdoc-note">
          <h3>Note</h3>
          <p>{quote.note_to_customer}</p>
        </section>
      )}

      {brand && <Acceptance brand={brand} title={title} />}

      <footer className="qdoc-foot">
        {quote.rates.contract
          ? `Priced under ${quote.rates.contract.name}.`
          : ''}
        {' '}
        This {title.toLowerCase()} is valid for 30 days from the date above.
        {brand && ` Prices in ${quote.currency}.`}
      </footer>
      <DocTerms template={tpl} />
      {brand && <BrandFoot brand={brand} />}
    </article>
  );
}

/** The company's header: the logo and the document's name and number, then
    who it is for, where, and the details (BKR: in a slate strip). */
function BrandHead({ brand, title, quote, issued, extName, billTo, shipTo, subject, tpl }: {
  brand: QuoteBrand; title: string; quote: Quote; issued: string; extName: string | null;
  billTo: string; shipTo: string; subject: string | null; tpl: PrintTemplate | null;
}) {
  const details = (
    <dl className="qdoc-b-details">
      <div><dt>Date</dt><dd>{issued}</dd></div>
      <div><dt>Work order</dt><dd className="mono">{quote.wo_number}</dd></div>
      {extName && <div><dt>Client ref</dt><dd className="mono">{extName}</dd></div>}
      <div><dt>Revision</dt><dd>{quote.rev}</dd></div>
    </dl>
  );
  return (
    <>
      <header className="qdoc-b-band">
        {brand === 'sfm'
          ? <img className="qdoc-b-logo" src="/brand/sheets/sfm-header.png" alt="Seamless Facility Management" />
          : <img className="qdoc-b-logo" src="/brand/sheets/bkr-logo.png" alt="BKR National Facility Services" />}
        <div className="qdoc-b-title">
          <span className="qdoc-b-kind">{title}</span>
          <span className="qdoc-b-no mono">{quote.number ?? '—'}</span>
        </div>
      </header>
      <div className="qdoc-b-rule" aria-hidden="true"><span /><span /></div>
      <DocLetterhead template={tpl} />
      {brand === 'bkr' && <div className="qdoc-b-strip">{details}</div>}
      <section className="qdoc-b-parties">
        <div>
          <h3>Bill to</h3>
          <p>{billTo}</p>
        </div>
        <div>
          <h3>{brand === 'sfm' ? 'Site' : 'Service address'}</h3>
          <p>{shipTo}</p>
        </div>
        {brand === 'sfm' && details}
        {subject && (
          <div className="qdoc-wide">
            <h3>Subject</h3>
            <p>{subject}</p>
          </div>
        )}
      </section>
    </>
  );
}

/** Where the client says yes on paper: name, signature, date. */
function Acceptance({ brand, title }: { brand: QuoteBrand; title: string }) {
  return (
    <section className="qdoc-b-accept">
      <h3>{brand === 'sfm' ? 'Client acceptance' : 'Client approval'}</h3>
      <p>By signing, the client accepts this {title.toLowerCase()} and authorizes the work.</p>
      <div className="qdoc-b-accept-row">
        <div><span /><small>Name</small></div>
        <div><span /><small>Signature</small></div>
        <div><span /><small>Date</small></div>
      </div>
    </section>
  );
}

function BrandFoot({ brand }: { brand: QuoteBrand }) {
  return brand === 'sfm' ? (
    <footer className="qdoc-b-foot">
      <b>Seamless Facility Management</b>
      <span>+1 (469) 501-1510 · info@seamlessfm.com · 1910 Pacific Ave, Suite 2000 #3299, Dallas, TX 75201</span>
    </footer>
  ) : (
    <footer className="qdoc-b-foot">
      <b>BKR National Facility Services</b>
      <span>www.bkrnational.com</span>
    </footer>
  );
}

/** 2026-11-16 (UAT #27) · each section prints its sales tax in dollars under
    its subtotal: the section's lines × the quote's %. */
function LinesBlock({ section, heading, note, taxPct = 0, num }: { section: QuoteSection; heading: string; note?: string; taxPct?: number; num?: string }) {
  const salesTax = taxPct > 0 ? Math.round(section.subtotal * taxPct) / 100 : 0;
  const anyTax = section.lines.some((l) => l.tax > 0);
  // M27 (UAT Wave D): the markup is ours, not the client's — the printed
  // quote has no Markup column; the unit price is the marked-up price, so
  // qty × unit price still reads as the amount (before overtime).
  const clientUnit = (l: { rate: number; markup_pct: number }) =>
    Math.round(l.rate * (1 + (l.markup_pct > 0 ? l.markup_pct / 100 : 0)) * 100) / 100;
  return (
    <section className="qdoc-lines">
      <h3>
        {num && <span className="qdoc-b-num">{num}</span>}
        {heading}
        {note && <small> · {note}</small>}
      </h3>
      {section.narrative_reported && <p className="qdoc-narr">{section.narrative_reported}</p>}
      {visibleScopeLines(section.scope_lines).length > 0 && (
        <ul className="qdoc-scope">
          {visibleScopeLines(section.scope_lines).map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      <table className="qdoc-table">
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Unit price</th>
            {anyTax && <th className="num">Tax</th>}
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {section.lines.map((l) => (
            <tr key={l.id}>
              <td>
                {l.description}
                {lineBillsOt(l) && <small> (overtime)</small>}
              </td>
              <td className="num">{l.qty}</td>
              <td className="num">{usd(clientUnit(l))}</td>
              {anyTax && <td className="num">{l.tax > 0 ? usd(l.tax) : ''}</td>}
              <td className="num">{usd(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={anyTax ? 4 : 3}>Subtotal</th>
            <td className="num">{usd(section.subtotal)}</td>
          </tr>
          {salesTax > 0 && (
            <tr>
              <th colSpan={anyTax ? 4 : 3}>Sales tax ({taxPct}%)</th>
              <td className="num">{usd(salesTax)}</td>
            </tr>
          )}
        </tfoot>
      </table>
      {/* UAT #25 (2026-11-16) · the section's specs, then (0146) its note to the customer. */}
      {section.specs?.trim() && (
        <p className="qdoc-narr qdoc-section-note qdoc-section-specs">
          <b>Specs:</b> {section.specs}
        </p>
      )}
      {section.note_to_customer?.trim() && <p className="qdoc-narr qdoc-section-note">{section.note_to_customer}</p>}
    </section>
  );
}
