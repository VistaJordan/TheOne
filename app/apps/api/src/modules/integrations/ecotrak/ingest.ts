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

import { query, withTransaction, type Queryable } from '../../../db.js';
import { EcotrakClient, configFromEnv, type EcotrakWorkOrder } from './client.js';
import { classifyInbound } from './statusMap.js';
import { resolveTrade } from './tradeMap.js';
import { planFolder, stateAbbr } from './sharepointPath.js';

export const MAP_VERSION = '2026-08-19.1';

/**
 * Ecotrak status -> the internal status NAME on the seeded pipeline.
 *
 * PROPOSAL_REJECTED goes to done/incurred, not back to quoting: per plan §8.2
 * a rejected proposal is BFI (Bill For Incurred), so the job completes and
 * bills the incurred work.
 */
const INTERNAL_STATUS_BY_ECOTRAK: Record<string, string> = {
  PENDING_SP_ACCEPTANCE: 'Open',
  UNASSIGNED: 'Open',
  ACCEPTED: 'Open',
  REASSIGN: 'Open',
  SUBMITTING_PROPOSAL: 'waiting for quote',
  PROPOSAL_SUBMITTED: 'quote ready',
  // NOT "!! approved" — field-mapping.md in the legacy sync lists it with the
  // "!!" prefix, but the seeded pipeline has a bare "approved". The prefix is
  // real on "!! waiting for advice/approval", "!! ready to invoice" and
  // "!! canceled/postponed" only. Verified against the status table.
  PROPOSAL_APPROVED: 'approved',
  PROPOSAL_REJECTED: 'done/incurred',
  ENROUTE: 'job ongoing',
  ARRIVED: 'job ongoing',
  PENDING_PARTS: 'waiting for parts',
  RETURN_VISIT_REQUIRED: 'return trip needed',
  NOT_FIXED: '!! waiting for advice',
  SOFT_COMPLETED: 'done/incurred',
  COMPLETED: '!! ready to invoice',
  REJECTED: '!! canceled/postponed',
  CANCELLED: '!! canceled/postponed',
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
  unmappedStatus: string[];
  unmappedTrade: string[];
  errors: string[];
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

/**
 * Pull work orders updated since the last sync (or `sinceDays` back on a cold
 * start) and upsert them. Every payload is landed raw BEFORE mapping, so a
 * mapping bug is always replayable without re-fetching.
 */
export async function ingestEcotrak(opts: { sinceDays?: number } = {}): Promise<IngestResult> {
  const res: IngestResult = {
    fetched: 0, created: 0, updated: 0, skippedHumanMoved: 0,
    unmappedStatus: [], unmappedTrade: [], errors: [],
  };

  const conn = await getEcotrakConnection();
  if (!conn) {
    res.errors.push('no active ecotrak connection (run migration 0005)');
    return res;
  }

  const client = new EcotrakClient(configFromEnv(conn.credentials_ref));

  // An explicit sinceDays OVERRIDES the incremental cursor. Without this a
  // backfill is impossible once last_synced_at is set: the caller asks for 21
  // days and silently gets today only, which is how the first re-run after a
  // mapping fix missed the 19 records it was meant to repair.
  const since =
    typeof opts.sinceDays === 'number'
      ? new Date(Date.now() - opts.sinceDays * 86_400_000)
      : conn.last_synced_at
        ? new Date(conn.last_synced_at)
        : new Date(Date.now() - 21 * 86_400_000);

  const orders = await client.fetchUpdatedSince(since);
  res.fetched = orders.length;

  // Resolve status ids once — the pipeline is small and static.
  const statusRows = await query<{ id: string; name: string; status_group: string }>(
    `SELECT s.id, s.name, s.status_group FROM status s`,
  );
  const statusByName = new Map(statusRows.rows.map((s) => [s.name.toLowerCase(), s]));

  for (const wo of orders) {
    try {
      await withTransaction(async (tx) => {
        await upsertOne(tx, conn, wo, statusByName, res);
      });
    } catch (e) {
      res.errors.push(`WO ${wo.id}: ${(e as Error).message}`);
    }
  }

  await query(`UPDATE cmms_connection SET last_synced_at = now() WHERE id = $1`, [conn.id]);
  return res;
}

async function upsertOne(
  tx: Queryable,
  conn: ConnectionRow,
  wo: EcotrakWorkOrder,
  statusByName: Map<string, { id: string; name: string; status_group: string }>,
  res: IngestResult,
): Promise<void> {
  const externalId = String(wo.id);

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

  const existing = await tx.query<{ task_id: string; last_seen_external_status: string | null }>(
    `SELECT task_id, last_seen_external_status FROM cmms_wo_link
      WHERE connection_id = $1 AND external_id = $2`,
    [conn.id, externalId],
  );

  const fields = {
    'Ecotrak ID': externalId,
    'Ecotrak Status': wo.status,
    'Store': wo.location?.store_number ?? null,
    'Asset': wo.asset_type_name ?? null,
    'Category': wo.category_type ?? null,
    'Requested By': wo.requested_by ?? null,
    'PO': wo.purchase_order ?? null,
    'Subtrade': tradeRule?.sub ?? null,
  };

  const common = [
    titleOf(wo),
    wo.description ?? null,
    status.id,
    status.status_group,
    wo.customer?.customer_name ?? null,
    tradeRule?.general ?? null,
    wo.location?.city ?? null,
    stateAbbr(wo.location?.state) ?? wo.location?.state ?? null,
    num(wo.raised_not_to_exceed ?? wo.not_to_exceed),
    wo.date_created ? wo.date_created.slice(0, 10) : null,
    JSON.stringify(fields),
    mapPriority(wo.priority_type),
  ];

  if (existing.rows.length === 0) {
    // 3a. Create. wo_number is namespaced so an Ecotrak import can never
    //     collide with a ClickUp-seeded WO-#####.
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
         (connection_id, external_id, task_id, last_seen_external_status, last_seen_at, sharepoint_path)
       VALUES ($1, $2, $3, $4, now(), $5)`,
      [conn.id, externalId, taskId, wo.status, sp?.fullPath ?? null],
    );
    await markProcessed(tx, conn.id, externalId);
    res.created++;
    return;
  }

  // 3b. Refresh an existing record.
  const link = existing.rows[0];
  const taskId = link.task_id;

  // Shadow-mode guard: if the external status has not changed since we last saw
  // it, a human may have moved the WO on our side and a stale poll must not
  // drag it back. Descriptive fields still refresh; only status is withheld.
  const externalUnchanged = link.last_seen_external_status === wo.status;

  if (externalUnchanged) {
    await tx.query(
      `UPDATE task SET title=$2, description=$3, client=$4, trade=$5, city=$6,
              state=$7, nte=$8, date_received=$9, fields=$10::jsonb, priority=$11,
              site_id=$12, asset_id=$13
         WHERE id=$1`,
      [taskId, common[0], common[1], common[4], common[5], common[6],
       common[7], common[8], common[9], common[10], common[11], siteId, assetId],
    );
    res.skippedHumanMoved++;
  } else {
    await tx.query(
      `UPDATE task SET title=$2, description=$3, status_id=$4, status_group=$5,
              client=$6, trade=$7, city=$8, state=$9, nte=$10, date_received=$11,
              fields=$12::jsonb, priority=$13, site_id=$14, asset_id=$15
         WHERE id=$1`,
      [taskId, ...common, siteId, assetId],
    );
    res.updated++;
  }

  await tx.query(
    `UPDATE cmms_wo_link
        SET last_seen_external_status = $1, last_seen_at = now()
      WHERE connection_id = $2 AND external_id = $3`,
    [wo.status, conn.id, externalId],
  );

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
