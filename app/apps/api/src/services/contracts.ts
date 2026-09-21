// Contracts and labor rates (0046) — what a client has agreed the work costs.
//
// Two halves. The first is the rate cards themselves: list, create, edit,
// delete, each logged as an admin change (they are commercial terms, and a
// changed rate has to be explicable months later). The second is the
// question every other money service asks: WHICH contract covers this work
// order, and what do its rates come to? That answer is pure (packages/shared/
// src/contracts.ts, pickContract + resolveRates); this file only fetches the
// candidates and the work order's own client / entity / trade / site.
//
// The client is still plain text on the task, so matching is by name. The
// portfolio batch promotes it to a record; the matching here moves with it.

import {
  CONTRACT_PERM_KEY,
  CONTRACT_KINDS,
  RATE_TYPES,
  billableHours,
  contractInForce,
  pickContract,
  resolveRates,
  type Contract,
  type ContractInput,
  type ContractRate,
  type ContractRateInput,
  type ContractsResponse,
  type ResolvedRates,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { requirePerm } from './permissions.js';
import { logAdminEvent } from './adminAudit.js';
import type { ActingPrincipal } from './activity.js';

export function requireContractView(p: ActingPrincipal): void {
  requirePerm(p, CONTRACT_PERM_KEY, 'view', 'You cannot see contracts');
}
function requireContractEdit(p: ActingPrincipal, action: 'create' | 'edit' | 'delete'): void {
  requireContractView(p);
  requirePerm(p, CONTRACT_PERM_KEY, action, 'You cannot change contracts');
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  name: string;
  client: string | null;
  billing_entity: string | null;
  kind: string;
  account_code: string | null;
  starts_on: string;
  ends_on: string | null;
  active: boolean;
  sites_covered: string[] | null;
  trades_covered: string[] | null;
  notes: string | null;
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

interface RateRow {
  id: string;
  contract_id: string;
  rate_type: string;
  trade: string | null;
  amount: string | number;
  position: number;
}

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const SELECT = `
  SELECT c.id::text AS id, c.name, c.client, c.billing_entity, c.kind, c.account_code,
         to_char(c.starts_on, 'YYYY-MM-DD') AS starts_on,
         to_char(c.ends_on, 'YYYY-MM-DD') AS ends_on,
         c.active, c.sites_covered, c.trades_covered, c.notes,
         c.created_by::text AS created_by_id, p.display_name AS created_by_name,
         ${ISO('c.created_at')} AS created_at,
         ${ISO('c.updated_at')} AS updated_at
    FROM contract c
    LEFT JOIN principal p ON p.id = c.created_by`;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function mapRow(r: Row, rates: ContractRate[]): Contract {
  const base = {
    id: r.id,
    name: r.name,
    client: r.client,
    billing_entity: r.billing_entity,
    kind: r.kind as Contract['kind'],
    account_code: r.account_code,
    starts_on: r.starts_on,
    ends_on: r.ends_on,
    active: r.active,
    sites_covered: r.sites_covered ?? [],
    trades_covered: r.trades_covered ?? [],
    notes: r.notes,
    created_by: r.created_by_id ? { id: r.created_by_id, display_name: r.created_by_name ?? '—' } : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    rates,
  };
  return { ...base, in_force: contractInForce(base, today()) };
}

async function ratesFor(ids: string[]): Promise<Map<string, ContractRate[]>> {
  const out = new Map<string, ContractRate[]>();
  if (ids.length === 0) return out;
  const res = await query<RateRow>(
    `SELECT id::text AS id, contract_id::text AS contract_id, rate_type, trade, amount, position
       FROM contract_rate WHERE contract_id = ANY($1::uuid[]) ORDER BY position, created_at`,
    [ids],
  );
  for (const r of res.rows) {
    const list = out.get(r.contract_id) ?? [];
    list.push({
      id: r.id,
      rate_type: r.rate_type as ContractRate['rate_type'],
      trade: r.trade,
      amount: Number(r.amount),
      position: r.position,
    });
    out.set(r.contract_id, list);
  }
  return out;
}

async function loadAll(where = '', params: unknown[] = []): Promise<Contract[]> {
  const res = await query<Row>(`${SELECT} ${where} ORDER BY c.active DESC, c.client NULLS LAST, c.name`, params);
  const rates = await ratesFor(res.rows.map((r) => r.id));
  return res.rows.map((r) => mapRow(r, rates.get(r.id) ?? []));
}

export async function listContracts(actor: ActingPrincipal): Promise<ContractsResponse> {
  requireContractView(actor);
  return { items: await loadAll() };
}

export async function getContract(id: string, actor: ActingPrincipal): Promise<Contract> {
  requireContractView(actor);
  const found = await loadAll(`WHERE c.id = $1`, [id]);
  if (!found[0]) throw notFound('No such contract');
  return found[0];
}

// ── Which contract covers a work order ───────────────────────────────────────

export interface ContractMatch {
  contract: Contract;
  rates: ResolvedRates;
}

interface SubjectRow {
  client: string | null;
  billing_entity: string | null;
  trade: string | null;
  store: string | null;
  site_store: string | null;
  site_name: string | null;
}

/**
 * The contract in force for a work order today, with its rates resolved for
 * the work order's trade — or null when none covers it. Internal: every
 * caller has already resolved the work order through its own scope check.
 */
export async function contractForTask(taskId: string): Promise<ContractMatch | null> {
  const subj = await query<SubjectRow>(
    `SELECT t.client, t.billing_entity, t.trade,
            t.fields->>'Store' AS store,
            s.store_number AS site_store, s.name AS site_name
       FROM task t
       LEFT JOIN site s ON s.id = t.site_id
      WHERE t.id = $1`,
    [taskId],
  );
  const s = subj.rows[0];
  if (!s) return null;

  const candidates = await loadAll(`WHERE c.active`);
  if (candidates.length === 0) return null;

  const subject = {
    client: s.client,
    billing_entity: s.billing_entity,
    trade: s.trade,
    site: s.store ?? s.site_store ?? s.site_name,
  };
  // A contract naming sites may name them by store number OR by site name;
  // try the store first, then the name, so either spelling on the card works.
  const contract =
    pickContract(candidates, subject, today()) ??
    (s.site_name && subject.site !== s.site_name
      ? pickContract(candidates, { ...subject, site: s.site_name }, today())
      : null);
  if (!contract) return null;
  return { contract, rates: resolveRates(contract.rates, s.trade) };
}

/** Hours on site across every completed visit on the work order (0021), to
    the quarter hour — the "hours" in "contract rate × hours on site". */
export async function hoursOnSite(taskId: string): Promise<{ hours: number; visits: number }> {
  const res = await query<{ checked_in_at: string | null; checked_out_at: string | null }>(
    `SELECT ${ISO('checked_in_at')} AS checked_in_at, ${ISO('checked_out_at')} AS checked_out_at
       FROM wo_visit WHERE task_id = $1`,
    [taskId],
  );
  let hours = 0;
  let visits = 0;
  for (const v of res.rows) {
    const h = billableHours(v.checked_in_at, v.checked_out_at);
    if (h > 0) {
      hours += h;
      visits += 1;
    }
  }
  return { hours: Math.round(hours * 100) / 100, visits };
}

// ── Writing ──────────────────────────────────────────────────────────────────

function cleanInput(input: ContractInput): Required<Omit<ContractInput, 'rates'>> & { rates: ContractRateInput[] } {
  const name = String(input.name ?? '').trim();
  if (name === '') throw badRequest('A contract needs a name');
  const kind = input.kind ?? 'tm';
  if (!(CONTRACT_KINDS as readonly string[]).includes(kind)) throw badRequest(`Unknown contract kind "${kind}"`);
  const starts_on = input.starts_on ?? today();
  const ends_on = input.ends_on ?? null;
  if (ends_on && ends_on < starts_on) throw badRequest('A contract cannot end before it starts');
  const rates = (input.rates ?? []).map((r) => {
    if (!(RATE_TYPES as readonly string[]).includes(r.rate_type)) {
      throw badRequest(`Unknown rate type "${r.rate_type}"`);
    }
    if (!Number.isFinite(r.amount) || r.amount < 0) throw badRequest('A rate is zero or more');
    return { rate_type: r.rate_type, trade: r.trade?.trim() || null, amount: r.amount };
  });
  const list = (v: string[] | undefined) =>
    (v ?? []).map((s) => String(s).trim()).filter((s) => s.length > 0);
  return {
    name,
    client: input.client?.trim() || null,
    billing_entity: input.billing_entity?.trim() || null,
    kind,
    account_code: input.account_code?.trim() || null,
    starts_on,
    ends_on,
    active: input.active ?? true,
    sites_covered: list(input.sites_covered),
    trades_covered: list(input.trades_covered),
    notes: input.notes?.trim() || null,
    rates,
  };
}

function snapshot(c: Contract): Record<string, unknown> & { name: string } {
  return {
    name: c.name,
    client: c.client,
    billing_entity: c.billing_entity,
    kind: c.kind,
    account_code: c.account_code,
    starts_on: c.starts_on,
    ends_on: c.ends_on,
    active: c.active,
    sites_covered: c.sites_covered,
    trades_covered: c.trades_covered,
    notes: c.notes,
    rates: c.rates.map((r) => `${r.rate_type}${r.trade ? ` (${r.trade})` : ''}: ${r.amount}`),
  };
}

async function writeRates(tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, id: string, rates: ContractRateInput[]) {
  await tx.query(`DELETE FROM contract_rate WHERE contract_id = $1`, [id]);
  let position = 0;
  for (const r of rates) {
    await tx.query(
      `INSERT INTO contract_rate (contract_id, rate_type, trade, amount, position) VALUES ($1, $2, $3, $4, $5)`,
      [id, r.rate_type, r.trade ?? null, r.amount, position++],
    );
  }
}

export async function createContract(input: ContractInput, actor: ActingPrincipal): Promise<Contract> {
  requireContractEdit(actor, 'create');
  const v = cleanInput(input);
  let id = '';
  await withTransaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO contract
         (name, client, billing_entity, kind, account_code, starts_on, ends_on, active,
          sites_covered, trades_covered, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9::text[], $10::text[], $11, $12)
       RETURNING id::text AS id`,
      [
        v.name, v.client, v.billing_entity, v.kind, v.account_code, v.starts_on, v.ends_on,
        v.active, v.sites_covered, v.trades_covered, v.notes, actor.id,
      ],
    );
    id = ins.rows[0].id;
    await writeRates(tx, id, v.rates);
  });
  const created = await getContract(id, actor);
  await logAdminEvent({ actorId: actor.id, entity: 'contract', entityId: id, action: 'contract_created', after: snapshot(created) });
  return created;
}

export async function updateContract(id: string, input: ContractInput, actor: ActingPrincipal): Promise<Contract> {
  requireContractEdit(actor, 'edit');
  const before = await getContract(id, actor);
  const v = cleanInput({ ...before, ...input, rates: input.rates ?? before.rates });
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE contract
          SET name = $2, client = $3, billing_entity = $4, kind = $5, account_code = $6,
              starts_on = $7::date, ends_on = $8::date, active = $9,
              sites_covered = $10::text[], trades_covered = $11::text[], notes = $12
        WHERE id = $1`,
      [
        id, v.name, v.client, v.billing_entity, v.kind, v.account_code, v.starts_on, v.ends_on,
        v.active, v.sites_covered, v.trades_covered, v.notes,
      ],
    );
    await writeRates(tx, id, v.rates);
  });
  const after = await getContract(id, actor);
  await logAdminEvent({
    actorId: actor.id, entity: 'contract', entityId: id, action: 'contract_updated',
    before: snapshot(before), after: snapshot(after),
  });
  return after;
}

export async function deleteContract(id: string, actor: ActingPrincipal): Promise<void> {
  requireContractEdit(actor, 'delete');
  const before = await getContract(id, actor);
  // A quote that priced against it keeps its snapshot (quote.ot_multiplier);
  // only the pointer goes (ON DELETE SET NULL).
  await query(`DELETE FROM contract WHERE id = $1`, [id]);
  await logAdminEvent({
    actorId: actor.id, entity: 'contract', entityId: id, action: 'contract_deleted',
    before: snapshot(before), after: null,
  });
}
