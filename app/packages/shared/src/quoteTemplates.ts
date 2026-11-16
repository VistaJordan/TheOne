// Quote templates (migration 0145, Elise 2026-11-16).
//
// A saved set of quote content — Incurred and the options with their scope
// lines and line items, plus the specs and the note to the customer — that a
// quote is started from later. The content is the quote builder's own save
// shape (QuoteDraftBody, the shape the AI quote draft stores), so the builder
// loads it with the converter it already has.
//
// Who sees one: the person who saved it, until a quote approver (`quotes`
// approve) shares it with everyone. Pure: the API and the builder read the
// same rules.

import type { QuoteDraftBody } from './calls';

export const QUOTE_TEMPLATE_NAME_MAX = 120;
export const QUOTE_TEMPLATE_DESCRIPTION_MAX = 1000;

export interface QuoteTemplate {
  id: string;
  name: string;
  description: string | null;
  /** The trade it was written for (the work order's Trade when saved), or null. */
  trade: string | null;
  content: QuoteDraftBody;
  shared: boolean;
  /** Saved by the viewer. */
  mine: boolean;
  owner: string | null;
  /** The viewer may rename, share / unshare (an approver) or delete it. */
  can_manage: boolean;
  updated_at: string;
}

export interface QuoteTemplatesResponse {
  templates: QuoteTemplate[];
  /** The viewer may share a template with everyone (`quotes` approve). */
  can_share: boolean;
}

export interface QuoteTemplateInput {
  name: string;
  description?: string | null;
  trade?: string | null;
  shared?: boolean;
  content: QuoteDraftBody;
}

export interface QuoteTemplatePatch {
  name?: string;
  description?: string | null;
  trade?: string | null;
  shared?: boolean;
}

/** May this person rename / share / delete the template? Their own always; a
    shared one when they may share (an approver); a super admin any. */
export function mayManageQuoteTemplate(
  t: { created_by: string | null; shared: boolean },
  viewer: { id: string; canShare: boolean; isSuperAdmin: boolean },
): boolean {
  if (viewer.isSuperAdmin) return true;
  if (t.created_by !== null && t.created_by === viewer.id) return true;
  return t.shared && viewer.canShare;
}

/** True when the content holds something a quote is made of: a line item or
    a non-blank scope line in any section. An empty quote is not a template. */
export function quoteTemplateHasContent(content: QuoteDraftBody): boolean {
  return content.sections.some((s) => s.lines.length > 0 || s.scope_lines.some((l) => l.trim() !== ''));
}

/** "2 options · 7 lines" — what the template holds, for its row in the list. */
export function quoteTemplateSummary(content: QuoteDraftBody): string {
  const options = content.sections.filter((s) => s.kind === 'option').length;
  const lines = content.sections.reduce((n, s) => n + s.lines.length, 0);
  const parts = [
    `${options} option${options === 1 ? '' : 's'}`,
    `${lines} line${lines === 1 ? '' : 's'}`,
  ];
  return parts.join(' · ');
}
