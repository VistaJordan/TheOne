// Which quotes carry tax (Elise, 2026-11-04). Only Seamless (SFM) charges the
// client tax on a quote; every other billing entity's quote shows none — no
// sales tax, no per-line tax, nothing added to the total. Pure: the API's
// computeQuoteTotals and the builder's copy both read it, so the screen, the
// printed quote, the text summary and the invoice prefill agree.

/** The one billing entity (`21. Comp`) whose quotes carry tax. */
export const QUOTE_TAX_ENTITY = 'SFM';

/** True when a quote for a work order billed by this entity carries tax. */
export function quoteTaxApplies(billingEntity: string | null | undefined): boolean {
  return (billingEntity ?? '').trim().toUpperCase() === QUOTE_TAX_ENTITY;
}
