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

import { CICO_PORTAL_METHOD, CLIENTS_PERM_KEY, VISIT_METHODS, permAllows, pickClientTeam } from '@theone/shared';
import type { ClientCicoInput, ClientCicoMethod, ClientCicoResponse } from '@theone/shared';
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
