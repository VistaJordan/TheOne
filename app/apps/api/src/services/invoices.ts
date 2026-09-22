// Invoices (0045) — the bill to the client.
//
// The last money record to become real. Three things this file is careful
// about, each of which is a way invoicing goes wrong in practice:
//
//   the number.  Issued from a per-entity, per-year sequence inside the same
//   transaction that writes the row, with the sequence row locked while it is
//   read — two people pressing "Create invoice" in the same second get
//   different numbers, or neither gets one. A number is never reused: voiding
//   keeps it, because the client has already seen it.
//
//   the snapshot.  Lines are COPIED from the approved quote, never joined to
//   it. A sent invoice has to keep saying what it said when it was sent, and
//   a quote that is revised in October must not silently restate an invoice
//   from July.
//
//   the lock.  A draft is free to edit. Once sent it is what the client
//   holds, so the only moves left are paid and void — enforced here, not just
//   hidden in the UI.
//
// One invoice per work order (Elise, 2026-09-20). Billing several work orders
// on one invoice is a real request, but it turns every screen invoice-first;
// when it is wanted it becomes a join table, not a rewrite of this.

import {
  INVOICE_DEFAULT_TERMS_DAYS,
  INVOICE_EXISTS_CODE,
  INVOICE_LOCKED_CODE,
  contractBillingLines,
  formatInvoiceNumber,
  invoiceTotals,
  isEditable,
  lineAmount,
  type Invoice,
  type InvoiceLine,
  type InvoiceLineInput,
  type InvoiceStatus,
  type InvoiceUpdateInput,
  type InvoicesResponse,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { requirePerm } from './permissions.js';
import { woScopeSql } from './woScope.js';
import { Params } from './woFields.js';
import type { ActingPrincipal } from './activity.js';
import { OT_MULTIPLIER, computeLineAmount, computeQuoteTotals } from './quotes.js';
import { contractForTask, hoursOnSite, taskVendor } from './contracts.js';
import { assertTierAllows } from './approvalTiers.js';

const PERM = 'invoicing';

export function requireInvoiceView(p: ActingPrincipal): void {
  requirePerm(p, PERM, 'view', 'You cannot see invoices');
}
function requireInvoiceCreate(p: ActingPrincipal): void {
  requireInvoiceView(p);
  requirePerm(p, PERM, 'create', 'You cannot raise invoices');
}
function requireInvoiceEdit(p: ActingPrincipal): void {
  requireInvoiceView(p);
  requirePerm(p, PERM, 'edit', 'You cannot change invoices');
}
/** Sending a bill to a client is the approval, not a mere edit. */
function requireInvoiceSend(p: ActingPrincipal): void {
  requireInvoiceView(p);
  requirePerm(p, PERM, 'approve', 'You cannot send invoices to clients');
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  task_id: string;
  wo_number: string;
  number: string;
  billing_entity: string | null;
  client: string | null;
  status: string;
  subtotal: string | number;
  tax: string | number;
  discount: string | number;
  total: string | number;
  cost: string | number | null;
  title: string | null;
  site: string | null;
  vendor_name: string | null;
  vendor_contact: string | null;
  contract_id: string | null;
  contract_name: string | null;
  note: string | null;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  paid_reference: string | null;
  created_by_id: string | null;
  created_by_name: string | null;
  sent_by_id: string | null;
  sent_by_name: string | null;
  created_at: string;
  updated_at: string;
  overdue_days: number | null;
}

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const SELECT = `
  SELECT i.id::text AS id,
         i.task_id::text AS task_id,
         t.wo_number,
         i.number, i.billing_entity, i.client, i.status,
         i.subtotal, i.tax, i.discount, i.total, i.cost, i.note,
         i.title, i.site, i.vendor_name, i.vendor_contact,
         i.contract_id::text AS contract_id, c.name AS contract_name,
         ${ISO('i.issued_at')} AS issued_at,
         to_char(i.due_at, 'YYYY-MM-DD') AS due_at,
         ${ISO('i.paid_at')} AS paid_at,
         i.paid_reference,
         i.created_by::text AS created_by_id, cb.display_name AS created_by_name,
         i.sent_by::text AS sent_by_id, sb.display_name AS sent_by_name,
         ${ISO('i.created_at')} AS created_at,
         ${ISO('i.updated_at')} AS updated_at,
         CASE WHEN i.status = 'sent' AND i.due_at IS NOT NULL AND i.due_at < now()::date
              THEN (now()::date - i.due_at) END AS overdue_days
    FROM invoice i
    JOIN task t ON t.id = i.task_id
    LEFT JOIN principal cb ON cb.id = i.created_by
    LEFT JOIN principal sb ON sb.id = i.sent_by
    LEFT JOIN contract c ON c.id = i.contract_id`;

const n = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

function mapRow(r: Row, lines: InvoiceLine[]): Invoice {
  return {
    id: r.id,
    task_id: r.task_id,
    wo_number: r.wo_number,
    number: r.number,
    billing_entity: r.billing_entity,
    client: r.client,
    status: r.status as InvoiceStatus,
    subtotal: n(r.subtotal),
    tax: n(r.tax),
    discount: n(r.discount),
    total: n(r.total),
    cost: r.cost === null ? null : n(r.cost),
    title: r.title,
    site: r.site,
    vendor_name: r.vendor_name,
    vendor_contact: r.vendor_contact,
    contract_id: r.contract_id,
    contract_name: r.contract_name,
    note: r.note,
    issued_at: r.issued_at,
    due_at: r.due_at,
    paid_at: r.paid_at,
    paid_reference: r.paid_reference,
    created_by: r.created_by_id ? { id: r.created_by_id, display_name: r.created_by_name ?? '—' } : null,
    sent_by: r.sent_by_id ? { id: r.sent_by_id, display_name: r.sent_by_name ?? '—' } : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    lines,
    overdue_days: r.overdue_days === null ? null : Number(r.overdue_days),
  };
}

interface LineRow {
  id: string;
  invoice_id: string;
  kind: string;
  description: string;
  quantity: string | number;
  unit_price: string | number;
  amount: string | number;
  position: number;
}

async function linesFor(invoiceIds: string[]): Promise<Map<string, InvoiceLine[]>> {
  const out = new Map<string, InvoiceLine[]>();
  if (invoiceIds.length === 0) return out;
  const res = await query<LineRow>(
    `SELECT id::text AS id, invoice_id::text AS invoice_id, kind, description,
            quantity, unit_price, amount, position
       FROM invoice_line WHERE invoice_id = ANY($1::uuid[]) ORDER BY position, created_at`,
    [invoiceIds],
  );
  for (const r of res.rows) {
    const list = out.get(r.invoice_id) ?? [];
    list.push({
      id: r.id,
      kind: r.kind,
      description: r.description,
      quantity: n(r.quantity),
      unit_price: n(r.unit_price),
      amount: n(r.amount),
      position: r.position,
    });
    out.set(r.invoice_id, list);
  }
  return out;
}

export async function listInvoices(actor: ActingPrincipal): Promise<InvoicesResponse> {
  requireInvoiceView(actor);

  // 0026 · the queue shows invoices for work orders this person can see.
  // Money is not an exception to scope.
  const p = new Params();
  const scope = woScopeSql(actor, p);
  const res = await query<Row>(
    `${SELECT} WHERE t.deleted_at IS NULL${scope ? ` AND ${scope}` : ''}
      ORDER BY i.created_at DESC LIMIT 500`,
    p.values,
  );
  const byInvoice = await linesFor(res.rows.map((r) => r.id));
  const items = res.rows.map((r) => mapRow(r, byInvoice.get(r.id) ?? []));

  const totals = {
    draft: items.filter((i) => i.status === 'draft').reduce((s, i) => s + i.total, 0),
    outstanding: items.filter((i) => i.status === 'sent').reduce((s, i) => s + i.total, 0),
    overdue: items
      .filter((i) => i.status === 'sent' && (i.overdue_days ?? 0) > 0)
      .reduce((s, i) => s + i.total, 0),
    paid_30d: items
      .filter(
        (i) =>
          i.status === 'paid' &&
          i.paid_at !== null &&
          Date.now() - Date.parse(i.paid_at) < 30 * 86_400_000,
      )
      .reduce((s, i) => s + i.total, 0),
  };

  return { items, totals };
}

export async function getInvoice(id: string, actor: ActingPrincipal): Promise<Invoice> {
  requireInvoiceView(actor);
  const res = await query<Row>(`${SELECT} WHERE i.id = $1`, [id]);
  const row = res.rows[0];
  if (!row) throw notFound('No such invoice');
  const lines = await linesFor([row.id]);
  return mapRow(row, lines.get(row.id) ?? []);
}

/** The invoice on one work order, if it has been raised. */
export async function getInvoiceForTask(taskId: string, actor: ActingPrincipal): Promise<Invoice | null> {
  requireInvoiceView(actor);
  const res = await query<Row>(`${SELECT} WHERE i.task_id = $1 LIMIT 1`, [taskId]);
  const row = res.rows[0];
  if (!row) return null;
  const lines = await linesFor([row.id]);
  return mapRow(row, lines.get(row.id) ?? []);
}

// ── Raising one ──────────────────────────────────────────────────────────────

interface QuoteLineRow {
  line_type: string;
  description: string;
  qty: string | number;
  rate: string | number;
  ot: boolean;
  tax_pct: string | number | null;
  markup_pct: string | number | null;
  ot_multiplier: string | number | null;
  kind: string;
  include_in_summary: boolean;
  position: number;
}

/**
 * The lines an invoice starts with: the incurred work, plus every option the
 * quote included in its summary — which is exactly what the client agreed to
 * (rule B of the quote's own arithmetic). Overtime and markup are folded into
 * the unit price here, because an invoice line says what it costs, not how
 * the rate was arrived at; the quote's per-line tax (0048) comes back as the
 * invoice's tax figure.
 */
async function prefillFromQuote(taskId: string): Promise<{ lines: InvoiceLineInput[]; tax: number }> {
  const res = await query<QuoteLineRow>(
    `SELECT l.line_type, l.description, l.qty, l.rate, l.ot, l.tax_pct, l.markup_pct,
            q.ot_multiplier, s.kind, s.include_in_summary, l.position
       FROM quote q
       JOIN quote_section s ON s.quote_id = q.id
       JOIN quote_line l ON l.section_id = s.id
      WHERE q.task_id = $1
        AND (s.kind = 'incurred' OR s.include_in_summary)
      ORDER BY s.position, l.position`,
    [taskId],
  );

  let taxCents = 0;
  const lines = res.rows
    .filter((r) => String(r.description ?? '').trim() !== '')
    .map((r) => {
      const qty = n(r.qty);
      const mult = r.ot_multiplier === null ? OT_MULTIPLIER : n(r.ot_multiplier);
      const math = { qty, rate: n(r.rate), ot: r.ot, tax_pct: n(r.tax_pct), markup_pct: n(r.markup_pct) };
      const amount = computeLineAmount(math, mult);
      if (math.tax_pct > 0) taxCents += Math.round((amount * math.tax_pct) / 100 * 100);
      // Unit price back out of the amount, so qty × unit price always equals
      // what the quote said — including the overtime multiplier and markup.
      const unit = qty === 0 ? 0 : Math.round((amount / qty) * 100) / 100;
      return {
        kind: r.line_type,
        description: r.description,
        quantity: qty,
        unit_price: unit,
      };
    });
  return { lines, tax: taxCents / 100 };
}

/**
 * 0046 · no quote, but a time-and-materials contract covers the work order:
 * bill the hours on site (every completed visit, to the quarter hour) at the
 * contract's standard rate, plus its trip charge per visit. Returns nothing
 * when the contract states no hourly rate or no visit has been completed.
 */
async function prefillFromContract(
  taskId: string,
): Promise<{ lines: InvoiceLineInput[]; basis: string; contract_id: string; hours: number; visits: number } | null> {
  const match = await contractForTask(taskId);
  if (!match || match.contract.kind !== 'tm') return null;
  const { hours, visits } = await hoursOnSite(taskId);
  const lines = contractBillingLines(match.rates, hours, visits, match.contract.name);
  if (lines.length === 0) return null;
  return { lines, basis: match.contract.name, contract_id: match.contract.id, hours, visits };
}

/** The work order's own money, for the fallback and for the margin — and,
    since 0053, the name, location and vendor the invoice snapshots. */
interface TaskMoneyRow {
  wo_number: string;
  title: string | null;
  client: string | null;
  billing_entity: string | null;
  nte: string | number | null;
  cost: string | null;
  invoiced: string | null;
  store: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  tech_name: string | null;
  tech_phone: string | null;
}

const TASK_MONEY_SQL = `
  SELECT t.wo_number, t.title, t.client, t.billing_entity, t.nte,
         t.fields->>'34. Cost' AS cost,
         t.fields->>'Total Invoiced' AS invoiced,
         t.fields->>'Store' AS store,
         t.fields->>'17. Address' AS address,
         t.fields->>'City' AS city,
         t.fields->>'State' AS state,
         t.fields->>'Zip Code' AS zip,
         t.fields->>'Tech Name' AS tech_name,
         t.fields->>'Tech Phone Number' AS tech_phone
    FROM task t WHERE t.id = $1 AND t.deleted_at IS NULL`;

/** "Store 1234 · 12 Main St, Austin, TX 78701" — whatever the work order has. */
function siteLine(t: TaskMoneyRow): string | null {
  const place = [t.address, [t.city, t.state].filter(Boolean).join(', '), t.zip]
    .map((v) => String(v ?? '').trim())
    .filter((v) => v !== '')
    .join(', ');
  const parts = [t.store ? `Store ${t.store}` : null, place || null].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** What an invoice would start from, before one exists: the approved
    quote's lines, else the contract's hours on site, else the work order's
    own figure. Exported so a completion proposal (0053) shows the same lines
    Raise invoice would write. */
export interface InvoiceDraft {
  lines: InvoiceLineInput[];
  tax: number;
  basis: string;
  contract_id: string | null;
  hours: number;
  visits: number;
}

export async function draftInvoice(taskId: string, task?: TaskMoneyRow): Promise<InvoiceDraft> {
  const t = task ?? (await query<TaskMoneyRow>(TASK_MONEY_SQL, [taskId])).rows[0];
  if (!t) throw notFound('Work order not found');

  const fromQuote = await prefillFromQuote(taskId);
  let lines = fromQuote.lines;
  let tax = fromQuote.tax;
  let basis = 'quote';
  let contractId: string | null = null;
  let hours = 0;
  let visits = 0;
  // No quote: under a time-and-materials contract (0046) the bill is the
  // hours on site at the contract rate, plus the trip charge.
  if (lines.length === 0) {
    const fromContract = await prefillFromContract(taskId);
    if (fromContract) {
      lines = fromContract.lines;
      basis = `contract: ${fromContract.basis}`;
      contractId = fromContract.contract_id;
      hours = fromContract.hours;
      visits = fromContract.visits;
    }
  }
  // Still nothing: start from what the work order says it is worth, so AR
  // has a line to correct rather than a blank page.
  if (lines.length === 0) {
    const fallback = Number(t.invoiced ?? '') || n(t.nte);
    basis = 'work order';
    lines = [
      {
        kind: 'service',
        description: `Work order ${t.wo_number}`,
        quantity: 1,
        unit_price: Math.round(fallback * 100) / 100,
      },
    ];
  }
  if (!(tax > 0)) tax = 0;
  if (contractId === null) {
    // A quote priced against a contract carries it; the invoice inherits.
    const q = await query<{ contract_id: string | null }>(
      `SELECT contract_id::text AS contract_id FROM quote WHERE task_id = $1 LIMIT 1`,
      [taskId],
    );
    contractId = q.rows[0]?.contract_id ?? null;
  }
  return { lines, tax, basis, contract_id: contractId, hours, visits };
}

export async function createInvoice(
  taskId: string,
  actor: ActingPrincipal,
  /** 0053 · a confirmed proposal's lines, written as they were shown. */
  from?: Pick<InvoiceDraft, 'lines' | 'tax' | 'basis' | 'contract_id'>,
): Promise<Invoice> {
  requireInvoiceCreate(actor);

  const already = await query<{ id: string; number: string }>(
    `SELECT id::text AS id, number FROM invoice WHERE task_id = $1 LIMIT 1`,
    [taskId],
  );
  if (already.rows[0]) {
    throw conflict(`This work order is already on invoice ${already.rows[0].number}`, {
      code: INVOICE_EXISTS_CODE,
      invoice_id: already.rows[0].id,
      number: already.rows[0].number,
    });
  }

  const taskRes = await query<TaskMoneyRow>(TASK_MONEY_SQL, [taskId]);
  const task = taskRes.rows[0];
  if (!task) throw notFound('Work order not found');

  const draft = from ?? (await draftInvoice(taskId, task));
  const lines = draft.lines;
  const tax = draft.tax > 0 ? draft.tax : 0;
  const basis = draft.basis;
  // BRD §6.4 "vendor details": the technician on the job, by name and phone.
  const vendor = await taskVendor(taskId);
  const vendorName = vendor.name;
  const vendorContact = vendor.phone ?? ((task.tech_phone ?? '').trim() || null);

  const { subtotal, total } = invoiceTotals(
    lines.map((l) => ({ quantity: l.quantity ?? 1, unit_price: l.unit_price ?? 0 })),
    tax,
    0,
  );
  const cost = Number(task.cost ?? '');

  let invoiceId = '';
  await withTransaction(async (tx) => {
    const year = new Date().getUTCFullYear();
    const entity = task.billing_entity;
    const seqKey = (entity ?? '').trim() || 'INV';

    // Claim the next number with the sequence row LOCKED: two people pressing
    // Create at the same moment take different numbers, never the same one.
    await tx.query(
      `INSERT INTO invoice_sequence (billing_entity, year, next_number)
       VALUES ($1, $2, 1) ON CONFLICT (billing_entity, year) DO NOTHING`,
      [seqKey, year],
    );
    const seq = await tx.query<{ next_number: number }>(
      `UPDATE invoice_sequence SET next_number = next_number + 1
        WHERE billing_entity = $1 AND year = $2
        RETURNING next_number - 1 AS next_number`,
      [seqKey, year],
    );
    const number = formatInvoiceNumber(entity, year, seq.rows[0].next_number);

    const ins = await tx.query<{ id: string }>(
      `INSERT INTO invoice
         (task_id, number, billing_entity, client, status, subtotal, tax, discount, total, cost, created_by, due_at,
          title, site, vendor_name, vendor_contact, contract_id)
       VALUES ($1, $2, $3, $4, 'draft', $5, $10, 0, $6, $7, $8, (now() + ($9 || ' days')::interval)::date,
               $11, $12, $13, $14, $15::uuid)
       RETURNING id::text AS id`,
      [
        taskId,
        number,
        entity,
        task.client,
        subtotal,
        total,
        Number.isFinite(cost) && cost > 0 ? cost : null,
        actor.id,
        String(INVOICE_DEFAULT_TERMS_DAYS),
        tax,
        (task.title ?? '').trim() || null,
        siteLine(task),
        vendorName,
        vendorContact,
        draft.contract_id,
      ],
    );
    invoiceId = ins.rows[0].id;

    let position = 0;
    for (const l of lines) {
      const qty = l.quantity ?? 1;
      const unit = l.unit_price ?? 0;
      await tx.query(
        `INSERT INTO invoice_line (invoice_id, kind, description, quantity, unit_price, amount, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [invoiceId, l.kind ?? 'service', l.description, qty, unit, lineAmount(qty, unit), position++],
      );
    }

    await tx.query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'invoice_created', $3, NULL, $4::jsonb)`,
      [
        actor.id,
        taskId,
        `invoice:${invoiceId}`,
        JSON.stringify({ number, total, lines: lines.length, basis }),
      ],
    );
  });

  return getInvoice(invoiceId, actor);
}

// ── Editing, while it is still a draft ───────────────────────────────────────

async function loadForWrite(id: string): Promise<Row> {
  const res = await query<Row>(`${SELECT} WHERE i.id = $1`, [id]);
  const row = res.rows[0];
  if (!row) throw notFound('No such invoice');
  return row;
}

export async function updateInvoice(
  id: string,
  input: InvoiceUpdateInput,
  actor: ActingPrincipal,
): Promise<Invoice> {
  requireInvoiceEdit(actor);
  const current = await loadForWrite(id);
  if (!isEditable(current.status as InvoiceStatus)) {
    throw conflict(`Invoice ${current.number} has been sent, so its figures are fixed`, {
      code: INVOICE_LOCKED_CODE,
      status: current.status,
    });
  }

  const tax = input.tax ?? n(current.tax);
  const discount = input.discount ?? n(current.discount);
  if (tax < 0 || discount < 0) throw badRequest('Tax and discount cannot be negative');

  await withTransaction(async (tx) => {
    if (input.lines) {
      // Replaced whole: the editor sends the list it is showing, which is the
      // only way a reorder and a deletion arrive as one coherent change.
      await tx.query(`DELETE FROM invoice_line WHERE invoice_id = $1`, [id]);
      let position = 0;
      for (const l of input.lines) {
        const description = String(l.description ?? '').trim();
        if (description === '') continue;
        const qty = Number(l.quantity ?? 1);
        const unit = Number(l.unit_price ?? 0);
        await tx.query(
          `INSERT INTO invoice_line (invoice_id, kind, description, quantity, unit_price, amount, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, l.kind ?? 'service', description, qty, unit, lineAmount(qty, unit), position++],
        );
      }
    }

    const lines = await tx.query<{ quantity: string; unit_price: string }>(
      `SELECT quantity, unit_price FROM invoice_line WHERE invoice_id = $1`,
      [id],
    );
    const { subtotal, total } = invoiceTotals(
      lines.rows.map((l) => ({ quantity: n(l.quantity), unit_price: n(l.unit_price) })),
      tax,
      discount,
    );

    await tx.query(
      `UPDATE invoice
          SET note = COALESCE($2, note),
              tax = $3, discount = $4, subtotal = $5, total = $6,
              due_at = COALESCE($7::date, due_at)
        WHERE id = $1`,
      [id, input.note ?? null, tax, discount, subtotal, total, input.due_at ?? null],
    );
  });

  const after = await getInvoice(id, actor);
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'invoice_updated', $3, $4::jsonb, $5::jsonb)`,
    [
      actor.id,
      current.task_id,
      `invoice:${id}`,
      JSON.stringify({ total: n(current.total), tax: n(current.tax), discount: n(current.discount) }),
      JSON.stringify({ total: after.total, tax: after.tax, discount: after.discount }),
    ],
  );
  return after;
}

// ── The status moves ─────────────────────────────────────────────────────────

async function move(
  id: string,
  to: InvoiceStatus,
  actor: ActingPrincipal,
  extra: { reference?: string | null } = {},
): Promise<Invoice> {
  const current = await loadForWrite(id);
  const from = current.status as InvoiceStatus;

  // The rules, in one place, so the UI hiding a button is a convenience and
  // not the thing keeping the record straight.
  const allowed: Record<InvoiceStatus, InvoiceStatus[]> = {
    draft: ['sent', 'void'],
    sent: ['paid', 'void'],
    paid: [],
    void: ['draft'],
  };
  if (!allowed[from].includes(to)) {
    throw conflict(`An invoice that is ${from} cannot become ${to}`, { from, to });
  }

  if (to === 'sent') {
    requireInvoiceSend(actor);
    // Rule 6.2.3: the amount's band may exclude this role (0047).
    await assertTierAllows('invoice', n(current.total), actor, 'Sending an invoice');
    if (n(current.total) <= 0) {
      throw badRequest('An invoice for nothing cannot be sent — add a line first');
    }
  } else {
    requireInvoiceEdit(actor);
  }

  await query(
    `UPDATE invoice
        SET status = $2,
            issued_at = CASE WHEN $2 = 'sent' THEN COALESCE(issued_at, now()) ELSE issued_at END,
            sent_by   = CASE WHEN $2 = 'sent' THEN COALESCE(sent_by, $3) ELSE sent_by END,
            paid_at   = CASE WHEN $2 = 'paid' THEN now()
                             WHEN $2 = 'draft' THEN NULL ELSE paid_at END,
            paid_reference = CASE WHEN $2 = 'paid' THEN $4 ELSE paid_reference END
      WHERE id = $1`,
    [id, to, actor.id, extra.reference ?? null],
  );

  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'invoice_status_changed', $3, $4::jsonb, $5::jsonb)`,
    [
      actor.id,
      current.task_id,
      `invoice:${id}`,
      JSON.stringify({ status: from }),
      JSON.stringify({ status: to, number: current.number, total: n(current.total) }),
    ],
  );

  return getInvoice(id, actor);
}

export const sendInvoice = (id: string, actor: ActingPrincipal) => move(id, 'sent', actor);
export const voidInvoice = (id: string, actor: ActingPrincipal) => move(id, 'void', actor);
export const reopenInvoice = (id: string, actor: ActingPrincipal) => move(id, 'draft', actor);
export const markInvoicePaid = (id: string, actor: ActingPrincipal, reference?: string | null) =>
  move(id, 'paid', actor, { reference });

/** Deleting is deliberately absent: an invoice that existed is voided, never
    erased. `ApiError` is imported for the typed throws above. */
void ApiError;
