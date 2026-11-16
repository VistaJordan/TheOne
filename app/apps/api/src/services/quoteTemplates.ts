// Quote templates (migration 0145, Elise 2026-11-16).
//
// A saved set of quote content to start a quote from later. The content is
// the quote builder's own save shape (QuoteDraftBody), validated on the way
// in by the route with the same section schema PUT /quote uses, so a
// template always loads into the builder and saves back through the
// ordinary quote save — this module never writes a quote.
//
// Who sees one: the viewer's own templates and every shared one. Saving and
// using a template is for whoever builds quotes (`quotes` edit); sharing with
// everyone (and managing a shared one) is for a quote approver (`quotes`
// approve) — the people who decide what a quote should say. Every write is an
// admin audit row (entity `quote_template`, whole snapshots minus the content
// lines, which can be long: the counts say what it held).

import {
  QUOTE_TEMPLATE_DESCRIPTION_MAX,
  QUOTE_TEMPLATE_NAME_MAX,
  mayManageQuoteTemplate,
  permAllows,
  quoteTemplateHasContent,
  quoteTemplateSummary,
  type QuoteDraftBody,
  type QuoteTemplate,
  type QuoteTemplateInput,
  type QuoteTemplatePatch,
  type QuoteTemplatesResponse,
} from '@theone/shared';
import { query } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canBuild(a: ActingPrincipal): boolean {
  return permAllows(a.perms, 'quotes', 'edit', a.isSuperAdmin);
}
function canShare(a: ActingPrincipal): boolean {
  return permAllows(a.perms, 'quotes', 'approve', a.isSuperAdmin);
}
function requireBuild(a: ActingPrincipal): void {
  if (!canBuild(a)) throw forbidden('You cannot build quotes, so you cannot use quote templates', { required_permission: 'quotes:edit' });
}

function clean(s: string | null | undefined, max: number): string | null {
  const t = (s ?? '').trim();
  return t === '' ? null : t.slice(0, max);
}

type Row = {
  id: string;
  name: string;
  description: string | null;
  trade: string | null;
  content: QuoteDraftBody;
  shared: boolean;
  created_by: string | null;
  owner: string | null;
  updated_at: string;
};

const SELECT = `SELECT t.id::text AS id, t.name, t.description, t.trade, t.content, t.shared,
                       t.created_by::text AS created_by, p.display_name AS owner,
                       to_char(t.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
                  FROM quote_template t
                  LEFT JOIN principal p ON p.id = t.created_by`;

function toTemplate(r: Row, a: ActingPrincipal): QuoteTemplate {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    trade: r.trade,
    content: r.content,
    shared: r.shared,
    mine: r.created_by === a.id,
    owner: r.owner,
    can_manage: mayManageQuoteTemplate(r, { id: a.id, canShare: canShare(a), isSuperAdmin: a.isSuperAdmin }),
    updated_at: r.updated_at,
  };
}

/** The viewer's own templates and every shared one; their own first, then by name. */
export async function listQuoteTemplates(a: ActingPrincipal): Promise<QuoteTemplatesResponse> {
  requireBuild(a);
  const res = await query<Row>(
    `${SELECT}
      WHERE t.shared OR t.created_by = $1
      ORDER BY (t.created_by = $1) DESC NULLS LAST, lower(t.name)`,
    [a.id],
  );
  return { templates: res.rows.map((r) => toTemplate(r, a)), can_share: canShare(a) };
}

async function loadRow(id: string): Promise<Row> {
  if (!UUID_RE.test(id)) throw notFound('That template does not exist');
  const res = await query<Row>(`${SELECT} WHERE t.id = $1`, [id]);
  if (!res.rows[0]) throw notFound('That template does not exist');
  return res.rows[0];
}

/** What the audit row keeps: the name and settings, and what the content held. */
function snap(r: { name: string; description: string | null; trade: string | null; shared: boolean; content: QuoteDraftBody }) {
  return { name: r.name, description: r.description, trade: r.trade, shared: r.shared, holds: quoteTemplateSummary(r.content) };
}

export async function saveQuoteTemplate(input: QuoteTemplateInput, a: ActingPrincipal): Promise<QuoteTemplatesResponse> {
  requireBuild(a);
  const name = clean(input.name, QUOTE_TEMPLATE_NAME_MAX);
  if (!name) throw badRequest('The template needs a name', { field: 'name' });
  if (input.shared && !canShare(a)) throw forbidden('Only a quote approver can share a template with everyone');
  if (!quoteTemplateHasContent(input.content)) throw badRequest('Add a line or a scope line before saving the quote as a template');
  const row = {
    name,
    description: clean(input.description, QUOTE_TEMPLATE_DESCRIPTION_MAX),
    trade: clean(input.trade, 80),
    shared: Boolean(input.shared),
    content: input.content,
  };
  const ins = await query<{ id: string }>(
    `INSERT INTO quote_template (name, description, trade, content, shared, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id::text AS id`,
    [row.name, row.description, row.trade, JSON.stringify(row.content), row.shared, a.id],
  );
  await logAdminEvent({ actorId: a.id, entity: 'quote_template', entityId: ins.rows[0].id, action: 'quote_template_created', after: snap(row) });
  return listQuoteTemplates(a);
}

export async function updateQuoteTemplate(id: string, patch: QuoteTemplatePatch, a: ActingPrincipal): Promise<QuoteTemplatesResponse> {
  requireBuild(a);
  const cur = await loadRow(id);
  if (!mayManageQuoteTemplate(cur, { id: a.id, canShare: canShare(a), isSuperAdmin: a.isSuperAdmin })) {
    throw forbidden('That template belongs to someone else');
  }
  if (patch.shared !== undefined && patch.shared !== cur.shared && !canShare(a)) {
    throw forbidden('Only a quote approver can share a template with everyone, or stop sharing it');
  }
  const next = {
    name: patch.name !== undefined ? clean(patch.name, QUOTE_TEMPLATE_NAME_MAX) : cur.name,
    description: patch.description !== undefined ? clean(patch.description, QUOTE_TEMPLATE_DESCRIPTION_MAX) : cur.description,
    trade: patch.trade !== undefined ? clean(patch.trade, 80) : cur.trade,
    shared: patch.shared !== undefined ? patch.shared : cur.shared,
    content: cur.content,
  };
  if (!next.name) throw badRequest('The template needs a name', { field: 'name' });
  await query(
    `UPDATE quote_template SET name = $2, description = $3, trade = $4, shared = $5 WHERE id = $1`,
    [id, next.name, next.description, next.trade, next.shared],
  );
  await logAdminEvent({
    actorId: a.id,
    entity: 'quote_template',
    entityId: id,
    action: 'quote_template_updated',
    before: snap(cur),
    after: snap({ ...next, name: next.name }),
  });
  return listQuoteTemplates(a);
}

export async function deleteQuoteTemplate(id: string, a: ActingPrincipal): Promise<QuoteTemplatesResponse> {
  requireBuild(a);
  const cur = await loadRow(id);
  if (!mayManageQuoteTemplate(cur, { id: a.id, canShare: canShare(a), isSuperAdmin: a.isSuperAdmin })) {
    throw forbidden('That template belongs to someone else');
  }
  await query(`DELETE FROM quote_template WHERE id = $1`, [id]);
  await logAdminEvent({ actorId: a.id, entity: 'quote_template', entityId: id, action: 'quote_template_deleted', before: snap(cur) });
  return listQuoteTemplates(a);
}
