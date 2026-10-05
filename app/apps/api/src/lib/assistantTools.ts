// 0068 · What the assistant can look up, and how a look-up becomes requests.
//
// Every look-up is one or more of the app's own GET routes. Nothing here runs
// a query: `planLookup` turns the model's tool call into the paths to fetch,
// services/assistant.ts fetches them through the app with the asker's session
// (so each route's permission checks, work-order scope and field redaction
// apply exactly as on screen), and `shapeResult` cuts the answers down to what
// is worth the model's attention.
//
// The list of routes below is the whole surface. The model names a resource,
// never a path, so it cannot reach a route that is not written here — no admin
// console, no exports, nothing that writes.

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { filterRows, lookupResultText, rowsOf } from '@theone/shared';

// ── Tool definitions (what the model is shown) ───────────────────────────────

const WO_PARTS = {
  details: { path: '', about: 'every field on the work order' },
  updates: { path: '/feed', about: 'comments and activity, newest first' },
  messages: { path: '/messages', about: 'the message thread, internal and to the client' },
  visits: { path: '/visits', about: 'each trip to the site with check-in and check-out' },
  quote: { path: '/quote', about: 'the quote with its lines and totals' },
  payments: { path: '/payment-requests', about: 'vendor payment requests' },
  invoice: { path: '/invoice', about: 'the bill to the client' },
  vendor_bills: { path: '/vendor-bills', about: 'bills from vendors' },
  billing_proposals: { path: '/billing-proposals', about: 'what a contract proposes to bill' },
  approvals: { path: '/approval-tasks', about: 'NTE increases, status change requests and other decisions' },
  calls: { path: '/calls', about: 'phone calls placed from it, with transcripts' },
  record: { path: '/record', about: 'responsible vendor, pauses, ETA, tags, checklist, completion codes' },
  place: { path: '/place', about: 'its site and asset records' },
  contract: { path: '/contract', about: 'the client contract and rates that apply' },
  technicians: { path: '/technicians', about: 'technicians attached to it' },
  maintenance: { path: '/maintenance', about: 'job plans, services, time entries and work permits' },
  purchasing: { path: '/purchasing', about: 'purchase requests and orders raised for it' },
  dispatch: { path: '/dispatch', about: 'offers made to vendors' },
  attachments: { path: '/attachments', about: 'photos and files (names and review state, not the files)' },
  field_times: { path: '/field-times', about: 'when each field last changed' },
} as const;

type WoPart = keyof typeof WO_PARTS;
const WO_PART_NAMES = Object.keys(WO_PARTS) as [WoPart, ...WoPart[]];

interface Resource {
  path: string;
  /** Path for one record, `:id` replaced. */
  one?: string;
  about: string;
  /** Query parameters the route itself understands. When present the route
      does the searching and paging; otherwise the whole list comes back and
      is narrowed here. */
  params?: string;
}

const RESOURCES: Record<string, Resource> = {
  quotes: { path: '/quotes', about: 'every quote: work order, status (draft, pending_approval, approved, sent), totals' },
  payments: { path: '/payments', about: 'vendor payment requests: status (requested, approved, rejected, sent, paid), amount, vendor, work order' },
  approvals: { path: '/approvals', about: 'the approvals inbox: NTE increases, status change requests, incoming work orders, with who raised and who decided' },
  approval_counts: { path: '/approvals/counts', about: 'how many decisions are waiting, by kind' },
  invoices: { path: '/invoices', one: '/invoices/:id', about: 'bills to clients: status, amounts, work order' },
  vendor_bills: { path: '/vendor-bills', one: '/vendor-bills/:id', about: 'bills from vendors: status, amounts, vendor, work order' },
  billing_proposals: { path: '/billing-proposals', about: 'invoices and vendor bills proposed on completion, waiting to be confirmed' },
  contracts: { path: '/contracts', one: '/contracts/:id', about: 'client rate cards and vendor terms' },
  vendors: {
    path: '/vendors',
    one: '/vendors/:id',
    about: 'vendors and technicians: contact, trades, coverage, compliance, status',
    params: 'search, kind (vendor | tech), status, trade, state (2 letters), compliance (MISSING_DOCS | IN_REVIEW | APPROVED | EXPIRED | REJECTED), flag (blacklisted | duplicate | missing | not_on_map), sort, dir, page, page_size (max 100)',
  },
  vendor_alerts: { path: '/vendors/alerts', about: 'vendor documents expiring or expired, and other vendor alerts' },
  sites: {
    path: '/sites',
    one: '/sites/:id',
    about: 'client stores: address, client, store number, open work',
    params: 'search, client, state, site_type, show (active | inactive | all), flag (not_on_map | open_work | no_assets), sort, dir, page, page_size (max 100)',
  },
  assets: {
    path: '/assets',
    one: '/assets/:id',
    about: 'equipment at sites: type, condition, warranty',
    params: 'search, site (site id), client, category, asset_type, status (in_service | out_of_service | retired), condition (good | fair | poor | critical | none), warranty (expired | expiring | active | none), sort, dir, page, page_size (max 100)',
  },
  clients: { path: '/clients', one: '/clients/:id', about: 'client companies', params: 'search, show (active | inactive | all)' },
  site_events: { path: '/site-events', about: 'dated notices on sites (closures, access changes)' },
  planned_maintenance: { path: '/planned-maintenance', one: '/planned-maintenance/:id', about: 'recurring schedules that raise work orders' },
  purchase_requests: { path: '/purchasing/requests', about: 'purchase requests' },
  rfqs: { path: '/purchasing/rfqs', about: 'requests for quotation sent to vendors' },
  purchase_orders: { path: '/purchasing/orders', one: '/purchasing/orders/:id', about: 'purchase orders' },
  budgets: { path: '/purchasing/budgets', about: 'budgets, cost centers and AFEs with spend against them', params: 'year' },
  services: { path: '/maintenance/services', about: 'the services price list' },
  job_plans: { path: '/maintenance/job-plans', about: 'reusable step lists for kinds of job' },
  work_permits: { path: '/maintenance/permits', about: 'work permits across work orders' },
  intake_drafts: { path: '/intake/drafts', about: 'work orders being drafted before they are submitted' },
  people: { path: '/principals', about: 'the Seamless team: names and roles' },
  kpis: { path: '/kpis', about: 'the headline counts on the dashboard' },
  pulse: { path: '/pulse', about: 'obligations with clocks running: what is close to or past its deadline' },
  saved_views: { path: '/views', about: 'saved work-order views and the filters they hold' },
};

const RESOURCE_NAMES = Object.keys(RESOURCES) as [string, ...string[]];

const filterRule = {
  type: 'object',
  properties: {
    field: { type: 'string', description: 'A field key from the reference, e.g. status, client, fields.Assignee.' },
    op: { type: 'string', description: 'A test the field type takes, e.g. eq, in, contains, gt, between, is_set.' },
    value: { description: 'A scalar; a pair for between; a list for in / not_in; omitted for is_set, is_not_set, is_true, is_false.' },
    join: { type: 'string', enum: ['and', 'or'], description: 'How this rule joins the one before it. Leave out to follow `match`.' },
  },
  required: ['field', 'op'],
} as const;

export const ASSISTANT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'search_work_orders',
    description:
      'Search, count or group work orders. Returns `total` (how many matched in all) and one page of rows. For "how many" questions set count_only, with group_by to break the count down. Rows always carry WO number, title, client, location, trade, priority, status and age; name any other field you need in `columns`.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Free text matched against WO number, title, client and location. Use filters for anything precise.' },
        filters: {
          type: 'object',
          description: 'Precise conditions on fields.',
          properties: {
            match: { type: 'string', enum: ['all', 'any'], description: 'all = every rule must hold (default); any = at least one.' },
            rules: { type: 'array', items: filterRule },
          },
          required: ['rules'],
        },
        sort: {
          type: 'object',
          properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } },
          required: ['field'],
        },
        group_by: { type: 'string', description: 'A field key. Returns the count per value across everything that matched.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Extra field keys to include on each row.' },
        count_only: { type: 'boolean', description: 'Return the total (and groups) with no rows.' },
        limit: { type: 'integer', description: 'Rows to return, 1-100. Default 25.' },
        offset: { type: 'integer', description: 'Rows to skip, for the next page.' },
      },
    },
  },
  {
    name: 'get_work_order',
    description:
      `Read one work order by its WO number. Ask only for the parts the question needs; several parts come back together. Parts: ${Object.entries(WO_PARTS)
        .map(([k, v]) => `${k} (${v.about})`)
        .join('; ')}.`,
    input_schema: {
      type: 'object',
      properties: {
        wo: { type: 'string', description: 'The WO number.' },
        parts: { type: 'array', items: { type: 'string', enum: WO_PART_NAMES }, description: 'Default: ["details"].' },
      },
      required: ['wo'],
    },
  },
  {
    name: 'lookup',
    description:
      `Read the other records in The One. Give a resource, and an id to open one record. Resources: ${Object.entries(RESOURCES)
        .map(([k, r]) => `${k} — ${r.about}${r.one ? ' [opens by id]' : ''}${r.params ? ` [params: ${r.params}]` : ''}`)
        .join('; ')}. A resource with params is searched by the server: pass them in \`params\`. The others return their whole list, which you narrow with \`search\` (words that must all appear in a row), \`where\` (a field that must equal a value) and \`count_by\` (count rows per value of a field); read one row first if you do not know the field names.`,
    input_schema: {
      type: 'object',
      properties: {
        resource: { type: 'string', enum: RESOURCE_NAMES },
        id: { type: 'string', description: 'Open this one record.' },
        params: { type: 'object', description: 'Query parameters the resource lists.', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        search: { type: 'string' },
        where: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        count_by: { type: 'string' },
        limit: { type: 'integer', description: 'Rows to return, 1-100. Default 25.' },
        offset: { type: 'integer' },
      },
      required: ['resource'],
    },
  },
];

// ── Tool input → requests ────────────────────────────────────────────────────

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const searchInput = z.object({
  search: z.string().trim().max(200).optional(),
  filters: z
    .object({
      match: z.enum(['all', 'any']).default('all'),
      rules: z
        .array(
          z.object({
            field: z.string().min(1).max(200),
            op: z.string().min(1).max(40),
            value: z.union([scalar, z.array(z.union([z.string(), z.number()]))]).nullish(),
            join: z.enum(['and', 'or']).optional(),
          }),
        )
        .max(50),
    })
    .optional(),
  sort: z.object({ field: z.string().min(1), dir: z.enum(['asc', 'desc']).default('asc') }).optional(),
  group_by: z.string().min(1).max(200).optional(),
  columns: z.array(z.string().min(1).max(200)).max(20).optional(),
  count_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

const getInput = z.object({
  wo: z.string().trim().min(1).max(120),
  parts: z.array(z.enum(WO_PART_NAMES)).min(1).max(8).optional(),
});

const lookupInput = z.object({
  resource: z.enum(RESOURCE_NAMES),
  id: z.string().trim().min(1).max(120).optional(),
  params: z.record(scalar).optional(),
  search: z.string().trim().max(200).optional(),
  where: z.record(scalar).optional(),
  count_by: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

/** One GET the look-up needs. `label` names it in a multi-part answer. */
export interface PlannedRequest {
  label: string;
  /** Under /api, query string included. */
  url: string;
}

export interface LookupPlan {
  tool: string;
  requests: PlannedRequest[];
  /** What the people reading the lookup log see. */
  describe: string;
  /** Kept for shapeResult. */
  input: unknown;
}

export class LookupInputError extends Error {}

const seg = (s: string) => encodeURIComponent(s);

function qs(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

function checked<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    throw new LookupInputError(
      `The look-up was not understood: ${r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`,
    );
  }
  return r.data;
}

export function planLookup(tool: string, rawInput: unknown): LookupPlan {
  if (tool === 'search_work_orders') {
    const i = checked(searchInput, rawInput);
    const countOnly = i.count_only === true;
    const url = `/work-orders${qs({
      search: i.search,
      filters: i.filters && i.filters.rules.length > 0 ? i.filters : undefined,
      sort: i.sort,
      group_by: i.group_by,
      columns: i.columns && i.columns.length > 0 && !countOnly ? i.columns.join(',') : undefined,
      limit: countOnly ? 1 : (i.limit ?? 25),
      offset: countOnly ? 0 : (i.offset ?? 0),
    })}`;
    const bits = [
      i.search ? `“${i.search}”` : null,
      ...(i.filters?.rules ?? []).map((r) => `${r.field} ${r.op}${r.value === undefined || r.value === null ? '' : ` ${Array.isArray(r.value) ? r.value.join(', ') : r.value}`}`),
      i.group_by ? `by ${i.group_by}` : null,
    ].filter(Boolean);
    return {
      tool,
      input: i,
      requests: [{ label: 'work_orders', url }],
      describe: `${countOnly ? 'Counted' : 'Searched'} work orders${bits.length ? ` · ${bits.join(' · ')}` : ''}`,
    };
  }

  if (tool === 'get_work_order') {
    const i = checked(getInput, rawInput);
    const parts: WoPart[] = [...new Set<WoPart>(i.parts ?? ['details'])];
    return {
      tool,
      input: i,
      requests: parts.map((p) => ({ label: p, url: `/work-orders/${seg(i.wo)}${WO_PARTS[p].path}` })),
      describe: `Read work order ${i.wo} · ${parts.join(', ')}`,
    };
  }

  if (tool === 'lookup') {
    const i = checked(lookupInput, rawInput);
    const r = RESOURCES[i.resource];
    if (i.id) {
      if (!r.one) throw new LookupInputError(`${i.resource} cannot be opened by id; read the list instead.`);
      return {
        tool,
        input: i,
        requests: [{ label: i.resource, url: r.one.replace(':id', seg(i.id)) }],
        describe: `Opened ${i.resource.replace(/_/g, ' ')} ${i.id}`,
      };
    }
    const params: Record<string, unknown> = { ...(i.params ?? {}) };
    if (r.params) {
      // The route searches and pages; hand it the model's words for both.
      if (i.search && params.search === undefined) params.search = i.search;
      if (i.limit && params.page_size === undefined && r.params.includes('page_size')) params.page_size = i.limit;
    }
    const bits = [i.search ? `“${i.search}”` : null, ...Object.entries({ ...(i.params ?? {}), ...(i.where ?? {}) }).map(([k, v]) => `${k} ${v}`)].filter(Boolean);
    return {
      tool,
      input: i,
      requests: [{ label: i.resource, url: `${r.path}${qs(params)}` }],
      describe: `Read ${i.resource.replace(/_/g, ' ')}${bits.length ? ` · ${bits.join(' · ')}` : ''}`,
    };
  }

  throw new LookupInputError(`There is no look-up called ${tool}.`);
}

// ── Responses → what the model reads ─────────────────────────────────────────

export interface FetchedPart {
  label: string;
  status: number;
  body: unknown;
}

function errorLine(p: FetchedPart): string {
  const err = (p.body as { error?: { message?: string; details?: unknown } } | null)?.error;
  const msg = err?.message ?? 'no message';
  if (p.status === 403) return `Not available to this person (${msg}).`;
  if (p.status === 404) return `Not found among what this person can see (${msg}).`;
  if (p.status === 400) return `The look-up was refused: ${msg}${err?.details ? ` — ${JSON.stringify(err.details).slice(0, 800)}` : ''}`;
  return `The look-up failed (${p.status}): ${msg}`;
}

type Row = Record<string, unknown>;

/** A list row as the model needs it: the status as its name, the place as one
    line, the asked-for custom columns lifted out of `custom`. */
function woRow(item: Row): Row {
  const status = item.status as { name?: string } | null;
  const custom = (item.custom ?? {}) as Record<string, unknown>;
  const out: Row = {
    wo_number: item.wo_number,
    client_wo: item.ext_name,
    title: item.title,
    client: item.client,
    location: [item.city, item.state].filter(Boolean).join(', '),
    trade: item.trade,
    priority: item.priority,
    status: status?.name,
    billing_entity: item.billing_entity,
    nte: item.nte,
    date_received: item.date_received,
    age_days: item.age_days,
    home_list: item.home_list,
  };
  if (item.emergency === true) out.emergency = true;
  if (item.escalated === true) out.escalated = true;
  // An asked-for column with nothing in it still shows, so an empty cell is
  // not mistaken for a column that was never returned.
  for (const [k, v] of Object.entries(custom)) out[k.replace(/^fields\./, '')] = v ?? '(empty)';
  return out;
}

export interface ShapedResult {
  text: string;
  ok: boolean;
  /** Appended to the plan's description: "42 found". */
  outcome: string;
}

export function shapeResult(plan: LookupPlan, parts: FetchedPart[]): ShapedResult {
  if (plan.tool === 'search_work_orders') {
    const p = parts[0];
    if (p.status !== 200) return { text: errorLine(p), ok: false, outcome: 'refused' };
    const body = p.body as { total?: number; items?: Row[]; groups?: unknown; offset?: number };
    const countOnly = (plan.input as { count_only?: boolean }).count_only === true;
    const rows = countOnly ? [] : (body.items ?? []).map(woRow);
    const text = lookupResultText({
      total: body.total ?? 0,
      groups: body.groups,
      offset: countOnly ? undefined : body.offset,
      shown: countOnly ? undefined : rows.length,
      rows: countOnly ? undefined : rows,
    });
    return { text, ok: true, outcome: `${body.total ?? 0} found` };
  }

  if (plan.tool === 'get_work_order') {
    const out: Record<string, unknown> = {};
    let good = 0;
    const perPart = Math.floor(60_000 / parts.length);
    for (const p of parts) {
      if (p.status === 200) {
        good += 1;
        // Each part is cut on its own so a long feed cannot crowd out the quote.
        const text = lookupResultText(p.body, perPart, { maxArray: 40 });
        try {
          out[p.label] = JSON.parse(text);
        } catch {
          out[p.label] = text;
        }
      } else {
        out[p.label] = errorLine(p);
      }
    }
    return { text: JSON.stringify(out), ok: good > 0, outcome: good === parts.length ? 'read' : good > 0 ? 'partly read' : 'not available' };
  }

  // lookup
  const p = parts[0];
  if (p.status !== 200) return { text: errorLine(p), ok: false, outcome: p.status === 403 ? 'not available' : 'refused' };
  const i = plan.input as z.output<typeof lookupInput>;
  const r = RESOURCES[i.resource];
  if (i.id) return { text: lookupResultText(p.body, 60_000, { maxArray: 40 }), ok: true, outcome: 'read' };
  const rows = rowsOf(p.body);
  if (!rows) return { text: lookupResultText(p.body), ok: true, outcome: 'read' };
  if (r.params) {
    // Already searched and paged by the route: keep its totals beside the rows.
    const meta = Object.fromEntries(Object.entries(p.body as Row).filter(([, v]) => !Array.isArray(v) && (typeof v !== 'object' || v === null)));
    const f = filterRows(rows, { where: i.where, count_by: i.count_by, limit: 100 });
    return { text: lookupResultText({ ...meta, shown: f.shown, counts: f.counts, rows: f.rows }), ok: true, outcome: `${typeof meta.total === 'number' ? meta.total : f.matched} found` };
  }
  const f = filterRows(rows, { search: i.search, where: i.where, count_by: i.count_by, limit: i.limit, offset: i.offset });
  return {
    text: lookupResultText({ total_in_list: f.total, matched: f.matched, shown: f.shown, counts: f.counts, rows: f.rows }),
    ok: true,
    outcome: `${f.matched} found`,
  };
}
