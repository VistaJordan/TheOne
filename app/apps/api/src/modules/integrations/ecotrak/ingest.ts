/* Ecotrak ingestion: fetch -> land raw -> map -> upsert a work order.
 *
 * SHADOW-SAFE. While cmms_connection.shadow_mode is true this creates and
 * refreshes work orders but NEVER lets an inbound status overwrite one a human
 * has since moved. Nothing is written back to Ecotrak from here — the client
 * exposes no mutating call at all.
 *
 * Dedupe is on Ecotrak's immutable `id` via cmms_wo_link, never on
 * `work_order_id` (ours to set, null on 100% of production records).
 */

import { createHash } from 'node:crypto';
import { ecotrakAddressLine, normalizeZip } from '@theone/shared';
import { query, withTransaction, type Queryable } from '../../../db.js';
import { EcotrakClient, configFromEnv, type EcotrakWorkOrder } from './client.js';
import { classifyInbound } from './statusMap.js';
import { resolveTrade } from './tradeMap.js';
import { planFolder, stateAbbr } from './sharepointPath.js';
import { raiseAcceptanceTasks, settleAcceptanceFromClient } from '../../../services/approvals.js';
import { adoptClientsFromRecords } from '../../../services/dataRules.js';
import { integrationOnNow, requireIntegration } from '../../../services/integrations.js';
import { logTaskChanges, type TaskChange } from '../../../services/woAudit.js';
import { K_NTE } from '../../../services/money.js';
import { ecotrakSyncActorId } from '../../../services/serviceActors.js';
import { syncEcotrakNotes } from '../../../services/ecotrakNotes.js';

export const MAP_VERSION = '2026-09-01.1';

/**
 * Ecotrak status -> the internal status NAME on the seeded pipeline.
 *
 * PROPOSAL_REJECTED goes to done/incurred, not back to quoting: per plan §8.2
 * a rejected proposal is BFI (Bill For Incurred), so the job completes and
 * bills the incurred work.
 */
// Targets the S8 operational vocabulary (the 20-status pipeline in the seed —
// the legacy lowercase/'!!'-prefixed names were renamed wholesale; existing
// databases converge via migration 0020). Lookup is lowercased on both sides.
const INTERNAL_STATUS_BY_ECOTRAK: Record<string, string> = {
  PENDING_SP_ACCEPTANCE: 'Open',
  UNASSIGNED: 'Open',
  ACCEPTED: 'Open',
  REASSIGN: 'Open',
  SUBMITTING_PROPOSAL: 'Waiting for Quote',
  PROPOSAL_SUBMITTED: 'Quote Ready',
  PROPOSAL_APPROVED: 'Approved',
  PROPOSAL_REJECTED: 'Done / Incurred',
  ENROUTE: 'On Site (Job)',
  ARRIVED: 'On Site (Job)',
  PENDING_PARTS: 'Waiting for Parts',
  RETURN_VISIT_REQUIRED: 'Return Trip Needed',
  NOT_FIXED: 'Waiting for Advice',
  SOFT_COMPLETED: 'Done / Incurred',
  COMPLETED: 'Ready to Invoice',
  REJECTED: 'Cancelled / Postponed',
  CANCELLED: 'Cancelled / Postponed',
};

/** L1-L8 and P2-P7 both occur in production; only L1 drives urgency today.
 *  Exported for test: 45% of production WOs carry a code outside L1-L4, which
 *  the legacy field-mapping proposal did not anticipate. */
export function mapPriority(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const token = raw.trim().split(/\s|-/)[0]?.toUpperCase();
  switch (token) {
    case 'L1': return 'urgent';
    case 'L2': return 'high';
    case 'L3': case 'P2': return 'normal';
    case 'L4': case 'L5': case 'L6': case 'L7': case 'L8':
    case 'P3': case 'P4': case 'P5': case 'P7': return 'low';
    default: return null;
  }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** First meaningful line, for the task title. */
function titleOf(wo: EcotrakWorkOrder): string {
  const t = (wo.problem_type || wo.description || '').trim().split('\n')[0]?.trim();
  return t && t.length > 0 ? t.slice(0, 200) : `Ecotrak WO ${wo.id}`;
}

export interface IngestResult {
  fetched: number;
  created: number;
  updated: number;
  skippedHumanMoved: number;
  /** 0079 · seen again with nothing changed on Ecotrak's side: not touched. */
  unchanged: number;
  /** Incoming items closed because Ecotrak says accepted / rejected. */
  accepted: number;
  declined: number;
  /** 0114 · Ecotrak comments filed in Messages / updated after an edit there. */
  notesAdded: number;
  notesUpdated: number;
  unmappedStatus: string[];
  unmappedTrade: string[];
  errors: string[];
  /** 0079 · one line for Admin › Integrations. */
  note: string;
}

/** where a work order stands on Ecotrak's side of the acceptance:
    still waiting for us (PENDING_SP_ACCEPTANCE, UNASSIGNED, REASSIGN),
    turned down (REJECTED, CANCELLED), or accepted (every other status —
    ACCEPTED and everything that can only follow it). */
const WAITING_ON_ECOTRAK = new Set(['PENDING_SP_ACCEPTANCE', 'UNASSIGNED', 'REASSIGN']);
const DECLINED_ON_ECOTRAK = new Set(['REJECTED', 'CANCELLED']);
export function ecotrakAcceptance(status: string | null | undefined): 'waiting' | 'declined' | 'accepted' {
  const s = (status ?? '').toUpperCase();
  if (WAITING_ON_ECOTRAK.has(s)) return 'waiting';
  if (DECLINED_ON_ECOTRAK.has(s)) return 'declined';
  return 'accepted';
}

/** Work orders whose acceptance was answered on Ecotrak in this run. */
interface Settle {
  accepted: string[];
  rejected: string[];
  /** 0114 · every work order this pass created or changed: its notes are
   *  read after the commits. */
  touched: Array<{ taskId: string; externalId: string }>;
  /** 0119 · NTEs Ecotrak changed: dispatched to the automations after the
   *  commits, so the cost-over-NTE task is raised or cleared. */
  nte: Array<{ taskId: string; change: TaskChange }>;
}

interface ConnectionRow {
  id: string;
  credentials_ref: string;
  shadow_mode: boolean;
  last_synced_at: string | null;
}

export async function getEcotrakConnection(): Promise<ConnectionRow | null> {
  const r = await query<ConnectionRow>(
    `SELECT id, credentials_ref, shadow_mode, last_synced_at
       FROM cmms_connection
      WHERE provider = 'ecotrak' AND active = true
      ORDER BY created_at LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

/** Who started a run: Vercel's 10-minute cron, or Sync now in Admin. */
export type IngestTrigger = 'cron' | 'manual' | 'webhook';

/**
 * Pull work orders updated since the last sync (or `sinceDays` back on a cold
 * start) and upsert them. Every payload is landed raw BEFORE mapping, so a
 * mapping bug is always replayable without re-fetching.
 *
 * 0079 · the switch is read from the table itself before anything else (off =
 * Ecotrak is not contacted, not even for a token); one run at a time per
 * connection (a 5-minute lease, so a crashed run cannot block the next);
 * the outcome of every run is kept on the connection for the Admin panel.
 */
export async function ingestEcotrak(opts: { sinceDays?: number; trigger?: IngestTrigger } = {}): Promise<IngestResult> {
  // 0074 · the switch in Admin › Integrations (manual trigger and the poll).
  await integrationOnNow('ecotrak');
  requireIntegration('ecotrak');
  const trigger: IngestTrigger = opts.trigger ?? 'manual';
  const res: IngestResult = emptyResult();

  const conn = await getEcotrakConnection();
  if (!conn) {
    res.errors.push('no active ecotrak connection (run migration 0005)');
    res.note = 'No Ecotrak connection on file.';
    return res;
  }

  const lease = await query<{ started: string }>(
    `UPDATE cmms_connection SET run_started_at = now()
      WHERE id = $1 AND (run_started_at IS NULL OR run_started_at < now() - interval '5 minutes')
      RETURNING run_started_at::text AS started`,
    [conn.id],
  );
  if (lease.rows.length === 0) {
    res.note = 'A sync is already running; this one was skipped.';
    return res;
  }
  // The cursor moves to when this run STARTED, so a change made on Ecotrak
  // while it runs is picked up next time rather than lost.
  const startedAt = lease.rows[0].started;

  let fetchedOk = false;
  try {
    const client = new EcotrakClient(configFromEnv(conn.credentials_ref));

    // An explicit sinceDays OVERRIDES the incremental cursor. Without this a
    // backfill is impossible once last_synced_at is set: the caller asks for 21
    // days and silently gets today only, which is how the first re-run after a
    // mapping fix missed the 19 records it was meant to repair.
    // 0079 · the incremental cursor always reaches back one extra day: the API
    // filters by Ecotrak's calendar day, which is not ours at midnight.
    const dayAgo = new Date(Date.now() - 86_400_000);
    const since =
      typeof opts.sinceDays === 'number'
        ? new Date(Date.now() - opts.sinceDays * 86_400_000)
        : conn.last_synced_at
          ? new Date(Math.min(new Date(conn.last_synced_at).getTime(), dayAgo.getTime()))
          : new Date(Date.now() - 21 * 86_400_000);

    const orders = await client.fetchUpdatedSince(since);
    fetchedOk = true;
    res.fetched = orders.length;

    await processOrders(client, conn, orders, res);
    await backfillNotes(client, conn, res);
  } catch (e) {
    // Never the response body: an auth error can echo the request back.
    res.errors.push((e as Error).message);
  } finally {
    const parts = [
      fetchedOk ? `${res.fetched} read from Ecotrak` : 'Could not read from Ecotrak',
      res.created > 0 && `${res.created} new`,
      res.accepted > 0 && `${res.accepted} accepted on Ecotrak`,
      res.notesAdded > 0 && `${res.notesAdded} new comment${res.notesAdded === 1 ? '' : 's'}`,
      res.declined > 0 && `${res.declined} rejected on Ecotrak`,
      res.updated + res.skippedHumanMoved > 0 && `${res.updated + res.skippedHumanMoved} updated`,
      res.unchanged > 0 && `${res.unchanged} unchanged`,
      res.unmappedStatus.length > 0 && `held back, unknown status: ${res.unmappedStatus.join(', ')}`,
      res.errors.length > 0 && `${res.errors.length} error${res.errors.length === 1 ? '' : 's'}`,
    ].filter(Boolean);
    res.note = `${parts.join(' · ')}.`;
    const run = {
      at: new Date().toISOString(),
      trigger,
      ok: fetchedOk && res.errors.length === 0,
      fetched: res.fetched,
      created: res.created,
      updated: res.updated + res.skippedHumanMoved,
      unchanged: res.unchanged,
      note: res.note,
      errors: res.errors.slice(0, 20),
    };
    await query(
      `UPDATE cmms_connection
          SET run_started_at = NULL,
              last_run = $2::jsonb,
              last_synced_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE last_synced_at END
        WHERE id = $1`,
      [conn.id, JSON.stringify(run), fetchedOk, startedAt],
    );
  }
  return res;
}

/** Notes read per pass, at most: each is one GET, and a pass must finish
 *  well inside the function's time. */
const NOTES_PER_PASS = 40;
/** Work orders whose notes were never read, caught up a few per run. */
const NOTES_BACKFILL_PER_RUN = 15;

/**
 * Upsert a batch of Ecotrak work orders, then everything that waits for the
 * commits: the acceptance queue, client records, acceptances answered on
 * Ecotrak, and (0114) the notes of every work order that changed. Shared by
 * the poll and the webhook so both do exactly the same thing.
 */
async function processOrders(
  client: EcotrakClient,
  conn: ConnectionRow,
  orders: EcotrakWorkOrder[],
  res: IngestResult,
): Promise<void> {
  // Resolve status ids once — the pipeline is small and static.
  const statusRows = await query<{ id: string; name: string; status_group: string }>(
    `SELECT s.id, s.name, s.status_group FROM status s`,
  );
  const statusByName = new Map(statusRows.rows.map((s) => [s.name.toLowerCase(), s]));
  const actorId = await ecotrakSyncActorId();

  // Rule 7.1.1 (0036): every work order this run CREATES goes to the
  // manager's Pending Acceptance queue. Raised after each commit (the queue
  // row must never fail the sync), signed by the sync's own service
  // principal so the trail says which system put it there.
  const createdIds: string[] = [];
  const settle: Settle = { accepted: [], rejected: [], touched: [], nte: [] };
  for (const wo of orders) {
    try {
      await withTransaction(async (tx) => {
        await upsertOne(tx, conn, wo, statusByName, res, createdIds, actorId, settle);
      });
    } catch (e) {
      res.errors.push(`WO ${wo.id}: ${(e as Error).message}`);
    }
  }
  if (createdIds.length > 0) {
    try {
      await raiseAcceptanceTasks(createdIds, actorId, 'ecotrak');
    } catch (e) {
      res.errors.push(`acceptance queue: ${(e as Error).message}`);
    }
  }
  // #11 (Wave D): a client Ecotrak names for the first time gets its client
  // record, after the commits (our database only — nothing goes to Ecotrak).
  if (res.created > 0 || res.updated > 0) await adoptClientsFromRecords();
  // accepted (or rejected) on Ecotrak = answered here too.
  for (const id of settle.accepted) {
    if (await settleAcceptanceFromClient(id, 'accepted', 'Ecotrak', actorId)) res.accepted++;
  }
  for (const id of settle.rejected) {
    if (await settleAcceptanceFromClient(id, 'rejected', 'Ecotrak', actorId)) res.declined++;
  }
  // 0119 · an NTE Ecotrak changed is a field change like any other: the
  // rules see it (and the cost-over-NTE task is reconciled). Never throws.
  if (settle.nte.length > 0) {
    // Dynamic: the automations engine imports half the services.
    const { dispatchAutomations } = await import('../../../services/automations.js');
    for (const n of settle.nte) {
      await dispatchAutomations({ taskId: n.taskId, kind: 'changed', changes: [n.change] });
    }
  }
  // 0114 · the comments on what changed, client-visible in Messages.
  for (const t of settle.touched.slice(0, NOTES_PER_PASS)) {
    try {
      const n = await syncEcotrakNotes(client, conn.id, t.taskId, t.externalId);
      res.notesAdded += n.added;
      res.notesUpdated += n.updated;
    } catch (e) {
      res.errors.push(`notes for WO ${t.externalId}: ${(e as Error).message}`);
    }
  }
  // Past the cap: marked unread, so the backfill below reads them next.
  const later = settle.touched.slice(NOTES_PER_PASS).map((t) => t.externalId);
  if (later.length > 0) {
    await query(
      `UPDATE cmms_wo_link SET notes_synced_at = NULL WHERE connection_id = $1 AND external_id = ANY($2::text[])`,
      [conn.id, later],
    );
  }
}

/** 0114 · work orders linked before notes were read: a few per run, newest
 *  first, so their existing comments arrive without a burst of calls. */
async function backfillNotes(client: EcotrakClient, conn: ConnectionRow, res: IngestResult): Promise<void> {
  const r = await query<{ task_id: string; external_id: string }>(
    `SELECT l.task_id::text AS task_id, l.external_id
       FROM cmms_wo_link l JOIN task t ON t.id = l.task_id
      WHERE l.connection_id = $1 AND l.notes_synced_at IS NULL AND t.deleted_at IS NULL
      ORDER BY l.created_at DESC
      LIMIT $2`,
    [conn.id, NOTES_BACKFILL_PER_RUN],
  );
  for (const row of r.rows) {
    try {
      const n = await syncEcotrakNotes(client, conn.id, row.task_id, row.external_id);
      res.notesAdded += n.added;
      res.notesUpdated += n.updated;
    } catch (e) {
      res.errors.push(`notes for WO ${row.external_id}: ${(e as Error).message}`);
    }
  }
}

/**
 * 0114 · the webhook's path: read the named work orders back from Ecotrak
 * (never trusting the delivery's own copy) and run them through the same
 * pass as the poll. Answers which ids Ecotrak knew. Read only against Ecotrak.
 */
export async function refreshEcotrakWorkOrders(externalIds: string[]): Promise<{ found: string[]; result: IngestResult }> {
  await integrationOnNow('ecotrak');
  requireIntegration('ecotrak');
  const res = emptyResult();
  const conn = await getEcotrakConnection();
  if (!conn) {
    res.errors.push('no active ecotrak connection');
    return { found: [], result: res };
  }
  const client = new EcotrakClient(configFromEnv(conn.credentials_ref));
  const orders: EcotrakWorkOrder[] = [];
  for (const id of externalIds) {
    const wo = await client.fetchWorkOrder(id);
    if (wo) {
      orders.push(wo);
      break; // the first id Ecotrak knows is the one the delivery meant
    }
  }
  res.fetched = orders.length;
  await processOrders(client, conn, orders, res);
  // A comment does not always move the work order's own payload: read its
  // notes even when the work order itself came back unchanged.
  if (orders.length > 0 && res.created + res.updated + res.skippedHumanMoved === 0) {
    const ext = String(orders[0].id);
    const link = await query<{ task_id: string }>(
      `SELECT task_id::text AS task_id FROM cmms_wo_link WHERE connection_id = $1 AND external_id = $2`,
      [conn.id, ext],
    );
    if (link.rows[0]) {
      const n = await syncEcotrakNotes(client, conn.id, link.rows[0].task_id, ext);
      res.notesAdded += n.added;
      res.notesUpdated += n.updated;
    }
  }
  return { found: orders.map((o) => String(o.id)), result: res };
}

function emptyResult(): IngestResult {
  return {
    fetched: 0, created: 0, updated: 0, skippedHumanMoved: 0, unchanged: 0, accepted: 0, declined: 0,
    notesAdded: 0, notesUpdated: 0,
    unmappedStatus: [], unmappedTrade: [], errors: [], note: '',
  };
}

/** What the payload looked like last time, to leave an unchanged one alone. */
function fingerprint(wo: EcotrakWorkOrder): string {
  return createHash('sha256').update(JSON.stringify(wo)).digest('hex');
}

/** The task as it stands, for the audit rows a refresh writes. */
interface TaskNow {
  title: string | null;
  description: string | null;
  status_id: string | null;
  status_name: string | null;
  client: string | null;
  trade: string | null;
  city: string | null;
  state: string | null;
  nte: string | null;
  date_received: string | null;
  priority: string | null;
  site_id: string | null;
  asset_id: string | null;
  fields: Record<string, unknown> | null;
}

/** Same value? Numbers compare as numbers ('250.00' is 250), the rest as text. */
function same(a: unknown, b: unknown, numeric = false): boolean {
  if (numeric) return num(a) === num(b);
  return String(a ?? '') === String(b ?? '');
}

async function upsertOne(
  tx: Queryable,
  conn: ConnectionRow,
  wo: EcotrakWorkOrder,
  statusByName: Map<string, { id: string; name: string; status_group: string }>,
  res: IngestResult,
  createdIds: string[],
  actorId: string,
  settle: Settle,
): Promise<void> {
  const externalId = String(wo.id);
  const hash = fingerprint(wo);

  const existing = await tx.query<{
    task_id: string;
    last_seen_external_status: string | null;
    last_payload_hash: string | null;
    ecotrak_nte: string | null;
    ecotrak_nte_seen_at: string | null;
  }>(
    `SELECT task_id, last_seen_external_status, last_payload_hash,
            ecotrak_nte::text AS ecotrak_nte, ecotrak_nte_seen_at::text AS ecotrak_nte_seen_at
       FROM cmms_wo_link
      WHERE connection_id = $1 AND external_id = $2`,
    [conn.id, externalId],
  );

  // 0079 · the poll runs every minute and re-reads today and yesterday:
  // a work order nobody touched on Ecotrak since the last look is left alone
  // (no raw row, no write, no audit row).
  if (existing.rows[0]?.last_payload_hash === hash) {
    res.unchanged++;
    return;
  }

  // 1. Land the raw payload FIRST, verbatim and immutable.
  await tx.query(
    `INSERT INTO cmms_event_raw
       (connection_id, external_id, source, payload, external_status, external_updated_at, map_version)
     VALUES ($1, $2, 'poll', $3::jsonb, $4, $5, $6)`,
    [conn.id, externalId, JSON.stringify(wo), wo.status ?? null, wo.date_updated ?? null, MAP_VERSION],
  );

  // 2. Map. An unknown status is PARKED, never default-mapped.
  const rule = classifyInbound(wo.status);
  const internalName = INTERNAL_STATUS_BY_ECOTRAK[wo.status];
  if (!rule || !internalName) {
    if (!res.unmappedStatus.includes(wo.status)) res.unmappedStatus.push(wo.status);
    return;
  }
  const status = statusByName.get(internalName.toLowerCase());
  if (!status) {
    res.errors.push(`internal status "${internalName}" not found for ${wo.status}`);
    return;
  }

  const tradeRule = resolveTrade(wo.trade);
  if (!tradeRule && wo.trade && !res.unmappedTrade.includes(wo.trade)) {
    res.unmappedTrade.push(wo.trade);
  }

  // Site and asset are upserted BEFORE the task so both foreign keys are
  // available whether this is a create or a refresh. Both are keyed on Ecotrak's
  // stable ids, so re-running the poll cannot duplicate them.
  const siteId = await upsertSite(tx, wo);
  const assetId = await upsertAsset(tx, wo, siteId);

  const fields: Record<string, unknown> = {
    // Rule 2.6.1: the portal the work order came from (0033 field_def).
    'Client Portal Type': 'Ecotrak',
    'Ecotrak ID': externalId,
    'Ecotrak Status': wo.status,
    'Store': wo.location?.store_number ?? null,
    'Asset': wo.asset_type_name ?? null,
    'Category': wo.category_type ?? null,
    'Requested By': wo.requested_by ?? null,
    'PO': wo.purchase_order ?? null,
    'Subtrade': tradeRule?.sub ?? null,
    // When the work order was raised on Ecotrak's side, to the minute when
    // the feed says so (the bag's datetime shape, 'YYYY-MM-DDTHH:MM'). A
    // refresh keeps whatever is already stored — see the UPDATEs below.
    'Date Created': wo.date_created ? wo.date_created.replace(' ', 'T').slice(0, 16) : null,
  };
  // 0114 · the address, as the team writes it, and its parts (rule 11.1.1
  // asks for all four). Only what Ecotrak actually sends: a blank there never
  // empties what is on file here.
  const stateCode = stateAbbr(wo.location?.state) ?? (wo.location?.state?.trim() || null);
  const place: Record<string, unknown> = {
    '17. Address': ecotrakAddressLine(wo.location, stateCode),
    City: wo.location?.city?.trim() || null,
    State: stateCode,
    'Zip Code': normalizeZip(wo.location?.zip) ?? (wo.location?.zip?.trim() || null),
  };
  for (const [k, v] of Object.entries(place)) if (v) fields[k] = v;

  // 0119 · Ecotrak's NTE (the raised one when there is one). It goes into the
  // Client NTE FIELD, which `task.nte` mirrors — never the column alone.
  const ecoNte = num(wo.raised_not_to_exceed ?? wo.not_to_exceed);

  const common = [
    titleOf(wo),
    wo.description ?? null,
    status.id,
    status.status_group,
    wo.customer?.customer_name ?? null,
    tradeRule?.general ?? null,
    wo.location?.city ?? null,
    stateAbbr(wo.location?.state) ?? wo.location?.state ?? null,
    ecoNte,
    wo.date_created ? wo.date_created.slice(0, 10) : null,
    JSON.stringify(fields),
    mapPriority(wo.priority_type),
  ];

  if (existing.rows.length === 0) {
    // 3a. Create. wo_number is namespaced so an Ecotrak import can never
    //     collide with a ClickUp-seeded WO-#####.
    // 0119 · the new work order's Client NTE field holds Ecotrak's NTE too.
    if (ecoNte !== null) common[10] = JSON.stringify({ ...fields, [K_NTE]: ecoNte });
    const created = await tx.query<{ id: string }>(
      `INSERT INTO task
         (wo_number, ext_name, title, description, status_id, status_group,
          client, trade, city, state, nte, date_received, fields, priority,
          site_id, asset_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16)
       RETURNING id`,
      [`ECO-${externalId}`, externalId, ...common, siteId, assetId],
    );
    const taskId = created.rows[0].id;

    let sp: { fullPath: string } | null = null;
    try {
      sp = planFolder(wo, new Date().getUTCFullYear());
    } catch {
      // No customer name — the folder cannot be resolved. Not fatal to ingest.
    }

    await tx.query(
      `INSERT INTO cmms_wo_link
         (connection_id, external_id, task_id, last_seen_external_status, last_seen_at, sharepoint_path, last_payload_hash,
          ecotrak_nte, ecotrak_nte_seen_at)
       VALUES ($1, $2, $3, $4, now(), $5, $6, $7::numeric, now())`,
      [conn.id, externalId, taskId, wo.status, sp?.fullPath ?? null, hash, ecoNte],
    );
    // 0079 · the creation row every other path writes (source ecotrak).
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'created', NULL, NULL, $3::jsonb)`,
      [actorId, taskId, JSON.stringify({ wo_number: `ECO-${externalId}`, source: 'ecotrak', ecotrak_id: externalId, ecotrak_status: wo.status })],
    );
    await markProcessed(tx, conn.id, externalId);
    res.created++;
    // only a work order still waiting for us on Ecotrak goes to
    // Incoming Work Orders; one first seen already accepted (or rejected)
    // there has had its answer.
    if (ecotrakAcceptance(wo.status) === 'waiting') createdIds.push(taskId);
    settle.touched.push({ taskId, externalId });
    return;
  }

  // 3b. Refresh an existing record.
  const link = existing.rows[0];
  const taskId = link.task_id;

  const nowRow = await tx.query<TaskNow>(
    `SELECT t.title, t.description, t.status_id::text AS status_id, s.name AS status_name,
            t.client, t.trade, t.city, t.state, t.nte::text AS nte, t.date_received::text AS date_received,
            t.priority, t.site_id::text AS site_id, t.asset_id::text AS asset_id, t.fields
       FROM task t LEFT JOIN status s ON s.id = t.status_id
      WHERE t.id = $1
      FOR UPDATE OF t`,
    [taskId],
  );
  const before = nowRow.rows[0];

  // Shadow-mode guard: if the external status has not changed since we last saw
  // it, a human may have moved the WO on our side and a stale poll must not
  // drag it back. Descriptive fields still refresh; only status is withheld.
  const externalUnchanged = link.last_seen_external_status === wo.status;

  // 0079 · the bag is MERGED: Ecotrak's keys over what is on file, so every
  // key a person set (Assignee, FM, Comp, …) survives a refresh. Before 0079
  // the refresh replaced the whole bag with Ecotrak's ten keys.
  const mergedFields = (p: string) =>
    `COALESCE(fields, '{}'::jsonb) || ${p}::jsonb || jsonb_build_object('Date Created', COALESCE(fields->'Date Created', ${p}::jsonb->'Date Created'))`;
  // 0119 · neither UPDATE touches the NTE: it is written below, through the
  // field, and only when Ecotrak's own figure moved.
  if (externalUnchanged) {
    await tx.query(
      `UPDATE task SET title=$2, description=$3, client=$4, trade=$5, city=$6,
              state=$7, date_received=$8,
              fields=${mergedFields('$9')},
              priority=$10, site_id=$11, asset_id=$12
         WHERE id=$1`,
      [taskId, common[0], common[1], common[4], common[5], common[6],
       common[7], common[9], common[10], common[11], siteId, assetId],
    );
    res.skippedHumanMoved++;
  } else {
    await tx.query(
      `UPDATE task SET title=$2, description=$3, status_id=$4, status_group=$5,
              client=$6, trade=$7, city=$8, state=$9, date_received=$10,
              fields=${mergedFields('$11')},
              priority=$12, site_id=$13, asset_id=$14
         WHERE id=$1`,
      [taskId, common[0], common[1], common[2], common[3], common[4], common[5],
       common[6], common[7], common[9], common[10], common[11], siteId, assetId],
    );
    res.updated++;
    // Ecotrak's status moved: if that answers the acceptance, the
    // Incoming item is closed after this transaction commits.
    const answer = ecotrakAcceptance(wo.status);
    if (answer === 'accepted') settle.accepted.push(taskId);
    else if (answer === 'declined') settle.rejected.push(taskId);
  }

  // 0079 · every change Ecotrak made is an audit row, signed "Ecotrak sync"
  // and stamped via: 'ecotrak' (rule 1.2.1). It is also what tells the
  // ClickUp sync the work order moved.
  if (before) {
    const changes: TaskChange[] = [];
    const col = (field: string, b: unknown, a: unknown, numeric = false) => {
      if (!same(b, a, numeric)) changes.push({ field, before: b ?? null, after: a ?? null });
    };
    col('title', before.title, common[0]);
    col('description', before.description, common[1]);
    if (!externalUnchanged && before.status_id !== status.id) {
      changes.push({
        field: 'status_id',
        before: { status_id: before.status_id, status_name: before.status_name },
        after: { status_id: status.id, status_name: status.name, ecotrak_status: wo.status },
      });
    }
    col('client', before.client, common[4]);
    col('trade', before.trade, common[5]);
    col('city', before.city, common[6]);
    col('state', before.state, common[7]);
    col('date_received', before.date_received, common[9]);
    col('priority', before.priority, common[11]);
    col('site_id', before.site_id, siteId);
    col('asset_id', before.asset_id, assetId);
    const bagBefore = before.fields ?? {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'Date Created' && bagBefore[k] != null) continue; // kept, never overwritten
      col(`fields.${k}`, bagBefore[k], v);
    }

    // 0119 · the NTE follows Ecotrak when ECOTRAK's figure changed since the
    // last one it sent (not when it differs from ours: an NTE raised here
    // stands until Ecotrak's next moves — the last change wins). A work order
    // first seen after 0119 only records Ecotrak's figure; a blank there never
    // empties ours.
    const nteSeen = link.ecotrak_nte_seen_at !== null;
    if (nteSeen && ecoNte !== null && !same(link.ecotrak_nte, ecoNte, true)) {
      const ours = bagBefore[K_NTE] ?? before.nte ?? null;
      if (!same(ours, ecoNte, true)) {
        await tx.query(
          `UPDATE task SET fields = COALESCE(fields, '{}'::jsonb) || jsonb_build_object($2::text, $3::numeric),
                  nte = $3::numeric
            WHERE id = $1`,
          [taskId, K_NTE, ecoNte],
        );
        const change: TaskChange = { field: `fields.${K_NTE}`, before: ours, after: ecoNte };
        changes.push(change);
        settle.nte.push({ taskId, change });
      }
    }
    await logTaskChanges(tx, actorId, taskId, changes, 'ecotrak');
  }

  await tx.query(
    `UPDATE cmms_wo_link
        SET last_seen_external_status = $1, last_seen_at = now(), last_payload_hash = $4,
            ecotrak_nte = COALESCE($5::numeric, ecotrak_nte),
            ecotrak_nte_seen_at = COALESCE(ecotrak_nte_seen_at, now())
      WHERE connection_id = $2 AND external_id = $3`,
    [wo.status, conn.id, externalId, hash, ecoNte],
  );
  settle.touched.push({ taskId, externalId });

  await markProcessed(tx, conn.id, externalId);
}

/** Close out the raw rows for this work order. Both the create and the refresh
 *  path call it, so an unprocessed row always means a genuine failure. */
async function markProcessed(tx: Queryable, connectionId: string, externalId: string): Promise<void> {
  await tx.query(
    `UPDATE cmms_event_raw SET processed_at = now()
      WHERE connection_id = $1 AND external_id = $2 AND processed_at IS NULL`,
    [connectionId, externalId],
  );
}

/**
 * Upsert the site this work order happened at.
 *
 * Keyed on Ecotrak's `location.id`, which is stable — never on store number or
 * name, both of which are display strings that clients edit. Details refresh on
 * every sighting so a re-addressed store stays current.
 */
async function upsertSite(tx: Queryable, wo: EcotrakWorkOrder): Promise<string | null> {
  const loc = wo.location;
  const extId = loc?.id != null ? String(loc.id) : null;
  if (!extId) return null;

  const r = await tx.query<{ id: string }>(
    `INSERT INTO site (external_source, external_id, client, name, store_number,
                       address1, address2, city, state, zip)
     VALUES ('ecotrak', $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (external_source, external_id) DO UPDATE
        SET client = EXCLUDED.client, name = EXCLUDED.name,
            store_number = EXCLUDED.store_number, address1 = EXCLUDED.address1,
            address2 = EXCLUDED.address2, city = EXCLUDED.city,
            state = EXCLUDED.state, zip = EXCLUDED.zip
     RETURNING id`,
    [
      extId,
      wo.customer?.customer_name ?? null,
      loc?.name ?? null,
      loc?.store_number ?? null,
      loc?.address1 ?? null,
      loc?.address2 ?? null,
      loc?.city ?? null,
      loc?.state ?? null,
      loc?.zip ?? null,
    ],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * Upsert the asset the work order was raised against.
 *
 * `site_id` is set on first sight and NOT overwritten afterwards — the same
 * asset id appearing at a second location is a vendor data conflict, and
 * silently relocating equipment would destroy the service history that having
 * assets exists to build.
 */
async function upsertAsset(
  tx: Queryable,
  wo: EcotrakWorkOrder,
  siteId: string | null,
): Promise<string | null> {
  const a = wo.asset;
  const extId = a?.id != null ? String(a.id) : null;
  if (!extId) return null;

  const r = await tx.query<{ id: string }>(
    `INSERT INTO asset (external_source, external_id, site_id, name, asset_type,
                        model_number, description, alt_description)
     VALUES ('ecotrak', $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (external_source, external_id) DO UPDATE
        SET name = EXCLUDED.name, asset_type = EXCLUDED.asset_type,
            model_number = COALESCE(EXCLUDED.model_number, asset.model_number),
            description = COALESCE(EXCLUDED.description, asset.description),
            alt_description = COALESCE(EXCLUDED.alt_description, asset.alt_description),
            site_id = COALESCE(asset.site_id, EXCLUDED.site_id)
     RETURNING id`,
    [
      extId,
      siteId,
      (a?.name ?? '').trim() || 'Unnamed asset',
      wo.asset_type_name ?? null,
      (a?.model_number ?? '') || null,
      (a?.description ?? '') || null,
      (a?.alt_description ?? '') || null,
    ],
  );
  return r.rows[0]?.id ?? null;
}
