// 0067 · Financials, the rest: purchase requests, requests for quotation and
// vendor quotes, purchase orders, tax rates, document templates, cost centers,
// AFEs and budgets.
//
// The rules that keep this from disturbing what exists:
//   · a purchase order never writes a work order's `34. Cost`. The Cost of a
//     work order keeps its single source.
//   · budgets and AFEs count a work order's Cost, plus the purchase orders
//     that are NOT tied to a work order (those tied to one are already inside
//     its Cost) — so nothing is counted twice.
//   · going over a budget or an AFE is a warning on the order, never a block.
//   · a document tied to a work order follows that work order's scope: a
//     person who cannot see the work order does not see its documents.
//   · "sent" on a request for quotation is a status somebody sets after
//     contacting the vendors themselves. Nothing is emailed.

import {
  PURCHASING_PERM,
  budgetPosition,
  compareQuotes,
  purchaseLineAmount,
  permAllows,
  poStatusAfterReceipt,
  purchaseRequestProblem,
  purchaseTotals,
  quoteTotalFromLines,
  taxOn,
} from '@theone/shared';
import type {
  Afe,
  BudgetRow,
  BudgetsResponse,
  CostCenter,
  DocTemplate,
  DocTemplateInput,
  DocTemplateKind,
  FeedActor,
  FinanceSetup,
  PermAction,
  PoAction,
  PoStatus,
  PrAction,
  PrStatus,
  PrintTemplate,
  PurchaseLine,
  PurchaseLineInput,
  PurchaseOrder,
  PurchaseOrderInput,
  PurchaseRequest,
  PurchaseRequestInput,
  PurchasingList,
  PurchasingMeta,
  Rfq,
  RfqAction,
  RfqInput,
  RfqStatus,
  TaxRate,
  VendorQuote,
  VendorQuoteInput,
  WoPurchasing,
} from '@theone/shared';
import { query } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { resolveTaskId, type ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { notify } from './notices.js';
import { requirePerm } from './permissions.js';
import { logTaskChanges } from './woAudit.js';
import { Params } from './woFields.js';
import { woScopeSql } from './woScope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SETTINGS_KEY = 'admin/settings';
const COST_SQL = `NULLIF(regexp_replace(COALESCE(t.fields->>'34. Cost', ''), '[^0-9.-]', '', 'g'), '')::numeric`;
const clean = (v: string | null | undefined, max = 2000): string | null => {
  const s = (v ?? '').trim().slice(0, max);
  return s === '' ? null : s;
};
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const can = (a: ActingPrincipal, key: string, action: PermAction): boolean => permAllows(a.perms, key, action, a.isSuperAdmin);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const uuid = (v: string | null | undefined): string | null => (v && UUID_RE.test(v) ? v : null);
const day = (v: string | null | undefined, label: string): string | null => {
  const s = clean(v, 10);
  if (s === null) return null;
  if (!DAY_RE.test(s)) throw badRequest(`${label} is not a date`);
  return s;
};

async function peopleByIds(ids: (string | null | undefined)[]): Promise<Map<string, FeedActor>> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x) && UUID_RE.test(x!)))];
  if (want.length === 0) return new Map();
  const res = await query<FeedActor>(`SELECT id::text AS id, display_name AS name, kind FROM principal WHERE id = ANY($1::uuid[])`, [want]);
  return new Map(res.rows.map((r) => [r.id, r]));
}

async function logWo(taskId: string | null, actor: ActingPrincipal, field: string, after: string): Promise<void> {
  if (!taskId) return;
  await logTaskChanges({ query: (sql, params) => query(sql, params) }, actor.id, taskId, [{ field, before: null, after }]);
}

async function holders(key: string, action: PermAction): Promise<string[]> {
  const res = await query<{ id: string }>(
    `SELECT p.id::text AS id FROM principal p LEFT JOIN role r ON r.code = p.role
      WHERE p.kind = 'human' AND p.status <> 'disabled'
        AND (p.is_super_admin OR COALESCE(r.permissions -> $1 ->> $2, r.permissions -> 'purchasing' ->> $2) = 'true')`,
    [key, action],
  );
  return res.rows.map((r) => r.id);
}

/** A work-order reference typed or passed by the browser → its id, through
 *  the viewer's scope (403 outside it). Null stays null. */
async function taskOf(ref: string | null | undefined, actor: ActingPrincipal): Promise<string | null> {
  const r = clean(ref, 64);
  if (r === null) return null;
  const id = await resolveTaskId(r, actor);
  if (!id) throw badRequest(`There is no work order ${r}`, { field: 'task_ref' });
  return id;
}

/** "(x.task_id IS NULL OR <the viewer's work-order scope>)". */
function scopeOr(actor: ActingPrincipal, p: Params, col: string): string | null {
  const scope = woScopeSql(actor, p);
  return scope ? `(${col} IS NULL OR ${scope})` : null;
}

function cleanLines(lines: PurchaseLineInput[] | undefined): { description: string; qty: number; unit: string; unit_cost: number | null }[] {
  return (lines ?? [])
    .map((l) => ({
      description: String(l.description ?? '').trim().slice(0, 300),
      qty: Number.isFinite(Number(l.qty)) && Number(l.qty) > 0 ? round2(Number(l.qty)) : 1,
      unit: clean(l.unit, 40) ?? 'each',
      unit_cost: l.unit_cost === null || l.unit_cost === undefined ? null : Number.isFinite(Number(l.unit_cost)) && Number(l.unit_cost) >= 0 ? round2(Number(l.unit_cost)) : null,
    }))
    .filter((l) => l.description !== '')
    .slice(0, 200);
}

// ═══ Meta, tax rates, templates ══════════════════════════════════════════════

async function taxRates(activeOnly: boolean): Promise<TaxRate[]> {
  const res = await query<{ id: string; name: string; rate: string; state: string | null; is_default: boolean; is_active: boolean }>(
    `SELECT id::text AS id, name, rate, state, is_default, is_active FROM tax_rate ${activeOnly ? 'WHERE is_active' : ''} ORDER BY is_active DESC, is_default DESC, lower(name)`,
  );
  return res.rows.map((r) => ({ ...r, rate: Number(r.rate) }));
}

export async function listTaxRates(actor: ActingPrincipal): Promise<{ tax_rates: TaxRate[] }> {
  if (!actor.id) throw notFound();
  return { tax_rates: await taxRates(true) };
}

export async function purchasingMeta(actor: ActingPrincipal): Promise<PurchasingMeta> {
  const seeBudgets = can(actor, PURCHASING_PERM.budgets, 'view');
  const [cc, afes, rates] = await Promise.all([
    query<{ id: string; code: string; name: string }>(`SELECT id::text AS id, code, name FROM cost_center WHERE is_active ORDER BY lower(code)`),
    query<{ id: string; afe_number: string; title: string; cost_center_id: string | null }>(
      `SELECT id::text AS id, afe_number, title, cost_center_id::text AS cost_center_id FROM afe WHERE status = 'open' ORDER BY lower(afe_number)`,
    ),
    taxRates(true),
  ]);
  const grant = (key: string) => ({ view: can(actor, key, 'view'), create: can(actor, key, 'create'), edit: can(actor, key, 'edit'), approve: can(actor, key, 'approve') });
  return {
    cost_centers: cc.rows,
    afes: afes.rows,
    tax_rates: rates,
    can: { requests: grant(PURCHASING_PERM.requests), rfqs: grant(PURCHASING_PERM.rfqs), orders: grant(PURCHASING_PERM.orders), budgets: { view: seeBudgets, edit: can(actor, PURCHASING_PERM.budgets, 'edit') } },
  };
}

/** Vendors by name, for the pickers of this module. Anyone who may open
 *  Purchasing may look one up; blacklisted vendors are left out. */
export async function searchVendors(actor: ActingPrincipal, q: string): Promise<{ hits: { id: string; name: string; primary_trade: string | null; city: string | null; state: string | null }[] }> {
  requirePerm(actor, 'purchasing', 'view', 'You cannot open Purchasing');
  const needle = q.trim().toLowerCase();
  const res = await query<{ id: string; name: string; primary_trade: string | null; city: string | null; state: string | null }>(
    `SELECT id::text AS id, name, primary_trade, city, state FROM vendor
      WHERE deleted_at IS NULL AND NOT blacklisted AND kind = 'vendor' AND ($1 = '' OR lower(name) LIKE '%' || $1 || '%')
      ORDER BY lower(name) LIMIT 20`,
    [needle],
  );
  return { hits: res.rows };
}

async function templates(): Promise<DocTemplate[]> {
  const res = await query<DocTemplate>(
    `SELECT id::text AS id, kind, name, company_name, company_details, terms, footer, is_default, is_active FROM doc_template ORDER BY kind, is_default DESC, lower(name)`,
  );
  return res.rows;
}

export async function financeSetup(actor: ActingPrincipal): Promise<FinanceSetup> {
  requirePerm(actor, SETTINGS_KEY, 'view', 'You cannot open Admin › Settings');
  const [rates, tpl] = await Promise.all([taxRates(false), templates()]);
  return { tax_rates: rates, templates: tpl, can: { edit: can(actor, SETTINGS_KEY, 'edit') } };
}

export async function saveTaxRate(id: string | null, input: { name?: string; rate?: number; state?: string | null; is_default?: boolean; is_active?: boolean }, actor: ActingPrincipal): Promise<FinanceSetup> {
  requirePerm(actor, SETTINGS_KEY, 'edit', 'You cannot edit Admin › Settings');
  if (input.rate !== undefined && !(Number.isFinite(input.rate) && input.rate >= 0 && input.rate <= 100)) throw badRequest('The rate is a percent between 0 and 100', { field: 'rate' });
  let rowId = id;
  if (id) {
    if (!UUID_RE.test(id)) throw notFound('That tax rate does not exist');
    const res = await query(
      `UPDATE tax_rate SET name = COALESCE($2, name), rate = COALESCE($3, rate), state = CASE WHEN $4 THEN $5 ELSE state END, is_active = COALESCE($6, is_active) WHERE id = $1 RETURNING id`,
      [id, clean(input.name, 120), input.rate ?? null, input.state !== undefined, input.state !== undefined ? clean(input.state, 40) : null, input.is_active ?? null],
    );
    if (!res.rows[0]) throw notFound('That tax rate does not exist');
  } else {
    const name = clean(input.name, 120);
    if (!name) throw badRequest('Name the tax rate', { field: 'name' });
    if (input.rate === undefined) throw badRequest('Give the rate', { field: 'rate' });
    const dup = await query(`SELECT 1 FROM tax_rate WHERE lower(name) = lower($1)`, [name]);
    if (dup.rows[0]) throw conflict(`There is already a tax rate called “${name}”`);
    const ins = await query<{ id: string }>(`INSERT INTO tax_rate (name, rate, state) VALUES ($1, $2, $3) RETURNING id::text AS id`, [name, input.rate, clean(input.state, 40)]);
    rowId = ins.rows[0].id;
  }
  if (input.is_default !== undefined) {
    if (input.is_default) await query(`UPDATE tax_rate SET is_default = (id = $1)`, [rowId]);
    else await query(`UPDATE tax_rate SET is_default = false WHERE id = $1`, [rowId]);
  }
  await logAdminEvent({ actorId: actor.id, entity: 'tax_rate', entityId: rowId!, action: id ? 'tax_rate_updated' : 'tax_rate_added', after: { name: input.name ?? 'tax rate', ...input } });
  return financeSetup(actor);
}

export async function saveDocTemplate(id: string | null, input: DocTemplateInput, actor: ActingPrincipal): Promise<FinanceSetup> {
  requirePerm(actor, SETTINGS_KEY, 'edit', 'You cannot edit Admin › Settings');
  let rowId = id;
  let kind: DocTemplateKind;
  if (id) {
    if (!UUID_RE.test(id)) throw notFound('That template does not exist');
    const cur = await query<{ kind: DocTemplateKind }>(`SELECT kind FROM doc_template WHERE id = $1`, [id]);
    if (!cur.rows[0]) throw notFound('That template does not exist');
    kind = cur.rows[0].kind;
    const t = (v: string | null | undefined, max: number) => [v !== undefined, v !== undefined ? clean(v, max) : null] as const;
    await query(
      `UPDATE doc_template SET name = COALESCE($2, name),
              company_name = CASE WHEN $3 THEN $4 ELSE company_name END,
              company_details = CASE WHEN $5 THEN $6 ELSE company_details END,
              terms = CASE WHEN $7 THEN $8 ELSE terms END,
              footer = CASE WHEN $9 THEN $10 ELSE footer END,
              is_active = COALESCE($11, is_active), updated_at = now()
        WHERE id = $1`,
      [id, clean(input.name, 120), ...t(input.company_name, 200), ...t(input.company_details, 1000), ...t(input.terms, 6000), ...t(input.footer, 1000), input.is_active ?? null],
    );
  } else {
    const name = clean(input.name, 120);
    if (!name) throw badRequest('Name the template', { field: 'name' });
    if (!input.kind) throw badRequest('Pick the kind of document', { field: 'kind' });
    kind = input.kind;
    const ins = await query<{ id: string }>(
      `INSERT INTO doc_template (kind, name, company_name, company_details, terms, footer) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
      [kind, name, clean(input.company_name, 200), clean(input.company_details, 1000), clean(input.terms, 6000), clean(input.footer, 1000)],
    );
    rowId = ins.rows[0].id;
  }
  if (input.is_default !== undefined) {
    // One default per kind: clear the others first (the index allows only one).
    await query(`UPDATE doc_template SET is_default = false WHERE kind = $1 AND is_default`, [kind]);
    if (input.is_default) await query(`UPDATE doc_template SET is_default = true, is_active = true WHERE id = $1`, [rowId]);
  }
  await logAdminEvent({ actorId: actor.id, entity: 'doc_template', entityId: rowId!, action: id ? 'doc_template_updated' : 'doc_template_added', after: { name: input.name ?? 'template', kind } });
  return financeSetup(actor);
}

export async function deleteDocTemplate(id: string, actor: ActingPrincipal): Promise<FinanceSetup> {
  requirePerm(actor, SETTINGS_KEY, 'edit', 'You cannot edit Admin › Settings');
  if (!UUID_RE.test(id)) throw notFound('That template does not exist');
  const res = await query<{ name: string }>(`DELETE FROM doc_template WHERE id = $1 RETURNING name`, [id]);
  if (!res.rows[0]) throw notFound('That template does not exist');
  await logAdminEvent({ actorId: actor.id, entity: 'doc_template', entityId: id, action: 'doc_template_deleted', before: { name: res.rows[0].name } });
  return financeSetup(actor);
}

/** The template a printed document wears: the default of its kind. Null =
 *  print it bare, exactly as before templates existed. */
export async function printTemplate(kind: DocTemplateKind): Promise<{ template: PrintTemplate | null }> {
  const res = await query<PrintTemplate>(
    `SELECT company_name, company_details, terms, footer FROM doc_template WHERE kind = $1 AND is_default AND is_active LIMIT 1`,
    [kind],
  );
  return { template: res.rows[0] ?? null };
}

// ═══ Cost centers, AFEs, budgets ═════════════════════════════════════════════

const OPEN_PO = `('issued', 'partially_received', 'received', 'closed')`;
/** Received value of a purchase order, its tax share included. */
const PO_RECEIVED_SQL = `(SELECT COALESCE(sum(l.received_qty * l.unit_cost), 0) FROM purchase_order_line l WHERE l.po_id = po.id) * (1 + po.tax_pct / 100)`;

async function afeRows(): Promise<Afe[]> {
  const res = await query<{
    id: string; afe_number: string; title: string; cc_id: string | null; cc_code: string | null; cc_name: string | null;
    amount: string; status: 'open' | 'closed'; valid_from: string | null; valid_to: string | null; note: string | null; used: string;
  }>(
    `SELECT a.id::text AS id, a.afe_number, a.title, c.id::text AS cc_id, c.code AS cc_code, c.name AS cc_name, a.amount, a.status,
            to_char(a.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(a.valid_to, 'YYYY-MM-DD') AS valid_to, a.note,
            COALESCE((SELECT sum(${COST_SQL}) FROM task t WHERE t.afe_id = a.id AND t.deleted_at IS NULL), 0)
              + COALESCE((SELECT sum(po.total) FROM purchase_order po WHERE po.afe_id = a.id AND po.task_id IS NULL AND po.status IN ${OPEN_PO}), 0) AS used
       FROM afe a LEFT JOIN cost_center c ON c.id = a.cost_center_id
      ORDER BY a.status, lower(a.afe_number)`,
  );
  return res.rows.map((r) => {
    const amount = Number(r.amount);
    const used = round2(Number(r.used));
    return {
      id: r.id,
      afe_number: r.afe_number,
      title: r.title,
      cost_center: r.cc_id ? { id: r.cc_id, code: r.cc_code!, name: r.cc_name! } : null,
      amount,
      status: r.status,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      note: r.note,
      used,
      remaining: round2(amount - used),
      over: used > amount + 0.005,
    };
  });
}

export async function budgetsView(actor: ActingPrincipal, yearRaw?: number): Promise<BudgetsResponse> {
  requirePerm(actor, PURCHASING_PERM.budgets, 'view', 'You cannot open budgets');
  const year = yearRaw && yearRaw >= 2000 && yearRaw <= 2100 ? Math.round(yearRaw) : new Date().getFullYear();
  const [rows, afes, clients] = await Promise.all([
    query<{
      id: string; code: string; name: string; client: string | null; description: string | null; is_active: boolean;
      budget: string | null; wo_cost: string; work_orders: number; po_received: string; committed: string;
    }>(
      `SELECT c.id::text AS id, c.code, c.name, c.client, c.description, c.is_active,
              (SELECT b.amount FROM budget b WHERE b.cost_center_id = c.id AND b.year = $1) AS budget,
              COALESCE((SELECT sum(${COST_SQL}) FROM task t WHERE t.cost_center_id = c.id AND t.deleted_at IS NULL
                         AND EXTRACT(YEAR FROM COALESCE(t.date_received, t.created_at::date)) = $1), 0) AS wo_cost,
              (SELECT count(*)::int FROM task t WHERE t.cost_center_id = c.id AND t.deleted_at IS NULL
                 AND EXTRACT(YEAR FROM COALESCE(t.date_received, t.created_at::date)) = $1) AS work_orders,
              COALESCE((SELECT sum(${PO_RECEIVED_SQL}) FROM purchase_order po WHERE po.cost_center_id = c.id AND po.task_id IS NULL AND po.status IN ${OPEN_PO}
                         AND EXTRACT(YEAR FROM COALESCE(po.order_date, po.created_at::date)) = $1), 0) AS po_received,
              COALESCE((SELECT sum(po.total - ${PO_RECEIVED_SQL}) FROM purchase_order po WHERE po.cost_center_id = c.id AND po.task_id IS NULL AND po.status IN ('issued', 'partially_received')
                         AND EXTRACT(YEAR FROM COALESCE(po.order_date, po.created_at::date)) = $1), 0) AS committed
         FROM cost_center c
        ORDER BY c.is_active DESC, lower(c.code)`,
      [year],
    ),
    afeRows(),
    query<{ name: string }>(`SELECT DISTINCT client AS name FROM task WHERE client IS NOT NULL AND btrim(client) <> '' AND deleted_at IS NULL ORDER BY 1 LIMIT 500`),
  ]);
  const out: BudgetRow[] = rows.rows.map((r) => {
    const budget = numOrNull(r.budget);
    const wo = round2(num(r.wo_cost));
    const received = round2(num(r.po_received));
    const committed = round2(Math.max(0, num(r.committed)));
    const actual = round2(wo + received);
    return {
      cost_center: { id: r.id, code: r.code, name: r.name, client: r.client, description: r.description, is_active: r.is_active },
      year,
      budget,
      wo_cost: wo,
      work_orders: Number(r.work_orders),
      po_received: received,
      committed,
      actual,
      ...budgetPosition(budget, actual, committed),
    };
  });
  return {
    year,
    rows: out,
    afes,
    cost_centers: out.map((r) => r.cost_center),
    clients: clients.rows.map((c) => c.name),
    totals: { budget: round2(out.reduce((s, r) => s + (r.budget ?? 0), 0)), actual: round2(out.reduce((s, r) => s + r.actual, 0)), committed: round2(out.reduce((s, r) => s + r.committed, 0)) },
    can: { edit: can(actor, PURCHASING_PERM.budgets, 'edit') },
  };
}

export async function saveCostCenter(id: string | null, input: { code?: string; name?: string; client?: string | null; description?: string | null; is_active?: boolean }, actor: ActingPrincipal): Promise<BudgetsResponse> {
  requirePerm(actor, PURCHASING_PERM.budgets, 'edit', 'You cannot edit cost centers');
  if (id) {
    if (!UUID_RE.test(id)) throw notFound('That cost center does not exist');
    const code = clean(input.code, 40);
    if (code) {
      const dup = await query(`SELECT 1 FROM cost_center WHERE lower(code) = lower($1) AND id <> $2`, [code, id]);
      if (dup.rows[0]) throw conflict(`The code “${code}” is taken`);
    }
    const res = await query(
      `UPDATE cost_center SET code = COALESCE($2, code), name = COALESCE($3, name), client = CASE WHEN $4 THEN $5 ELSE client END,
              description = CASE WHEN $6 THEN $7 ELSE description END, is_active = COALESCE($8, is_active) WHERE id = $1 RETURNING id`,
      [id, code, clean(input.name, 200), input.client !== undefined, input.client !== undefined ? clean(input.client, 200) : null, input.description !== undefined, input.description !== undefined ? clean(input.description, 1000) : null, input.is_active ?? null],
    );
    if (!res.rows[0]) throw notFound('That cost center does not exist');
    await logAdminEvent({ actorId: actor.id, entity: 'cost_center', entityId: id, action: 'cost_center_updated', after: { name: input.name ?? code ?? 'cost center', ...input } });
  } else {
    const code = clean(input.code, 40);
    const name = clean(input.name, 200);
    if (!code || !name) throw badRequest('A cost center needs a code and a name', { field: !code ? 'code' : 'name' });
    const dup = await query(`SELECT 1 FROM cost_center WHERE lower(code) = lower($1)`, [code]);
    if (dup.rows[0]) throw conflict(`The code “${code}” is taken`);
    const ins = await query<{ id: string }>(
      `INSERT INTO cost_center (code, name, client, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`,
      [code, name, clean(input.client, 200), clean(input.description, 1000), actor.id],
    );
    await logAdminEvent({ actorId: actor.id, entity: 'cost_center', entityId: ins.rows[0].id, action: 'cost_center_added', after: { name: `${code} · ${name}` } });
  }
  return budgetsView(actor);
}

export async function saveBudget(costCenterId: string, year: number, amount: number | null, actor: ActingPrincipal): Promise<BudgetsResponse> {
  requirePerm(actor, PURCHASING_PERM.budgets, 'edit', 'You cannot edit budgets');
  if (!UUID_RE.test(costCenterId)) throw notFound('That cost center does not exist');
  const cc = await query<{ code: string }>(`SELECT code FROM cost_center WHERE id = $1`, [costCenterId]);
  if (!cc.rows[0]) throw notFound('That cost center does not exist');
  if (amount === null) await query(`DELETE FROM budget WHERE cost_center_id = $1 AND year = $2`, [costCenterId, year]);
  else {
    if (!(Number.isFinite(amount) && amount >= 0)) throw badRequest('The budget must be a positive amount', { field: 'amount' });
    await query(
      `INSERT INTO budget (cost_center_id, year, amount) VALUES ($1, $2, $3) ON CONFLICT (cost_center_id, year) DO UPDATE SET amount = EXCLUDED.amount`,
      [costCenterId, year, round2(amount)],
    );
  }
  await logAdminEvent({ actorId: actor.id, entity: 'cost_center', entityId: costCenterId, action: 'budget_set', after: { name: `${cc.rows[0].code} · ${year}`, amount } });
  return budgetsView(actor, year);
}

export async function saveAfe(id: string | null, input: { afe_number?: string; title?: string; cost_center_id?: string | null; amount?: number; status?: 'open' | 'closed'; valid_from?: string | null; valid_to?: string | null; note?: string | null }, actor: ActingPrincipal): Promise<BudgetsResponse> {
  requirePerm(actor, PURCHASING_PERM.budgets, 'edit', 'You cannot edit AFEs');
  if (input.amount !== undefined && !(Number.isFinite(input.amount) && input.amount >= 0)) throw badRequest('The amount must be positive', { field: 'amount' });
  const from = input.valid_from !== undefined ? day(input.valid_from, 'The first day') : undefined;
  const to = input.valid_to !== undefined ? day(input.valid_to, 'The last day') : undefined;
  if (from && to && to < from) throw badRequest('The last day is before the first', { field: 'valid_to' });
  if (id) {
    if (!UUID_RE.test(id)) throw notFound('That AFE does not exist');
    const res = await query(
      `UPDATE afe SET title = COALESCE($2, title), amount = COALESCE($3, amount), status = COALESCE($4, status),
              cost_center_id = CASE WHEN $5 THEN $6::uuid ELSE cost_center_id END,
              valid_from = CASE WHEN $7 THEN $8::date ELSE valid_from END, valid_to = CASE WHEN $9 THEN $10::date ELSE valid_to END,
              note = CASE WHEN $11 THEN $12 ELSE note END
        WHERE id = $1 RETURNING id`,
      [id, clean(input.title, 200), input.amount ?? null, input.status ?? null, input.cost_center_id !== undefined, uuid(input.cost_center_id), from !== undefined, from ?? null, to !== undefined, to ?? null, input.note !== undefined, input.note !== undefined ? clean(input.note, 1000) : null],
    );
    if (!res.rows[0]) throw notFound('That AFE does not exist');
    await logAdminEvent({ actorId: actor.id, entity: 'afe', entityId: id, action: 'afe_updated', after: { name: input.title ?? 'AFE', ...input } });
  } else {
    const number = clean(input.afe_number, 40);
    const title = clean(input.title, 200);
    if (!number || !title) throw badRequest('An AFE needs a number and a title', { field: !number ? 'afe_number' : 'title' });
    if (input.amount === undefined) throw badRequest('Give the amount authorized', { field: 'amount' });
    const dup = await query(`SELECT 1 FROM afe WHERE lower(afe_number) = lower($1)`, [number]);
    if (dup.rows[0]) throw conflict(`The number “${number}” is taken`);
    const ins = await query<{ id: string }>(
      `INSERT INTO afe (afe_number, title, cost_center_id, amount, valid_from, valid_to, note, created_by)
       VALUES ($1, $2, (SELECT id FROM cost_center WHERE id = $3::uuid), $4, $5::date, $6::date, $7, $8) RETURNING id::text AS id`,
      [number, title, uuid(input.cost_center_id), round2(input.amount), from ?? null, to ?? null, clean(input.note, 1000), actor.id],
    );
    await logAdminEvent({ actorId: actor.id, entity: 'afe', entityId: ins.rows[0].id, action: 'afe_added', after: { name: `${number} · ${title}`, amount: input.amount } });
  }
  return budgetsView(actor);
}

/** File a work order under a cost center and / or an AFE. */
export async function setWoFiling(taskId: string, input: { cost_center_id?: string | null; afe_id?: string | null }, actor: ActingPrincipal): Promise<WoPurchasing> {
  requirePerm(actor, 'work_orders', 'edit', 'You cannot edit work orders');
  requirePerm(actor, PURCHASING_PERM.budgets, 'view', 'You cannot file work orders under cost centers');
  const before = await query<{ cc: string | null; afe: string | null }>(
    `SELECT (SELECT code FROM cost_center c WHERE c.id = t.cost_center_id) AS cc, (SELECT afe_number FROM afe a WHERE a.id = t.afe_id) AS afe FROM task t WHERE t.id = $1`,
    [taskId],
  );
  await query(
    `UPDATE task SET cost_center_id = CASE WHEN $2 THEN (SELECT id FROM cost_center WHERE id = $3::uuid) ELSE cost_center_id END,
                     afe_id = CASE WHEN $4 THEN (SELECT id FROM afe WHERE id = $5::uuid) ELSE afe_id END
      WHERE id = $1`,
    [taskId, input.cost_center_id !== undefined, uuid(input.cost_center_id), input.afe_id !== undefined, uuid(input.afe_id)],
  );
  const after = await query<{ cc: string | null; afe: string | null }>(
    `SELECT (SELECT code FROM cost_center c WHERE c.id = t.cost_center_id) AS cc, (SELECT afe_number FROM afe a WHERE a.id = t.afe_id) AS afe FROM task t WHERE t.id = $1`,
    [taskId],
  );
  const changes = [
    before.rows[0]?.cc !== after.rows[0]?.cc ? { field: 'Cost center', before: before.rows[0]?.cc ?? null, after: after.rows[0]?.cc ?? null } : null,
    before.rows[0]?.afe !== after.rows[0]?.afe ? { field: 'AFE', before: before.rows[0]?.afe ?? null, after: after.rows[0]?.afe ?? null } : null,
  ].filter((x): x is { field: string; before: string | null; after: string | null } => x !== null);
  if (changes.length) await logTaskChanges({ query: (sql, params) => query(sql, params) }, actor.id, taskId, changes);
  return woPurchasing(taskId, actor);
}

// ═══ Purchase requests ═══════════════════════════════════════════════════════

type PrRow = {
  id: string; pr_number: string; task_id: string | null; wo_number: string | null; title: string; reason: string | null; needed_by: string | null;
  vendor_id: string | null; vendor_name: string | null; v_name: string | null; cc_id: string | null; cc_code: string | null; cc_name: string | null;
  status: PrStatus; requested_by: string | null; submitted_at: Date | null; decided_by: string | null; decided_at: Date | null; decision_note: string | null; created_at: Date;
};

const PR_SELECT = `
  SELECT r.id::text AS id, r.pr_number, r.task_id::text AS task_id, t.wo_number, r.title, r.reason, to_char(r.needed_by, 'YYYY-MM-DD') AS needed_by,
         r.vendor_id::text AS vendor_id, r.vendor_name, v.name AS v_name, c.id::text AS cc_id, c.code AS cc_code, c.name AS cc_name,
         r.status, r.requested_by::text AS requested_by, r.submitted_at, r.decided_by::text AS decided_by, r.decided_at, r.decision_note, r.created_at
    FROM purchase_request r
    LEFT JOIN task t ON t.id = r.task_id
    LEFT JOIN vendor v ON v.id = r.vendor_id
    LEFT JOIN cost_center c ON c.id = r.cost_center_id`;

async function hydrateRequests(rows: PrRow[]): Promise<PurchaseRequest[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [lines, orders, rfqs, people] = await Promise.all([
    query<{ id: string; request_id: string; description: string; qty: string; unit: string; est_unit_cost: string | null }>(
      `SELECT id::text AS id, request_id::text AS request_id, description, qty, unit, est_unit_cost FROM purchase_request_line WHERE request_id = ANY($1::uuid[]) ORDER BY position`,
      [ids],
    ),
    query<{ id: string; po_number: string; request_id: string }>(`SELECT id::text AS id, po_number, request_id::text AS request_id FROM purchase_order WHERE request_id = ANY($1::uuid[]) AND status <> 'cancelled'`, [ids]),
    query<{ id: string; rfq_number: string; request_id: string }>(`SELECT id::text AS id, rfq_number, request_id::text AS request_id FROM rfq WHERE request_id = ANY($1::uuid[]) AND status <> 'cancelled'`, [ids]),
    peopleByIds(rows.flatMap((r) => [r.requested_by, r.decided_by])),
  ]);
  return rows.map((r) => {
    const mine: PurchaseLine[] = lines.rows.filter((l) => l.request_id === r.id).map((l) => ({ id: l.id, description: l.description, qty: Number(l.qty), unit: l.unit, unit_cost: numOrNull(l.est_unit_cost) }));
    const name = r.v_name ?? r.vendor_name;
    return {
      id: r.id,
      pr_number: r.pr_number,
      task: r.task_id && r.wo_number ? { id: r.task_id, wo_number: r.wo_number } : null,
      title: r.title,
      reason: r.reason,
      needed_by: r.needed_by,
      vendor: name ? { id: r.vendor_id, name } : null,
      cost_center: r.cc_id ? { id: r.cc_id, code: r.cc_code!, name: r.cc_name! } : null,
      status: r.status,
      lines: mine,
      estimate: round2(mine.reduce((s, l) => s + purchaseLineAmount(l.qty, l.unit_cost), 0)),
      requested_by: r.requested_by ? (people.get(r.requested_by) ?? null) : null,
      submitted_at: iso(r.submitted_at),
      decided_by: r.decided_by ? (people.get(r.decided_by) ?? null) : null,
      decided_at: iso(r.decided_at),
      decision_note: r.decision_note,
      created_at: r.created_at.toISOString(),
      orders: orders.rows.filter((o) => o.request_id === r.id).map((o) => ({ id: o.id, po_number: o.po_number })),
      rfqs: rfqs.rows.filter((o) => o.request_id === r.id).map((o) => ({ id: o.id, rfq_number: o.rfq_number })),
    };
  });
}

const countBy = <T extends { status: string }>(rows: T[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
};

export async function listRequests(actor: ActingPrincipal, opts: { status?: string; search?: string }): Promise<PurchasingList<PurchaseRequest>> {
  requirePerm(actor, PURCHASING_PERM.requests, 'view', 'You cannot open purchase requests');
  const p = new Params();
  const where: string[] = [];
  const scope = scopeOr(actor, p, 'r.task_id');
  if (scope) where.push(scope);
  if (opts.search?.trim()) {
    const h = p.add(`%${opts.search.trim().toLowerCase()}%`);
    where.push(`(lower(r.pr_number) LIKE ${h} OR lower(r.title) LIKE ${h} OR lower(COALESCE(t.wo_number, '')) LIKE ${h} OR lower(COALESCE(v.name, r.vendor_name, '')) LIKE ${h})`);
  }
  const res = await query<PrRow>(`${PR_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC LIMIT 500`, p.values);
  const all = await hydrateRequests(res.rows);
  return { items: opts.status ? all.filter((r) => r.status === opts.status) : all, counts: countBy(all) };
}

async function loadRequest(id: string, actor: ActingPrincipal): Promise<PurchaseRequest> {
  if (!UUID_RE.test(id)) throw notFound('That purchase request does not exist');
  const p = new Params();
  const hole = p.add(id);
  const scope = scopeOr(actor, p, 'r.task_id');
  const res = await query<PrRow>(`${PR_SELECT} WHERE r.id = ${hole}${scope ? ` AND ${scope}` : ''}`, p.values);
  if (!res.rows[0]) throw notFound('That purchase request does not exist');
  return (await hydrateRequests(res.rows))[0];
}

async function vendorRef(vendorId: string | null | undefined, vendorName: string | null | undefined): Promise<{ id: string | null; name: string | null }> {
  const id = uuid(vendorId);
  if (id) {
    const v = await query<{ name: string }>(`SELECT name FROM vendor WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!v.rows[0]) throw badRequest('That vendor does not exist', { field: 'vendor_id' });
    return { id, name: v.rows[0].name };
  }
  return { id: null, name: clean(vendorName, 200) };
}

async function writeRequestLines(requestId: string, lines: ReturnType<typeof cleanLines>): Promise<void> {
  await query(`DELETE FROM purchase_request_line WHERE request_id = $1`, [requestId]);
  let pos = 0;
  for (const l of lines) {
    await query(`INSERT INTO purchase_request_line (request_id, position, description, qty, unit, est_unit_cost) VALUES ($1, $2, $3, $4, $5, $6)`, [requestId, pos++, l.description, l.qty, l.unit, l.unit_cost]);
  }
}

export async function saveRequest(id: string | null, input: PurchaseRequestInput, actor: ActingPrincipal): Promise<PurchaseRequest> {
  requirePerm(actor, PURCHASING_PERM.requests, id ? 'edit' : 'create', 'You cannot change purchase requests');
  const before = id ? await loadRequest(id, actor) : null;
  if (before && before.status !== 'draft' && before.status !== 'rejected') throw conflict('Only a draft or a rejected request can be changed');
  const title = input.title !== undefined ? (clean(input.title, 200) ?? '') : (before?.title ?? '');
  if (!title) throw badRequest('Say what is being bought', { field: 'title' });
  const taskId = input.task_ref !== undefined ? await taskOf(input.task_ref, actor) : (before?.task?.id ?? null);
  const vendor = input.vendor_id !== undefined || input.vendor_name !== undefined ? await vendorRef(input.vendor_id, input.vendor_name) : { id: before?.vendor?.id ?? null, name: before?.vendor?.name ?? null };
  const neededBy = input.needed_by !== undefined ? day(input.needed_by, 'The date it is needed by') : (before?.needed_by ?? null);
  const cc = input.cost_center_id !== undefined ? uuid(input.cost_center_id) : (before?.cost_center?.id ?? null);
  const reason = input.reason !== undefined ? clean(input.reason) : (before?.reason ?? null);
  let rowId = id;
  if (id) {
    await query(
      `UPDATE purchase_request SET task_id = $2, title = $3, reason = $4, needed_by = $5::date, vendor_id = $6, vendor_name = $7,
              cost_center_id = (SELECT c.id FROM cost_center c WHERE c.id = $8::uuid), updated_at = now() WHERE id = $1`,
      [id, taskId, title, reason, neededBy, vendor.id, vendor.name, cc],
    );
  } else {
    const ins = await query<{ id: string; pr_number: string }>(
      `INSERT INTO purchase_request (task_id, title, reason, needed_by, vendor_id, vendor_name, cost_center_id, requested_by)
       VALUES ($1, $2, $3, $4::date, $5, $6, (SELECT c.id FROM cost_center c WHERE c.id = $7::uuid), $8) RETURNING id::text AS id, pr_number`,
      [taskId, title, reason, neededBy, vendor.id, vendor.name, cc, actor.id],
    );
    rowId = ins.rows[0].id;
    await logWo(taskId, actor, 'Purchase request', `${ins.rows[0].pr_number} raised: ${title}`);
  }
  if (input.lines !== undefined) await writeRequestLines(rowId!, cleanLines(input.lines));
  return loadRequest(rowId!, actor);
}

export async function actOnRequest(id: string, action: PrAction, note: string | null, actor: ActingPrincipal): Promise<PurchaseRequest> {
  const cur = await loadRequest(id, actor);
  const link = '/purchasing?tab=requests';
  const set = async (status: PrStatus, extra = '', params: unknown[] = []) => {
    await query(`UPDATE purchase_request SET status = $2, updated_at = now()${extra} WHERE id = $1`, [id, status, ...params]);
  };
  if (action === 'submit') {
    requirePerm(actor, PURCHASING_PERM.requests, 'create', 'You cannot submit purchase requests');
    if (cur.status !== 'draft' && cur.status !== 'rejected') throw conflict('Only a draft can be submitted');
    const problem = purchaseRequestProblem(cur.title, cur.lines);
    if (problem) throw badRequest(problem);
    await set('submitted', ', submitted_at = now(), requested_by = COALESCE(requested_by, $3), decided_by = NULL, decided_at = NULL, decision_note = NULL', [actor.id]);
    await logWo(cur.task?.id ?? null, actor, 'Purchase request', `${cur.pr_number} submitted for approval`);
    await notify(await holders(PURCHASING_PERM.requests, 'approve'), { kind: 'purchasing', title: `${cur.pr_number} needs approval`, body: `${cur.title} — about $${cur.estimate.toFixed(2)}${cur.task ? ` · ${cur.task.wo_number}` : ''}.`, link, actorId: actor.id });
  } else if (action === 'approve' || action === 'reject') {
    requirePerm(actor, PURCHASING_PERM.requests, 'approve', 'Deciding a purchase request is a manager’s job');
    if (cur.status !== 'submitted') throw conflict('This request is not waiting for a decision');
    const reason = clean(note, 500);
    if (action === 'reject' && !reason) throw badRequest('Say why the request is rejected', { field: 'note' });
    await set(action === 'approve' ? 'approved' : 'rejected', ', decided_by = $3, decided_at = now(), decision_note = $4', [actor.id, reason]);
    await logWo(cur.task?.id ?? null, actor, 'Purchase request', `${cur.pr_number} ${action === 'approve' ? 'approved' : `rejected: ${reason}`}`);
    await notify([cur.requested_by?.id], { kind: 'purchasing', title: `${cur.pr_number} was ${action === 'approve' ? 'approved' : 'rejected'}`, body: action === 'approve' ? cur.title : `${cur.title}: ${reason}`, link, actorId: actor.id });
  } else if (action === 'cancel') {
    requirePerm(actor, PURCHASING_PERM.requests, 'edit', 'You cannot cancel purchase requests');
    if (cur.status === 'ordered' || cur.status === 'cancelled') throw conflict(cur.status === 'ordered' ? 'It was already ordered: cancel the purchase order instead' : 'It is already cancelled');
    await set('cancelled');
    await logWo(cur.task?.id ?? null, actor, 'Purchase request', `${cur.pr_number} cancelled`);
  } else {
    requirePerm(actor, PURCHASING_PERM.requests, 'edit', 'You cannot change purchase requests');
    if (cur.status !== 'rejected' && cur.status !== 'cancelled') throw conflict('Only a rejected or a cancelled request can go back to draft');
    await set('draft');
  }
  return loadRequest(id, actor);
}

// ═══ Requests for quotation and vendor quotes ════════════════════════════════

type RfqRow = {
  id: string; rfq_number: string; task_id: string | null; wo_number: string | null; request_id: string | null; pr_number: string | null;
  title: string; description: string | null; due_on: string | null; status: RfqStatus; created_by: string | null; created_at: Date; sent_at: Date | null;
};

const RFQ_SELECT = `
  SELECT q.id::text AS id, q.rfq_number, q.task_id::text AS task_id, t.wo_number, q.request_id::text AS request_id, r.pr_number,
         q.title, q.description, to_char(q.due_on, 'YYYY-MM-DD') AS due_on, q.status, q.created_by::text AS created_by, q.created_at, q.sent_at
    FROM rfq q LEFT JOIN task t ON t.id = q.task_id LEFT JOIN purchase_request r ON r.id = q.request_id`;

async function hydrateRfqs(rows: RfqRow[]): Promise<Rfq[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [lines, vendors, quotes, prices, orders, people] = await Promise.all([
    query<{ id: string; rfq_id: string; description: string; qty: string; unit: string }>(`SELECT id::text AS id, rfq_id::text AS rfq_id, description, qty, unit FROM rfq_line WHERE rfq_id = ANY($1::uuid[]) ORDER BY position`, [ids]),
    query<{ rfq_id: string; id: string; name: string }>(
      `SELECT rv.rfq_id::text AS rfq_id, v.id::text AS id, v.name FROM rfq_vendor rv JOIN vendor v ON v.id = rv.vendor_id WHERE rv.rfq_id = ANY($1::uuid[]) ORDER BY lower(v.name)`,
      [ids],
    ),
    query<{ id: string; rfq_id: string; vendor_id: string; vendor_name: string; quote_ref: string | null; total: string; lead_days: number | null; valid_until: string | null; note: string | null; status: VendorQuote['status']; received_on: string }>(
      `SELECT vq.id::text AS id, vq.rfq_id::text AS rfq_id, v.id::text AS vendor_id, v.name AS vendor_name, vq.quote_ref, vq.total, vq.lead_days,
              to_char(vq.valid_until, 'YYYY-MM-DD') AS valid_until, vq.note, vq.status, to_char(vq.received_on, 'YYYY-MM-DD') AS received_on
         FROM vendor_quote vq JOIN vendor v ON v.id = vq.vendor_id WHERE vq.rfq_id = ANY($1::uuid[]) ORDER BY vq.total`,
      [ids],
    ),
    query<{ quote_id: string; rfq_line_id: string; unit_price: string }>(
      `SELECT ql.quote_id::text AS quote_id, ql.rfq_line_id::text AS rfq_line_id, ql.unit_price FROM vendor_quote_line ql JOIN vendor_quote vq ON vq.id = ql.quote_id WHERE vq.rfq_id = ANY($1::uuid[])`,
      [ids],
    ),
    query<{ id: string; po_number: string; rfq_id: string }>(`SELECT id::text AS id, po_number, rfq_id::text AS rfq_id FROM purchase_order WHERE rfq_id = ANY($1::uuid[]) AND status <> 'cancelled' ORDER BY created_at`, [ids]),
    peopleByIds(rows.map((r) => r.created_by)),
  ]);
  return rows.map((r) => {
    const myQuotes: VendorQuote[] = quotes.rows.filter((q) => q.rfq_id === r.id).map((q) => ({
      id: q.id,
      vendor: { id: q.vendor_id, name: q.vendor_name },
      quote_ref: q.quote_ref,
      total: Number(q.total),
      lead_days: q.lead_days,
      valid_until: q.valid_until,
      note: q.note,
      status: q.status,
      received_on: q.received_on,
      prices: Object.fromEntries(prices.rows.filter((p) => p.quote_id === q.id).map((p) => [p.rfq_line_id, Number(p.unit_price)])),
    }));
    const quoted = new Set(myQuotes.map((q) => q.vendor.id));
    const order = orders.rows.find((o) => o.rfq_id === r.id);
    return {
      id: r.id,
      rfq_number: r.rfq_number,
      task: r.task_id && r.wo_number ? { id: r.task_id, wo_number: r.wo_number } : null,
      request: r.request_id && r.pr_number ? { id: r.request_id, pr_number: r.pr_number } : null,
      title: r.title,
      description: r.description,
      due_on: r.due_on,
      status: r.status,
      lines: lines.rows.filter((l) => l.rfq_id === r.id).map((l) => ({ id: l.id, description: l.description, qty: Number(l.qty), unit: l.unit, unit_cost: null })),
      vendors: vendors.rows.filter((v) => v.rfq_id === r.id).map((v) => ({ id: v.id, name: v.name, quoted: quoted.has(v.id) })),
      quotes: myQuotes,
      created_by: r.created_by ? (people.get(r.created_by) ?? null) : null,
      created_at: r.created_at.toISOString(),
      sent_at: iso(r.sent_at),
      order: order ? { id: order.id, po_number: order.po_number } : null,
    };
  });
}

export async function listRfqs(actor: ActingPrincipal, opts: { status?: string; search?: string }): Promise<PurchasingList<Rfq>> {
  requirePerm(actor, PURCHASING_PERM.rfqs, 'view', 'You cannot open requests for quotation');
  const p = new Params();
  const where: string[] = [];
  const scope = scopeOr(actor, p, 'q.task_id');
  if (scope) where.push(scope);
  if (opts.search?.trim()) {
    const h = p.add(`%${opts.search.trim().toLowerCase()}%`);
    where.push(`(lower(q.rfq_number) LIKE ${h} OR lower(q.title) LIKE ${h} OR lower(COALESCE(t.wo_number, '')) LIKE ${h})`);
  }
  const res = await query<RfqRow>(`${RFQ_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY q.created_at DESC LIMIT 300`, p.values);
  const all = await hydrateRfqs(res.rows);
  return { items: opts.status ? all.filter((r) => r.status === opts.status) : all, counts: countBy(all) };
}

async function loadRfq(id: string, actor: ActingPrincipal): Promise<Rfq> {
  if (!UUID_RE.test(id)) throw notFound('That request for quotation does not exist');
  const p = new Params();
  const hole = p.add(id);
  const scope = scopeOr(actor, p, 'q.task_id');
  const res = await query<RfqRow>(`${RFQ_SELECT} WHERE q.id = ${hole}${scope ? ` AND ${scope}` : ''}`, p.values);
  if (!res.rows[0]) throw notFound('That request for quotation does not exist');
  return (await hydrateRfqs(res.rows))[0];
}

export async function saveRfq(id: string | null, input: RfqInput, actor: ActingPrincipal): Promise<Rfq> {
  requirePerm(actor, PURCHASING_PERM.rfqs, id ? 'edit' : 'create', 'You cannot change requests for quotation');
  const before = id ? await loadRfq(id, actor) : null;
  if (before && (before.status === 'awarded' || before.status === 'cancelled')) throw conflict('An awarded or cancelled request for quotation cannot be changed');
  // Raised from a purchase request: it starts with that request's work order,
  // title and lines, unless the caller says otherwise.
  let from: PurchaseRequest | null = null;
  if (!id && input.request_id) from = await loadRequest(input.request_id, actor);
  const title = input.title !== undefined ? (clean(input.title, 200) ?? '') : (before?.title ?? from?.title ?? '');
  if (!title) throw badRequest('Give the request for quotation a title', { field: 'title' });
  const taskId = input.task_ref !== undefined ? await taskOf(input.task_ref, actor) : (before?.task?.id ?? from?.task?.id ?? null);
  const due = input.due_on !== undefined ? day(input.due_on, 'The due date') : (before?.due_on ?? null);
  const description = input.description !== undefined ? clean(input.description) : (before?.description ?? from?.reason ?? null);
  let rowId = id;
  if (id) {
    await query(`UPDATE rfq SET task_id = $2, title = $3, description = $4, due_on = $5::date, updated_at = now() WHERE id = $1`, [id, taskId, title, description, due]);
  } else {
    const ins = await query<{ id: string; rfq_number: string }>(
      `INSERT INTO rfq (task_id, request_id, title, description, due_on, created_by) VALUES ($1, $2, $3, $4, $5::date, $6) RETURNING id::text AS id, rfq_number`,
      [taskId, from?.id ?? null, title, description, due, actor.id],
    );
    rowId = ins.rows[0].id;
    await logWo(taskId, actor, 'Request for quotation', `${ins.rows[0].rfq_number} raised: ${title}`);
  }
  const lines = input.lines !== undefined ? cleanLines(input.lines) : !id && from ? from.lines.map((l) => ({ description: l.description, qty: l.qty, unit: l.unit, unit_cost: null })) : null;
  if (lines !== null) {
    // A line that vendors already priced keeps its id (and so its prices)
    // when its wording is unchanged; the rest are replaced.
    const existing = before?.lines ?? [];
    const keep = new Set<string>();
    let pos = 0;
    for (const l of lines) {
      const same = existing.find((e) => !keep.has(e.id) && e.description === l.description);
      if (same) {
        keep.add(same.id);
        await query(`UPDATE rfq_line SET position = $2, qty = $3, unit = $4 WHERE id = $1`, [same.id, pos++, l.qty, l.unit]);
      } else {
        await query(`INSERT INTO rfq_line (rfq_id, position, description, qty, unit) VALUES ($1, $2, $3, $4, $5)`, [rowId, pos++, l.description, l.qty, l.unit]);
      }
    }
    const drop = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    if (drop.length) await query(`DELETE FROM rfq_line WHERE id = ANY($1::uuid[])`, [drop]);
  }
  if (input.vendor_ids !== undefined) {
    const want = [...new Set(input.vendor_ids.filter((v) => UUID_RE.test(v)))].slice(0, 30);
    await query(`DELETE FROM rfq_vendor WHERE rfq_id = $1 AND NOT (vendor_id = ANY($2::uuid[])) AND vendor_id NOT IN (SELECT vendor_id FROM vendor_quote WHERE rfq_id = $1)`, [rowId, want]);
    if (want.length) {
      await query(
        `INSERT INTO rfq_vendor (rfq_id, vendor_id) SELECT $1, v.id FROM vendor v WHERE v.id = ANY($2::uuid[]) AND v.deleted_at IS NULL AND NOT v.blacklisted ON CONFLICT DO NOTHING`,
        [rowId, want],
      );
    }
  }
  return loadRfq(rowId!, actor);
}

export async function actOnRfq(id: string, action: RfqAction, actor: ActingPrincipal): Promise<Rfq> {
  requirePerm(actor, PURCHASING_PERM.rfqs, 'edit', 'You cannot change requests for quotation');
  const cur = await loadRfq(id, actor);
  if (action === 'send') {
    if (cur.status !== 'draft') throw conflict('Only a draft can be marked as sent');
    if (cur.lines.length === 0) throw badRequest('List what is to be quoted first.');
    if (cur.vendors.length === 0) throw badRequest('Pick at least one vendor to ask.');
    await query(`UPDATE rfq SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1`, [id]);
    await logWo(cur.task?.id ?? null, actor, 'Request for quotation', `${cur.rfq_number} out to ${cur.vendors.length} ${cur.vendors.length === 1 ? 'vendor' : 'vendors'}`);
  } else if (action === 'close') {
    if (cur.status !== 'sent') throw conflict('Only a request that is out to vendors can be closed');
    await query(`UPDATE rfq SET status = 'closed', updated_at = now() WHERE id = $1`, [id]);
  } else if (action === 'reopen') {
    if (cur.status !== 'closed' && cur.status !== 'cancelled') throw conflict('Only a closed or cancelled request can be reopened');
    await query(`UPDATE rfq SET status = $2, updated_at = now() WHERE id = $1`, [id, cur.sent_at ? 'sent' : 'draft']);
  } else {
    if (cur.status === 'awarded') throw conflict('It was awarded: cancel the purchase order instead');
    await query(`UPDATE rfq SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
    await logWo(cur.task?.id ?? null, actor, 'Request for quotation', `${cur.rfq_number} cancelled`);
  }
  return loadRfq(id, actor);
}

export async function saveVendorQuote(rfqId: string, input: VendorQuoteInput, actor: ActingPrincipal): Promise<Rfq> {
  requirePerm(actor, PURCHASING_PERM.rfqs, 'edit', 'You cannot record vendor quotes');
  const cur = await loadRfq(rfqId, actor);
  if (cur.status === 'awarded' || cur.status === 'cancelled') throw conflict('This request for quotation is closed to quotes');
  if (!UUID_RE.test(input.vendor_id)) throw badRequest('Pick the vendor the quote is from', { field: 'vendor_id' });
  const v = await query<{ name: string }>(`SELECT name FROM vendor WHERE id = $1 AND deleted_at IS NULL`, [input.vendor_id]);
  if (!v.rows[0]) throw badRequest('That vendor does not exist', { field: 'vendor_id' });
  const prices: Record<string, number> = {};
  for (const l of cur.lines) {
    const price = input.prices?.[l.id];
    if (typeof price === 'number' && Number.isFinite(price) && price >= 0) prices[l.id] = round2(price);
  }
  const fromLines = quoteTotalFromLines(cur.lines, prices);
  const total = fromLines ?? (typeof input.total === 'number' && Number.isFinite(input.total) && input.total >= 0 ? round2(input.total) : null);
  if (total === null) throw badRequest('Give a price for every line, or the total the vendor quoted.', { field: 'total' });
  const validUntil = day(input.valid_until, 'The date the quote is valid until');
  const lead = input.lead_days === null || input.lead_days === undefined ? null : Math.max(0, Math.round(input.lead_days));
  await query(`INSERT INTO rfq_vendor (rfq_id, vendor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [rfqId, input.vendor_id]);
  const up = await query<{ id: string }>(
    `INSERT INTO vendor_quote (rfq_id, vendor_id, quote_ref, total, lead_days, valid_until, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8)
     ON CONFLICT (rfq_id, vendor_id) DO UPDATE SET quote_ref = EXCLUDED.quote_ref, total = EXCLUDED.total, lead_days = EXCLUDED.lead_days,
            valid_until = EXCLUDED.valid_until, note = EXCLUDED.note
     RETURNING id::text AS id`,
    [rfqId, input.vendor_id, clean(input.quote_ref, 80), total, lead, validUntil, clean(input.note, 1000), actor.id],
  );
  await query(`DELETE FROM vendor_quote_line WHERE quote_id = $1`, [up.rows[0].id]);
  for (const [lineId, price] of Object.entries(prices)) {
    await query(`INSERT INTO vendor_quote_line (quote_id, rfq_line_id, unit_price) VALUES ($1, $2, $3)`, [up.rows[0].id, lineId, price]);
  }
  await logWo(cur.task?.id ?? null, actor, 'Request for quotation', `${cur.rfq_number}: ${v.rows[0].name} quoted $${total.toFixed(2)}`);
  return loadRfq(rfqId, actor);
}

export async function deleteVendorQuote(rfqId: string, quoteId: string, actor: ActingPrincipal): Promise<Rfq> {
  requirePerm(actor, PURCHASING_PERM.rfqs, 'edit', 'You cannot change vendor quotes');
  const cur = await loadRfq(rfqId, actor);
  if (cur.status === 'awarded') throw conflict('This request for quotation is awarded');
  if (!UUID_RE.test(quoteId)) throw notFound('That quote does not exist');
  const res = await query(`DELETE FROM vendor_quote WHERE id = $1 AND rfq_id = $2 RETURNING id`, [quoteId, rfqId]);
  if (!res.rows[0]) throw notFound('That quote does not exist');
  return loadRfq(rfqId, actor);
}

/** Award a quote: the request for quotation is settled and a draft purchase
 *  order is written from the winning prices, ready to be checked and issued. */
export async function awardQuote(rfqId: string, quoteId: string, actor: ActingPrincipal): Promise<{ rfq: Rfq; order: PurchaseOrder }> {
  requirePerm(actor, PURCHASING_PERM.rfqs, 'edit', 'You cannot award requests for quotation');
  requirePerm(actor, PURCHASING_PERM.orders, 'create', 'You cannot raise purchase orders');
  const cur = await loadRfq(rfqId, actor);
  if (cur.status === 'awarded') throw conflict('This request for quotation is already awarded');
  if (cur.status === 'cancelled') throw conflict('This request for quotation is cancelled');
  const win = cur.quotes.find((q) => q.id === quoteId);
  if (!win) throw notFound('That quote does not exist');
  const blocked = await query<{ blacklisted: boolean }>(`SELECT blacklisted FROM vendor WHERE id = $1`, [win.vendor.id]);
  if (blocked.rows[0]?.blacklisted) throw conflict(`${win.vendor.name} is blacklisted and cannot be awarded an order`);
  await query(`UPDATE vendor_quote SET status = CASE WHEN id = $2 THEN 'selected' ELSE 'rejected' END WHERE rfq_id = $1`, [rfqId, quoteId]);
  await query(`UPDATE rfq SET status = 'awarded', awarded_quote_id = $2, updated_at = now() WHERE id = $1`, [rfqId, quoteId]);
  // Per-line prices when the vendor gave them; otherwise one line for the lot.
  const priced = cur.lines.every((l) => typeof win.prices[l.id] === 'number');
  const lines: PurchaseLineInput[] = priced
    ? cur.lines.map((l) => ({ description: l.description, qty: l.qty, unit: l.unit, unit_cost: win.prices[l.id] }))
    : [{ description: `${cur.title} — as quoted${win.quote_ref ? ` (${win.quote_ref})` : ''}`, qty: 1, unit: 'lot', unit_cost: win.total }];
  const order = await createOrder({ vendor_id: win.vendor.id, rfq_id: rfqId, request_id: cur.request?.id ?? null, lines, note: win.note }, actor, cur.task?.id ?? null);
  if (cur.request) await query(`UPDATE purchase_request SET status = 'ordered', updated_at = now() WHERE id = $1 AND status = 'approved'`, [cur.request.id]);
  await logWo(cur.task?.id ?? null, actor, 'Request for quotation', `${cur.rfq_number} awarded to ${win.vendor.name} for $${win.total.toFixed(2)} → ${order.po_number}`);
  return { rfq: await loadRfq(rfqId, actor), order };
}

// ═══ Purchase orders ═════════════════════════════════════════════════════════

type PoRow = {
  id: string; po_number: string; task_id: string | null; wo_number: string | null; vendor_id: string | null; vendor_name: string; blacklisted: boolean | null;
  request_id: string | null; pr_number: string | null; rfq_id: string | null; rfq_number: string | null;
  cc_id: string | null; cc_code: string | null; cc_name: string | null; afe_id: string | null; afe_number: string | null;
  status: PoStatus; order_date: string | null; expected_on: string | null; ship_to: string | null; note: string | null;
  tax_rate_name: string | null; tax_pct: string; subtotal: string; tax: string; total: string;
  created_by: string | null; approved_by: string | null; approved_at: Date | null; created_at: Date;
};

const PO_SELECT = `
  SELECT po.id::text AS id, po.po_number, po.task_id::text AS task_id, t.wo_number, po.vendor_id::text AS vendor_id, po.vendor_name, v.blacklisted,
         po.request_id::text AS request_id, r.pr_number, po.rfq_id::text AS rfq_id, q.rfq_number,
         c.id::text AS cc_id, c.code AS cc_code, c.name AS cc_name, a.id::text AS afe_id, a.afe_number,
         po.status, to_char(po.order_date, 'YYYY-MM-DD') AS order_date, to_char(po.expected_on, 'YYYY-MM-DD') AS expected_on, po.ship_to, po.note,
         po.tax_rate_name, po.tax_pct, po.subtotal, po.tax, po.total,
         po.created_by::text AS created_by, po.approved_by::text AS approved_by, po.approved_at, po.created_at
    FROM purchase_order po
    LEFT JOIN task t ON t.id = po.task_id
    LEFT JOIN vendor v ON v.id = po.vendor_id
    LEFT JOIN purchase_request r ON r.id = po.request_id
    LEFT JOIN rfq q ON q.id = po.rfq_id
    LEFT JOIN cost_center c ON c.id = po.cost_center_id
    LEFT JOIN afe a ON a.id = po.afe_id`;

async function hydrateOrders(rows: PoRow[]): Promise<PurchaseOrder[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const needsAfe = rows.some((r) => r.afe_id);
  const [lines, people, afes] = await Promise.all([
    query<{ id: string; po_id: string; description: string; qty: string; unit: string; unit_cost: string; received_qty: string }>(
      `SELECT id::text AS id, po_id::text AS po_id, description, qty, unit, unit_cost, received_qty FROM purchase_order_line WHERE po_id = ANY($1::uuid[]) ORDER BY position`,
      [ids],
    ),
    peopleByIds(rows.flatMap((r) => [r.created_by, r.approved_by])),
    needsAfe ? afeRows() : Promise.resolve([] as Afe[]),
  ]);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  return rows.map((r) => {
    const mine: PurchaseLine[] = lines.rows.filter((l) => l.po_id === r.id).map((l) => ({ id: l.id, description: l.description, qty: Number(l.qty), unit: l.unit, unit_cost: Number(l.unit_cost), received_qty: Number(l.received_qty) }));
    const total = Number(r.total);
    const warnings: string[] = [];
    if (r.blacklisted) warnings.push(`${r.vendor_name} is blacklisted.`);
    const afe = r.afe_id ? afes.find((a) => a.id === r.afe_id) : undefined;
    if (afe) {
      // A draft is not counted in `used` yet, so it is added to see where issuing would land.
      const landing = r.status === 'draft' && !r.task_id ? afe.used + total : afe.used;
      if (landing > afe.amount + 0.005) warnings.push(`${afe.afe_number} authorizes $${afe.amount.toFixed(2)}; this would bring it to $${landing.toFixed(2)}.`);
      if (afe.status === 'closed') warnings.push(`${afe.afe_number} is closed.`);
      if (afe.valid_to && afe.valid_to < today) warnings.push(`${afe.afe_number} ran out on ${afe.valid_to}.`);
    }
    if (r.status === 'draft' && mine.some((l) => (l.unit_cost ?? 0) === 0)) warnings.push('A line has no price.');
    return {
      id: r.id,
      po_number: r.po_number,
      task: r.task_id && r.wo_number ? { id: r.task_id, wo_number: r.wo_number } : null,
      vendor: { id: r.vendor_id, name: r.vendor_name },
      request: r.request_id && r.pr_number ? { id: r.request_id, pr_number: r.pr_number } : null,
      rfq: r.rfq_id && r.rfq_number ? { id: r.rfq_id, rfq_number: r.rfq_number } : null,
      cost_center: r.cc_id ? { id: r.cc_id, code: r.cc_code!, name: r.cc_name! } : null,
      afe: r.afe_id && r.afe_number ? { id: r.afe_id, afe_number: r.afe_number } : null,
      status: r.status,
      order_date: r.order_date,
      expected_on: r.expected_on,
      ship_to: r.ship_to,
      note: r.note,
      tax_rate_name: r.tax_rate_name,
      tax_pct: Number(r.tax_pct),
      subtotal: Number(r.subtotal),
      tax: Number(r.tax),
      total,
      lines: mine,
      received_value: round2(mine.reduce((s, l) => s + purchaseLineAmount(l.received_qty ?? 0, l.unit_cost), 0)),
      created_by: r.created_by ? (people.get(r.created_by) ?? null) : null,
      approved_by: r.approved_by ? (people.get(r.approved_by) ?? null) : null,
      approved_at: iso(r.approved_at),
      created_at: r.created_at.toISOString(),
      warnings,
    };
  });
}

export async function listOrders(actor: ActingPrincipal, opts: { status?: string; search?: string }): Promise<PurchasingList<PurchaseOrder>> {
  requirePerm(actor, PURCHASING_PERM.orders, 'view', 'You cannot open purchase orders');
  const p = new Params();
  const where: string[] = [];
  const scope = scopeOr(actor, p, 'po.task_id');
  if (scope) where.push(scope);
  if (opts.search?.trim()) {
    const h = p.add(`%${opts.search.trim().toLowerCase()}%`);
    where.push(`(lower(po.po_number) LIKE ${h} OR lower(po.vendor_name) LIKE ${h} OR lower(COALESCE(t.wo_number, '')) LIKE ${h})`);
  }
  const res = await query<PoRow>(`${PO_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY po.created_at DESC LIMIT 500`, p.values);
  const all = await hydrateOrders(res.rows);
  return { items: opts.status ? all.filter((r) => r.status === opts.status) : all, counts: countBy(all) };
}

export async function getOrder(id: string, actor: ActingPrincipal): Promise<PurchaseOrder> {
  requirePerm(actor, PURCHASING_PERM.orders, 'view', 'You cannot open purchase orders');
  if (!UUID_RE.test(id)) throw notFound('That purchase order does not exist');
  const p = new Params();
  const hole = p.add(id);
  const scope = scopeOr(actor, p, 'po.task_id');
  const res = await query<PoRow>(`${PO_SELECT} WHERE po.id = ${hole}${scope ? ` AND ${scope}` : ''}`, p.values);
  if (!res.rows[0]) throw notFound('That purchase order does not exist');
  return (await hydrateOrders(res.rows))[0];
}

async function writeOrderLines(poId: string, lines: ReturnType<typeof cleanLines>, taxPct: number): Promise<void> {
  await query(`DELETE FROM purchase_order_line WHERE po_id = $1`, [poId]);
  let pos = 0;
  for (const l of lines) {
    await query(`INSERT INTO purchase_order_line (po_id, position, description, qty, unit, unit_cost) VALUES ($1, $2, $3, $4, $5, $6)`, [poId, pos++, l.description, l.qty, l.unit, l.unit_cost ?? 0]);
  }
  const t = purchaseTotals(lines, taxPct);
  await query(`UPDATE purchase_order SET subtotal = $2, tax = $3, total = $4, updated_at = now() WHERE id = $1`, [poId, t.subtotal, t.tax, t.total]);
}

async function taxOf(rateId: string | null | undefined): Promise<{ name: string | null; pct: number }> {
  const id = uuid(rateId);
  if (!id) return { name: null, pct: 0 };
  const r = await query<{ name: string; rate: string }>(`SELECT name, rate FROM tax_rate WHERE id = $1`, [id]);
  if (!r.rows[0]) throw badRequest('That tax rate does not exist', { field: 'tax_rate_id' });
  return { name: r.rows[0].name, pct: Number(r.rows[0].rate) };
}

async function createOrder(input: PurchaseOrderInput, actor: ActingPrincipal, taskId: string | null): Promise<PurchaseOrder> {
  const vendor = await vendorRef(input.vendor_id, input.vendor_name);
  if (!vendor.name) throw badRequest('Say who the order goes to', { field: 'vendor_name' });
  const tax = await taxOf(input.tax_rate_id);
  // A work order's own cost center and AFE carry onto its purchase order.
  const filing = taskId ? await query<{ cc: string | null; afe: string | null }>(`SELECT cost_center_id::text AS cc, afe_id::text AS afe FROM task WHERE id = $1`, [taskId]) : null;
  const ins = await query<{ id: string; po_number: string }>(
    `INSERT INTO purchase_order (task_id, vendor_id, vendor_name, request_id, rfq_id, cost_center_id, afe_id, order_date, expected_on, ship_to, note, tax_rate_name, tax_pct, created_by)
     VALUES ($1, $2, $3, $4, $5, (SELECT c.id FROM cost_center c WHERE c.id = $6::uuid), (SELECT a.id FROM afe a WHERE a.id = $7::uuid),
             COALESCE($8::date, CURRENT_DATE), $9::date, $10, $11, $12, $13, $14)
     RETURNING id::text AS id, po_number`,
    [
      taskId, vendor.id, vendor.name, uuid(input.request_id), uuid(input.rfq_id),
      uuid(input.cost_center_id) ?? filing?.rows[0]?.cc ?? null, uuid(input.afe_id) ?? filing?.rows[0]?.afe ?? null,
      day(input.order_date, 'The order date'), day(input.expected_on, 'The expected date'), clean(input.ship_to, 500), clean(input.note), tax.name, tax.pct, actor.id,
    ],
  );
  await writeOrderLines(ins.rows[0].id, cleanLines(input.lines), tax.pct);
  await logWo(taskId, actor, 'Purchase order', `${ins.rows[0].po_number} drafted for ${vendor.name}`);
  return getOrder(ins.rows[0].id, actor);
}

export async function saveOrder(id: string | null, input: PurchaseOrderInput, actor: ActingPrincipal): Promise<PurchaseOrder> {
  requirePerm(actor, PURCHASING_PERM.orders, id ? 'edit' : 'create', 'You cannot change purchase orders');
  if (!id) {
    // From an approved request: its work order, vendor, cost center and lines.
    let from: PurchaseRequest | null = null;
    if (input.request_id) {
      from = await loadRequest(input.request_id, actor);
      if (from.status !== 'approved' && from.status !== 'ordered') throw conflict('Only an approved request can be ordered');
    }
    const taskId = input.task_ref !== undefined ? await taskOf(input.task_ref, actor) : (from?.task?.id ?? null);
    const order = await createOrder(
      {
        ...input,
        vendor_id: input.vendor_id ?? from?.vendor?.id ?? null,
        vendor_name: input.vendor_name ?? from?.vendor?.name ?? null,
        cost_center_id: input.cost_center_id ?? from?.cost_center?.id ?? null,
        lines: input.lines ?? from?.lines.map((l) => ({ description: l.description, qty: l.qty, unit: l.unit, unit_cost: l.unit_cost })) ?? [],
      },
      actor,
      taskId,
    );
    if (from) await query(`UPDATE purchase_request SET status = 'ordered', updated_at = now() WHERE id = $1`, [from.id]);
    return order;
  }
  const before = await getOrder(id, actor);
  if (before.status !== 'draft') throw conflict('Only a draft purchase order can be changed. Cancel it and raise a new one, or record what was received.');
  const vendor = input.vendor_id !== undefined || input.vendor_name !== undefined ? await vendorRef(input.vendor_id, input.vendor_name) : before.vendor;
  if (!vendor.name) throw badRequest('Say who the order goes to', { field: 'vendor_name' });
  const tax = input.tax_rate_id !== undefined ? await taxOf(input.tax_rate_id) : { name: before.tax_rate_name, pct: before.tax_pct };
  const taskId = input.task_ref !== undefined ? await taskOf(input.task_ref, actor) : (before.task?.id ?? null);
  await query(
    `UPDATE purchase_order SET task_id = $2, vendor_id = $3, vendor_name = $4,
            cost_center_id = (SELECT c.id FROM cost_center c WHERE c.id = $5::uuid), afe_id = (SELECT a.id FROM afe a WHERE a.id = $6::uuid),
            order_date = COALESCE($7::date, order_date), expected_on = $8::date, ship_to = $9, note = $10, tax_rate_name = $11, tax_pct = $12, updated_at = now()
      WHERE id = $1`,
    [
      id, taskId, vendor.id, vendor.name,
      input.cost_center_id !== undefined ? uuid(input.cost_center_id) : (before.cost_center?.id ?? null),
      input.afe_id !== undefined ? uuid(input.afe_id) : (before.afe?.id ?? null),
      day(input.order_date, 'The order date'),
      input.expected_on !== undefined ? day(input.expected_on, 'The expected date') : before.expected_on,
      input.ship_to !== undefined ? clean(input.ship_to, 500) : before.ship_to,
      input.note !== undefined ? clean(input.note) : before.note,
      tax.name, tax.pct,
    ],
  );
  const lines = input.lines !== undefined ? cleanLines(input.lines) : before.lines.map((l) => ({ description: l.description, qty: l.qty, unit: l.unit, unit_cost: l.unit_cost }));
  await writeOrderLines(id, lines, tax.pct);
  return getOrder(id, actor);
}

export async function actOnOrder(id: string, action: PoAction, actor: ActingPrincipal): Promise<PurchaseOrder> {
  const cur = await getOrder(id, actor);
  if (action === 'issue') {
    requirePerm(actor, PURCHASING_PERM.orders, 'approve', 'Issuing a purchase order is for people who approve them');
    if (cur.status !== 'draft') throw conflict('Only a draft can be issued');
    if (cur.lines.length === 0) throw badRequest('List what is being ordered first.');
    if (cur.total <= 0) throw badRequest('The order has no value yet: give its lines a price.');
    await query(`UPDATE purchase_order SET status = 'issued', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [id, actor.id]);
    await logWo(cur.task?.id ?? null, actor, 'Purchase order', `${cur.po_number} issued to ${cur.vendor.name} for $${cur.total.toFixed(2)}`);
    await notify([cur.created_by?.id], { kind: 'purchasing', title: `${cur.po_number} was issued`, body: `${cur.vendor.name} · $${cur.total.toFixed(2)}`, link: '/purchasing?tab=orders', actorId: actor.id });
  } else if (action === 'close') {
    requirePerm(actor, PURCHASING_PERM.orders, 'edit', 'You cannot close purchase orders');
    if (!['issued', 'partially_received', 'received'].includes(cur.status)) throw conflict('Only an issued order can be closed');
    await query(`UPDATE purchase_order SET status = 'closed', updated_at = now() WHERE id = $1`, [id]);
    await logWo(cur.task?.id ?? null, actor, 'Purchase order', `${cur.po_number} closed`);
  } else if (action === 'cancel') {
    requirePerm(actor, PURCHASING_PERM.orders, cur.status === 'draft' ? 'edit' : 'approve', 'You cannot cancel this purchase order');
    if (cur.status === 'cancelled' || cur.status === 'closed') throw conflict(`It is already ${cur.status}`);
    if (cur.received_value > 0) throw conflict('Something was already received against it: close it instead');
    await query(`UPDATE purchase_order SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
    // The request it came from can be ordered again.
    if (cur.request) await query(`UPDATE purchase_request SET status = 'approved', updated_at = now() WHERE id = $1 AND status = 'ordered'`, [cur.request.id]);
    await logWo(cur.task?.id ?? null, actor, 'Purchase order', `${cur.po_number} cancelled`);
  } else {
    requirePerm(actor, PURCHASING_PERM.orders, 'edit', 'You cannot reopen purchase orders');
    if (cur.status !== 'closed') throw conflict('Only a closed order can be reopened');
    await query(`UPDATE purchase_order SET status = $2, updated_at = now() WHERE id = $1`, [id, poStatusAfterReceipt(cur.lines.map((l) => ({ qty: l.qty, received_qty: l.received_qty ?? 0 })))]);
  }
  return getOrder(id, actor);
}

/** Record what arrived: the TOTAL received so far, per line. */
export async function receiveOrder(id: string, received: { line_id: string; received_qty: number }[], actor: ActingPrincipal): Promise<PurchaseOrder> {
  requirePerm(actor, PURCHASING_PERM.orders, 'edit', 'You cannot receive purchase orders');
  const cur = await getOrder(id, actor);
  if (!['issued', 'partially_received', 'received'].includes(cur.status)) throw conflict('Only an issued order can be received');
  for (const r of received) {
    const line = cur.lines.find((l) => l.id === r.line_id);
    if (!line) throw badRequest('That line is not on this order');
    if (!(Number.isFinite(r.received_qty) && r.received_qty >= 0)) throw badRequest('A received quantity cannot be negative');
    if (r.received_qty > line.qty + 0.005) throw badRequest(`“${line.description}”: ${r.received_qty} is more than the ${line.qty} ordered`);
    await query(`UPDATE purchase_order_line SET received_qty = $3 WHERE id = $1 AND po_id = $2`, [r.line_id, id, round2(r.received_qty)]);
  }
  const lines = await query<{ qty: string; received_qty: string }>(`SELECT qty, received_qty FROM purchase_order_line WHERE po_id = $1`, [id]);
  const status = poStatusAfterReceipt(lines.rows.map((l) => ({ qty: Number(l.qty), received_qty: Number(l.received_qty) })));
  await query(`UPDATE purchase_order SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  await logWo(cur.task?.id ?? null, actor, 'Purchase order', `${cur.po_number}: ${status === 'received' ? 'everything received' : status === 'partially_received' ? 'partly received' : 'nothing received'}`);
  return getOrder(id, actor);
}

// ═══ Everything purchasing on one work order ═════════════════════════════════

export async function woPurchasing(taskId: string, actor: ActingPrincipal): Promise<WoPurchasing> {
  requirePerm(actor, 'work_orders', 'view', 'You cannot open work orders');
  const meta = await purchasingMeta(actor);
  const [pr, rq, po, filing] = await Promise.all([
    meta.can.requests.view ? query<PrRow>(`${PR_SELECT} WHERE r.task_id = $1 ORDER BY r.created_at`, [taskId]) : { rows: [] as PrRow[] },
    meta.can.rfqs.view ? query<RfqRow>(`${RFQ_SELECT} WHERE q.task_id = $1 ORDER BY q.created_at`, [taskId]) : { rows: [] as RfqRow[] },
    meta.can.orders.view ? query<PoRow>(`${PO_SELECT} WHERE po.task_id = $1 ORDER BY po.created_at`, [taskId]) : { rows: [] as PoRow[] },
    query<{ cc_id: string | null; cc_code: string | null; cc_name: string | null; afe_id: string | null; afe_number: string | null; afe_title: string | null }>(
      `SELECT c.id::text AS cc_id, c.code AS cc_code, c.name AS cc_name, a.id::text AS afe_id, a.afe_number, a.title AS afe_title
         FROM task t LEFT JOIN cost_center c ON c.id = t.cost_center_id LEFT JOIN afe a ON a.id = t.afe_id WHERE t.id = $1`,
      [taskId],
    ),
  ]);
  const f = filing.rows[0];
  return {
    requests: await hydrateRequests(pr.rows),
    rfqs: await hydrateRfqs(rq.rows),
    orders: await hydrateOrders(po.rows),
    cost_center: meta.can.budgets.view && f?.cc_id ? { id: f.cc_id, code: f.cc_code!, name: f.cc_name! } : null,
    afe: meta.can.budgets.view && f?.afe_id ? { id: f.afe_id, afe_number: f.afe_number!, title: f.afe_title! } : null,
    meta,
    can_file: meta.can.budgets.view && can(actor, 'work_orders', 'edit'),
  };
}

// Kept for the comparison the browser also draws; exported so a test or a
// report can ask the API's own answer.
export function rfqComparison(rfq: Rfq): ReturnType<typeof compareQuotes> {
  return compareQuotes(rfq.lines, rfq.quotes);
}

/** Tax on an amount at a named rate — the "apply" button on a quote. */
export function applyTax(amount: number, ratePct: number): number {
  return taxOn(amount, ratePct);
}
