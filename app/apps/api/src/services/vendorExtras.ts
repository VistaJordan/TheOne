// 0066 · Vendors, the rest: invoicing rules and credit notes, the dispatch
// cascade, skills / inductions / consumables, and vendor performance.
//
// Three things here are deliberately soft:
//   · the invoicing rules only WARN. `billExtrasFor` hangs the warnings on a
//     bill as it is read; approving and paying a bill are untouched.
//   · a credit note changes no stored total: a bill's net is computed here.
//   · the dispatch cascade does nothing at all while its setting is off
//     (the default). Switched on, it only ever offers a job to the vendors
//     Admin › Vendors & map lists as PREFERRED for that client and trade, so
//     a client or trade with no preferred vendors is never touched.
// Nothing here sends an email or talks to Ecotrak.

import {
  BILL_RULE_DEFAULTS,
  DISPATCH_DEFAULTS,
  VENDOR_DISPATCH_PERM_KEY,
  billWarnings,
  cleanBillRules,
  cleanDispatchSettings,
  creditNeedsApproval,
  creditNoteProblem,
  inductionState,
  nextCandidate,
  permAllows,
} from '@theone/shared';
import type {
  BillExtras,
  BillRules,
  ConsumableItem,
  DispatchCandidate,
  DispatchOffer,
  DispatchOfferStatus,
  DispatchSettings,
  FeedActor,
  PermAction,
  SkillLevel,
  VendorCatalogues,
  VendorCreditNote,
  VendorPerformanceResponse,
  VendorPerformanceRow,
  VendorQualifications,
  WoConsumablesResponse,
  WoDispatch,
} from '@theone/shared';
import { query } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { notify } from './notices.js';
import { requirePerm } from './permissions.js';
import { serviceActorId } from './serviceActors.js';
import { requireVendorAdmin } from './vendorMap.js';
import { assertVendorInScope, requireVendorsView } from './vendors.js';
import { logTaskChanges } from './woAudit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const can = (a: ActingPrincipal, key: string, action: PermAction): boolean => permAllows(a.perms, key, action, a.isSuperAdmin);
const today = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const round2 = (n: number): number => Math.round(n * 100) / 100;

async function peopleByIds(ids: (string | null | undefined)[]): Promise<Map<string, FeedActor>> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x) && UUID_RE.test(x!)))];
  if (want.length === 0) return new Map();
  const res = await query<FeedActor>(`SELECT id::text AS id, display_name AS name, kind FROM principal WHERE id = ANY($1::uuid[])`, [want]);
  return new Map(res.rows.map((r) => [r.id, r]));
}

async function logWo(taskId: string, actorId: string, field: string, before: unknown, after: unknown): Promise<void> {
  await logTaskChanges({ query: (sql, params) => query(sql, params) }, actorId, taskId, [{ field, before, after }]);
}

// ═══ Settings ════════════════════════════════════════════════════════════════

async function setting(key: string): Promise<unknown> {
  const res = await query<{ value: unknown }>(`SELECT value FROM vendor_setting WHERE key = $1`, [key]);
  return res.rows[0]?.value ?? null;
}

async function writeSetting(key: string, value: unknown, actor: ActingPrincipal, before: unknown): Promise<void> {
  await query(
    `INSERT INTO vendor_setting (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), actor.id],
  );
  await logAdminEvent({
    actorId: actor.id,
    entity: 'vendor_setting',
    entityId: key,
    action: 'vendor_setting_updated',
    before: { name: key, ...(before as Record<string, unknown>) },
    after: { name: key, ...(value as Record<string, unknown>) },
  });
}

export async function getBillRules(): Promise<BillRules> {
  const raw = await setting('bill_rules');
  return raw === null ? { ...BILL_RULE_DEFAULTS } : cleanBillRules(raw);
}

export async function getDispatchSettings(): Promise<DispatchSettings> {
  const raw = await setting('dispatch_cascade');
  return raw === null ? { ...DISPATCH_DEFAULTS } : cleanDispatchSettings(raw);
}

// ═══ Vendor bills: warnings and credit notes ═════════════════════════════════

type CreditRow = {
  id: string;
  credit_number: string;
  bill_id: string;
  amount: string;
  reason: string;
  vendor_ref: string | null;
  status: VendorCreditNote['status'];
  created_by: string | null;
  created_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  void_reason: string | null;
};

const CREDIT_SELECT = `
  SELECT id::text AS id, credit_number, bill_id::text AS bill_id, amount, reason, vendor_ref, status,
         created_by::text AS created_by, created_at, decided_by::text AS decided_by, decided_at, void_reason
    FROM vendor_credit_note`;

async function mapCredits(rows: CreditRow[]): Promise<VendorCreditNote[]> {
  const people = await peopleByIds(rows.flatMap((r) => [r.created_by, r.decided_by]));
  return rows.map((r) => ({
    id: r.id,
    credit_number: r.credit_number,
    bill_id: r.bill_id,
    amount: Number(r.amount),
    reason: r.reason,
    vendor_ref: r.vendor_ref,
    status: r.status,
    created_by: r.created_by ? (people.get(r.created_by) ?? null) : null,
    created_at: r.created_at.toISOString(),
    decided_by: r.decided_by ? (people.get(r.decided_by) ?? null) : null,
    decided_at: iso(r.decided_at),
    void_reason: r.void_reason,
  }));
}

/** The warnings and credit notes of a set of bills, in three queries however
 *  many bills there are. Called by the vendor-bill reads; a failure here must
 *  never take the bills down with it, so the caller catches. */
export async function billExtrasFor(bills: { id: string; total: number; status: string }[]): Promise<Map<string, BillExtras>> {
  const out = new Map<string, BillExtras>();
  if (bills.length === 0) return out;
  const ids = bills.map((b) => b.id);
  const [rules, facts, credits] = await Promise.all([
    getBillRules(),
    query<{
      id: string;
      bill_number: string | null;
      received_on: string;
      same_number: number;
      vendor_total: string;
      wo_cost: string | null;
      has_vendor: boolean;
      vendor_on_wo: boolean;
      completed_on: string | null;
    }>(
      `SELECT b.id::text AS id, b.bill_number, to_char(b.received_on, 'YYYY-MM-DD') AS received_on,
              (SELECT count(*)::int FROM vendor_bill o
                WHERE o.id <> b.id AND o.status <> 'void' AND NULLIF(btrim(o.bill_number), '') IS NOT NULL
                  AND lower(btrim(o.bill_number)) = lower(btrim(b.bill_number))
                  AND (o.vendor_id = b.vendor_id OR (b.vendor_id IS NULL AND lower(o.vendor_name) = lower(b.vendor_name)))) AS same_number,
              (SELECT COALESCE(sum(o.total), 0) FROM vendor_bill o
                WHERE o.task_id = b.task_id AND o.status <> 'void'
                  AND (o.vendor_id = b.vendor_id OR (b.vendor_id IS NULL AND lower(o.vendor_name) = lower(b.vendor_name)))) AS vendor_total,
              NULLIF(regexp_replace(COALESCE(t.fields->>'34. Cost', ''), '[^0-9.-]', '', 'g'), '') AS wo_cost,
              b.vendor_id IS NOT NULL AS has_vendor,
              (b.vendor_id IS NOT NULL AND (t.vendor_id = b.vendor_id
                 OR EXISTS (SELECT 1 FROM wo_technician wt WHERE wt.task_id = b.task_id AND wt.vendor_id = b.vendor_id))) AS vendor_on_wo,
              CASE WHEN t.service_completed_at IS NOT NULL THEN to_char(t.service_completed_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD')
                   WHEN t.status_group::text IN ('done', 'closed') THEN to_char(t.updated_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD')
              END AS completed_on
         FROM vendor_bill b JOIN task t ON t.id = b.task_id
        WHERE b.id = ANY($1::uuid[])`,
      [ids],
    ),
    query<CreditRow>(`${CREDIT_SELECT} WHERE bill_id = ANY($1::uuid[]) ORDER BY created_at`, [ids]),
  ]);
  const notes = await mapCredits(credits.rows);
  const factsById = new Map(facts.rows.map((r) => [r.id, r]));
  for (const b of bills) {
    const f = factsById.get(b.id);
    const mine = notes.filter((n) => n.bill_id === b.id);
    const credited = round2(mine.filter((n) => n.status === 'approved').reduce((s, n) => s + n.amount, 0));
    out.set(b.id, {
      // A void bill is history: nothing to warn about.
      warnings:
        f && b.status !== 'void'
          ? billWarnings(
              {
                bill_number: f.bill_number,
                received_on: f.received_on,
                same_number: Number(f.same_number),
                vendor_total_on_wo: Number(f.vendor_total),
                wo_cost: num(f.wo_cost),
                has_vendor: f.has_vendor,
                vendor_on_wo: f.vendor_on_wo,
                completed_on: f.completed_on,
              },
              rules,
            )
          : [],
      credit_notes: mine,
      credited,
      net_total: round2(b.total - credited),
    });
  }
  return out;
}

async function billForCredit(billId: string): Promise<{ id: string; task_id: string; wo_number: string; total: number; status: string; vendor_name: string; live: number }> {
  if (!UUID_RE.test(billId)) throw notFound('No such vendor bill');
  const res = await query<{ id: string; task_id: string; wo_number: string; total: string; status: string; vendor_name: string; live: string }>(
    `SELECT b.id::text AS id, b.task_id::text AS task_id, t.wo_number, b.total, b.status, b.vendor_name,
            (SELECT COALESCE(sum(c.amount), 0) FROM vendor_credit_note c WHERE c.bill_id = b.id AND c.status <> 'void') AS live
       FROM vendor_bill b JOIN task t ON t.id = b.task_id WHERE b.id = $1`,
    [billId],
  );
  const r = res.rows[0];
  if (!r) throw notFound('No such vendor bill');
  return { ...r, total: Number(r.total), live: Number(r.live) };
}

export async function addCreditNote(billId: string, input: { amount: number; reason: string; vendor_ref?: string | null }, actor: ActingPrincipal): Promise<{ ok: true; credit_number: string; status: string }> {
  requirePerm(actor, 'payments', 'create', 'You cannot raise credit notes');
  const bill = await billForCredit(billId);
  const problem = creditNoteProblem(input.amount, input.reason ?? '', bill.total, bill.live, bill.status);
  if (problem) throw badRequest(problem);
  const rules = await getBillRules();
  const amount = round2(input.amount);
  // Small credits are approved as they are written; larger ones wait for
  // somebody who approves payments — unless the writer is one.
  const waits = creditNeedsApproval(amount, rules) && !can(actor, 'payments', 'approve');
  const ins = await query<{ credit_number: string }>(
    `INSERT INTO vendor_credit_note (bill_id, task_id, amount, reason, vendor_ref, status, created_by, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING credit_number`,
    [billId, bill.task_id, amount, input.reason.trim().slice(0, 500), clean(input.vendor_ref), waits ? 'pending' : 'approved', actor.id, waits ? null : actor.id, waits ? null : new Date()],
  );
  const number = ins.rows[0].credit_number;
  await logWo(bill.task_id, actor.id, 'Vendor credit note', null, `${number}: ${amount.toFixed(2)} against ${bill.vendor_name}’s bill — ${input.reason.trim()}${waits ? ' (waiting for approval)' : ''}`);
  if (waits) {
    const approvers = await query<{ id: string }>(
      `SELECT p.id::text AS id FROM principal p LEFT JOIN role r ON r.code = p.role
        WHERE p.kind = 'human' AND p.status <> 'disabled' AND (p.is_super_admin OR (r.permissions -> 'payments' ->> 'approve') = 'true')`,
    );
    await notify(approvers.rows.map((r) => r.id), {
      kind: 'credit_note',
      title: `${number} needs approval`,
      body: `A credit of $${amount.toFixed(2)} against ${bill.vendor_name}’s bill on ${bill.wo_number}.`,
      link: `/work-orders/${encodeURIComponent(bill.wo_number)}?tab=payables`,
      actorId: actor.id,
    });
  }
  return { ok: true, credit_number: number, status: waits ? 'pending' : 'approved' };
}

export async function decideCreditNote(creditId: string, decision: 'approve' | 'void', note: string | null, actor: ActingPrincipal): Promise<{ ok: true }> {
  if (!UUID_RE.test(creditId)) throw notFound('No such credit note');
  const cur = await query<{ credit_number: string; task_id: string; status: string; created_by: string | null; amount: string }>(
    `SELECT credit_number, task_id::text AS task_id, status, created_by::text AS created_by, amount FROM vendor_credit_note WHERE id = $1`,
    [creditId],
  );
  const row = cur.rows[0];
  if (!row) throw notFound('No such credit note');
  if (row.status === 'void') throw conflict('That credit note is already void');
  if (decision === 'approve') {
    requirePerm(actor, 'payments', 'approve', 'Approving a credit note is for people who approve payments');
    if (row.status !== 'pending') throw conflict('That credit note is not waiting for approval');
    await query(`UPDATE vendor_credit_note SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [creditId, actor.id]);
    await logWo(row.task_id, actor.id, 'Vendor credit note', 'pending', `${row.credit_number} approved`);
  } else {
    // Whoever wrote it may withdraw it while it waits; after that, an approver.
    const own = row.status === 'pending' && row.created_by === actor.id;
    if (!own) requirePerm(actor, 'payments', 'approve', 'Voiding a credit note is for people who approve payments');
    const reason = clean(note);
    if (!reason) throw badRequest('Say why the credit note is void', { field: 'note' });
    await query(`UPDATE vendor_credit_note SET status = 'void', decided_by = $2, decided_at = now(), void_reason = $3 WHERE id = $1`, [creditId, actor.id, reason]);
    await logWo(row.task_id, actor.id, 'Vendor credit note', row.status, `${row.credit_number} void: ${reason}`);
  }
  return { ok: true };
}

// ═══ Dispatch cascade ════════════════════════════════════════════════════════

type OfferRow = {
  id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_phone: string | null;
  rank: number;
  status: DispatchOfferStatus;
  offered_at: Date;
  expires_at: Date | null;
  responded_at: Date | null;
  responded_via: string | null;
  note: string | null;
};

const mapOffer = (r: OfferRow): DispatchOffer => ({
  id: r.id,
  vendor: { id: r.vendor_id, name: r.vendor_name, phone: r.vendor_phone },
  rank: r.rank,
  status: r.status,
  offered_at: r.offered_at.toISOString(),
  expires_at: iso(r.expires_at),
  responded_at: iso(r.responded_at),
  responded_via: r.responded_via,
  note: r.note,
});

async function offersOf(taskId: string): Promise<DispatchOffer[]> {
  const res = await query<OfferRow>(
    `SELECT o.id::text AS id, o.vendor_id::text AS vendor_id, v.name AS vendor_name, COALESCE(v.dispatch_phone, v.phone) AS vendor_phone,
            o.rank, o.status, o.offered_at, o.expires_at, o.responded_at, o.responded_via, o.note
       FROM wo_dispatch_offer o JOIN vendor v ON v.id = o.vendor_id
      WHERE o.task_id = $1 ORDER BY o.offered_at`,
    [taskId],
  );
  return res.rows.map(mapOffer);
}

/** The preferred vendors for the work order's client, trade and state, the
 *  most specific rule first, each vendor once. */
async function candidatesOf(taskId: string, offered: Set<string>): Promise<DispatchCandidate[]> {
  const res = await query<{ vendor_id: string; name: string; rank: number; client: string | null; trade: string | null; state: string | null; blacklisted: boolean; spec: number }>(
    `SELECT pv.vendor_id::text AS vendor_id, v.name, pv.rank, pv.client, pv.trade, pv.state, v.blacklisted,
            ((pv.client IS NOT NULL)::int * 4 + (pv.trade IS NOT NULL)::int * 2 + (pv.state IS NOT NULL)::int) AS spec
       FROM task t
       JOIN preferred_vendor pv
         ON (pv.client IS NULL OR lower(pv.client) = lower(COALESCE(t.client, '')))
        AND (pv.trade IS NULL OR lower(pv.trade) = lower(COALESCE(t.trade, '')))
        AND (pv.state IS NULL OR lower(pv.state) = lower(COALESCE(t.state, '')))
       JOIN vendor v ON v.id = pv.vendor_id AND v.deleted_at IS NULL
      WHERE t.id = $1
      ORDER BY spec DESC, pv.rank, lower(v.name)`,
    [taskId],
  );
  const seen = new Set<string>();
  const out: DispatchCandidate[] = [];
  for (const r of res.rows) {
    if (seen.has(r.vendor_id)) continue;
    seen.add(r.vendor_id);
    out.push({
      vendor_id: r.vendor_id,
      name: r.name,
      rank: out.length + 1,
      rule: [r.client ?? 'Any client', r.trade ?? 'any trade', r.state].filter(Boolean).join(' · '),
      blacklisted: r.blacklisted,
      offered: offered.has(r.vendor_id),
    });
  }
  return out;
}

async function offerTo(taskId: string, c: DispatchCandidate, hours: number, startedBy: string | null): Promise<void> {
  await query(
    `INSERT INTO wo_dispatch_offer (task_id, vendor_id, rank, expires_at, started_by)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5)`,
    [taskId, c.vendor_id, c.rank, hours, startedBy],
  );
}

/** Move a run along: an offer whose clock ran out becomes "no answer" and the
 *  job goes to the next preferred vendor. Safe to call on every read. */
async function advance(taskId: string, settings: DispatchSettings): Promise<void> {
  if (!settings.enabled) return;
  const lapsed = await query<{ id: string; started_by: string | null }>(
    `UPDATE wo_dispatch_offer SET status = 'expired', responded_at = now(), responded_via = 'system'
      WHERE task_id = $1 AND status = 'offered' AND expires_at IS NOT NULL AND expires_at < now()
      RETURNING id::text AS id, started_by::text AS started_by`,
    [taskId],
  );
  if (!lapsed.rows[0]) return;
  await offerNext(taskId, settings, lapsed.rows[0].started_by);
}

async function offerNext(taskId: string, settings: DispatchSettings, startedBy: string | null): Promise<DispatchCandidate | null> {
  const has = await query<{ vendor_id: string | null }>(`SELECT vendor_id::text AS vendor_id FROM task WHERE id = $1`, [taskId]);
  // Somebody assigned a vendor by hand in the meantime: the run is over.
  if (has.rows[0]?.vendor_id) return null;
  const offers = await offersOf(taskId);
  if (offers.some((o) => o.status === 'offered')) return null;
  const next = nextCandidate(await candidatesOf(taskId, new Set(offers.map((o) => o.vendor.id))));
  if (!next) {
    const wo = await query<{ wo_number: string }>(`SELECT wo_number FROM task WHERE id = $1`, [taskId]);
    await notify([startedBy], {
      kind: 'dispatch',
      title: `No vendor took ${wo.rows[0]?.wo_number ?? 'the work order'}`,
      body: 'Every preferred vendor declined or did not answer. Assign one by hand.',
      link: wo.rows[0] ? `/work-orders/${encodeURIComponent(wo.rows[0].wo_number)}?tab=people` : null,
    });
    return null;
  }
  await offerTo(taskId, next, settings.hours, startedBy);
  return next;
}

export async function getWoDispatch(taskId: string, actor: ActingPrincipal): Promise<WoDispatch> {
  const view = can(actor, VENDOR_DISPATCH_PERM_KEY, 'view');
  const settings = await getDispatchSettings();
  if (!view) return { settings, offers: [], candidates: [], live: null, can: { view: false, edit: false } };
  await advance(taskId, settings);
  const offers = await offersOf(taskId);
  return {
    settings,
    offers,
    candidates: await candidatesOf(taskId, new Set(offers.map((o) => o.vendor.id))),
    live: offers.find((o) => o.status === 'offered') ?? null,
    can: { view: true, edit: settings.enabled && can(actor, VENDOR_DISPATCH_PERM_KEY, 'edit') && can(actor, 'work_orders', 'edit') },
  };
}

function requireDispatchEdit(actor: ActingPrincipal): void {
  requirePerm(actor, VENDOR_DISPATCH_PERM_KEY, 'edit', 'You cannot run dispatch offers');
  requirePerm(actor, 'work_orders', 'edit', 'You cannot edit work orders');
}

export async function startDispatch(taskId: string, actor: ActingPrincipal): Promise<WoDispatch> {
  requireDispatchEdit(actor);
  const settings = await getDispatchSettings();
  if (!settings.enabled) throw conflict('Dispatch offers are switched off (Admin › Vendors & map)');
  const t = await query<{ vendor_id: string | null }>(`SELECT vendor_id::text AS vendor_id FROM task WHERE id = $1`, [taskId]);
  if (t.rows[0]?.vendor_id) throw conflict('This work order already has a responsible vendor');
  const live = await query(`SELECT 1 FROM wo_dispatch_offer WHERE task_id = $1 AND status = 'offered'`, [taskId]);
  if (live.rows[0]) throw conflict('An offer is already out for this work order');
  const next = await offerNext(taskId, settings, actor.id);
  if (!next) throw conflict('There is no preferred vendor left to offer this work order to. Add preferred vendors for its client and trade in Admin › Vendors & map, or assign one by hand.');
  await logWo(taskId, actor.id, 'Dispatch offer', null, `offered to ${next.name} (${settings.hours}h to answer)`);
  return getWoDispatch(taskId, actor);
}

/** Record an answer. `via` says who gave it; the portal passes no actor. */
export async function answerOffer(
  offerId: string,
  answer: 'accept' | 'decline',
  note: string | null,
  via: 'staff' | 'portal',
  actorId: string,
): Promise<{ task_id: string; vendor_name: string }> {
  if (!UUID_RE.test(offerId)) throw notFound('That offer does not exist');
  const cur = await query<{ task_id: string; vendor_id: string; vendor_name: string; blacklisted: boolean; status: string; started_by: string | null; wo_number: string; current_vendor: string | null }>(
    `SELECT o.task_id::text AS task_id, o.vendor_id::text AS vendor_id, v.name AS vendor_name, v.blacklisted, o.status, o.started_by::text AS started_by,
            t.wo_number, t.vendor_id::text AS current_vendor
       FROM wo_dispatch_offer o JOIN vendor v ON v.id = o.vendor_id JOIN task t ON t.id = o.task_id WHERE o.id = $1`,
    [offerId],
  );
  const o = cur.rows[0];
  if (!o) throw notFound('That offer does not exist');
  if (o.status !== 'offered') throw conflict('That offer is no longer open');
  const settings = await getDispatchSettings();
  const link = `/work-orders/${encodeURIComponent(o.wo_number)}?tab=people`;
  if (answer === 'accept') {
    if (o.blacklisted) throw conflict(`${o.vendor_name} is blacklisted and cannot take a work order`);
    if (o.current_vendor && o.current_vendor !== o.vendor_id) throw conflict('Another vendor was assigned to this work order in the meantime');
    await query(`UPDATE wo_dispatch_offer SET status = 'accepted', responded_at = now(), responded_via = $2, note = $3 WHERE id = $1`, [offerId, via, clean(note)]);
    await query(`UPDATE task SET vendor_id = $2 WHERE id = $1`, [o.task_id, o.vendor_id]);
    await logWo(o.task_id, actorId, 'Vendor', null, `${o.vendor_name} (accepted the offer${via === 'portal' ? ' on the vendor portal' : ''})`);
    await notify([o.started_by], { kind: 'dispatch', title: `${o.vendor_name} accepted ${o.wo_number}`, body: via === 'portal' ? 'Answered on the vendor portal.' : null, link, actorId });
  } else {
    await query(`UPDATE wo_dispatch_offer SET status = 'declined', responded_at = now(), responded_via = $2, note = $3 WHERE id = $1`, [offerId, via, clean(note)]);
    await logWo(o.task_id, actorId, 'Dispatch offer', null, `${o.vendor_name} declined${clean(note) ? `: ${clean(note)}` : ''}`);
    const next = settings.enabled ? await offerNext(o.task_id, settings, o.started_by) : null;
    if (next) await logWo(o.task_id, actorId, 'Dispatch offer', null, `offered to ${next.name} (${settings.hours}h to answer)`);
    await notify([o.started_by], { kind: 'dispatch', title: `${o.vendor_name} declined ${o.wo_number}`, body: next ? `Now offered to ${next.name}.` : null, link, actorId });
  }
  return { task_id: o.task_id, vendor_name: o.vendor_name };
}

export async function answerOfferAsStaff(taskId: string, offerId: string, answer: 'accept' | 'decline', note: string | null, actor: ActingPrincipal): Promise<WoDispatch> {
  requireDispatchEdit(actor);
  const own = await query(`SELECT 1 FROM wo_dispatch_offer WHERE id = $1 AND task_id = $2`, [UUID_RE.test(offerId) ? offerId : null, taskId]);
  if (!own.rows[0]) throw notFound('That offer does not exist');
  await answerOffer(offerId, answer, note, 'staff', actor.id);
  return getWoDispatch(taskId, actor);
}

export async function stopDispatch(taskId: string, actor: ActingPrincipal): Promise<WoDispatch> {
  requireDispatchEdit(actor);
  const res = await query<{ id: string }>(
    `UPDATE wo_dispatch_offer SET status = 'cancelled', responded_at = now(), responded_via = 'staff' WHERE task_id = $1 AND status = 'offered' RETURNING id::text AS id`,
    [taskId],
  );
  if (!res.rows[0]) throw conflict('No offer is out for this work order');
  await logWo(taskId, actor.id, 'Dispatch offer', null, 'stopped');
  return getWoDispatch(taskId, actor);
}

/** Called after a work order is created. Does nothing unless the cascade is
 *  on AND set to start by itself AND the work order has no vendor yet. */
export async function maybeAutoStartDispatch(taskId: string, actorId: string | null): Promise<void> {
  try {
    const settings = await getDispatchSettings();
    if (!settings.enabled || !settings.auto_start) return;
    const next = await offerNext(taskId, settings, actorId);
    if (next) await logWo(taskId, actorId ?? (await serviceActorId('Dispatch', 'DP')), 'Dispatch offer', null, `offered to ${next.name} (${settings.hours}h to answer, started automatically)`);
  } catch (err) {
    console.error('[dispatch] auto start failed', err);
  }
}

/** Every run with a lapsed offer, moved along. For a clock (the daily cron). */
export async function sweepDispatchOffers(): Promise<{ advanced: number }> {
  const settings = await getDispatchSettings();
  if (!settings.enabled) return { advanced: 0 };
  const due = await query<{ task_id: string }>(`SELECT DISTINCT task_id::text AS task_id FROM wo_dispatch_offer WHERE status = 'offered' AND expires_at < now()`);
  for (const r of due.rows) await advance(r.task_id, settings);
  return { advanced: due.rows.length };
}

// ═══ Skills, inductions, consumables on a vendor ═════════════════════════════

async function gateVendor(vendorId: string, actor: ActingPrincipal, action: 'view' | 'edit'): Promise<void> {
  if (!UUID_RE.test(vendorId)) throw notFound('No such vendor');
  requireVendorsView(actor);
  if (action === 'edit') requirePerm(actor, 'vendors', 'edit', 'You cannot edit vendors');
  await assertVendorInScope(actor, vendorId);
}

export async function vendorQualifications(vendorId: string, actor: ActingPrincipal): Promise<VendorQualifications> {
  await gateVendor(vendorId, actor, 'view');
  const day = today();
  const [skills, inductions, used, list, clients] = await Promise.all([
    query<{ id: string; skill: string; level: SkillLevel; certified_until: string | null; note: string | null }>(
      `SELECT id::text AS id, skill, level, to_char(certified_until, 'YYYY-MM-DD') AS certified_until, note FROM vendor_skill WHERE vendor_id = $1 ORDER BY lower(skill)`,
      [vendorId],
    ),
    query<{ id: string; title: string; client: string | null; completed_on: string | null; expires_on: string | null; note: string | null }>(
      `SELECT id::text AS id, title, client, to_char(completed_on, 'YYYY-MM-DD') AS completed_on, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, note
         FROM vendor_induction WHERE vendor_id = $1 ORDER BY lower(title)`,
      [vendorId],
    ),
    query<{ wo_number: string; name: string; qty: string; unit: string; unit_cost: string | null; added_at: Date }>(
      `SELECT t.wo_number, c.name, c.qty, c.unit, c.unit_cost, c.added_at FROM wo_consumable c JOIN task t ON t.id = c.task_id
        WHERE c.vendor_id = $1 AND t.deleted_at IS NULL ORDER BY c.added_at DESC LIMIT 50`,
      [vendorId],
    ),
    query<{ name: string; trade: string | null }>(`SELECT name, trade FROM skill WHERE is_active ORDER BY lower(name)`),
    query<{ name: string }>(`SELECT DISTINCT client AS name FROM task WHERE client IS NOT NULL AND btrim(client) <> '' AND deleted_at IS NULL ORDER BY 1 LIMIT 500`),
  ]);
  return {
    skills: skills.rows.map((s) => ({ ...s, expired: s.certified_until !== null && s.certified_until < day })),
    inductions: inductions.rows.map((i) => ({ ...i, state: inductionState(i.completed_on, i.expires_on, day) })),
    consumables: used.rows.map((u) => ({ wo_number: u.wo_number, name: u.name, qty: Number(u.qty), unit: u.unit, unit_cost: num(u.unit_cost), added_at: u.added_at.toISOString() })),
    skill_list: list.rows,
    clients: clients.rows.map((c) => c.name),
    can: { edit: can(actor, 'vendors', 'edit') },
  };
}

const dayOrNull = (v: string | null | undefined, label: string): string | null => {
  const s = clean(v);
  if (s === null) return null;
  if (!DAY_RE.test(s)) throw badRequest(`${label} is not a date`);
  return s;
};

export async function saveVendorSkill(vendorId: string, id: string | null, input: { skill?: string; level?: SkillLevel; certified_until?: string | null; note?: string | null }, actor: ActingPrincipal): Promise<VendorQualifications> {
  await gateVendor(vendorId, actor, 'edit');
  if (id) {
    if (!UUID_RE.test(id)) throw notFound('That skill is not on this vendor');
    const res = await query(
      `UPDATE vendor_skill SET level = COALESCE($3, level),
              certified_until = CASE WHEN $4 THEN $5::date ELSE certified_until END,
              note = CASE WHEN $6 THEN $7 ELSE note END
        WHERE id = $1 AND vendor_id = $2 RETURNING id`,
      [id, vendorId, input.level ?? null, input.certified_until !== undefined, input.certified_until !== undefined ? dayOrNull(input.certified_until, 'The certificate date') : null, input.note !== undefined, input.note !== undefined ? clean(input.note) : null],
    );
    if (!res.rows[0]) throw notFound('That skill is not on this vendor');
  } else {
    const skill = (input.skill ?? '').trim().slice(0, 120);
    if (!skill) throw badRequest('Name the skill', { field: 'skill' });
    const dup = await query(`SELECT 1 FROM vendor_skill WHERE vendor_id = $1 AND lower(skill) = lower($2)`, [vendorId, skill]);
    if (dup.rows[0]) throw conflict(`“${skill}” is already on this vendor`);
    await query(
      `INSERT INTO vendor_skill (vendor_id, skill, level, certified_until, note, created_by) VALUES ($1, $2, $3, $4::date, $5, $6)`,
      [vendorId, skill, input.level ?? 'skilled', dayOrNull(input.certified_until, 'The certificate date'), clean(input.note), actor.id],
    );
    await logAdminEvent({ actorId: actor.id, entity: 'vendor', entityId: vendorId, action: 'vendor_skill_added', after: { name: skill, level: input.level ?? 'skilled' } });
  }
  return vendorQualifications(vendorId, actor);
}

export async function removeVendorSkill(vendorId: string, id: string, actor: ActingPrincipal): Promise<VendorQualifications> {
  await gateVendor(vendorId, actor, 'edit');
  if (!UUID_RE.test(id)) throw notFound('That skill is not on this vendor');
  const res = await query<{ skill: string }>(`DELETE FROM vendor_skill WHERE id = $1 AND vendor_id = $2 RETURNING skill`, [id, vendorId]);
  if (!res.rows[0]) throw notFound('That skill is not on this vendor');
  await logAdminEvent({ actorId: actor.id, entity: 'vendor', entityId: vendorId, action: 'vendor_skill_removed', before: { name: res.rows[0].skill } });
  return vendorQualifications(vendorId, actor);
}

export async function saveVendorInduction(vendorId: string, id: string | null, input: { title?: string; client?: string | null; completed_on?: string | null; expires_on?: string | null; note?: string | null }, actor: ActingPrincipal): Promise<VendorQualifications> {
  await gateVendor(vendorId, actor, 'edit');
  const completed = dayOrNull(input.completed_on, 'The completion date');
  const expires = dayOrNull(input.expires_on, 'The expiry date');
  if (completed && expires && expires < completed) throw badRequest('The induction expires before it was completed', { field: 'expires_on' });
  const title = (input.title ?? '').trim().slice(0, 200);
  if (id) {
    if (!UUID_RE.test(id)) throw notFound('That induction is not on this vendor');
    if (!title) throw badRequest('Name the induction', { field: 'title' });
    const res = await query(
      `UPDATE vendor_induction SET title = $3, client = $4, completed_on = $5::date, expires_on = $6::date, note = $7 WHERE id = $1 AND vendor_id = $2 RETURNING id`,
      [id, vendorId, title, clean(input.client), completed, expires, clean(input.note)],
    );
    if (!res.rows[0]) throw notFound('That induction is not on this vendor');
  } else {
    if (!title) throw badRequest('Name the induction', { field: 'title' });
    await query(
      `INSERT INTO vendor_induction (vendor_id, title, client, completed_on, expires_on, note, created_by) VALUES ($1, $2, $3, $4::date, $5::date, $6, $7)`,
      [vendorId, title, clean(input.client), completed, expires, clean(input.note), actor.id],
    );
  }
  await logAdminEvent({ actorId: actor.id, entity: 'vendor', entityId: vendorId, action: id ? 'vendor_induction_updated' : 'vendor_induction_added', after: { name: title, client: clean(input.client), completed_on: completed, expires_on: expires } });
  return vendorQualifications(vendorId, actor);
}

export async function removeVendorInduction(vendorId: string, id: string, actor: ActingPrincipal): Promise<VendorQualifications> {
  await gateVendor(vendorId, actor, 'edit');
  if (!UUID_RE.test(id)) throw notFound('That induction is not on this vendor');
  const res = await query<{ title: string }>(`DELETE FROM vendor_induction WHERE id = $1 AND vendor_id = $2 RETURNING title`, [id, vendorId]);
  if (!res.rows[0]) throw notFound('That induction is not on this vendor');
  await logAdminEvent({ actorId: actor.id, entity: 'vendor', entityId: vendorId, action: 'vendor_induction_removed', before: { name: res.rows[0].title } });
  return vendorQualifications(vendorId, actor);
}

// ═══ Consumables on a work order ═════════════════════════════════════════════

export async function woConsumables(taskId: string, actor: ActingPrincipal): Promise<WoConsumablesResponse> {
  requirePerm(actor, 'work_orders', 'view', 'You cannot open work orders');
  const [items, catalogue, techs] = await Promise.all([
    query<{ id: string; consumable_id: string | null; name: string; unit: string; qty: string; unit_cost: string | null; vendor_id: string | null; vendor_name: string | null; note: string | null; added_by: string | null; added_at: Date }>(
      `SELECT c.id::text AS id, c.consumable_id::text AS consumable_id, c.name, c.unit, c.qty, c.unit_cost, c.vendor_id::text AS vendor_id, v.name AS vendor_name,
              c.note, c.added_by::text AS added_by, c.added_at
         FROM wo_consumable c LEFT JOIN vendor v ON v.id = c.vendor_id WHERE c.task_id = $1 ORDER BY c.added_at`,
      [taskId],
    ),
    query<{ id: string; name: string; unit: string; unit_cost: string | null; is_active: boolean }>(`SELECT id::text AS id, name, unit, unit_cost, is_active FROM consumable WHERE is_active ORDER BY lower(name)`),
    query<{ vendor_id: string; name: string }>(
      `SELECT v.id::text AS vendor_id, v.name FROM vendor v
        WHERE v.id = (SELECT vendor_id FROM task WHERE id = $1)
           OR v.id IN (SELECT vendor_id FROM wo_technician WHERE task_id = $1 AND released_at IS NULL)
        ORDER BY lower(v.name)`,
      [taskId],
    ),
  ]);
  const people = await peopleByIds(items.rows.map((r) => r.added_by));
  const mapped = items.rows.map((r) => ({
    id: r.id,
    consumable_id: r.consumable_id,
    name: r.name,
    unit: r.unit,
    qty: Number(r.qty),
    unit_cost: num(r.unit_cost),
    vendor: r.vendor_id && r.vendor_name ? { id: r.vendor_id, name: r.vendor_name } : null,
    note: r.note,
    added_by: r.added_by ? (people.get(r.added_by) ?? null) : null,
    added_at: r.added_at.toISOString(),
  }));
  return {
    items: mapped,
    total_cost: round2(mapped.reduce((s, i) => s + i.qty * (i.unit_cost ?? 0), 0)),
    catalogue: catalogue.rows.map((c) => ({ ...c, unit_cost: num(c.unit_cost) })),
    technicians: techs.rows,
    can: { edit: can(actor, 'work_orders', 'edit') },
  };
}

export async function addWoConsumable(taskId: string, input: { consumable_id?: string | null; name?: string; unit?: string; qty?: number; unit_cost?: number | null; vendor_id?: string | null; note?: string | null }, actor: ActingPrincipal): Promise<WoConsumablesResponse> {
  requirePerm(actor, 'work_orders', 'edit', 'You cannot edit work orders');
  const qty = input.qty !== undefined && Number.isFinite(input.qty) && input.qty > 0 ? round2(input.qty) : 1;
  let line: { consumable_id: string | null; name: string; unit: string; unit_cost: number | null };
  if (input.consumable_id) {
    const c = UUID_RE.test(input.consumable_id)
      ? await query<{ id: string; name: string; unit: string; unit_cost: string | null }>(`SELECT id::text AS id, name, unit, unit_cost FROM consumable WHERE id = $1`, [input.consumable_id])
      : { rows: [] };
    if (!c.rows[0]) throw badRequest('That consumable does not exist', { field: 'consumable_id' });
    line = { consumable_id: c.rows[0].id, name: c.rows[0].name, unit: c.rows[0].unit, unit_cost: input.unit_cost !== undefined ? input.unit_cost : num(c.rows[0].unit_cost) };
  } else {
    const name = (input.name ?? '').trim().slice(0, 200);
    if (!name) throw badRequest('Pick a consumable or name one', { field: 'name' });
    line = { consumable_id: null, name, unit: clean(input.unit) ?? 'each', unit_cost: input.unit_cost ?? null };
  }
  if (line.unit_cost !== null && !(Number.isFinite(line.unit_cost) && line.unit_cost >= 0)) throw badRequest('The cost must be a positive amount', { field: 'unit_cost' });
  const vendorId = input.vendor_id && UUID_RE.test(input.vendor_id) ? input.vendor_id : null;
  await query(
    `INSERT INTO wo_consumable (task_id, vendor_id, consumable_id, name, unit, qty, unit_cost, note, added_by)
     VALUES ($1, (SELECT id FROM vendor WHERE id = $2::uuid), $3, $4, $5, $6, $7, $8, $9)`,
    [taskId, vendorId, line.consumable_id, line.name, line.unit, qty, line.unit_cost, clean(input.note), actor.id],
  );
  await logWo(taskId, actor.id, 'Consumables', null, `used ${qty} ${line.unit} of ${line.name}`);
  return woConsumables(taskId, actor);
}

export async function removeWoConsumable(taskId: string, id: string, actor: ActingPrincipal): Promise<WoConsumablesResponse> {
  requirePerm(actor, 'work_orders', 'edit', 'You cannot edit work orders');
  if (!UUID_RE.test(id)) throw notFound('That line does not exist');
  const res = await query<{ name: string }>(`DELETE FROM wo_consumable WHERE id = $1 AND task_id = $2 RETURNING name`, [id, taskId]);
  if (!res.rows[0]) throw notFound('That line does not exist');
  await logWo(taskId, actor.id, 'Consumables', res.rows[0].name, null);
  return woConsumables(taskId, actor);
}

// ═══ Admin › Vendors & map: the lists and the two settings ═══════════════════

export async function vendorCatalogues(actor: ActingPrincipal): Promise<VendorCatalogues> {
  requireVendorAdmin(actor, 'view');
  const [skills, consumables, rules, dispatch] = await Promise.all([
    query<{ id: string; name: string; trade: string | null; is_active: boolean; used: number }>(
      `SELECT s.id::text AS id, s.name, s.trade, s.is_active, (SELECT count(*)::int FROM vendor_skill vs WHERE lower(vs.skill) = lower(s.name)) AS used
         FROM skill s ORDER BY s.is_active DESC, lower(s.name)`,
    ),
    query<{ id: string; name: string; unit: string; unit_cost: string | null; is_active: boolean; used: number }>(
      `SELECT c.id::text AS id, c.name, c.unit, c.unit_cost, c.is_active, (SELECT count(*)::int FROM wo_consumable w WHERE w.consumable_id = c.id) AS used
         FROM consumable c ORDER BY c.is_active DESC, lower(c.name)`,
    ),
    getBillRules(),
    getDispatchSettings(),
  ]);
  let edit = true;
  try { requireVendorAdmin(actor, 'edit'); } catch { edit = false; }
  return {
    skills: skills.rows.map((s) => ({ ...s, used: Number(s.used) })),
    consumables: consumables.rows.map((c) => ({ ...c, unit_cost: num(c.unit_cost), used: Number(c.used) })),
    bill_rules: rules,
    dispatch,
    can: { edit },
  };
}

export async function saveSkillDef(id: string | null, input: { name?: string; trade?: string | null; is_active?: boolean }, actor: ActingPrincipal): Promise<VendorCatalogues> {
  requireVendorAdmin(actor, 'edit');
  if (id) {
    if (!UUID_RE.test(id)) throw notFound('That skill does not exist');
    const res = await query(
      `UPDATE skill SET name = COALESCE($2, name), trade = CASE WHEN $3 THEN $4 ELSE trade END, is_active = COALESCE($5, is_active) WHERE id = $1 RETURNING id`,
      [id, clean(input.name), input.trade !== undefined, input.trade !== undefined ? clean(input.trade) : null, input.is_active ?? null],
    );
    if (!res.rows[0]) throw notFound('That skill does not exist');
  } else {
    const name = (input.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('Name the skill', { field: 'name' });
    const dup = await query(`SELECT 1 FROM skill WHERE lower(name) = lower($1)`, [name]);
    if (dup.rows[0]) throw conflict(`“${name}” is already on the list`);
    await query(`INSERT INTO skill (name, trade) VALUES ($1, $2)`, [name, clean(input.trade)]);
  }
  await logAdminEvent({ actorId: actor.id, entity: 'vendor_setting', entityId: 'skill', action: id ? 'vendor_list_updated' : 'vendor_list_added', after: { name: input.name ?? 'skill', list: 'skills', ...input } });
  return vendorCatalogues(actor);
}

export async function saveConsumableDef(id: string | null, input: { name?: string; unit?: string; unit_cost?: number | null; is_active?: boolean }, actor: ActingPrincipal): Promise<VendorCatalogues> {
  requireVendorAdmin(actor, 'edit');
  if (input.unit_cost !== undefined && input.unit_cost !== null && !(Number.isFinite(input.unit_cost) && input.unit_cost >= 0)) throw badRequest('The cost must be a positive amount', { field: 'unit_cost' });
  if (id) {
    if (!UUID_RE.test(id)) throw notFound('That consumable does not exist');
    const res = await query(
      `UPDATE consumable SET name = COALESCE($2, name), unit = COALESCE($3, unit),
              unit_cost = CASE WHEN $4 THEN $5::numeric ELSE unit_cost END, is_active = COALESCE($6, is_active) WHERE id = $1 RETURNING id`,
      [id, clean(input.name), clean(input.unit), input.unit_cost !== undefined, input.unit_cost ?? null, input.is_active ?? null],
    );
    if (!res.rows[0]) throw notFound('That consumable does not exist');
  } else {
    const name = (input.name ?? '').trim().slice(0, 200);
    if (!name) throw badRequest('Name the consumable', { field: 'name' });
    const dup = await query(`SELECT 1 FROM consumable WHERE lower(name) = lower($1)`, [name]);
    if (dup.rows[0]) throw conflict(`“${name}” is already on the list`);
    await query(`INSERT INTO consumable (name, unit, unit_cost) VALUES ($1, $2, $3)`, [name, clean(input.unit) ?? 'each', input.unit_cost ?? null]);
  }
  await logAdminEvent({ actorId: actor.id, entity: 'vendor_setting', entityId: 'consumable', action: id ? 'vendor_list_updated' : 'vendor_list_added', after: { name: input.name ?? 'consumable', list: 'consumables', ...input } });
  return vendorCatalogues(actor);
}

export async function saveBillRules(input: unknown, actor: ActingPrincipal): Promise<VendorCatalogues> {
  requireVendorAdmin(actor, 'edit');
  const before = await getBillRules();
  await writeSetting('bill_rules', cleanBillRules({ ...before, ...(input as object) }), actor, before);
  return vendorCatalogues(actor);
}

export async function saveDispatchSettings(input: unknown, actor: ActingPrincipal): Promise<VendorCatalogues> {
  requireVendorAdmin(actor, 'edit');
  const before = await getDispatchSettings();
  const next = cleanDispatchSettings({ ...before, ...(input as object) });
  await writeSetting('dispatch_cascade', next, actor, before);
  // Switched off: every offer still out is stopped, so nothing lingers.
  if (!next.enabled) await query(`UPDATE wo_dispatch_offer SET status = 'cancelled', responded_at = now(), responded_via = 'system' WHERE status = 'offered'`);
  return vendorCatalogues(actor);
}

// ═══ Performance ═════════════════════════════════════════════════════════════

export async function vendorPerformance(actor: ActingPrincipal, opts: { from?: string; to?: string; vendor_id?: string }): Promise<VendorPerformanceResponse> {
  requireVendorsView(actor);
  const to = opts.to && DAY_RE.test(opts.to) ? opts.to : today();
  const start = new Date(`${to}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 89);
  const from = opts.from && DAY_RE.test(opts.from) ? opts.from : start.toISOString().slice(0, 10);
  const only = opts.vendor_id && UUID_RE.test(opts.vendor_id) ? opts.vendor_id : null;
  const res = await query<{
    vendor_id: string; name: string; kind: string; primary_trade: string | null;
    jobs: number; completed: number; open: number; sla_met: number; sla_missed: number; recalls: number; temporary_fixes: number;
    offers: number; offers_accepted: number; avg_response_hours: string | null; billed: string; bill_ids: string[] | null;
  }>(
    `WITH job AS (
       SELECT DISTINCT x.vendor_id, x.task_id FROM (
         SELECT t.vendor_id, t.id AS task_id FROM task t WHERE t.vendor_id IS NOT NULL
         UNION ALL
         SELECT wt.vendor_id, wt.task_id FROM wo_technician wt
       ) x
     ), j AS (
       SELECT job.vendor_id, t.id, t.temporary_fix,
              (t.status_group::text IN ('done', 'closed') OR t.service_completed_at IS NOT NULL) AS completed,
              COALESCE(t.service_completed_at, t.updated_at) AS completed_at,
              NULLIF(left(COALESCE(t.fields->>'SLA Due Date', ''), 10), '') AS sla_day,
              EXISTS (SELECT 1 FROM wo_tag g WHERE g.task_id = t.id AND lower(g.tag) = 'recall') AS recall,
              (SELECT min(v2.checked_in_at) FROM wo_visit v2 WHERE v2.task_id = t.id AND v2.vendor_id = job.vendor_id) AS first_in,
              (SELECT min(wt.hired_at) FROM wo_technician wt WHERE wt.task_id = t.id AND wt.vendor_id = job.vendor_id) AS hired_at
         FROM job JOIN task t ON t.id = job.task_id
        WHERE t.deleted_at IS NULL
          AND COALESCE(t.date_received, t.created_at::date) BETWEEN $1::date AND $2::date
     )
     SELECT v.id::text AS vendor_id, v.name, v.kind, v.primary_trade,
            count(j.id)::int AS jobs,
            count(j.id) FILTER (WHERE j.completed)::int AS completed,
            count(j.id) FILTER (WHERE NOT j.completed)::int AS open,
            count(j.id) FILTER (WHERE j.completed AND j.sla_day IS NOT NULL AND to_char(j.completed_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') <= j.sla_day)::int AS sla_met,
            count(j.id) FILTER (WHERE j.completed AND j.sla_day IS NOT NULL AND to_char(j.completed_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') > j.sla_day)::int AS sla_missed,
            count(j.id) FILTER (WHERE j.recall)::int AS recalls,
            count(j.id) FILTER (WHERE j.temporary_fix)::int AS temporary_fixes,
            (SELECT count(*)::int FROM wo_dispatch_offer o WHERE o.vendor_id = v.id AND o.status <> 'offered' AND o.status <> 'cancelled' AND o.offered_at::date BETWEEN $1::date AND $2::date) AS offers,
            (SELECT count(*)::int FROM wo_dispatch_offer o WHERE o.vendor_id = v.id AND o.status = 'accepted' AND o.offered_at::date BETWEEN $1::date AND $2::date) AS offers_accepted,
            avg(EXTRACT(EPOCH FROM (j.first_in - j.hired_at)) / 3600.0) FILTER (WHERE j.first_in IS NOT NULL AND j.hired_at IS NOT NULL AND j.first_in >= j.hired_at) AS avg_response_hours,
            COALESCE((SELECT sum(b.total) FROM vendor_bill b WHERE b.vendor_id = v.id AND b.status <> 'void' AND b.task_id IN (SELECT id FROM j j2 WHERE j2.vendor_id = v.id)), 0) AS billed,
            (SELECT array_agg(b.id::text) FROM vendor_bill b WHERE b.vendor_id = v.id AND b.status <> 'void' AND b.task_id IN (SELECT id FROM j j2 WHERE j2.vendor_id = v.id)) AS bill_ids
       FROM vendor v JOIN j ON j.vendor_id = v.id
      WHERE v.deleted_at IS NULL AND ($3::uuid IS NULL OR v.id = $3::uuid)
      GROUP BY v.id
      ORDER BY count(j.id) DESC, lower(v.name)
      LIMIT 500`,
    [from, to, only],
  );
  // The bill warnings come from the same rules the bills are read with.
  const allBills = res.rows.flatMap((r) => r.bill_ids ?? []);
  const warned = new Map<string, number>();
  if (allBills.length > 0) {
    const bills = await query<{ id: string; total: string; status: string; vendor_id: string }>(`SELECT id::text AS id, total, status, vendor_id::text AS vendor_id FROM vendor_bill WHERE id = ANY($1::uuid[])`, [allBills]);
    const extras = await billExtrasFor(bills.rows.map((b) => ({ id: b.id, total: Number(b.total), status: b.status })));
    for (const b of bills.rows) if ((extras.get(b.id)?.warnings.length ?? 0) > 0) warned.set(b.vendor_id, (warned.get(b.vendor_id) ?? 0) + 1);
  }
  const rows: VendorPerformanceRow[] = res.rows.map((r) => ({
    vendor_id: r.vendor_id,
    name: r.name,
    kind: r.kind,
    primary_trade: r.primary_trade,
    jobs: Number(r.jobs),
    completed: Number(r.completed),
    open: Number(r.open),
    sla_met: Number(r.sla_met),
    sla_missed: Number(r.sla_missed),
    recalls: Number(r.recalls),
    temporary_fixes: Number(r.temporary_fixes),
    offers: Number(r.offers),
    offers_accepted: Number(r.offers_accepted),
    avg_response_hours: r.avg_response_hours === null ? null : Math.round(Number(r.avg_response_hours) * 10) / 10,
    billed: Number(r.billed),
    bill_warnings: warned.get(r.vendor_id) ?? 0,
  }));
  const sum = (k: keyof VendorPerformanceRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
  return { from, to, rows, totals: { jobs: sum('jobs'), completed: sum('completed'), sla_met: sum('sla_met'), sla_missed: sum('sla_missed'), recalls: sum('recalls'), billed: round2(sum('billed')) } };
}
