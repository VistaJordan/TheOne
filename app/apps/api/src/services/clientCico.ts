// 0100 · The check-in method per client and billing entity — one row per
// (client, Comp), edited on Clients › a client › Check-in method, loaded from
// the operation's "CICO methods" sheet by the migration. A new visit reads
// the row for its work order's Client + Comp (`cicoForClient`, called by
// methodForTask in visits.ts) before the FM table. Vocabulary:
// packages/shared/src/clientCico.ts.
//
// Logged on the client's own history (entity `client`) as
// `client_cico_added | client_cico_updated | client_cico_removed`, with the
// whole row before / after — the Account team's pattern.

import { CICO_PORTAL_METHOD, CLIENTS_PERM_KEY, PORTAL_TYPE_KEY, VISIT_METHODS, permAllows, pickClientTeam, portalTypeFromCico } from '@theone/shared';
import type { ClientCicoInput, ClientCicoMethod, ClientCicoResponse, ClientPortalTypeForForm } from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { requirePerm } from './permissions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = new Set<string>(VISIT_METHODS);
const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
};

type Row = Omit<ClientCicoMethod, 'updated_at'> & { updated_at: Date };
const COLS = `id::text AS id, billing_entity, method, portal, detail, email, updated_at`;
const mapRow = (r: Row): ClientCicoMethod => ({ ...r, updated_at: r.updated_at.toISOString() });
const snap = (m: ClientCicoMethod) => ({
  billing_entity: m.billing_entity,
  method: m.method,
  portal: m.portal,
  detail: m.detail,
  email: m.email,
});

/** The Comp values a row may be filed under: the field's own options. */
async function billingEntities(): Promise<string[]> {
  const r = await query<{ options: unknown }>(
    `SELECT type_config->'options' AS options FROM field_def WHERE key = '21. Comp' ORDER BY position NULLS LAST LIMIT 1`,
  );
  const opts = r.rows[0]?.options;
  return Array.isArray(opts) ? opts.map((o) => String(typeof o === 'string' ? o : (o as { name?: string })?.name ?? '')).filter(Boolean) : [];
}

async function clientName(id: string): Promise<string> {
  if (!UUID_RE.test(id)) throw notFound('Client not found');
  const r = await query<{ name: string }>(`SELECT name FROM client WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!r.rows[0]) throw notFound('Client not found');
  return r.rows[0].name;
}

export async function listClientCico(clientId: string, actor: ActingPrincipal): Promise<ClientCicoResponse> {
  requirePerm(actor, CLIENTS_PERM_KEY, 'view', 'You cannot open Clients');
  await clientName(clientId);
  const [rows, entities] = await Promise.all([
    query<Row>(`SELECT ${COLS} FROM client_cico_method WHERE client_id = $1 ORDER BY upper(billing_entity)`, [clientId]),
    billingEntities(),
  ]);
  return {
    items: rows.rows.map(mapRow),
    billing_entities: entities,
    can_edit: permAllows(actor.perms, CLIENTS_PERM_KEY, 'edit', actor.isSuperAdmin),
  };
}

function cleanInput(input: ClientCicoInput): Required<ClientCicoInput> {
  const entity = clean(input.billing_entity)?.toUpperCase() ?? null;
  if (!entity) throw badRequest('Pick the company (Comp) this check-in method is for', { field: 'billing_entity' });
  const method = clean(input.method);
  if (!method || !METHODS.has(method)) {
    throw badRequest(`Method must be one of ${[...METHODS].join(', ')}`, { field: 'method' });
  }
  return {
    billing_entity: entity,
    method,
    // 0098 · a portal is kept only beside the Portal method.
    portal: method === CICO_PORTAL_METHOD ? clean(input.portal) : null,
    detail: clean(input.detail),
    email: clean(input.email)?.toLowerCase() ?? null,
  };
}

/** Adds a row, or replaces the one with `rowId`. One row per Comp. */
export async function saveClientCico(
  clientId: string,
  rowId: string | null,
  input: ClientCicoInput,
  actor: ActingPrincipal,
): Promise<ClientCicoResponse> {
  requirePerm(actor, CLIENTS_PERM_KEY, 'edit', 'You cannot edit clients');
  const name = await clientName(clientId);
  const v = cleanInput(input);
  if (rowId !== null && !UUID_RE.test(rowId)) throw notFound('Check-in method not found');
  const { before, after } = await withTransaction(async (tx) => {
    const clash = await tx.query<{ id: string }>(
      `SELECT id::text AS id FROM client_cico_method
        WHERE client_id = $1 AND upper(btrim(billing_entity)) = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [clientId, v.billing_entity, rowId],
    );
    if (clash.rows[0]) throw conflict(`${name} already has a check-in method under ${v.billing_entity}. Edit that one instead.`, { field: 'billing_entity' });
    if (rowId) {
      const cur = await tx.query<Row>(
        `SELECT ${COLS} FROM client_cico_method WHERE id = $1 AND client_id = $2 FOR UPDATE`,
        [rowId, clientId],
      );
      if (!cur.rows[0]) throw notFound('Check-in method not found');
      const r = await tx.query<Row>(
        `UPDATE client_cico_method
            SET billing_entity = $2, method = $3, portal = $4, detail = $5, email = $6, updated_at = now(), updated_by = $7
          WHERE id = $1 RETURNING ${COLS}`,
        [rowId, v.billing_entity, v.method, v.portal, v.detail, v.email, actor.id],
      );
      return { before: mapRow(cur.rows[0]), after: mapRow(r.rows[0]) };
    }
    const r = await tx.query<Row>(
      `INSERT INTO client_cico_method (client_id, billing_entity, method, portal, detail, email, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
      [clientId, v.billing_entity, v.method, v.portal, v.detail, v.email, actor.id],
    );
    return { before: null as ClientCicoMethod | null, after: mapRow(r.rows[0]) };
  });
  if (!before || JSON.stringify(snap(before)) !== JSON.stringify(snap(after))) {
    await logAdminEvent({
      actorId: actor.id,
      entity: 'client',
      entityId: clientId,
      action: before ? 'client_cico_updated' : 'client_cico_added',
      field: `cico:${after.id}`,
      before: before ? { name, ...snap(before) } : null,
      after: { name, ...snap(after) },
    });
  }
  return listClientCico(clientId, actor);
}

export async function deleteClientCico(clientId: string, rowId: string, actor: ActingPrincipal): Promise<ClientCicoResponse> {
  requirePerm(actor, CLIENTS_PERM_KEY, 'edit', 'You cannot edit clients');
  const name = await clientName(clientId);
  if (!UUID_RE.test(rowId)) throw notFound('Check-in method not found');
  const r = await query<Row>(
    `DELETE FROM client_cico_method WHERE id = $1 AND client_id = $2 RETURNING ${COLS}`,
    [rowId, clientId],
  );
  if (!r.rows[0]) throw notFound('Check-in method not found');
  await logAdminEvent({
    actorId: actor.id,
    entity: 'client',
    entityId: clientId,
    action: 'client_cico_removed',
    field: `cico:${rowId}`,
    before: { name, ...snap(mapRow(r.rows[0])) },
  });
  return listClientCico(clientId, actor);
}

/**
 * The row for a work order's Client + Comp — the client's single row when the
 * Comp is blank (`pickClientTeam`'s rule). Decoration-grade like the account
 * team's read: a database 0100 has not reached (42P01) answers null, so the
 * visit falls back to the FM table instead of failing.
 */
export async function cicoForClient(
  client: string | null,
  comp: string | null,
): Promise<(ClientCicoMethod & { client: string }) | null> {
  if (!client || !client.trim()) return null;
  try {
    const r = await query<Row & { client: string }>(
      `SELECT c.name AS client, m.id::text AS id, m.billing_entity, m.method, m.portal, m.detail, m.email, m.updated_at
         FROM client_cico_method m JOIN client c ON c.id = m.client_id
        WHERE c.deleted_at IS NULL AND lower(btrim(c.name)) = lower(btrim($1))`,
      [client],
    );
    const hit = pickClientTeam(r.rows, client, comp);
    return hit ? { ...mapRow(hit), client: hit.client } : null;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code !== '42P01') throw e;
    return null;
  }
}

// ── Client Portal Type follows the client (Elise, 2026-10-30) ─────────────────
// `portalTypeFromCico` (shared) is the rule; these read the rows and the
// dropdown's options. Decoration-grade like `cicoForClient`: a failure fills
// nothing and never takes the save down.

const blankValue = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

async function portalTypeOptions(): Promise<string[]> {
  const r = await query<{ options: unknown }>(
    `SELECT type_config->'options' AS options FROM field_def WHERE key = $1 AND type = 'dropdown' ORDER BY position NULLS LAST LIMIT 1`,
    [PORTAL_TYPE_KEY],
  );
  const opts = r.rows[0]?.options;
  return Array.isArray(opts) ? opts.map((o) => String(typeof o === 'string' ? o : (o as { name?: string })?.name ?? '').trim()).filter(Boolean) : [];
}

type PortalRow = { client: string; billing_entity: string; method: string; portal: string | null; detail: string | null };

async function cicoRows(): Promise<PortalRow[]> {
  const r = await query<PortalRow>(
    `SELECT c.name AS client, m.billing_entity, m.method, m.portal, m.detail
       FROM client_cico_method m JOIN client c ON c.id = m.client_id
      WHERE c.deleted_at IS NULL
      ORDER BY lower(c.name), upper(m.billing_entity)`,
  );
  return r.rows;
}

/** Every client + Comp whose check-in row names a Client Portal Type option —
    the Add work order form fills the field from it. */
export async function portalTypesForForm(): Promise<ClientPortalTypeForForm[]> {
  try {
    const [rows, options] = await Promise.all([cicoRows(), portalTypeOptions()]);
    const out: ClientPortalTypeForForm[] = [];
    for (const r of rows) {
      const portal_type = portalTypeFromCico(r, options);
      if (portal_type) out.push({ client: r.client, billing_entity: r.billing_entity, portal_type });
    }
    return out;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('client portal types unavailable', { code: err.code, message: err.message });
    return [];
  }
}

function portalTypeIn(rows: PortalRow[], options: string[], client: unknown, comp: unknown): string | null {
  return portalTypeFromCico(pickClientTeam(rows, text(client), text(comp)), options);
}

/** `createWorkOrder`'s half: an empty Client Portal Type takes the client's. */
export async function fillPortalType(bag: Record<string, unknown>): Promise<void> {
  if (!blankValue(bag[PORTAL_TYPE_KEY]) || !text(bag['Client'])) return;
  try {
    const [rows, options] = await Promise.all([cicoRows(), portalTypeOptions()]);
    const v = portalTypeIn(rows, options, bag['Client'], bag['21. Comp']);
    if (v) bag[PORTAL_TYPE_KEY] = v;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('client portal type fill skipped', { code: err.code, message: err.message });
  }
}

/**
 * `updateWorkOrderFields`' half: a save that changed the Client or the Comp
 * moves Client Portal Type with it while it is empty or still holds what the
 * OLD client / Comp implied (a value picked by hand stays, as the account
 * team's seats do); one the same save set is left alone. Changes `bag` in
 * place and returns the change for the audit trail, or null.
 */
export async function refillPortalTypeOnEdit(
  before: { client: unknown; comp: unknown },
  bag: Record<string, unknown>,
  explicit: ReadonlySet<string>,
): Promise<{ before: unknown; after: string | null } | null> {
  if (explicit.has(PORTAL_TYPE_KEY)) return null;
  try {
    const [rows, options] = await Promise.all([cicoRows(), portalTypeOptions()]);
    const was = portalTypeIn(rows, options, before.client, before.comp);
    const now = portalTypeIn(rows, options, bag['Client'], bag['21. Comp']);
    const cur = bag[PORTAL_TYPE_KEY];
    const held = text(cur);
    if (held !== null && held !== was) return null;
    if (held === now) return null;
    if (now === null) delete bag[PORTAL_TYPE_KEY];
    else bag[PORTAL_TYPE_KEY] = now;
    return { before: cur ?? null, after: now };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('client portal type refill skipped', { code: err.code, message: err.message });
    return null;
  }
}
