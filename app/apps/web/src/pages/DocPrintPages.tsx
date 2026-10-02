/* The printed purchase order and the printed invoice (0067), and the two
 * pieces every printed document shares: the letterhead and the terms that a
 * document template (Admin › Settings) adds.
 *
 * "PDF output" is the browser's print dialog, exactly as for the quote
 * (QuotePrintPage): the page carries the print stylesheet in quote.css and
 * the button calls window.print().
 *
 * With no template set for a kind of document, nothing is added: the quote
 * prints exactly as it did before templates existed.
 */

import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { PO_STATUS_LABELS, type DocTemplateKind, type PrintTemplate } from '@theone/shared';
import { getInvoice, getPrintTemplate, getPurchaseOrder } from '../api/client';
import { Icon, IconSprite } from '../components/Icon';
import { usd } from '../components/ui/Sheet';

export function usePrintTemplate(kind: DocTemplateKind): PrintTemplate | null {
  const q = useQuery({ queryKey: ['print-template', kind], queryFn: () => getPrintTemplate(kind), staleTime: 60_000, retry: false });
  return q.data?.template ?? null;
}

/** Under the entity name: the template's company details, when it has any. */
export function DocLetterhead({ template }: { template: PrintTemplate | null }) {
  if (!template?.company_details) return null;
  return <div className="qdoc-letterhead">{template.company_details}</div>;
}

/** After the totals: the template's terms and its footer. */
export function DocTerms({ template }: { template: PrintTemplate | null }) {
  if (!template?.terms && !template?.footer) return null;
  return (
    <>
      {template.terms && <section className="qdoc-note"><h3>Terms</h3><p>{template.terms}</p></section>}
      {template.footer && <footer className="qdoc-foot qdoc-foot-tpl">{template.footer}</footer>}
    </>
  );
}

function PrintShell({ back, backLabel, title, children }: { back: string; backLabel: string; title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = title;
    return () => { document.title = 'The One'; };
  }, [title]);
  return (
    <div className="qprint">
      <IconSprite />
      <div className="qprint-bar no-print">
        <Link className="btn" to={back}><Icon name="arrow-l" size={14} /> {backLabel}</Link>
        <span className="hint">Save as PDF from the print dialog.</span>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}><Icon name="file" size={14} /> Print / Save as PDF</button>
      </div>
      <article className="qdoc">{children}</article>
    </div>
  );
}

// ═══ Purchase order ══════════════════════════════════════════════════════════

export function PurchaseOrderPrintPage() {
  const { id = '' } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['purchasing', 'order', id], queryFn: () => getPurchaseOrder(id), enabled: id.length > 0 });
  const tpl = usePrintTemplate('purchase_order');
  const po = q.data?.order;
  if (q.isLoading) return <div className="qprint qprint-state">Preparing the document…</div>;
  if (!po) return <div className="qprint qprint-state"><b>No such purchase order</b><Link className="btn" to="/purchasing?tab=orders">Open Purchasing</Link></div>;
  return (
    <PrintShell back="/purchasing?tab=orders" backLabel="Back to Purchasing" title={`${po.po_number} · ${po.vendor.name}`}>
      <header className="qdoc-head">
        <div>
          <div className="qdoc-entity">{tpl?.company_name || 'Seamless FM'}</div>
          <div className="qdoc-kind">Purchase order{po.status === 'draft' ? ' — DRAFT, not issued' : po.status === 'cancelled' ? ' — CANCELLED' : ''}</div>
          <DocLetterhead template={tpl} />
        </div>
        <table className="qdoc-meta">
          <tbody>
            <tr><th>PO #</th><td className="mono">{po.po_number}</td></tr>
            <tr><th>Date</th><td>{po.order_date ?? po.created_at.slice(0, 10)}</td></tr>
            {po.expected_on && <tr><th>Expected</th><td>{po.expected_on}</td></tr>}
            {po.task && <tr><th>Work order</th><td className="mono">{po.task.wo_number}</td></tr>}
            <tr><th>Status</th><td>{PO_STATUS_LABELS[po.status]}</td></tr>
          </tbody>
        </table>
      </header>
      <section className="qdoc-parties">
        <div><h3>Vendor</h3><p>{po.vendor.name}</p></div>
        <div><h3>Ship to</h3><p>{po.ship_to?.trim() || '—'}</p></div>
      </section>
      <section className="qdoc-lines">
        <table className="qdoc-table">
          <thead><tr><th>Item</th><th className="num">Qty</th><th>Unit</th><th className="num">Unit cost</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {po.lines.map((l) => (
              <tr key={l.id}><td>{l.description}</td><td className="num">{l.qty}</td><td>{l.unit}</td><td className="num">{usd(l.unit_cost)}</td><td className="num">{usd(l.qty * (l.unit_cost ?? 0))}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="qdoc-totals">
        <table>
          <tbody>
            <tr><th>Subtotal</th><td>{usd(po.subtotal)}</td></tr>
            {po.tax > 0 && <tr><th>Tax{po.tax_rate_name ? ` (${po.tax_rate_name} · ${po.tax_pct}%)` : ''}</th><td>{usd(po.tax)}</td></tr>}
            <tr className="qdoc-grand"><th>Total</th><td>{usd(po.total)}</td></tr>
          </tbody>
        </table>
      </section>
      {po.note && <section className="qdoc-note"><h3>Note</h3><p>{po.note}</p></section>}
      <DocTerms template={tpl} />
    </PrintShell>
  );
}

// ═══ Invoice ═════════════════════════════════════════════════════════════════

export function InvoicePrintPage() {
  const { id = '' } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['invoice-print', id], queryFn: () => getInvoice(id), enabled: id.length > 0 });
  const tpl = usePrintTemplate('invoice');
  const inv = q.data?.invoice;
  if (q.isLoading) return <div className="qprint qprint-state">Preparing the document…</div>;
  if (!inv) return <div className="qprint qprint-state"><b>No such invoice</b><Link className="btn" to="/receivables">Open Receivables</Link></div>;
  const back = `/work-orders/${encodeURIComponent(inv.wo_number)}?tab=money`;
  return (
    <PrintShell back={back} backLabel="Back to the work order" title={`${inv.number} · ${inv.wo_number}`}>
      <header className="qdoc-head">
        <div>
          <div className="qdoc-entity">{tpl?.company_name || inv.billing_entity || 'Seamless FM'}</div>
          <div className="qdoc-kind">Invoice{inv.status === 'draft' ? ' — DRAFT, not sent' : inv.status === 'void' ? ' — VOID' : ''}</div>
          <DocLetterhead template={tpl} />
        </div>
        <table className="qdoc-meta">
          <tbody>
            <tr><th>Invoice #</th><td className="mono">{inv.number}</td></tr>
            <tr><th>Date</th><td>{(inv.issued_at ?? inv.created_at).slice(0, 10)}</td></tr>
            {inv.due_at && <tr><th>Due</th><td>{inv.due_at.slice(0, 10)}</td></tr>}
            <tr><th>Work order</th><td className="mono">{inv.wo_number}</td></tr>
          </tbody>
        </table>
      </header>
      <section className="qdoc-parties">
        <div><h3>Bill to</h3><p>{inv.client ?? '—'}</p></div>
        <div><h3>Site</h3><p>{inv.site ?? '—'}</p></div>
        {inv.title && <div className="qdoc-wide"><h3>Subject</h3><p>{inv.title}</p></div>}
      </section>
      <section className="qdoc-lines">
        <table className="qdoc-table">
          <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.id}><td>{l.description}</td><td className="num">{l.quantity}</td><td className="num">{usd(l.unit_price)}</td><td className="num">{usd(l.amount)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="qdoc-totals">
        <table>
          <tbody>
            <tr><th>Subtotal</th><td>{usd(inv.subtotal)}</td></tr>
            {inv.discount > 0 && <tr><th>Discount</th><td>−{usd(inv.discount)}</td></tr>}
            {inv.tax > 0 && <tr><th>Tax</th><td>{usd(inv.tax)}</td></tr>}
            <tr className="qdoc-grand"><th>Total</th><td>{usd(inv.total)}</td></tr>
          </tbody>
        </table>
      </section>
      {inv.note && <section className="qdoc-note"><h3>Note</h3><p>{inv.note}</p></section>}
      <DocTerms template={tpl} />
    </PrintShell>
  );
}
