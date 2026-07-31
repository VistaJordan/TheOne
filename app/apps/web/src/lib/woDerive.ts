/* Everything the detail page derives from a work order: money, people, site,
   dates, parts, flags and the soft-close checklist. Kept out of the components
   so each card stays a pure renderer and the null-handling lives in one place. */

import type { WorkOrderAttachment, WorkOrderDetailV2, Money } from '../api/client';
import {
  DASH,
  FIELD,
  FLAG_FIELDS,
  bool,
  dateVal,
  field,
  num,
  numericDate,
  str,
} from './fields';

// ── Money ────────────────────────────────────────────────────────────────────

/** Prefer the API's `money` block (S2 contract item 4); derive the same
    numbers from the promoted column + fields bag when it is absent. */
export function resolveMoney(wo: WorkOrderDetailV2): Money {
  if (wo.money) return wo.money;

  const f = wo.fields ?? {};
  const nte = wo.nte ?? num(field(f, FIELD.nte));
  const cost = num(field(f, FIELD.cost));
  const invoiced = num(field(f, FIELD.invoiced));
  const profit = num(field(f, FIELD.profit));
  // There is no dedicated quote field in the bag — null unless the API supplies it.
  const quote = null;
  const marginPct =
    profit != null && invoiced != null && invoiced !== 0
      ? (profit / invoiced) * 100
      : null;

  return { nte, quote, cost, invoiced, profit, marginPct };
}

/** The value the NTE meter compares against the NTE: quote if quoted, else invoiced. */
export function nteBasis(m: Money): { label: 'Quote' | 'Invoiced'; value: number } | null {
  if (m.quote != null) return { label: 'Quote', value: m.quote };
  if (m.invoiced != null) return { label: 'Invoiced', value: m.invoiced };
  return null;
}

/** The comp's warning line fires at 85% of NTE. */
export const NTE_WARN_PCT = 85;

// ── People ───────────────────────────────────────────────────────────────────

export interface Person {
  name: string;
  role: string;
  accent?: boolean;
}

export function derivePeople(wo: WorkOrderDetailV2): Person[] {
  const f = wo.fields ?? {};
  const out: Person[] = [];
  const seen = new Set<string>();

  const push = (name: string | null, role: string, accent = false) => {
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, role, accent });
  };

  push(str(field(f, FIELD.am)), 'AM · account manager', true);

  const home = wo.memberships?.find((m) => m.is_home);
  if (home) push(home.list_name, 'OM book · home list');

  push(str(field(f, FIELD.assigneeName)), 'Assignee');
  push(str(field(f, FIELD.completionAssignee)), 'Completion assignee');
  push(str(field(f, FIELD.previousAssignees)), 'Previous assignee');
  push(str(field(f, FIELD.salesOwner)), 'Sales owner');
  push(str(field(f, FIELD.facilityManager)), 'Facility manager');

  for (const m of wo.memberships ?? []) {
    if (!m.is_home) push(m.list_name, 'Routed list');
  }

  return out;
}

// ── Site ─────────────────────────────────────────────────────────────────────

export interface SiteInfo {
  name: string;
  addressLines: string[];
  /** Already prefixed ('Store #41669') when numeric; the raw name otherwise
      — a good half of the seeded 'Store' values are brand names, not numbers. */
  storeLabel: string | null;
  fm: string | null;
  mapCaption: string | null;
}

export function deriveSite(wo: WorkOrderDetailV2): SiteInfo {
  const f = wo.fields ?? {};
  const store = str(field(f, FIELD.store));
  // Same '22. FM' backstop as the header — see deriveHeaderMeta.
  const client = wo.client ?? str(field(f, 'Client')) ?? str(field(f, FIELD.fm));
  const name = [client, store && /^\d+$/.test(store) ? `#${store}` : null]
    .filter(Boolean)
    .join(' ') || client || store || 'Site not recorded';

  const address = str(field(f, FIELD.address));
  const locality = [wo.city ?? str(field(f, FIELD.city)), wo.state ?? str(field(f, FIELD.state))]
    .filter(Boolean)
    .join(', ');
  const zip = str(field(f, FIELD.zip));
  const localityLine = [locality, zip].filter(Boolean).join(' ');

  const addressLines: string[] = [];
  if (address) {
    // '5714 Broadway Avenue J, Galveston, TX 77551, USA' → street on line 1.
    const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      addressLines.push(parts[0]);
      addressLines.push(parts.slice(1).filter((p) => p.toUpperCase() !== 'USA').join(', '));
    } else {
      addressLines.push(address);
    }
  } else if (localityLine) {
    addressLines.push(localityLine);
  }

  const mapCaption = addressLines[0] || locality || null;

  return {
    name,
    addressLines: addressLines.filter(Boolean),
    storeLabel: store ? (/^\d+$/.test(store) ? `Store #${store}` : store) : null,
    fm: str(field(f, FIELD.fm)),
    mapCaption,
  };
}

// ── Dates ────────────────────────────────────────────────────────────────────

export interface DateRow {
  key: string;
  value: string | null;
  warn?: boolean;
}

/** Three anchors always render (so the card keeps a stable minimum shape);
    the rest appear only when dated — a card of six em-dashes reads as broken
    rather than as "not yet". */
export function deriveDates(wo: WorkOrderDetailV2): DateRow[] {
  const f = wo.fields ?? {};
  const sla = dateVal(field(f, FIELD.slaDue));
  const slaOverdue = sla != null && Date.parse(sla) < Date.now();

  const rows: (DateRow & { always?: boolean })[] = [
    { key: 'Received', value: numericDate(wo.date_received ?? dateVal(field(f, FIELD.dateReceived))), always: true },
    { key: 'ETA', value: numericDate(dateVal(field(f, FIELD.actEta))) },
    { key: 'SLA due', value: numericDate(sla), warn: slaOverdue, always: true },
    { key: 'Grey flag', value: numericDate(dateVal(field(f, FIELD.greyFlag))) },
    { key: 'Parts ordered', value: numericDate(dateVal(field(f, FIELD.partsOrderDate))) },
    { key: 'Invoiced', value: numericDate(dateVal(field(f, FIELD.invoiceDate))), always: true },
  ];

  return rows.filter((r) => r.always || r.value != null).map(({ key, value, warn }) => ({ key, value, warn }));
}

// ── Parts ────────────────────────────────────────────────────────────────────

export interface PartsInfo {
  tags: string[];
  orderedOn: string | null;
  detail: string | null;
}

/** The '👣 Order/Tracking Details' field is a fill-in template
    ("ETA:\nOrder #:\nTracking #:\nLink:") — only lines with a value count. */
export function deriveParts(wo: WorkOrderDetailV2): PartsInfo | null {
  const f = wo.fields ?? {};
  const raw = str(field(f, FIELD.orderTracking));
  const orderedOn = numericDate(dateVal(field(f, FIELD.partsOrderDate)));

  const filled: string[] = [];
  if (raw) {
    for (const line of raw.split('\n')) {
      const m = /^\s*(ETA|Order #|Tracking #|Link)\s*:\s*(.+?)\s*$/i.exec(line);
      if (m && m[2] && !/^~+$/.test(m[2])) filled.push(`${m[1]}: ${m[2]}`);
    }
  }

  if (filled.length === 0 && !orderedOn) return null;

  return {
    tags: filled.length > 0 ? [filled[0]] : [],
    orderedOn,
    detail: filled.length > 1 ? filled.slice(1).join(' · ') : null,
  };
}

// ── Flags ────────────────────────────────────────────────────────────────────

export interface FlagInfo {
  key: string;
  on: boolean;
}

export function deriveFlags(wo: WorkOrderDetailV2): FlagInfo[] {
  const f = wo.fields ?? {};
  return FLAG_FIELDS.map((key) => ({ key, on: bool(field(f, key)) }));
}

// ── Photos / attachments ─────────────────────────────────────────────────────

export interface PhotoGroups {
  before: WorkOrderAttachment[];
  after: WorkOrderAttachment[];
}

const IMAGE_RE = /\.(jpe?g|png|heic|webp|gif)$/i;

export function derivePhotos(wo: WorkOrderDetailV2): PhotoGroups {
  const all = (wo.attachments ?? []).filter(
    (a) => (a.content_type?.startsWith('image/') ?? false) || IMAGE_RE.test(a.file_name ?? ''),
  );
  // Without a visit model yet, client-visible attachments read as the "after"
  // (sign-off) set and everything else as the assessment "before" set.
  return {
    before: all.filter((a) => !a.client_visible),
    after: all.filter((a) => a.client_visible === true),
  };
}

/** '1 file(s)' → 1. The PDF field is the only file counter the bag carries. */
export function pdfFileCount(wo: WorkOrderDetailV2): number {
  const raw = str(field(wo.fields ?? {}, FIELD.pdf));
  if (!raw) return 0;
  const m = /(\d+)/.exec(raw);
  return m ? Number(m[1]) : 0;
}

// ── Soft-close checklist ─────────────────────────────────────────────────────

export interface ChecklistItem {
  label: string;
  done: boolean;
  note: string;
}

export function deriveChecklist(wo: WorkOrderDetailV2): ChecklistItem[] {
  const f = wo.fields ?? {};
  const photos = derivePhotos(wo);
  // Count PHOTOS only. '37. PDF' is the generated work-order PDF, not a site
  // photo, and it is present ("1 file(s)") on 21 of 28 seeded WOs — using it as
  // a fallback ticked "Before photos" off on pages whose Photos card correctly
  // read "0 before · 0 after", so the same page contradicted itself.
  const fileCount = photos.before.length + photos.after.length;

  const quoteCreated = bool(field(f, FIELD.quoteReadyToSend)) || str(field(f, FIELD.clientQuote)) != null;
  const quoteOn = numericDate(dateVal(field(f, FIELD.quoteCheckoutDate)));
  const am = str(field(f, FIELD.am));
  const invoiceOn = numericDate(dateVal(field(f, FIELD.invoiceDate)));

  return [
    {
      label: 'Quote created',
      done: quoteCreated,
      note: quoteCreated ? (quoteOn ?? 'Recorded') : 'Pending',
    },
    {
      label: 'Before photos',
      done: fileCount > 0,
      note: fileCount > 0 ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : 'None uploaded',
    },
    {
      label: 'Quote check',
      done: bool(field(f, FIELD.quoteCheck)),
      note: bool(field(f, FIELD.quoteCheck)) ? (am ?? 'Checked') : 'Pending',
    },
    {
      label: 'Admin check',
      done: bool(field(f, FIELD.adminCheck)),
      note: bool(field(f, FIELD.adminCheck)) ? (invoiceOn ?? 'Checked') : 'Pending',
    },
    {
      label: 'GTG',
      done: bool(field(f, FIELD.gtg)),
      note: bool(field(f, FIELD.gtg)) ? 'Good to go' : 'Pending',
    },
  ];
}

// ── Header meta ──────────────────────────────────────────────────────────────

export interface HeaderMeta {
  client: string;
  store: string | null;
  location: string | null;
  trade: string | null;
  billingEntity: string | null;
  priorityLabel: string | null;
}

export function deriveHeaderMeta(wo: WorkOrderDetailV2): HeaderMeta {
  const f = wo.fields ?? {};
  const store = str(field(f, FIELD.store));
  const location = [wo.city, wo.state].filter(Boolean).join(', ') || null;
  const priorityLabel =
    wo.priority === 'urgent' ? 'Urgent'
      : wo.priority === 'high' ? 'High priority'
        : null;

  return {
    // Only 12 of the 28 seeded WOs carry a 'Client' dropdown value; '22. FM'
    // (the FM company that dispatched the job) is populated on all of them and
    // is the same account by another name, so it backstops the headline.
    client: wo.client ?? str(field(f, 'Client')) ?? str(field(f, FIELD.fm)) ?? DASH,
    store: store ? (/^\d+$/.test(store) ? `Store #${store}` : store) : null,
    location,
    trade: wo.trade ?? str(field(f, 'Trade')),
    billingEntity: wo.billing_entity ?? str(field(f, FIELD.comp)),
    priorityLabel,
  };
}
