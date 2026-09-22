// Billing proposals (0053) — BRD §6.4: "Vendor payments can be automated from
// the contract held with the vendor and the hours spent on site. If enabled,
// an invoice is generated automatically once the work order is completed;
// confirming it creates the invoice and files it in the Invoices section."
//
// The generated half is a `billing_proposal` row, written when a work order
// moves into the done group and a covering contract has `auto_invoice` on:
//
//   client contract  → an INVOICE proposal — the approved quote's lines if
//                      there is one, else hours on site × the contract rate
//                      plus the trip charge (the same lines "Raise invoice"
//                      would write, from services/invoices.ts draftInvoice);
//   vendor contract  → a VENDOR BILL proposal — hours on site × the vendor's
//                      rate plus their trip charge.
//
// A proposal is not a document. It has no number, sits in no queue's totals,
// and is refused by nothing: confirming it copies its lines into a real
// invoice (createInvoice) or vendor bill (createVendorBill), which then run
// the same gates as one raised by hand; dismissing files nothing and says
// why. Both are logged on the work order under field `proposal:<id>`.
//
// Proposing never throws — it runs after a status change has committed, and
// a contract with a typo must not undo a completion.

import {
  BILLING_PROPOSAL_KINDS,
  INVOICE_PERM_KEY,
  contractBillingLines,
  proposalTotals,
  withAmounts,
  type BillingProposal,
  type BillingProposalKind,
  type BillingProposalLine,
  type BillingProposalStatus,
} from '@theone/shared';
import { query } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { requirePerm } from './permissions.js';
import { woScopeSql } from './woScope.js';
import { Params } from './woFields.js';
import type { ActingPrincipal } from './activity.js';
import { contractForTask, hoursOnSite, vendorContractForTask } from './contracts.js';
import { createInvoice, draftInvoice } from './invoices.js';
import { createVendorBill } from './vendorBills.js';

const ISO = (col: string) => `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const n = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

// ── Who may see and decide which kind ────────────────────────────────────────

/** An invoice proposal is AR's (`invoicing`); a vendor-bill proposal is AP's
    (`payments`) — the same grants that raise the real documents. */
const PERM_BY_KIND: Record<BillingProposalKind, string> = {
  invoice: INVOICE_PERM_KEY,
  vendor_bill: 'payments',
};

function canView(p: ActingPrincipal, kind: BillingProposalKind): boolean {
  try {
    requirePerm(p, PERM_BY_KIND[kind], 'view', '');
    return true;
  } catch {
    return false;
  }
}

function requireDecide(p: ActingPrincipal, kind: BillingProposalKind): void {
  requirePerm(p, PERM_BY_KIND[kind], 'view', 'You cannot see this proposal');
  requirePerm(
    p,
    PERM_BY_KIND[kind],
    'create',
    kind === 'invoice' ? 'You cannot raise invoices' : 'You cannot record vendor bills',
  );
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  task_id: string;
  wo_number: string;
  client: string | null;
  billing_entity: string | null;
  title: string | null;
  kind: string;
  contract_id: string | null;
  contract_name: string;
  vendor_name: string | null;
  basis: string;
  hours: string | number;
  visits: number;
  lines: unknown;
  subtotal: string | number;
  tax: string | number;
  total: string | number;
  status: string;
  result_id: string | null;
  decided_by_id: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

const SELECT = `
  SELECT p.id::text AS id, p.task_id::text AS task_id, t.wo_number, t.client, t.billing_entity, t.title,
         p.kind, p.contract_id::text AS contract_id, p.contract_name, p.vendor_name,
         p.basis, p.hours, p.visits, p.lines, p.subtotal, p.tax, p.total, p.status,
         p.result_id::text AS result_id,
         p.decided_by::text AS decided_by_id, d.display_name AS decided_by_name,
         ${ISO('p.decided_at')} AS decided_at, p.decision_note,
         ${ISO('p.created_at')} AS created_at
    FROM billing_proposal p
    JOIN task t ON t.id = p.task_id
    LEFT JOIN principal d ON d.id = p.decided_by`;

function parseLines(v: unknown): BillingProposalLine[] {
  const raw = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    return {
      kind: String(o.kind ?? 'service'),
      description: String(o.description ?? ''),
      quantity: n(o.quantity as number),
      unit_price: n(o.unit_price as number),
      amount: n(o.amount as number),
    };
  });
}

function mapRow(r: Row): BillingProposal {
  return {
    id: r.id,
    task_id: r.task_id,
    wo_number: r.wo_number,
    client: r.client,
    billing_entity: r.billing_entity,
    title: r.title,
    kind: (r.kind === 'vendor_bill' ? 'vendor_bill' : 'invoice') as BillingProposalKind,
    contract_id: r.contract_id,
    contract_name: r.contract_name,
    vendor_name: r.vendor_name,
    basis: r.basis,
    hours: n(r.hours),
    visits: Number(r.visits ?? 0),
    lines: parseLines(r.lines),
    subtotal: n(r.subtotal),
    tax: n(r.tax),
    total: n(r.total),
    status: r.status as BillingProposalStatus,
    result_id: r.result_id,
    decided_by: r.decided_by_id ? { id: r.decided_by_id, display_name: r.decided_by_name ?? '—' } : null,
    decided_at: r.decided_at,
    decision_note: r.decision_note,
    created_at: r.created_at,
  };
}

/** Every pending proposal on work orders this person can see, oldest first,
    trimmed to the kinds their grants cover. */
export async function listPendingProposals(actor: ActingPrincipal): Promise<BillingProposal[]> {
  const kinds = BILLING_PROPOSAL_KINDS.filter((k) => canView(actor, k));
  if (kinds.length === 0) return [];
  const p = new Params();
  const scope = woScopeSql(actor, p);
  const kindsParam = p.add(kinds);
  const res = await query<Row>(
    `${SELECT} WHERE p.status = 'pending' AND t.deleted_at IS NULL
        AND p.kind = ANY(${kindsParam}::text[])${scope ? ` AND ${scope}` : ''}
      ORDER BY p.created_at ASC LIMIT 500`,
    p.values,
  );
  return res.rows.map(mapRow);
}

/** The proposals on one work order — pending ones and the decided ones, so
    the card can say "dismissed by X: reason". Internal: the route resolved
    the work order through the scope check already. */
export async function proposalsForTask(taskId: string, actor: ActingPrincipal): Promise<BillingProposal[]> {
  const kinds = BILLING_PROPOSAL_KINDS.filter((k) => canView(actor, k));
  if (kinds.length === 0) return [];
  const res = await query<Row>(
    `${SELECT} WHERE p.task_id = $1 AND p.kind = ANY($2::text[]) ORDER BY p.created_at DESC`,
    [taskId, kinds],
  );
  return res.rows.map(mapRow);
}

async function load(id: string): Promise<BillingProposal> {
  const res = await query<Row>(`${SELECT} WHERE p.id = $1`, [id]);
  if (!res.rows[0]) throw notFound('No such proposal');
  return mapRow(res.rows[0]);
}

// ── Deciding ─────────────────────────────────────────────────────────────────

async function stamp(
  proposal: BillingProposal,
  status: 'confirmed' | 'dismissed',
  actor: ActingPrincipal,
  resultId: string | null,
  note: string | null,
): Promise<void> {
  await query(
    `UPDATE billing_proposal
        SET status = $2, result_id = $3::uuid, decided_by = $4, decided_at = now(), decision_note = $5
      WHERE id = $1`,
    [proposal.id, status, resultId, actor.id, note],
  );
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      actor.id,
      proposal.task_id,
      status === 'confirmed' ? 'billing_proposal_confirmed' : 'billing_proposal_dismissed',
      `proposal:${proposal.id}`,
      JSON.stringify({ status: 'pending', kind: proposal.kind, total: proposal.total }),
      JSON.stringify({ status, kind: proposal.kind, total: proposal.total, contract: proposal.contract_name, result_id: resultId, note }),
    ],
  );
}

/** Yes: file the document the proposal describes, with exactly its lines. */
export async function confirmProposal(
  id: string,
  actor: ActingPrincipal,
  note?: string | null,
): Promise<{ proposal: BillingProposal; result_id: string }> {
  const proposal = await load(id);
  requireDecide(actor, proposal.kind);
  if (proposal.status !== 'pending') {
    throw conflict(`This proposal was already ${proposal.status}`, { status: proposal.status });
  }
  if (proposal.lines.length === 0) throw badRequest('This proposal has no lines to file');

  let resultId: string;
  if (proposal.kind === 'invoice') {
    const invoice = await createInvoice(proposal.task_id, actor, {
      lines: proposal.lines.map((l) => ({ kind: l.kind, description: l.description, quantity: l.quantity, unit_price: l.unit_price })),
      tax: proposal.tax,
      basis: `proposal: ${proposal.basis}`,
      contract_id: proposal.contract_id,
    });
    resultId = invoice.id;
  } else {
    const bill = await createVendorBill(
      {
        task_id: proposal.task_id,
        vendor_name: proposal.vendor_name ?? 'Vendor',
        tax: proposal.tax,
        note: `Proposed on completion from ${proposal.contract_name}`,
        contract_id: proposal.contract_id,
        lines: proposal.lines.map((l) => ({ kind: l.kind, description: l.description, quantity: l.quantity, unit_price: l.unit_price })),
      },
      actor,
    );
    resultId = bill.id;
  }
  await stamp(proposal, 'confirmed', actor, resultId, note?.trim() || null);
  return { proposal: await load(id), result_id: resultId };
}

/** No: file nothing, keep the reason. */
export async function dismissProposal(id: string, actor: ActingPrincipal, note?: string | null): Promise<BillingProposal> {
  const proposal = await load(id);
  requireDecide(actor, proposal.kind);
  if (proposal.status !== 'pending') {
    throw conflict(`This proposal was already ${proposal.status}`, { status: proposal.status });
  }
  await stamp(proposal, 'dismissed', actor, null, note?.trim() || null);
  return load(id);
}

// ── Proposing, on completion ─────────────────────────────────────────────────

async function insertProposal(
  taskId: string,
  actorId: string,
  p: {
    kind: BillingProposalKind;
    contract_id: string;
    contract_name: string;
    vendor_name: string | null;
    basis: string;
    hours: number;
    visits: number;
    lines: BillingProposalLine[];
    tax: number;
  },
): Promise<void> {
  const { subtotal, total } = proposalTotals(p.lines, p.tax);
  const ins = await query<{ id: string }>(
    `INSERT INTO billing_proposal
       (task_id, kind, contract_id, contract_name, vendor_name, basis, hours, visits, lines, subtotal, tax, total)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
     RETURNING id::text AS id`,
    [
      taskId, p.kind, p.contract_id, p.contract_name, p.vendor_name, p.basis,
      p.hours, p.visits, JSON.stringify(p.lines), subtotal, p.tax, total,
    ],
  );
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'billing_proposed', $3, NULL, $4::jsonb)`,
    [
      actorId,
      taskId,
      `proposal:${ins.rows[0].id}`,
      JSON.stringify({ kind: p.kind, contract: p.contract_name, basis: p.basis, hours: p.hours, visits: p.visits, total, lines: p.lines.length }),
    ],
  );
}

async function hasPending(taskId: string, kind: BillingProposalKind): Promise<boolean> {
  const res = await query<{ id: string }>(
    `SELECT id::text AS id FROM billing_proposal WHERE task_id = $1 AND kind = $2 AND status = 'pending' LIMIT 1`,
    [taskId, kind],
  );
  return res.rows.length > 0;
}

/**
 * Called after a work order's status change has committed, when the move
 * landed in the done group. Writes at most one pending proposal per kind
 * and never throws: a completion is a completion whatever the rate card
 * says. Returns what it proposed, for the caller's log.
 */
export async function proposeBillingOnCompletion(
  taskId: string,
  actorId: string,
): Promise<BillingProposalKind[]> {
  const proposed: BillingProposalKind[] = [];
  try {
    // The client side: our invoice, from the contract that prices the client.
    const client = await contractForTask(taskId);
    if (client?.contract.auto_invoice) {
      const existing = await query<{ id: string }>(
        `SELECT id::text AS id FROM invoice WHERE task_id = $1 LIMIT 1`,
        [taskId],
      );
      if (existing.rows.length === 0 && !(await hasPending(taskId, 'invoice'))) {
        const draft = await draftInvoice(taskId);
        const lines = withAmounts(
          draft.lines.map((l) => ({
            kind: l.kind ?? 'service',
            description: l.description,
            quantity: l.quantity ?? 1,
            unit_price: l.unit_price ?? 0,
            amount: 0,
          })),
        );
        if (lines.length > 0) {
          await insertProposal(taskId, actorId, {
            kind: 'invoice',
            contract_id: client.contract.id,
            contract_name: client.contract.name,
            vendor_name: null,
            basis: draft.basis,
            hours: draft.hours,
            visits: draft.visits,
            lines,
            tax: draft.tax,
          });
          proposed.push('invoice');
        }
      }
    }

    // The vendor side: their bill to us, from the terms held with them.
    const vendor = await vendorContractForTask(taskId);
    if (vendor?.contract.auto_invoice && vendor.contract.kind === 'tm') {
      const existing = await query<{ id: string }>(
        `SELECT id::text AS id FROM vendor_bill WHERE task_id = $1 AND status <> 'void' LIMIT 1`,
        [taskId],
      );
      if (existing.rows.length === 0 && !(await hasPending(taskId, 'vendor_bill'))) {
        const { hours, visits } = await hoursOnSite(taskId);
        const lines = contractBillingLines(vendor.rates, hours, visits, vendor.contract.name);
        if (lines.length > 0) {
          await insertProposal(taskId, actorId, {
            kind: 'vendor_bill',
            contract_id: vendor.contract.id,
            contract_name: vendor.contract.name,
            vendor_name: vendor.vendor,
            basis: `contract: ${vendor.contract.name}`,
            hours,
            visits,
            lines,
            tax: 0,
          });
          proposed.push('vendor_bill');
        }
      }
    }
  } catch (err) {
    // Logged, never raised: see the file comment.
    console.error('billing proposal on completion failed', { taskId, err });
  }
  return proposed;
}
