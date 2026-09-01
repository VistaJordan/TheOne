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
  // Profit is a FORMULA: always Total Invoiced − Cost (the stored field is a
  // snapshot the server keeps in step but display never trusts). An absent
  // input counts as $0; both absent → no profit to show.
  const profit =
    cost == null && invoiced == null
      ? null
      : Math.round(((invoiced ?? 0) - (cost ?? 0)) * 100) / 100;
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
  /** Catalogue key when a single editable bag field backs the row. */
  fieldKey?: string;
}

/** One of the named seats on a work order. The slot exists whether or not it
    is filled: "who is the team lead?" deserves the answer "nobody yet", and a
    row that simply vanishes when empty cannot give it. */
export interface PersonSlot {
  role: string;
  /** Everyone in the seat — these bag fields are comma-joined name lists. */
  names: string[];
  accent?: boolean;
  fieldKey?: string;
}

export interface WoPeople {
  /** The six seats, always in this order. */
  slots: PersonSlot[];
  /** Lists and client-side contacts — attached to the WO, not seated on it. */
  attached: Person[];
}

/** A `users`-type bag value ("Matt Hammond, Bob Sanders") as separate names. */
function names(v: unknown): string[] {
  const raw = str(v);
  if (!raw) return [];
  return raw.split(',').map((n) => n.trim()).filter(Boolean);
}

export function derivePeople(wo: WorkOrderDetailV2): WoPeople {
  const f = wo.fields ?? {};

  // Deliberately NOT de-duplicated across slots. The previous version dropped
  // a name it had already printed, which meant the common case — the assignee
  // is also the only previous assignee — silently erased the whole Previous
  // assignees row. Each seat answers for itself.
  const slots: PersonSlot[] = [
    { role: 'Account manager', names: names(field(f, FIELD.am)), accent: true,
      fieldKey: `fields.${FIELD.am}` },
    { role: 'Team lead', names: names(field(f, FIELD.teamLead)),
      fieldKey: `fields.${FIELD.teamLead}` },
    // The dropdown is the field the list filters on; the older free-text
    // 'Assignee Name TXT' backstops WOs imported before it existed. The editor
    // writes the dropdown either way (same rule as the header).
    { role: 'Assignee',
      names: names(field(f, FIELD.assignee) ?? field(f, FIELD.assigneeName)),
      fieldKey: `fields.${FIELD.assignee}` },
    { role: 'Completion assignee', names: names(field(f, FIELD.completionAssignee)),
      fieldKey: `fields.${FIELD.completionAssignee}` },
    { role: 'Previous assignees', names: names(field(f, FIELD.previousAssignees)),
      fieldKey: `fields.${FIELD.previousAssignees}` },
    { role: 'Sales owner', names: names(field(f, FIELD.salesOwner)),
      fieldKey: `fields.${FIELD.salesOwner}` },
  ];

  const attached: Person[] = [];
  const push = (name: string | null, role: string, fieldKey?: string) => {
    if (name) attached.push({ name, role, fieldKey });
  };

  const home = wo.memberships?.find((m) => m.is_home);
  if (home) push(home.list_name, 'OM book · home list');
  for (const m of wo.memberships ?? []) if (!m.is_home) push(m.list_name, 'Routed list');
  push(str(field(f, FIELD.facilityManager)), 'Facility manager (client side)');

  return { slots, attached };
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
  /** Catalogue key (`fields.<bag key>`) when an editable bag field backs the
      row — the card wires an inline editor to it. Received has none: it comes
      from the promoted import column. */
  fieldKey?: string;
  /** Anchors that render even when empty, so the card keeps a stable shape. */
  always?: boolean;
}

/** Returns every row; the card decides which empty ones to show (anchors for
    everyone, all of them for editors — an empty row is how a date gets set). */
export function deriveDates(wo: WorkOrderDetailV2): DateRow[] {
  const f = wo.fields ?? {};
  const sla = dateVal(field(f, FIELD.slaDue));
  const slaOverdue = sla != null && Date.parse(sla) < Date.now();

  return [
    { key: 'Received', value: numericDate(wo.date_received ?? dateVal(field(f, FIELD.dateReceived))), always: true },
    { key: 'ETA', value: numericDate(dateVal(field(f, FIELD.actEta))), fieldKey: `fields.${FIELD.actEta}` },
    { key: 'SLA due', value: numericDate(sla), warn: slaOverdue, always: true, fieldKey: `fields.${FIELD.slaDue}` },
    { key: 'Grey flag', value: numericDate(dateVal(field(f, FIELD.greyFlag))), fieldKey: `fields.${FIELD.greyFlag}` },
    { key: 'Parts ordered', value: numericDate(dateVal(field(f, FIELD.partsOrderDate))), fieldKey: `fields.${FIELD.partsOrderDate}` },
    { key: 'Invoiced', value: numericDate(dateVal(field(f, FIELD.invoiceDate))), always: true, fieldKey: `fields.${FIELD.invoiceDate}` },
  ];
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
