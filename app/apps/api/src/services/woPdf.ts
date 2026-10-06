// 0073 · Save a work order as a PDF.
//
// Two halves. The LAYOUTS (Admin › Settings › Work-order PDFs): one row per
// kind in `wo_pdf_layout` — a title, the ordered catalogue keys to print and
// whether empty fields are left off — read with the field catalogue so the
// editor can offer every field by section, written under admin/settings
// edit and logged like every other admin change. And the DOCUMENT: the work
// order read the way the page reads it (getWorkOrderDetail), trimmed by the
// same redaction (a field the person may not see is never printed, whatever
// the layout says), each value formatted for paper, and handed to the
// renderer in the billing entity's branding. Saving one is a button, so it
// lands in the work order's activity (rule 1.2.1).

import {
  FIELD_SECTIONS,
  HEADER_SECTION_SLUG,
  HEADER_SECTION_TITLE,
  MORE_SECTION_TITLE,
  SIGNOFF_ENTITY_NAMES,
  WO_PDF_CORE_KEYS,
  WO_PDF_DEFAULTS,
  WO_PDF_KINDS,
  WO_PDF_PERM_KEY,
  fieldSectionSlug,
  permAllows,
  signoffLayoutFor,
  woPdfFileName,
  type PermAction,
  type WoPdfFieldInfo,
  type WoPdfKind,
  type WoPdfLayout,
  type WoPdfLayoutInput,
  type WoPdfLayoutsResponse,
} from '@theone/shared';
import { query } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { renderWorkOrderPdf, stampText, type WoPdfRow } from '../lib/woPdf.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent, snapshotsDiffer, type Snapshot } from './adminAudit.js';
import { allowFor, canViewField, redactWorkOrder, requirePerm } from './permissions.js';
import { getFieldCatalogue, type FieldDescriptor } from './woFields.js';
import { getWorkOrderDetail } from './workOrders.js';

const SETTINGS_KEY = 'admin/settings';
const CHICAGO = 'America/Chicago';
const MAX_ITEMS = 80;

const can = (a: ActingPrincipal, key: string, action: PermAction): boolean => permAllows(a.perms, key, action, a.isSuperAdmin);

// ── The layouts ──────────────────────────────────────────────────────────────

interface LayoutRow {
  kind: WoPdfKind;
  title: string;
  items: unknown;
  hide_empty: boolean;
  note: string | null;
  updated_at: Date | string | null;
}

function fromRow(r: LayoutRow): WoPdfLayout {
  const items = Array.isArray(r.items) ? r.items.filter((k): k is string => typeof k === 'string') : [];
  return {
    kind: r.kind,
    title: r.title,
    items,
    hide_empty: r.hide_empty,
    note: r.note,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

function fallback(kind: WoPdfKind): WoPdfLayout {
  const d = WO_PDF_DEFAULTS[kind];
  return { kind, title: d.title, items: [...d.items], hide_empty: d.hide_empty, note: null, updated_at: null };
}

async function loadLayouts(): Promise<Record<WoPdfKind, WoPdfLayout>> {
  const res = await query<LayoutRow>(`SELECT kind, title, items, hide_empty, note, updated_at FROM wo_pdf_layout`);
  const out = { full: fallback('full'), request: fallback('request') } as Record<WoPdfKind, WoPdfLayout>;
  for (const r of res.rows) if ((WO_PDF_KINDS as readonly string[]).includes(r.kind)) out[r.kind] = fromRow(r);
  return out;
}

async function loadLayout(kind: WoPdfKind): Promise<WoPdfLayout> {
  const res = await query<LayoutRow>(`SELECT kind, title, items, hide_empty, note, updated_at FROM wo_pdf_layout WHERE kind = $1`, [kind]);
  return res.rows[0] ? fromRow(res.rows[0]) : fallback(kind);
}

const SECTION_TITLE = new Map<string, string>(FIELD_SECTIONS.map((s) => [s.slug, s.title]));

/** Every field a layout may list, with the section the Roles screen and the
    All-fields tab file it under. */
function offeredFields(fields: FieldDescriptor[]): WoPdfFieldInfo[] {
  const core = new Set<string>(WO_PDF_CORE_KEYS);
  const out: WoPdfFieldInfo[] = [];
  for (const f of fields) {
    if (f.custom) {
      if (f.computed) continue;
    } else if (!core.has(f.key)) continue;
    const slug = fieldSectionSlug(f.key);
    const section = slug === HEADER_SECTION_SLUG ? HEADER_SECTION_TITLE : (SECTION_TITLE.get(slug) ?? MORE_SECTION_TITLE);
    out.push({ key: f.key, label: f.label, section });
  }
  return out;
}

export async function getPdfLayouts(actor: ActingPrincipal): Promise<WoPdfLayoutsResponse> {
  requirePerm(actor, SETTINGS_KEY, 'view', 'You cannot open Admin › Settings');
  const [layouts, cat] = await Promise.all([loadLayouts(), getFieldCatalogue()]);
  return {
    layouts: WO_PDF_KINDS.map((k) => layouts[k]),
    fields: offeredFields(cat.fields),
    can: { edit: can(actor, SETTINGS_KEY, 'edit') },
  };
}

function snapshotOf(l: WoPdfLayout): Snapshot {
  return { name: l.title, kind: l.kind, title: l.title, items: l.items, hide_empty: l.hide_empty, note: l.note };
}

export async function savePdfLayout(kind: WoPdfKind, input: WoPdfLayoutInput, actor: ActingPrincipal): Promise<WoPdfLayoutsResponse> {
  requirePerm(actor, SETTINGS_KEY, 'edit', 'You cannot edit Admin › Settings');
  if (!(WO_PDF_KINDS as readonly string[]).includes(kind)) throw notFound('That document kind does not exist');
  const [before, cat] = await Promise.all([loadLayout(kind), getFieldCatalogue()]);

  const next: WoPdfLayout = { ...before };
  if (input.title !== undefined) {
    const t = input.title.trim().slice(0, 80);
    if (!t) throw badRequest('Give the document a title', { field: 'title' });
    next.title = t;
  }
  if (input.items !== undefined) {
    const offered = new Map(offeredFields(cat.fields).map((f) => [f.key, f.label]));
    const seen = new Set<string>();
    const items: string[] = [];
    for (const raw of input.items) {
      const k = String(raw);
      if (seen.has(k)) continue;
      if (!offered.has(k)) throw badRequest(`"${k}" is not a field that can go on the PDF`, { field: 'items', key: k });
      seen.add(k);
      items.push(k);
    }
    if (items.length > MAX_ITEMS) throw badRequest(`At most ${MAX_ITEMS} fields fit on one document`, { field: 'items' });
    next.items = items;
  }
  if (input.hide_empty !== undefined) next.hide_empty = input.hide_empty;
  if (input.note !== undefined) {
    const n = (input.note ?? '').trim().slice(0, 1000);
    next.note = n === '' ? null : n;
  }

  await query(
    `INSERT INTO wo_pdf_layout (kind, title, items, hide_empty, note, updated_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, now())
     ON CONFLICT (kind) DO UPDATE
        SET title = EXCLUDED.title, items = EXCLUDED.items, hide_empty = EXCLUDED.hide_empty,
            note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [kind, next.title, JSON.stringify(next.items), next.hide_empty, next.note, actor.id],
  );

  const a = snapshotOf(next);
  const b = snapshotOf(before);
  if (snapshotsDiffer(b, a)) {
    await logAdminEvent({ actorId: actor.id, entity: 'wo_pdf_layout', entityId: kind, action: 'wo_pdf_layout_updated', before: b, after: a });
  }
  return getPdfLayouts(actor);
}

// ── Values on paper ──────────────────────────────────────────────────────────

const usd = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.-]/g, ''));
    return v.trim() !== '' && Number.isFinite(n) ? n : null;
  }
  return null;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A date value as stored: ISO text, a 'YYYY-MM-DD' day, or ClickUp's epoch
    milliseconds (as a number or a numeric string). */
function dateOf(v: unknown): { at: Date; dayOnly: boolean } | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : { at: v, dayOnly: false };
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? { at: new Date(v), dayOnly: false } : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  const m = DAY_RE.exec(s);
  if (m) return { at: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))), dayOnly: true };
  if (/^\d{11,14}$/.test(s)) return { at: new Date(Number(s)), dayOnly: false };
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : { at: new Date(t), dayOnly: false };
}

function dayText(d: Date, utc: boolean): string {
  return d.toLocaleDateString('en-US', { timeZone: utc ? 'UTC' : CHICAGO, month: 'short', day: 'numeric', year: 'numeric' });
}

function scalarText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(scalarText).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['name', 'label', 'value', 'username', 'email']) {
      if (typeof o[k] === 'string' && (o[k] as string).trim()) return o[k] as string;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

/** One value as the document prints it; null when there is nothing to print. */
export function formatForPdf(v: unknown, desc: Pick<FieldDescriptor, 'type' | 'subtype' | 'options'> | null): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  if (Array.isArray(v) && v.length === 0) return null;
  const type = desc?.type ?? 'text';
  switch (type) {
    case 'money': {
      const n = numberOf(v);
      return n === null ? scalarText(v) || null : usd(n);
    }
    case 'number': {
      const n = numberOf(v);
      return n === null ? scalarText(v) || null : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v ? 'Yes' : 'No';
      const s = String(v).trim().toLowerCase();
      if (['true', 'yes', '1', 'checked'].includes(s)) return 'Yes';
      if (['false', 'no', '0', ''].includes(s)) return 'No';
      return scalarText(v) || null;
    }
    case 'date':
    case 'datetime': {
      const d = dateOf(v);
      if (!d) return scalarText(v) || null;
      if (type === 'date' || d.dayOnly) return dayText(d.at, d.dayOnly);
      return stampText(d.at);
    }
    case 'select': {
      const s = scalarText(v);
      if (!s) return null;
      const opt = desc?.options?.find((o) => o.value === s);
      return opt?.label ?? s;
    }
    default: {
      const s = scalarText(v);
      return s.trim() === '' ? null : s;
    }
  }
}

/** The label as it reads on paper: no ClickUp numbering, no emoji. */
export function paperLabel(label: string): string {
  return label
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/[^\x20-\x7e\xa1-\xff]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*$/, '')
    .trim() || label;
}

const WIDE_SUBTYPES = new Set(['long_text', 'text_area', 'textarea', 'rich_text']);
const WIDE_KEYS = new Set(['description', 'title', 'fields.35. WO Description', 'fields.Parts Required', 'fields.20. Last Update', 'fields.Admin Comment', 'fields.MoD Call Notes']);

function isWide(key: string, desc: FieldDescriptor | undefined, text: string | null): boolean {
  if (WIDE_KEYS.has(key)) return true;
  if (desc?.subtype && WIDE_SUBTYPES.has(desc.subtype)) return true;
  return text !== null && (text.length > 90 || text.includes('\n'));
}

// ── The document ─────────────────────────────────────────────────────────────

export interface WoPdfFile {
  bytes: Uint8Array;
  fileName: string;
}

export async function workOrderPdf(taskId: string, kind: WoPdfKind, actor: ActingPrincipal): Promise<WoPdfFile> {
  requirePerm(actor, 'work_orders', 'view', 'You cannot view work orders');
  requirePerm(actor, WO_PDF_PERM_KEY, 'view', 'You cannot save work orders as PDF');

  const [detail, layout, cat] = await Promise.all([getWorkOrderDetail(taskId), loadLayout(kind), getFieldCatalogue()]);
  if (!detail) throw notFound('Work order not found');

  // The branding is the entity's, whoever is looking: read it before the
  // redaction can blank it.
  const comp = detail.billing_entity ?? (typeof detail.fields['21. Comp'] === 'string' ? (detail.fields['21. Comp'] as string) : null);
  const brand = signoffLayoutFor(comp, detail.client);
  const entityName = brand ? SIGNOFF_ENTITY_NAMES[brand] : (comp ?? 'The One');

  const allow = allowFor(actor);
  redactWorkOrder(allow, detail);
  const byKey = new Map(cat.fields.map((f) => [f.key, f]));

  const rows: WoPdfRow[] = [];
  for (const key of layout.items) {
    if (!canViewField(allow, key)) continue;
    const desc = byKey.get(key);
    if (!desc) continue; // a field that no longer exists
    let raw: unknown;
    if (key.startsWith('fields.')) raw = detail.fields[key.slice('fields.'.length)];
    else if (key === 'status') raw = detail.status?.name ?? null;
    else raw = (detail as unknown as Record<string, unknown>)[key];
    let text = formatForPdf(raw, desc);
    if (key === 'priority' && text) text = text.charAt(0).toUpperCase() + text.slice(1);
    if (text === null && layout.hide_empty) continue;
    rows.push({ label: paperLabel(desc.label), value: text, wide: isWide(key, desc, text) });
  }

  const now = new Date();
  const bytes = await renderWorkOrderPdf({
    layout: brand,
    entity_name: entityName,
    kind,
    title: layout.title,
    wo_number: detail.wo_number,
    headline: detail.title,
    rows,
    note: layout.note,
    generated_at: now,
    generated_by: actor.name,
  });
  const fileName = woPdfFileName(detail.wo_number, kind);

  // Rule 1.2.1: a download is a button. The file is not kept.
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'work_order_pdf_saved', NULL, NULL, $3::jsonb)`,
    [actor.id, taskId, JSON.stringify({ kind, title: layout.title, file_name: fileName, fields: rows.length, entity: entityName })],
  );

  return { bytes, fileName };
}
