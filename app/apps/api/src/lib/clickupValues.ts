// 0078 · Our work-order values in the shapes ClickUp's API takes. Pure: the
// sync (services/clickup.ts) reads the row, this turns each mapped value into
// what one ClickUp call sends, and tests/clickup.test.ts pins the shapes.
//
// Our bag keeps the original ClickUp field names verbatim (field_def.key), so
// the automatic match is by name; `matchName` forgives case, spacing,
// punctuation and the emoji markers ("16. Client NTE 🔴").

import { CLICKUP_WRITABLE_TYPES, clickUpFits, type ClickUpFieldDef } from '@theone/shared';
import { wallToInstant } from './businessDays.js';

export const matchName = (s: string): string =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/#/g, ' number ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The same without ClickUp's ordering prefix ("32. Tech Name" → "tech name"),
    the second-chance match when no field carries the exact name. */
export const bareName = (s: string): string => matchName(s).replace(/^\d+ /, '');

/** A person's name for matching our display name to a ClickUp username. */
export const personKey = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/[^a-z]/g, '');

export const WRITABLE_CU_TYPES = new Set(CLICKUP_WRITABLE_TYPES);

/** Empty in every sense the bag has: null, '', whitespace. */
export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** A date / datetime value as ClickUp's epoch milliseconds, and whether the
    time of day is meaningful. Our stamps are Chicago wall time. */
export function toCuDate(v: unknown): { ms: number; time: boolean } | null {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const d = wallToInstant(s);
  if (!d) return null;
  return { ms: d.getTime(), time: /\d{2}:\d{2}/.test(s) };
}

/** The Vista space's ClickUp status names → ours. The same table the seed
    reads ClickUp's export through (packages/db/src/seed.ts STATUS_ALIAS);
    keep the two in step. */
export const CLICKUP_STATUS_ALIASES: Record<string, string> = {
  emergency: 'Emergency',
  'assessment scheduled': 'Assessment Sched',
  'job scheduled': 'Job Sched',
  'pm scheduled': 'PM Sched',
  'assessment ongoing': 'On Site (Assessment)',
  'job ongoing': 'On Site (Job)',
  'return trip needed': 'Return Trip Needed',
  'waiting for quote': 'Waiting for Quote',
  'quote ready': 'Quote Ready',
  'waiting for parts': 'Waiting for Parts',
  'please order parts': 'Please Order Parts',
  '!! waiting for advice': 'Waiting for Advice',
  '!! waiting for approval': 'Waiting for Approval',
  approved: 'Approved',
  '!! approved': 'Approved',
  '!! ready to invoice': 'Ready to Invoice',
  'done/incurred': 'Done / Incurred',
  '<< invoiced not paid >>': 'Invoiced Not Paid',
  invoiced: 'Invoiced',
  '!! canceled/postponed': 'Cancelled / Postponed',
};

/** Our statuses that are never sent as a ClickUp status. Invoiced: in the
    team's ClickUp an invoiced work order is told by "Total Invoiced" being
    filled (Elise, 2026-10-13), not by a status, and The One fills Total
    Invoiced on the move to Invoiced — so the task keeps its ClickUp status
    and the amount carries the news. */
export const CLICKUP_STATUS_NOT_SENT = new Set(['invoiced']);

export const statusSent = (ours: string): boolean => !CLICKUP_STATUS_NOT_SENT.has(ours.trim().toLowerCase());

/** Our status as the List spells it: through the alias table, else the same
    name give or take case and punctuation ("!! approved" = "Approved").
    Null when the List has nothing that fits. With no statuses known yet, our
    name lower-cased. */
export function toCuStatus(ours: string, cuStatuses: string[]): string | null {
  if (cuStatuses.length === 0) return ours.toLowerCase();
  const want = matchName(ours);
  const hit =
    cuStatuses.find((s) => matchName(CLICKUP_STATUS_ALIASES[s.toLowerCase()] ?? '') === want) ??
    cuStatuses.find((s) => matchName(s) === want);
  return hit ?? null;
}

/** 'urgent' | 'high' | 'normal' | 'low' → ClickUp's 1–4; anything else none. */
export function toCuPriority(v: unknown): number | null {
  const s = String(v ?? '').trim().toLowerCase();
  return ({ urgent: 1, high: 2, normal: 3, low: 4 } as Record<string, number>)[s] ?? null;
}

/** A person field holds display names, comma-joined. */
export function splitNames(v: unknown): string[] {
  if (isBlank(v)) return [];
  const parts = Array.isArray(v) ? v.map(String) : String(v).split(',');
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** People's ClickUp ids, from our names. `missing` lists names with no match. */
export function userIds(v: unknown, idByName: Map<string, number>): { ids: number[]; missing: string[] } {
  const ids: number[] = [];
  const missing: string[] = [];
  for (const n of splitNames(v)) {
    const id = idByName.get(n.toLowerCase());
    if (id === undefined) missing.push(n);
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, missing };
}

export type CuValue =
  | { kind: 'set'; value: unknown; options?: { time: boolean } }
  | { kind: 'clear' }
  | { kind: 'error'; message: string };

const optionName = (o: { name?: string; label?: string }) => (o.name ?? o.label ?? '').trim();

/** The option for one of our values: same name, else the same name behind
    ClickUp's ordering prefix ("1. Checked-in" for "Checked-in"). Only the
    ClickUp side loses its prefix, so "7-Eleven" never reads as "Eleven". */
export function findOption<O extends { name?: string; label?: string }>(options: O[], value: string): O | undefined {
  const want = matchName(value);
  return options.find((o) => matchName(optionName(o)) === want) ?? options.find((o) => bareName(optionName(o)) === want);
}

/** One of our values for one ClickUp custom field. Users fields return the
    full id list as `value`; the caller turns it into ClickUp's {add, rem}. */
export function toCuFieldValue(field: ClickUpFieldDef, v: unknown, idByName: Map<string, number>): CuValue {
  if (isBlank(v) || (field.type === 'labels' && splitNames(v).length === 0)) return { kind: 'clear' };
  switch (field.type) {
    case 'drop_down': {
      const opt = findOption(field.options ?? [], String(v));
      return opt ? { kind: 'set', value: opt.id } : { kind: 'error', message: `"${String(v)}" is not an option of ClickUp's "${field.name}"` };
    }
    case 'labels': {
      const ids: string[] = [];
      for (const n of splitNames(v)) {
        const opt = findOption(field.options ?? [], n);
        if (!opt) return { kind: 'error', message: `"${n}" is not a label of ClickUp's "${field.name}"` };
        ids.push(opt.id);
      }
      return { kind: 'set', value: ids };
    }
    case 'number':
    case 'currency':
    case 'emoji': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
      if (!Number.isFinite(n)) return { kind: 'error', message: `"${String(v)}" is not a number for ClickUp's "${field.name}"` };
      return { kind: 'set', value: field.type === 'emoji' ? Math.round(n) : n };
    }
    case 'date': {
      const d = toCuDate(v);
      return d ? { kind: 'set', value: d.ms, options: { time: d.time } } : { kind: 'error', message: `"${String(v)}" is not a date` };
    }
    case 'checkbox': {
      const s = String(v).toLowerCase();
      return { kind: 'set', value: v === true || ['true', 'yes', '1'].includes(s) };
    }
    case 'users': {
      const { ids, missing } = userIds(v, idByName);
      if (missing.length) return { kind: 'error', message: `No ClickUp member for ${missing.join(', ')} (matched by email or name)` };
      return { kind: 'set', value: ids };
    }
    default:
      return { kind: 'set', value: typeof v === 'object' ? JSON.stringify(v) : String(v) };
  }
}

export const fits = clickUpFits;

/** Stable comparison key for "did this value change since the last push". */
export function sig(v: unknown): string {
  if (v === undefined) return 'null';
  return JSON.stringify(v);
}
