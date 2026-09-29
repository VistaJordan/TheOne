// 0054 · The pure half of the AI quote draft: the prompt, the output schema,
// the user message built from a work order and a call, and the conversion of
// the model's answer into the quote builder's PUT body. No database, no
// network — tests/quo-calls.test.ts exercises it directly.

import { z } from 'zod';
import { QUOTE_UOMS } from '@theone/shared';
import type { QuoteDraftBody, QuoteDraftLine, QuoteDraftSection, WoCall } from '@theone/shared';

export const SYSTEM_PROMPT = `You draft quotes for Seamless FM, a facilities-maintenance company. Seamless FM dispatches technicians and vendors to client sites (restaurants, retail stores) and bills the client for the work.

You receive the transcript of a phone call about one work order — usually a Seamless FM dispatcher talking to the technician who assessed the job, sometimes a vendor or the client — together with the work order's details and the client contract rates that apply to it. Write the draft quote that call supports, in Seamless FM's quote format. A person reviews and edits every draft before it goes anywhere, so be accurate, keep to what was said, and flag anything uncertain instead of guessing.

## The quote format

- incurred — the work ALREADY performed, usually the assessment or diagnostic visit.
  - narrative_reported: what the technician found, in plain client-facing English. It is printed after the words "Tech reported that", so do not start with those words; start like "the walk-in freezer was stuck in defrost because…".
  - scope_lines: what was done on the visit, one short line each.
  - lines: the charges for that work (trip charge, diagnostic labor) — only when the call or the contract makes them clear. Leave the list empty otherwise.
- options — each repair the client can approve, the recommended one first. Usually one; add another only when the call discussed a real alternative (repair vs replace, a cheaper temporary fix).
  - name: a short title, e.g. "Condenser fan motor + start kit replacement".
  - narrative_reported: why the work is needed, client-facing.
  - scope_lines: the work, each an imperative line completing "Required is to:", e.g. "Replace the condenser fan motor".
  - lines: the priced items for that option.

Line items:
- line_type: "labor" (hours × hourly rate), "part", "material" (consumables, refrigerant, fittings), or "service" (a flat-priced service or a trip charge).
- description: what the client is paying for, without the price.
- qty and rate: numbers. rate is the unit price in USD with at most two decimals.
- uom: one of "hr", "ea", "trip", "day", "lot", "ft", "sq ft", or null.
- ot: true only when the call says the work is after hours or overtime. Keep rate at the normal rate — the system applies the overtime multiplier itself.
- markup_pct: 0 unless rule 2 below applies.

## Pricing rules — in this order

1. A client-facing price stated on the call wins ("we'll put it to the client at $2,890").
2. When only the technician's or vendor's OWN cost is stated ("$1,450 parts and labor my side"), put that cost in rate and set markup_pct to the contract's markup percentage when one is given. With no contract markup, set markup_pct to 0 and add to missing_info that the price is the vendor's cost and still needs Seamless FM's markup.
3. Labor with no stated price uses the contract's standard hourly rate; a trip uses the contract's trip charge.
4. Past quotes, when provided, are references for how similar jobs were scoped and priced. Use them only to fill a gap the call leaves, and say so in assumptions.
5. Never invent a price. When nothing above gives one, set rate to 0 and name the item in missing_info.

A lump sum for several items stays one line ("Parts and labor per technician quote", qty 1) unless the call itemised it — do not split a total into made-up parts.

## Other fields

- specs: internal notes for Seamless FM only, never shown to the client — equipment make/model/serial, part numbers, the technician's availability, lead times, access notes. null when the call has none.
- note_to_customer: a short client-facing note (lead time, warranty, what happens next), or null.
- assumptions: every decision you made that the call did not state outright.
- missing_info: everything the reviewer must check or fill in before sending.

Write in clear, professional English. Keep prices out of narratives and scope lines.`;

const LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['line_type', 'description', 'qty', 'rate', 'uom', 'ot', 'markup_pct'],
  properties: {
    line_type: { type: 'string', enum: ['service', 'labor', 'part', 'material'] },
    description: { type: 'string' },
    qty: { type: 'number' },
    rate: { type: 'number' },
    uom: { anyOf: [{ type: 'string', enum: [...QUOTE_UOMS] }, { type: 'null' }] },
    ot: { type: 'boolean' },
    markup_pct: { type: 'number' },
  },
};

export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['incurred', 'options', 'specs', 'note_to_customer', 'assumptions', 'missing_info'],
  properties: {
    incurred: {
      type: 'object',
      additionalProperties: false,
      required: ['narrative_reported', 'scope_lines', 'lines'],
      properties: {
        narrative_reported: { type: 'string' },
        scope_lines: { type: 'array', items: { type: 'string' } },
        lines: { type: 'array', items: LINE_SCHEMA },
      },
    },
    options: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'narrative_reported', 'scope_lines', 'lines'],
        properties: {
          name: { type: 'string' },
          narrative_reported: { type: 'string' },
          scope_lines: { type: 'array', items: { type: 'string' } },
          lines: { type: 'array', items: LINE_SCHEMA },
        },
      },
    },
    specs: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    note_to_customer: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    assumptions: { type: 'array', items: { type: 'string' } },
    missing_info: { type: 'array', items: { type: 'string' } },
  },
};

/** What the model returns — validated again here: structured outputs make it
    very likely, not something to trust with money. */
const modelLine = z.object({
  line_type: z.enum(['service', 'labor', 'part', 'material']),
  description: z.string(),
  qty: z.number(),
  rate: z.number(),
  uom: z.string().nullable(),
  ot: z.boolean(),
  markup_pct: z.number(),
});
const modelSection = z.object({
  narrative_reported: z.string(),
  scope_lines: z.array(z.string()),
  lines: z.array(modelLine),
});
export const modelOutput = z.object({
  incurred: modelSection,
  options: z.array(modelSection.extend({ name: z.string() })),
  specs: z.string().nullable(),
  note_to_customer: z.string().nullable(),
  assumptions: z.array(z.string()),
  missing_info: z.array(z.string()),
});
export type ModelOutput = z.infer<typeof modelOutput>;

export type TaskContextRow = {
  wo_number: string;
  title: string;
  description: string | null;
  client: string | null;
  trade: string | null;
  billing_entity: string | null;
  nte: string | null;
  city: string | null;
  state: string | null;
  priority: string | null;
  store: string | null;
  address: string | null;
  fm: string | null;
  wo_description: string | null;
};

/** The contract match as buildUserMessage reads it (services/contracts.ts ContractMatch). */
export type RatesInput = {
  contract: { name: string };
  rates: { standard: number | null; overtime: number | null; trip_charge: number | null; markup_pct: number | null; ot_multiplier: number };
} | null;

export function buildUserMessage(
  ctx: TaskContextRow,
  rates: RatesInput,
  call: WoCall,
): string {
  const wo: Record<string, string | null> = {
    'Work order': ctx.wo_number,
    Title: ctx.title,
    Client: ctx.client,
    'Facility manager (FM)': ctx.fm,
    Store: ctx.store,
    Address: ctx.address ?? ([ctx.city, ctx.state].filter(Boolean).join(', ') || null),
    Trade: ctx.trade,
    Priority: ctx.priority,
    'Client NTE (not-to-exceed), USD': ctx.nte,
    Description: ctx.wo_description ?? ctx.description,
  };
  const woText = Object.entries(wo)
    .filter(([, v]) => v !== null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  let ratesText = 'No client contract covers this work order — no contract rates apply.';
  if (rates) {
    const r = rates.rates;
    const rows: [string, number | null][] = [
      ['Standard hourly rate, USD', r.standard],
      ['Overtime hourly rate, USD', r.overtime],
      ['Trip charge, USD', r.trip_charge],
      ['Markup on vendor cost, %', r.markup_pct],
    ];
    ratesText =
      `Contract: ${rates.contract.name}\n` +
      rows
        .map(([k, v]) => `${k}: ${v === null ? 'not set' : v}`)
        .join('\n') +
      `\nOvertime multiplier applied by the system: ×${r.ot_multiplier}`;
  }

  const who = [call.contact_name, call.contact_role !== 'other' ? `(${call.contact_role})` : null]
    .filter(Boolean)
    .join(' ');
  const transcript = (call.transcript ?? [])
    .map((l) => `${l.speaker}: ${l.line}`)
    .join('\n');
  const quoSummary = call.summary
    ? [...call.summary.summary.map((s) => `- ${s}`), ...call.summary.next_steps.map((s) => `- Next step: ${s}`)].join('\n')
    : null;

  return [
    '<work_order>',
    woText,
    '</work_order>',
    '',
    '<contract_rates>',
    ratesText,
    '</contract_rates>',
    '',
    `<call placed_by="${call.placed_by.name}" with="${who || call.phone}" date="${call.created_at.slice(0, 10)}">`,
    transcript,
    '</call>',
    ...(quoSummary ? ['', '<quo_call_summary>', quoSummary, '</quo_call_summary>'] : []),
    '',
    'Draft the quote this call supports.',
  ].join('\n');
}

const round2 = (n: number): number => Math.round(Math.max(0, Number.isFinite(n) ? n : 0) * 100) / 100;
const clip = (s: string, max: number): string => s.trim().slice(0, max);

/** Model output → the builder's PUT body, with every limit the PUT enforces. */
export function toDraftBody(out: ModelOutput): QuoteDraftBody {
  const uoms = new Set<string>(QUOTE_UOMS);
  const line = (l: ModelOutput['incurred']['lines'][number]): QuoteDraftLine | null => {
    const description = clip(l.description, 500);
    if (description === '') return null;
    return {
      line_type: l.line_type,
      description,
      qty: round2(l.qty),
      rate: round2(l.rate),
      day_value: null,
      ot: l.ot,
      uom: l.uom && uoms.has(l.uom) ? l.uom : null,
      tax_pct: 0,
      markup_pct: Math.min(1000, round2(l.markup_pct)),
    };
  };
  const section = (
    kind: 'incurred' | 'option',
    name: string | null,
    s: ModelOutput['incurred'],
  ): QuoteDraftSection => ({
    kind,
    name,
    narrative_reported: clip(s.narrative_reported, 8000) || null,
    scope_lines: s.scope_lines.map((x) => clip(x, 1000)).filter((x) => x !== '').slice(0, 50),
    include_in_summary: true,
    lines: s.lines.map(line).filter((l): l is QuoteDraftLine => l !== null).slice(0, 100),
  });
  return {
    sections: [
      section('incurred', 'Work already performed', out.incurred),
      ...out.options.slice(0, 10).map((o) => section('option', clip(o.name, 200) || null, o)),
    ],
    specs: out.specs ? clip(out.specs, 8000) || null : null,
    note_to_customer: out.note_to_customer ? clip(out.note_to_customer, 8000) || null : null,
  };
}

