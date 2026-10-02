// 0064 · The work-order record: one read that feeds the right rail and the
// checklist / cost breakdown / timelog / related tabs, and the small writes a
// person makes from them — assign the responsible vendor, pause and resume,
// give an ETA, cancel, complete the service, keep a checklist, tag it, ask
// for more NTE.
//
// Every route resolves the work order through `resolveTaskId(id, actor)`, so
// the viewer's scope (0026, 0062) applies before anything here runs. Every
// write is logged on the work order through `logTaskChanges`, the same path a
// field edit takes, so the Audit trail shows it like any other change.
//
// What this deliberately does NOT do:
//   · a pause stops no Pulse clock and no SLA (rule 2.4.4 — nothing pauses a
//     timer). It is a marker and a span on the Timelog.
//   · the manual NTE increase is its own small request, decided here; the
//     automatic `nte_override` approval task (0026) is untouched.
//   · money is read through the existing services, each with its own gate; a
//     viewer without quotes / payments / invoicing sees those parts empty.

import { approvalSectionPermKey, geofenceCheck, minutesBetween, permAllows, siteEventPhase } from '@theone/shared';
import type {
  FeedActor,
  PermAction,
  SiteEvent,
  SiteEventKind,
  WoChecklistItem,
  WoCode,
  WoCompleteInput,
  WoCostBreakdown,
  WoCostLine,
  WoNteRequest,
  WoRecord,
  WoRelated,
  WoRelatedWorkOrder,
  WoStatusSpan,
  WoTag,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { notify } from './notices.js';
import { requirePerm } from './permissions.js';
import { logTaskChanges } from './woAudit.js';
import { Params } from './woFields.js';
import { woScopeSql } from './woScope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NTE_KEY = '16. Client NTE 🔴';
const COST_KEY = '34. Cost';
const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const can = (a: ActingPrincipal, key: string, action: PermAction): boolean => permAllows(a.perms, key, action, a.isSuperAdmin);
const today = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const NTE_APPROVAL_KEY = approvalSectionPermKey('nte');

function requireEdit(a: ActingPrincipal): void {
  requirePerm(a, 'work_orders', 'edit', 'You cannot edit work orders');
}

/** People by id, for the plain-uuid stamp columns. */
async function peopleByIds(ids: (string | null | undefined)[]): Promise<Map<string, FeedActor>> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x) && UUID_RE.test(x!)))];
  if (want.length === 0) return new Map();
  const res = await query<FeedActor>(`SELECT id::text AS id, display_name AS name, kind FROM principal WHERE id = ANY($1::uuid[])`, [want]);
  return new Map(res.rows.map((r) => [r.id, r]));
}

// ═══ The read ════════════════════════════════════════════════════════════════

type TaskRow = {
  id: string;
  wo_number: string;
  status_name: string;
  site_id: string | null;
  asset_id: string | null;
  vendor_id: string | null;
  nte: string | null;
  fields: Record<string, unknown>;
  date_received: string | null;
  created_at: Date;
  paused_at: Date | null;
  paused_by: string | null;
  pause_reason: string | null;
  eta_at: Date | null;
  eta_note: string | null;
  eta_by: string | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  completion_note: string | null;
  fault_code: string | null;
  action_code: string | null;
  temporary_fix: boolean | null;
  service_completed_at: Date | null;
  service_completed_by: string | null;
};

async function loadTask(taskId: string): Promise<TaskRow> {
  const res = await query<TaskRow>(
    `SELECT t.id::text AS id, t.wo_number, st.name AS status_name, t.site_id::text AS site_id, t.asset_id::text AS asset_id,
            t.vendor_id::text AS vendor_id, t.nte, t.fields, to_char(t.date_received, 'YYYY-MM-DD') AS date_received, t.created_at,
            t.paused_at, t.paused_by::text AS paused_by, t.pause_reason, t.eta_at, t.eta_note, t.eta_by::text AS eta_by,
            t.cancelled_at, t.cancelled_by::text AS cancelled_by, t.cancel_reason, t.completion_note, t.fault_code,
            t.action_code, t.temporary_fix, t.service_completed_at, t.service_completed_by::text AS service_completed_by
       FROM task t JOIN status st ON st.id = t.status_id
      WHERE t.id = $1`,
    [taskId],
  );
  if (!res.rows[0]) throw notFound('Work order not found');
  return res.rows[0];
}

/** The value of a bag key as text, whatever it was stored as. */
const bagText = (t: TaskRow, key: string): string | null => {
  const v = t.fields?.[key];
  if (v === null || v === undefined || v === '') return null;
  return Array.isArray(v) ? v.join(', ') : String(v);
};

async function loadCodes(): Promise<{ fault: WoCode[]; action: WoCode[] }> {
  const res = await query<WoCode>(`SELECT id::text AS id, kind, code, label, position, is_active FROM wo_code ORDER BY kind, position, lower(label)`);
  return { fault: res.rows.filter((r) => r.kind === 'fault'), action: res.rows.filter((r) => r.kind === 'action') };
}

export async function runningSiteEvents(siteId: string | null): Promise<SiteEvent[]> {
  if (!siteId) return [];
  const day = today();
  const res = await query<SiteEventRow>(
    `${SITE_EVENT_SELECT} WHERE e.site_id = $1 AND e.starts_on <= $2::date AND (e.ends_on IS NULL OR e.ends_on >= $2::date)
      ORDER BY e.starts_on DESC`,
    [siteId, day],
  );
  return res.rows.map((r) => mapSiteEvent(r, day));
}

export async function getWoRecord(taskId: string, actor: ActingPrincipal): Promise<WoRecord> {
  const t = await loadTask(taskId);
  const seeMoney = can(actor, 'work_orders/tabs/money', 'view');
  const seeVendors = can(actor, 'vendor_map', 'view') || can(actor, 'vendors', 'view');

  const [vendor, techs, visits, pauses, checklist, tags, tagSuggestions, nteRows, statusRows, codes, events] = await Promise.all([
    t.vendor_id
      ? query<{ id: string; name: string; phone: string | null; primary_trade: string | null; blacklisted: boolean; compliance_status: string }>(
          `SELECT id::text AS id, name, phone, primary_trade, blacklisted, compliance_status FROM vendor WHERE id = $1`,
          [t.vendor_id],
        )
      : Promise.resolve({ rows: [] }),
    query<{ id: string; name: string; phone: string | null }>(
      `SELECT v.id::text AS id, v.name, v.phone FROM wo_technician w JOIN vendor v ON v.id = w.vendor_id
        WHERE w.task_id = $1 AND w.released_at IS NULL ORDER BY w.hired_at`,
      [taskId],
    ),
    query<{ id: string; seq: number; visit_type: string; tech_name: string | null; checked_in_at: Date | null; checked_out_at: Date | null; geofence_result: 'inside' | 'outside' | 'no_site' | 'no_boundary' | null; geofence_ft: number | null }>(
      `SELECT id::text AS id, seq, visit_type, tech_name, checked_in_at, checked_out_at, geofence_result, geofence_ft
         FROM wo_visit WHERE task_id = $1 ORDER BY seq`,
      [taskId],
    ),
    query<{ id: string; paused_at: Date; resumed_at: Date | null; reason: string | null; paused_by: string | null }>(
      `SELECT id::text AS id, paused_at, resumed_at, reason, paused_by::text AS paused_by FROM wo_pause WHERE task_id = $1 ORDER BY paused_at`,
      [taskId],
    ),
    query<{ id: string; title: string; done: boolean; done_by: string | null; done_at: Date | null; note: string | null; position: number }>(
      `SELECT id::text AS id, title, done, done_by::text AS done_by, done_at, note, position FROM wo_checklist_item
        WHERE task_id = $1 ORDER BY position, created_at`,
      [taskId],
    ),
    query<{ id: string; tag: string; reason: string | null; created_by: string | null; created_at: Date }>(
      `SELECT id::text AS id, tag, reason, created_by::text AS created_by, created_at FROM wo_tag WHERE task_id = $1 ORDER BY created_at`,
      [taskId],
    ),
    query<{ tag: string }>(`SELECT min(tag) AS tag FROM wo_tag GROUP BY lower(tag) ORDER BY count(*) DESC, lower(min(tag)) LIMIT 40`),
    query<{ id: string; current_nte: string | null; requested_nte: string; reason: string; status: WoNteRequest['status']; requested_by: string | null; decided_by: string | null; decided_at: Date | null; decision_note: string | null; created_at: Date }>(
      `SELECT id::text AS id, current_nte, requested_nte, reason, status, requested_by::text AS requested_by,
              decided_by::text AS decided_by, decided_at, decision_note, created_at
         FROM wo_nte_request WHERE task_id = $1 ORDER BY created_at DESC`,
      [taskId],
    ),
    // entity_id is text (0017): the id travels as text, never as a uuid here.
    query<{ after: { status_name?: string } | null; before: { status_name?: string } | null; actor: string | null; created_at: Date }>(
      `SELECT a.after, a.before, a.actor_principal_id::text AS actor, a.created_at
         FROM activity_log a
        WHERE a.entity_type = 'task' AND a.entity_id = $1::text AND a.action = 'status_changed'
        ORDER BY a.created_at`,
      [taskId],
    ),
    loadCodes(),
    runningSiteEvents(t.site_id),
  ]);

  const people = await peopleByIds([
    t.paused_by, t.cancelled_by, t.eta_by, t.service_completed_by,
    ...checklist.rows.map((c) => c.done_by),
    ...tags.rows.map((x) => x.created_by),
    ...nteRows.rows.flatMap((n) => [n.requested_by, n.decided_by]),
    ...pauses.rows.map((p) => p.paused_by),
    ...statusRows.rows.map((s) => s.actor),
  ]);
  const who = (id: string | null) => (id ? (people.get(id) ?? null) : null);
  const now = new Date();

  // ── Time ────────────────────────────────────────────────────────────────────
  const ins = visits.rows.filter((v) => v.checked_in_at).map((v) => v.checked_in_at!.getTime());
  const outs = visits.rows.filter((v) => v.checked_out_at).map((v) => v.checked_out_at!.getTime());
  const onSite = visits.rows.find((v) => v.checked_in_at && !v.checked_out_at);
  const onSiteMinutes = visits.rows.reduce((sum, v) => sum + (v.checked_in_at && v.checked_out_at ? Math.max(0, Math.round((v.checked_out_at.getTime() - v.checked_in_at.getTime()) / 60_000)) : 0), 0);
  const pausedMinutes = pauses.rows.reduce((sum, p) => sum + (p.resumed_at ? Math.max(0, Math.round((p.resumed_at.getTime() - p.paused_at.getTime()) / 60_000)) : 0), 0);
  const lastChange = statusRows.rows[statusRows.rows.length - 1];
  const start = t.date_received ? `${t.date_received}T00:00:00Z` : t.created_at.toISOString();

  // ── Status spans: created → first change → … → now ─────────────────────────
  const statuses: WoStatusSpan[] = [];
  let from = t.created_at;
  let name = statusRows.rows[0]?.before?.status_name ?? t.status_name;
  let by: string | null = null;
  for (const row of statusRows.rows) {
    statuses.push({ status: name, from: from.toISOString(), to: row.created_at.toISOString(), minutes: Math.max(0, Math.round((row.created_at.getTime() - from.getTime()) / 60_000)), by: who(by) });
    from = row.created_at;
    name = row.after?.status_name ?? name;
    by = row.actor;
  }
  statuses.push({ status: name, from: from.toISOString(), to: null, minutes: Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000)), by: who(by) });

  // ── Money ───────────────────────────────────────────────────────────────────
  const money = seeMoney ? await loadMoney(taskId, t, actor) : emptyMoney(t);

  const related = await loadRelated(taskId, t, actor, nteRows.rows.length);

  return {
    state: {
      paused: t.paused_at ? { at: iso(t.paused_at)!, by: who(t.paused_by), reason: t.pause_reason } : null,
      cancelled: t.cancelled_at ? { at: iso(t.cancelled_at)!, by: who(t.cancelled_by), reason: t.cancel_reason } : null,
      eta: t.eta_at ? { at: iso(t.eta_at)!, eta_at: iso(t.eta_at)!, by: who(t.eta_by), note: t.eta_note } : null,
      completion: t.service_completed_at
        ? { at: iso(t.service_completed_at)!, by: who(t.service_completed_by), note: t.completion_note, fault_code: t.fault_code, action_code: t.action_code, temporary_fix: t.temporary_fix }
        : null,
    },
    responsibility: {
      vendor: seeVendors ? (vendor.rows[0] ?? null) : null,
      assignee: bagText(t, 'Assignee') ?? bagText(t, 'Assignee Name TXT'),
      am: bagText(t, 'AM'),
      technicians: seeVendors ? techs.rows : [],
    },
    time: {
      created_at: t.created_at.toISOString(),
      date_received: t.date_received,
      due_date: bagText(t, 'Due Date'),
      sla_due: bagText(t, 'SLA Due Date'),
      scheduled: bagText(t, 'Scheduled Date'),
      first_check_in: ins.length ? new Date(Math.min(...ins)).toISOString() : null,
      last_check_out: outs.length ? new Date(Math.max(...outs)).toISOString() : null,
      on_site_since: onSite ? iso(onSite.checked_in_at) : null,
      on_site_minutes: onSiteMinutes,
      visits: visits.rows.length,
      status_since: lastChange ? lastChange.created_at.toISOString() : t.created_at.toISOString(),
      paused_minutes: pausedMinutes,
    },
    cost: money.summary,
    checklist: checklist.rows.map((c) => ({ id: c.id, title: c.title, done: c.done, done_by: who(c.done_by), done_at: iso(c.done_at), note: c.note, position: c.position })),
    tags: tags.rows.map((x) => ({ id: x.id, tag: x.tag, reason: x.reason, created_by: who(x.created_by), created_at: iso(x.created_at)! })),
    tag_suggestions: tagSuggestions.rows.map((r) => r.tag),
    nte_requests: nteRows.rows.map((n) => ({
      id: n.id,
      current_nte: num(n.current_nte),
      requested_nte: Number(n.requested_nte),
      reason: n.reason,
      status: n.status,
      requested_by: who(n.requested_by),
      decided_by: who(n.decided_by),
      decided_at: iso(n.decided_at),
      decision_note: n.decision_note,
      created_at: iso(n.created_at)!,
      can: { decide: n.status === 'open' && can(actor, NTE_APPROVAL_KEY, 'approve'), withdraw: n.status === 'open' && n.requested_by === actor.id },
    })),
    timelog: {
      statuses,
      visits: visits.rows.map((v) => ({
        id: v.id,
        seq: v.seq,
        visit_type: v.visit_type,
        tech_name: v.tech_name,
        checked_in_at: iso(v.checked_in_at),
        checked_out_at: iso(v.checked_out_at),
        minutes: minutesBetween(iso(v.checked_in_at), iso(v.checked_out_at)),
        geofence_result: v.geofence_result,
        geofence_ft: v.geofence_ft,
      })),
      pauses: pauses.rows.map((p) => ({
        id: p.id,
        paused_at: iso(p.paused_at)!,
        resumed_at: iso(p.resumed_at),
        minutes: Math.max(0, Math.round(((p.resumed_at ?? now).getTime() - p.paused_at.getTime()) / 60_000)),
        reason: p.reason,
        paused_by: who(p.paused_by),
      })),
      response_minutes: ins.length ? minutesBetween(start, new Date(Math.min(...ins)).toISOString()) : null,
      open_minutes: minutesBetween(start, (t.service_completed_at ?? now).toISOString()) ?? 0,
    },
    breakdown: money.breakdown,
    related,
    site_events: events,
    codes,
    can: { edit: can(actor, 'work_orders', 'edit'), decide_nte: can(actor, NTE_APPROVAL_KEY, 'approve'), see_money: seeMoney, see_vendors: seeVendors },
  };
}

// ── Money ────────────────────────────────────────────────────────────────────

function emptyMoney(t: TaskRow): { summary: WoRecord['cost']; breakdown: WoCostBreakdown } {
  void t;
  return {
    summary: { nte: null, cost: null, quote_total: null, quote_status: null, invoiced: null, payables_requested: null, payables_paid: null, vendor_bills: null, profit: null, margin_pct: null, over_nte: false },
    breakdown: { quote: null, invoices: [], payables: [], vendor_bills: [], revenue: null, cost: null, revenue_basis: '', cost_basis: '' },
  };
}

/** Each part is read through the service that owns it, behind that service's
 *  own gate; a part the viewer may not see comes back empty, never as an error. */
async function loadMoney(taskId: string, t: TaskRow, actor: ActingPrincipal): Promise<{ summary: WoRecord['cost']; breakdown: WoCostBreakdown }> {
  const quiet = async <T>(allowed: boolean, fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (!allowed) return fallback;
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };
  const [{ getQuote }, { listPaymentRequests }, { listVendorBillsForTask }] = await Promise.all([
    import('./quotes.js'),
    import('./payments.js'),
    import('./vendorBills.js'),
  ]);
  const [quote, payments, bills, invoices] = await Promise.all([
    quiet(can(actor, 'quotes', 'view'), () => getQuote(taskId, actor), null),
    quiet(can(actor, 'payments', 'view'), () => listPaymentRequests(taskId), null),
    quiet(can(actor, 'payments', 'view'), () => listVendorBillsForTask(taskId, actor), []),
    quiet(can(actor, 'invoicing', 'view'), async () => {
      const r = await query<{ id: string; number: string; status: string; total: string; issued_at: Date | null }>(
        `SELECT id::text AS id, number, status, total, issued_at FROM invoice WHERE task_id = $1 ORDER BY created_at`,
        [taskId],
      );
      return r.rows;
    }, [] as { id: string; number: string; status: string; total: string; issued_at: Date | null }[]),
  ]);

  const nte = num(t.nte) ?? num(t.fields?.[NTE_KEY]);
  const cost = num(t.fields?.[COST_KEY]);
  const liveInvoices = invoices.filter((i) => i.status === 'sent' || i.status === 'paid');
  const invoiced = liveInvoices.length ? liveInvoices.reduce((s, i) => s + Number(i.total), 0) : null;
  const liveBills = bills.filter((b) => b.status !== 'void');
  const billsTotal = liveBills.length ? liveBills.reduce((s, b) => s + b.total, 0) : null;
  const quoteTotal = quote ? quote.totals.grand_total : null;

  // Revenue: what was actually billed, else what was quoted. Cost: the work
  // order's own Cost (rule: the final vendor cost), else the vendor bills,
  // else what has been asked to be paid out.
  const revenue = invoiced ?? quoteTotal;
  const revenueBasis = invoiced !== null ? 'Invoices sent to the client' : quoteTotal !== null ? 'The quote (nothing invoiced yet)' : 'Nothing quoted or invoiced yet';
  const jobCost = cost ?? billsTotal ?? (payments && payments.total_requested > 0 ? payments.total_requested : null);
  const costBasis = cost !== null ? 'The work order’s Cost field' : billsTotal !== null ? 'Vendor bills (no Cost entered yet)' : jobCost !== null ? 'Payment requests (no Cost or bill yet)' : 'No cost recorded yet';
  const profit = revenue !== null && jobCost !== null ? Math.round((revenue - jobCost) * 100) / 100 : null;

  const byType = new Map<string, { count: number; amount: number }>();
  if (quote) {
    for (const s of quote.sections) {
      for (const l of s.lines) {
        const cur = byType.get(l.line_type) ?? { count: 0, amount: 0 };
        cur.count += 1;
        cur.amount += l.amount;
        byType.set(l.line_type, cur);
      }
    }
  }
  const line = (label: string, detail: string | null, amount: number, status: string | null, link: string | null): WoCostLine => ({ label, detail, amount, status, link });

  return {
    summary: {
      nte,
      cost,
      quote_total: quoteTotal,
      quote_status: quote?.status ?? null,
      invoiced,
      payables_requested: payments ? payments.total_requested : null,
      payables_paid: payments ? payments.total_paid : null,
      vendor_bills: billsTotal,
      profit,
      margin_pct: profit !== null && revenue ? Math.round((profit / revenue) * 1000) / 10 : null,
      over_nte: nte !== null && cost !== null && cost > nte,
    },
    breakdown: {
      quote: quote
        ? {
            status: quote.status,
            by_type: [...byType.entries()].map(([type, v]) => ({ type, count: v.count, amount: Math.round(v.amount * 100) / 100 })),
            tax: (quote.totals.sales_tax ?? 0) + (quote.totals.line_tax ?? 0),
            total: quote.totals.grand_total,
          }
        : null,
      invoices: invoices.map((i) => line(`Invoice ${i.number}`, i.issued_at ? `sent ${i.issued_at.toISOString().slice(0, 10)}` : null, Number(i.total), i.status, null)),
      payables: (payments?.items ?? []).map((p) => line(p.payee.name ?? 'Payee', p.purpose, p.amount, p.status, null)),
      vendor_bills: bills.map((b) => line(b.vendor_name, b.bill_number ? `bill ${b.bill_number}` : null, b.total, b.status, null)),
      revenue,
      cost: jobCost,
      revenue_basis: revenueBasis,
      cost_basis: costBasis,
    },
  };
}

// ── Related ──────────────────────────────────────────────────────────────────

async function loadRelated(taskId: string, t: TaskRow, actor: ActingPrincipal, nteRequests: number): Promise<WoRelated> {
  const others = async (col: 't.site_id' | 't.asset_id', id: string | null, exclude?: string | null): Promise<WoRelatedWorkOrder[]> => {
    if (!id) return [];
    const p = new Params();
    const target = p.add(id);
    const self = p.add(taskId);
    const scope = woScopeSql(actor, p);
    const not = exclude ? `AND (t.asset_id IS NULL OR t.asset_id <> ${p.add(exclude)})` : '';
    const res = await query<WoRelatedWorkOrder>(
      `SELECT t.wo_number, t.title, st.name AS status, t.status_group::text AS status_group, t.trade,
              to_char(COALESCE(t.date_received, t.created_at::date), 'YYYY-MM-DD') AS date_received
         FROM task t JOIN status st ON st.id = t.status_id
        WHERE ${col} = ${target} AND t.id <> ${self} AND t.deleted_at IS NULL ${not} ${scope ? `AND ${scope}` : ''}
        ORDER BY COALESCE(t.date_received, t.created_at::date) DESC LIMIT 25`,
      p.values,
    );
    return res.rows;
  };
  const [sameAsset, sameSite, approvals, counts] = await Promise.all([
    others('t.asset_id', t.asset_id),
    // The site's other work orders, leaving out the ones already listed under the asset.
    others('t.site_id', t.site_id, t.asset_id),
    query<{ type: string; title: string; status: string; created_at: Date }>(
      `SELECT type, title, status, created_at FROM approval_task WHERE task_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [taskId],
    ),
    query<{ quotes: number; invoices: number; bills: number; payments: number; visits: number; messages: number; photos: number }>(
      `SELECT (SELECT count(*)::int FROM quote WHERE task_id = $1) AS quotes,
              (SELECT count(*)::int FROM invoice WHERE task_id = $1) AS invoices,
              (SELECT count(*)::int FROM vendor_bill WHERE task_id = $1) AS bills,
              (SELECT count(*)::int FROM payment_request WHERE task_id = $1) AS payments,
              (SELECT count(*)::int FROM wo_visit WHERE task_id = $1) AS visits,
              (SELECT count(*)::int FROM comment WHERE task_id = $1) AS messages,
              (SELECT count(*)::int FROM attachment WHERE task_id = $1) AS photos`,
      [taskId],
    ).catch(() => ({ rows: [{ quotes: 0, invoices: 0, bills: 0, payments: 0, visits: 0, messages: 0, photos: 0 }] })),
  ]);
  const c = counts.rows[0];
  const wo = encodeURIComponent(t.wo_number);
  const records: WoRelated['records'] = [];
  const add = (n: number, kind: string, one: string, many: string, link: string) => {
    if (n > 0) records.push({ kind, label: `${n} ${n === 1 ? one : many}`, status: null, link });
  };
  add(c.quotes, 'quote', 'quote', 'quotes', `/work-orders/${wo}/quote`);
  add(c.invoices, 'invoice', 'invoice', 'invoices', `/work-orders/${wo}?tab=money`);
  add(c.bills, 'vendor_bill', 'vendor bill', 'vendor bills', `/work-orders/${wo}?tab=payables`);
  add(c.payments, 'payment', 'payment request', 'payment requests', `/work-orders/${wo}?tab=payables`);
  add(c.visits, 'visit', 'visit', 'visits', `/work-orders/${wo}?tab=cico`);
  add(c.messages, 'message', 'message', 'messages', `/work-orders/${wo}?tab=messages`);
  add(c.photos, 'photo', 'photo or file', 'photos and files', `/work-orders/${wo}?tab=overview`);
  if (nteRequests > 0) records.push({ kind: 'nte_request', label: `${nteRequests} NTE increase ${nteRequests === 1 ? 'request' : 'requests'}`, status: null, link: null });
  return {
    same_asset: sameAsset,
    same_site: sameSite,
    approvals: approvals.rows.map((a) => ({ kind: a.type, title: a.title, status: a.status, created_at: a.created_at.toISOString() })),
    records,
  };
}

// ═══ The writes ══════════════════════════════════════════════════════════════

/** One change on the work order, logged the way a field edit is. */
async function logChange(taskId: string, actor: ActingPrincipal, field: string, before: unknown, after: unknown): Promise<void> {
  await logTaskChanges({ query: (sql, params) => query(sql, params) }, actor.id, taskId, [{ field, before, after }]);
}

export async function setWoVendor(taskId: string, vendorId: string | null, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  const t = await loadTask(taskId);
  let name: string | null = null;
  if (vendorId) {
    if (!UUID_RE.test(vendorId)) throw badRequest('That vendor does not exist', { field: 'vendor_id' });
    const v = await query<{ name: string; blacklisted: boolean }>(`SELECT name, blacklisted FROM vendor WHERE id = $1 AND deleted_at IS NULL`, [vendorId]);
    if (!v.rows[0]) throw badRequest('That vendor does not exist', { field: 'vendor_id' });
    if (v.rows[0].blacklisted) throw conflict(`${v.rows[0].name} is blacklisted and cannot be made responsible for a work order`);
    name = v.rows[0].name;
  }
  if ((t.vendor_id ?? null) !== (vendorId ?? null)) {
    const before = t.vendor_id ? (await query<{ name: string }>(`SELECT name FROM vendor WHERE id = $1`, [t.vendor_id])).rows[0]?.name ?? null : null;
    await query(`UPDATE task SET vendor_id = $2 WHERE id = $1`, [taskId, vendorId]);
    await logChange(taskId, actor, 'Responsible vendor', before, name);
  }
  return getWoRecord(taskId, actor);
}

export async function pauseWo(taskId: string, reason: string | null, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  const t = await loadTask(taskId);
  if (t.paused_at) throw conflict('This work order is already paused');
  if (t.cancelled_at) throw conflict('A cancelled work order cannot be paused');
  const why = clean(reason);
  if (!why) throw badRequest('Say why it is paused', { field: 'reason' });
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE task SET paused_at = now(), paused_by = $2, pause_reason = $3 WHERE id = $1`, [taskId, actor.id, why]);
    await tx.query(`INSERT INTO wo_pause (task_id, reason, paused_by) VALUES ($1, $2, $3)`, [taskId, why, actor.id]);
    await logTaskChanges(tx, actor.id, taskId, [{ field: 'Paused', before: null, after: why }]);
  });
  return getWoRecord(taskId, actor);
}

export async function resumeWo(taskId: string, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  const t = await loadTask(taskId);
  if (!t.paused_at) throw conflict('This work order is not paused');
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE task SET paused_at = NULL, paused_by = NULL, pause_reason = NULL WHERE id = $1`, [taskId]);
    await tx.query(`UPDATE wo_pause SET resumed_at = now(), resumed_by = $2 WHERE task_id = $1 AND resumed_at IS NULL`, [taskId, actor.id]);
    await logTaskChanges(tx, actor.id, taskId, [{ field: 'Paused', before: t.pause_reason, after: null }]);
  });
  return getWoRecord(taskId, actor);
}

export async function setWoEta(taskId: string, input: { eta_at: string | null; note?: string | null }, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  const t = await loadTask(taskId);
  let at: Date | null = null;
  if (input.eta_at) {
    at = new Date(input.eta_at);
    if (Number.isNaN(at.getTime())) throw badRequest('That is not a date and time', { field: 'eta_at' });
  }
  await query(`UPDATE task SET eta_at = $2, eta_note = $3, eta_by = $4 WHERE id = $1`, [taskId, at, at ? clean(input.note) : null, at ? actor.id : null]);
  await logChange(taskId, actor, 'ETA', iso(t.eta_at), iso(at));
  return getWoRecord(taskId, actor);
}

/** Cancel: a reason, a stamp, and — when the workflow has a status whose name
 *  says cancelled — a move to it through the ordinary status change, so the
 *  gates, the audit row and the automations all run. */
export async function cancelWo(taskId: string, reason: string | null, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  const t = await loadTask(taskId);
  if (t.cancelled_at) throw conflict('This work order is already cancelled');
  const why = clean(reason);
  if (!why) throw badRequest('Say why it is cancelled', { field: 'reason' });
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE task SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, paused_at = NULL, paused_by = NULL, pause_reason = NULL WHERE id = $1`, [taskId, actor.id, why]);
    await tx.query(`UPDATE wo_pause SET resumed_at = now(), resumed_by = $2 WHERE task_id = $1 AND resumed_at IS NULL`, [taskId, actor.id]);
    await logTaskChanges(tx, actor.id, taskId, [{ field: 'Cancelled', before: null, after: why }]);
  });
  const st = await query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM status WHERE name ~* '^cancel' ORDER BY position LIMIT 1`,
  );
  if (st.rows[0] && st.rows[0].name !== t.status_name) {
    const { changeStatus } = await import('./workOrders.js');
    // The stamp stands even if a gate refuses the move; the person is told.
    await changeStatus(taskId, st.rows[0].id, actor.id).catch(() => undefined);
  }
  return getWoRecord(taskId, actor);
}

export async function reopenWo(taskId: string, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  const t = await loadTask(taskId);
  if (!t.cancelled_at) throw conflict('This work order is not cancelled');
  await query(`UPDATE task SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL WHERE id = $1`, [taskId]);
  await logChange(taskId, actor, 'Cancelled', t.cancel_reason, null);
  return getWoRecord(taskId, actor);
}

export async function completeWoService(taskId: string, input: WoCompleteInput, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  const t = await loadTask(taskId);
  if (t.cancelled_at) throw conflict('A cancelled work order cannot be completed');
  const codes = await loadCodes();
  const fault = clean(input.fault_code);
  const action = clean(input.action_code);
  if (fault && !codes.fault.some((c) => c.code === fault)) throw badRequest('That is not a fault code', { field: 'fault_code' });
  if (action && !codes.action.some((c) => c.code === action)) throw badRequest('That is not an action code', { field: 'action_code' });
  const note = clean(input.note);
  if (!note && !fault && !action) throw badRequest('Say what was found or what was done');
  await query(
    `UPDATE task SET completion_note = $2, fault_code = $3, action_code = $4, temporary_fix = $5,
            service_completed_at = COALESCE(service_completed_at, now()), service_completed_by = $6
      WHERE id = $1`,
    [taskId, note, fault, action, input.temporary_fix ?? null, actor.id],
  );
  await logChange(
    taskId,
    actor,
    'Service completed',
    t.service_completed_at ? { note: t.completion_note, fault_code: t.fault_code, action_code: t.action_code, temporary_fix: t.temporary_fix } : null,
    { note, fault_code: fault, action_code: action, temporary_fix: input.temporary_fix ?? null },
  );
  return getWoRecord(taskId, actor);
}

export async function clearWoCompletion(taskId: string, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  const t = await loadTask(taskId);
  if (!t.service_completed_at) throw conflict('The service is not marked complete');
  await query(`UPDATE task SET completion_note = NULL, fault_code = NULL, action_code = NULL, temporary_fix = NULL, service_completed_at = NULL, service_completed_by = NULL WHERE id = $1`, [taskId]);
  await logChange(taskId, actor, 'Service completed', { note: t.completion_note, fault_code: t.fault_code, action_code: t.action_code }, null);
  return getWoRecord(taskId, actor);
}

// ── Checklist ────────────────────────────────────────────────────────────────

export async function addChecklistItems(taskId: string, titles: string[], actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  const list = titles.map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (list.length === 0) throw badRequest('Name the step', { field: 'title' });
  const base = await query<{ n: number }>(`SELECT COALESCE(max(position), -1)::int + 1 AS n FROM wo_checklist_item WHERE task_id = $1`, [taskId]);
  let pos = base.rows[0]?.n ?? 0;
  for (const title of list) {
    await query(`INSERT INTO wo_checklist_item (task_id, title, position, created_by) VALUES ($1, $2, $3, $4)`, [taskId, title.slice(0, 300), pos++, actor.id]);
  }
  await logChange(taskId, actor, 'Checklist', null, list.length === 1 ? `added “${list[0]}”` : `added ${list.length} steps`);
  return getWoRecord(taskId, actor);
}

export async function updateChecklistItem(taskId: string, itemId: string, patch: { done?: boolean; title?: string; note?: string | null }, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  if (!UUID_RE.test(itemId)) throw notFound('That step does not exist');
  const cur = await query<{ title: string; done: boolean }>(`SELECT title, done FROM wo_checklist_item WHERE id = $1 AND task_id = $2`, [itemId, taskId]);
  if (!cur.rows[0]) throw notFound('That step does not exist');
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (sql: string, v?: unknown) => {
    if (v !== undefined) vals.push(v);
    sets.push(v !== undefined ? sql.replace('?', `$${vals.length}`) : sql);
  };
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw badRequest('Name the step', { field: 'title' });
    set('title = ?', title.slice(0, 300));
  }
  if (patch.note !== undefined) set('note = ?', clean(patch.note));
  if (patch.done !== undefined && patch.done !== cur.rows[0].done) {
    set('done = ?', patch.done);
    if (patch.done) {
      set('done_by = ?', actor.id);
      set('done_at = now()');
    } else {
      set('done_by = NULL');
      set('done_at = NULL');
    }
  }
  if (sets.length > 0) {
    vals.push(itemId);
    await query(`UPDATE wo_checklist_item SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    if (patch.done !== undefined && patch.done !== cur.rows[0].done) {
      await logChange(taskId, actor, 'Checklist', null, `${patch.done ? 'ticked' : 'unticked'} “${cur.rows[0].title}”`);
    }
  }
  return getWoRecord(taskId, actor);
}

export async function removeChecklistItem(taskId: string, itemId: string, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  if (!UUID_RE.test(itemId)) throw notFound('That step does not exist');
  const res = await query<{ title: string }>(`DELETE FROM wo_checklist_item WHERE id = $1 AND task_id = $2 RETURNING title`, [itemId, taskId]);
  if (!res.rows[0]) throw notFound('That step does not exist');
  await logChange(taskId, actor, 'Checklist', `“${res.rows[0].title}”`, null);
  return getWoRecord(taskId, actor);
}

// ── Tags ─────────────────────────────────────────────────────────────────────

export async function addWoTag(taskId: string, input: { tag: string; reason?: string | null }, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  const tag = input.tag.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!tag) throw badRequest('Name the tag', { field: 'tag' });
  const dup = await query<{ id: string }>(`SELECT id FROM wo_tag WHERE task_id = $1 AND lower(tag) = lower($2)`, [taskId, tag]);
  if (dup.rows[0]) throw conflict(`This work order already carries the tag ${tag}`);
  // The spelling already in use wins, so "Recall" and "recall" stay one tag.
  const known = await query<{ tag: string }>(`SELECT tag FROM wo_tag WHERE lower(tag) = lower($1) ORDER BY created_at LIMIT 1`, [tag]);
  const name = known.rows[0]?.tag ?? tag;
  await query(`INSERT INTO wo_tag (task_id, tag, reason, created_by) VALUES ($1, $2, $3, $4)`, [taskId, name, clean(input.reason), actor.id]);
  await logChange(taskId, actor, 'Tag', null, clean(input.reason) ? `${name} — ${clean(input.reason)}` : name);
  return getWoRecord(taskId, actor);
}

export async function removeWoTag(taskId: string, tagId: string, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  if (!UUID_RE.test(tagId)) throw notFound('That tag is not on this work order');
  const res = await query<{ tag: string }>(`DELETE FROM wo_tag WHERE id = $1 AND task_id = $2 RETURNING tag`, [tagId, taskId]);
  if (!res.rows[0]) throw notFound('That tag is not on this work order');
  await logChange(taskId, actor, 'Tag', res.rows[0].tag, null);
  return getWoRecord(taskId, actor);
}

// ── A manual NTE increase ────────────────────────────────────────────────────

async function nteDeciderIds(): Promise<string[]> {
  const res = await query<{ id: string }>(
    `SELECT p.id::text AS id FROM principal p LEFT JOIN role r ON r.code = p.role
      WHERE p.kind = 'human' AND p.status <> 'disabled'
        AND (p.is_super_admin
             OR (r.permissions -> $1 ->> 'approve') = 'true'
             OR (NOT (r.permissions ? $1) AND (r.permissions -> 'approvals' ->> 'approve') = 'true'))`,
    [NTE_APPROVAL_KEY],
  );
  return res.rows.map((r) => r.id);
}

export async function requestNteIncrease(taskId: string, input: { requested_nte: number; reason: string }, actor: ActingPrincipal): Promise<WoRecord> {
  requireEdit(actor);
  const t = await loadTask(taskId);
  const amount = Number(input.requested_nte);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Give the NTE you are asking for', { field: 'requested_nte' });
  const current = num(t.nte) ?? num(t.fields?.[NTE_KEY]);
  if (current !== null && amount <= current) throw badRequest(`That is not an increase — the NTE is already ${current.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`, { field: 'requested_nte' });
  const reason = clean(input.reason);
  if (!reason) throw badRequest('Say why more is needed', { field: 'reason' });
  const open = await query<{ id: string }>(`SELECT id FROM wo_nte_request WHERE task_id = $1 AND status = 'open'`, [taskId]);
  if (open.rows[0]) throw conflict('An NTE increase is already waiting for a decision on this work order');
  await query(`INSERT INTO wo_nte_request (task_id, current_nte, requested_nte, reason, requested_by) VALUES ($1, $2, $3, $4, $5)`, [taskId, current, amount, reason, actor.id]);
  await logChange(taskId, actor, 'NTE increase requested', current, { requested: amount, reason });
  await notify(await nteDeciderIds(), {
    kind: 'nte_increase',
    title: `${actor.name} asks to raise the NTE on ${t.wo_number} to $${amount.toLocaleString('en-US')}`,
    body: reason,
    link: `/work-orders/${encodeURIComponent(t.wo_number)}?tab=costs`,
    actorId: actor.id,
  });
  return getWoRecord(taskId, actor);
}

export async function decideNteIncrease(taskId: string, requestId: string, decision: 'approve' | 'reject' | 'withdraw', note: string | null, actor: ActingPrincipal): Promise<WoRecord> {
  if (!UUID_RE.test(requestId)) throw notFound('That request does not exist');
  const t = await loadTask(taskId);
  const cur = await query<{ status: string; requested_nte: string; requested_by: string | null }>(
    `SELECT status, requested_nte, requested_by::text AS requested_by FROM wo_nte_request WHERE id = $1 AND task_id = $2`,
    [requestId, taskId],
  );
  const r = cur.rows[0];
  if (!r) throw notFound('That request does not exist');
  if (r.status !== 'open') throw conflict('That request has already been decided');
  const text = clean(note);
  if (decision === 'withdraw') {
    if (r.requested_by !== actor.id) throw forbidden('Only the person who asked can withdraw the request');
  } else {
    requirePerm(actor, NTE_APPROVAL_KEY, 'approve', 'Deciding an NTE increase is a manager’s job');
    if (decision === 'reject' && !text) throw badRequest('Say why it is rejected', { field: 'note' });
  }
  const amount = Number(r.requested_nte);
  if (decision === 'approve') {
    // The new NTE goes in through the ordinary field path: audited, mirrored
    // to task.nte, and the rules that watch cost against NTE run on it.
    const { updateWorkOrderFields } = await import('./woFieldValues.js');
    await updateWorkOrderFields(taskId, { [`fields.${NTE_KEY}`]: amount }, actor.id);
  }
  const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'withdrawn';
  await query(`UPDATE wo_nte_request SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [requestId, status, actor.id, text]);
  await logChange(taskId, actor, `NTE increase ${status}`, null, { requested: amount, note: text });
  if (decision !== 'withdraw') {
    await notify([r.requested_by], {
      kind: 'nte_increase_decided',
      title: `${actor.name} ${status} the NTE increase on ${t.wo_number}`,
      body: text,
      link: `/work-orders/${encodeURIComponent(t.wo_number)}?tab=costs`,
      actorId: actor.id,
    });
  }
  return getWoRecord(taskId, actor);
}

// ═══ A visit's location, against the geofence ════════════════════════════════

export async function locateVisit(taskId: string, visitId: string, at: { lat: number; lng: number } | null, actor: ActingPrincipal): Promise<WoRecord> {
  requirePerm(actor, 'work_orders/fields/cico', 'edit', 'You cannot edit visits');
  if (!UUID_RE.test(visitId)) throw notFound('That visit does not exist');
  const v = await query<{ seq: number }>(`SELECT seq FROM wo_visit WHERE id = $1 AND task_id = $2`, [visitId, taskId]);
  if (!v.rows[0]) throw notFound('That visit does not exist');
  if (!at) {
    await query(`UPDATE wo_visit SET check_in_lat = NULL, check_in_lng = NULL, geofence_ft = NULL, geofence_limit_ft = NULL, geofence_result = NULL, located_by = NULL, located_at = NULL WHERE id = $1`, [visitId]);
    await logChange(taskId, actor, `Visit ${v.rows[0].seq} location`, 'recorded', null);
    return getWoRecord(taskId, actor);
  }
  if (!Number.isFinite(at.lat) || !Number.isFinite(at.lng) || Math.abs(at.lat) > 90 || Math.abs(at.lng) > 180) throw badRequest('Those are not coordinates');
  const s = await query<{ lat: number | null; lng: number | null; boundary_radius_ft: number | null }>(
    `SELECT s.lat, s.lng, s.boundary_radius_ft FROM task t JOIN site s ON s.id = t.site_id WHERE t.id = $1`,
    [taskId],
  );
  const check = geofenceCheck(at, s.rows[0] ?? null);
  await query(
    `UPDATE wo_visit SET check_in_lat = $2, check_in_lng = $3, geofence_ft = $4, geofence_limit_ft = $5, geofence_result = $6, located_by = $7, located_at = now() WHERE id = $1`,
    [visitId, at.lat, at.lng, check.feet, check.limit, check.result, actor.id],
  );
  await logChange(taskId, actor, `Visit ${v.rows[0].seq} location`, null, { result: check.result, feet: check.feet, limit: check.limit });
  return getWoRecord(taskId, actor);
}

// ═══ Site events ═════════════════════════════════════════════════════════════

type SiteEventRow = {
  id: string;
  s_id: string;
  s_name: string | null;
  s_client: string | null;
  s_city: string | null;
  s_state: string | null;
  kind: SiteEventKind;
  title: string;
  detail: string | null;
  starts_on: string;
  ends_on: string | null;
  c_id: string | null;
  c_name: string | null;
  c_kind: 'human' | 'service' | null;
  created_at: Date;
};

const SITE_EVENT_SELECT = `
  SELECT e.id::text AS id, s.id::text AS s_id, COALESCE(s.name, s.client) AS s_name, s.client AS s_client, s.city AS s_city, s.state AS s_state,
         e.kind, e.title, e.detail, to_char(e.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(e.ends_on, 'YYYY-MM-DD') AS ends_on,
         p.id::text AS c_id, p.display_name AS c_name, p.kind AS c_kind, e.created_at
    FROM site_event e
    JOIN site s ON s.id = e.site_id AND s.deleted_at IS NULL
    LEFT JOIN principal p ON p.id = e.created_by`;

function mapSiteEvent(r: SiteEventRow, day: string): SiteEvent {
  return {
    id: r.id,
    site: { id: r.s_id, name: r.s_name ?? 'Site', client: r.s_client, city: r.s_city, state: r.s_state },
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    starts_on: r.starts_on,
    ends_on: r.ends_on,
    phase: siteEventPhase(r.starts_on, r.ends_on, day),
    created_by: r.c_id ? { id: r.c_id, name: r.c_name ?? 'Unknown', kind: r.c_kind ?? 'human' } : null,
    created_at: r.created_at.toISOString(),
  };
}

/** Events for one site (everything), or across the sites the viewer may see
 *  (running and upcoming, plus what ended in the last 30 days). */
export async function listSiteEvents(q: { site?: string }, actor: ActingPrincipal): Promise<SiteEvent[]> {
  requirePerm(actor, 'sites', 'view', 'You cannot open Sites');
  const { assertSiteAccess, siteAccessSql } = await import('./portfolio.js');
  const day = today();
  const p = new Params();
  const where: string[] = [];
  if (q.site) {
    if (!UUID_RE.test(q.site)) throw notFound('Site not found');
    await assertSiteAccess(actor, q.site);
    where.push(`e.site_id = ${p.add(q.site)}`);
  } else {
    where.push(`(e.ends_on IS NULL OR e.ends_on >= ${p.add(day)}::date - 30)`);
    const acc = siteAccessSql(actor, p, 'e.site_id');
    if (acc) where.push(acc);
  }
  const res = await query<SiteEventRow>(`${SITE_EVENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.starts_on DESC, e.created_at DESC LIMIT 500`, p.values);
  return res.rows.map((r) => mapSiteEvent(r, day));
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_KINDS = ['closure', 'restricted_access', 'remodel', 'incident', 'inspection', 'weather', 'notice'];

export async function saveSiteEvent(siteId: string, eventId: string | null, input: { kind?: string; title?: string; detail?: string | null; starts_on?: string; ends_on?: string | null }, actor: ActingPrincipal): Promise<SiteEvent[]> {
  requirePerm(actor, 'sites', 'edit', 'You cannot edit sites');
  if (!UUID_RE.test(siteId)) throw notFound('Site not found');
  const { assertSiteAccess } = await import('./portfolio.js');
  await assertSiteAccess(actor, siteId);
  const site = await query<{ name: string | null }>(`SELECT COALESCE(name, client) AS name FROM site WHERE id = $1 AND deleted_at IS NULL`, [siteId]);
  if (!site.rows[0]) throw notFound('Site not found');
  if (input.kind !== undefined && !EVENT_KINDS.includes(input.kind)) throw badRequest('That is not a kind of event', { field: 'kind' });
  for (const k of ['starts_on', 'ends_on'] as const) {
    const v = input[k];
    if (v && !DAY_RE.test(v)) throw badRequest('That is not a date', { field: k });
  }
  const { logAdminEvent } = await import('./adminAudit.js');
  if (!eventId) {
    const title = clean(input.title);
    if (!title) throw badRequest('Say what is happening', { field: 'title' });
    const starts = input.starts_on ?? today();
    if (input.ends_on && input.ends_on < starts) throw badRequest('It cannot end before it starts', { field: 'ends_on' });
    await query(`INSERT INTO site_event (site_id, kind, title, detail, starts_on, ends_on, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [siteId, input.kind ?? 'notice', title.slice(0, 200), clean(input.detail), starts, input.ends_on ?? null, actor.id]);
    await logAdminEvent({ actorId: actor.id, entity: 'site', entityId: siteId, action: 'site_event_added', after: { name: site.rows[0].name ?? 'Site', event: title, kind: input.kind ?? 'notice', starts_on: starts, ends_on: input.ends_on ?? null } });
  } else {
    if (!UUID_RE.test(eventId)) throw notFound('That event does not exist');
    const cur = await query<{ title: string; starts_on: string; ends_on: string | null }>(
      `SELECT title, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on FROM site_event WHERE id = $1 AND site_id = $2`,
      [eventId, siteId],
    );
    if (!cur.rows[0]) throw notFound('That event does not exist');
    const starts = input.starts_on ?? cur.rows[0].starts_on;
    const ends = input.ends_on !== undefined ? input.ends_on : cur.rows[0].ends_on;
    if (ends && ends < starts) throw badRequest('It cannot end before it starts', { field: 'ends_on' });
    const title = input.title !== undefined ? clean(input.title) : cur.rows[0].title;
    if (!title) throw badRequest('Say what is happening', { field: 'title' });
    await query(
      `UPDATE site_event SET kind = COALESCE($3, kind), title = $4, detail = CASE WHEN $5::boolean THEN $6 ELSE detail END, starts_on = $7, ends_on = $8 WHERE id = $1 AND site_id = $2`,
      [eventId, siteId, input.kind ?? null, title.slice(0, 200), input.detail !== undefined, clean(input.detail), starts, ends],
    );
    await logAdminEvent({ actorId: actor.id, entity: 'site', entityId: siteId, action: 'site_event_updated', before: { name: site.rows[0].name ?? 'Site', event: cur.rows[0].title, ends_on: cur.rows[0].ends_on }, after: { name: site.rows[0].name ?? 'Site', event: title, ends_on: ends } });
  }
  return listSiteEvents({ site: siteId }, actor);
}

export async function removeSiteEvent(siteId: string, eventId: string, actor: ActingPrincipal): Promise<SiteEvent[]> {
  requirePerm(actor, 'sites', 'edit', 'You cannot edit sites');
  if (!UUID_RE.test(siteId) || !UUID_RE.test(eventId)) throw notFound('That event does not exist');
  const { assertSiteAccess } = await import('./portfolio.js');
  await assertSiteAccess(actor, siteId);
  const res = await query<{ title: string }>(`DELETE FROM site_event WHERE id = $1 AND site_id = $2 RETURNING title`, [eventId, siteId]);
  if (!res.rows[0]) throw notFound('That event does not exist');
  const { logAdminEvent } = await import('./adminAudit.js');
  await logAdminEvent({ actorId: actor.id, entity: 'site', entityId: siteId, action: 'site_event_removed', before: { name: 'Site', event: res.rows[0].title } });
  return listSiteEvents({ site: siteId }, actor);
}

// ═══ The space viewer ════════════════════════════════════════════════════════

export async function spaceViewer(siteId: string, actor: ActingPrincipal): Promise<import('@theone/shared').SpaceViewerResponse> {
  requirePerm(actor, 'sites', 'view', 'You cannot open Sites');
  if (!UUID_RE.test(siteId)) throw notFound('Site not found');
  const { assertSiteAccess } = await import('./portfolio.js');
  await assertSiteAccess(actor, siteId);
  const site = await query<{ name: string | null }>(`SELECT COALESCE(name, client) AS name FROM site WHERE id = $1 AND deleted_at IS NULL`, [siteId]);
  if (!site.rows[0]) throw notFound('Site not found');
  const seeAssets = can(actor, 'assets', 'view');
  const p = new Params();
  const sid = p.add(siteId);
  const scope = woScopeSql(actor, p);
  const [locs, assets, wos] = await Promise.all([
    query<{ id: string; parent_id: string | null; kind: 'building' | 'floor' | 'space'; name: string; level: number | null; space_type: string | null; area_sqft: string | null; notes: string | null; position: number }>(
      `SELECT id::text AS id, parent_id::text AS parent_id, kind, name, level, space_type, area_sqft, notes, position FROM site_location WHERE site_id = $1 ORDER BY position, lower(name)`,
      [siteId],
    ),
    seeAssets
      ? query<{ id: string; name: string; asset_type: string | null; status: string; condition: string | null; location_id: string | null }>(
          `SELECT id::text AS id, name, asset_type, status, condition, location_id::text AS location_id FROM asset WHERE site_id = $1 AND deleted_at IS NULL ORDER BY lower(name)`,
          [siteId],
        )
      : Promise.resolve({ rows: [] }),
    query<{ wo_number: string; title: string; status: string; asset_id: string | null; asset: string | null; location_id: string | null }>(
      `SELECT t.wo_number, t.title, st.name AS status, x.id::text AS asset_id, x.name AS asset, x.location_id::text AS location_id
         FROM task t JOIN status st ON st.id = t.status_id LEFT JOIN asset x ON x.id = t.asset_id
        WHERE t.site_id = ${sid} AND t.deleted_at IS NULL AND t.status_group::text NOT IN ('done', 'closed') ${scope ? `AND ${scope}` : ''}
        ORDER BY t.created_at DESC LIMIT 500`,
      p.values,
    ),
  ]);
  const openOn = (assetId: string) => wos.rows.filter((w) => w.asset_id === assetId).length;
  const assetView = (a: (typeof assets.rows)[number]) => ({ id: a.id, name: a.name, asset_type: a.asset_type, status: a.status, condition: a.condition, open_work_orders: openOn(a.id) });
  return {
    site: { id: siteId, name: site.rows[0].name ?? 'Site' },
    spaces: locs.rows.map((l) => {
      const here = assets.rows.filter((a) => a.location_id === l.id);
      return {
        ...l,
        area_sqft: num(l.area_sqft),
        assets: here.length,
        asset_list: here.map(assetView),
        open_work_orders: wos.rows.filter((w) => w.location_id === l.id).map((w) => ({ wo_number: w.wo_number, title: w.title, status: w.status, asset: w.asset })),
      };
    }),
    unplaced: assets.rows.filter((a) => !a.location_id).map(assetView),
  };
}

// ═══ Admin › Settings: fault and action codes ════════════════════════════════

const SETTINGS_KEY = 'admin/settings';

export async function listWoCodes(actor: ActingPrincipal): Promise<{ fault: WoCode[]; action: WoCode[] }> {
  requirePerm(actor, SETTINGS_KEY, 'view', 'You cannot open Admin › Settings');
  return loadCodes();
}

export async function saveWoCode(id: string | null, input: { kind?: 'fault' | 'action'; code?: string; label?: string; is_active?: boolean }, actor: ActingPrincipal): Promise<{ fault: WoCode[]; action: WoCode[] }> {
  requirePerm(actor, SETTINGS_KEY, 'edit', 'You cannot edit Admin › Settings');
  const { logAdminEvent } = await import('./adminAudit.js');
  if (!id) {
    if (input.kind !== 'fault' && input.kind !== 'action') throw badRequest('Say whether it is a fault or an action code');
    const code = (input.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
    const label = clean(input.label);
    if (!code || !label) throw badRequest('Give the code and what it means');
    const dup = await query<{ id: string }>(`SELECT id FROM wo_code WHERE kind = $1 AND lower(code) = lower($2)`, [input.kind, code]);
    if (dup.rows[0]) throw conflict(`${code} is already a ${input.kind} code`);
    await query(`INSERT INTO wo_code (kind, code, label, position) VALUES ($1, $2, $3, (SELECT COALESCE(max(position), -1) + 1 FROM wo_code WHERE kind = $1))`, [input.kind, code, label.slice(0, 120)]);
    await logAdminEvent({ actorId: actor.id, entity: 'wo_code', entityId: `${input.kind}:${code}`, action: 'wo_code_added', after: { name: `${code} — ${label}`, kind: input.kind } });
  } else {
    if (!UUID_RE.test(id)) throw notFound('That code does not exist');
    const cur = await query<{ kind: string; code: string; label: string; is_active: boolean }>(`SELECT kind, code, label, is_active FROM wo_code WHERE id = $1`, [id]);
    if (!cur.rows[0]) throw notFound('That code does not exist');
    const label = input.label !== undefined ? clean(input.label) : cur.rows[0].label;
    if (!label) throw badRequest('Say what the code means');
    // The code itself never changes: work orders already carry it.
    await query(`UPDATE wo_code SET label = $2, is_active = $3 WHERE id = $1`, [id, label.slice(0, 120), input.is_active ?? cur.rows[0].is_active]);
    await logAdminEvent({ actorId: actor.id, entity: 'wo_code', entityId: `${cur.rows[0].kind}:${cur.rows[0].code}`, action: 'wo_code_updated', before: { name: `${cur.rows[0].code} — ${cur.rows[0].label}`, is_active: cur.rows[0].is_active }, after: { name: `${cur.rows[0].code} — ${label}`, is_active: input.is_active ?? cur.rows[0].is_active } });
  }
  return loadCodes();
}
