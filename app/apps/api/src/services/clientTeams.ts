// 0096 · The account team per client and billing entity: Team Lead,
// Assistant Team Lead, salesperson, Account Manager — one row per (client,
// Comp), edited on Clients › a client › Account team. "Add work order" reads
// every team (`teamsForForm`) and fills AM / TL / ATL from the one matching
// its Client and Comp; `createWorkOrder` fills the same three again when the
// form left them empty (`fillFromClientTeam`). Vocabulary and the name
// matching: packages/shared/src/clientTeams.ts.
//
// Logged on the client's own history (entity `client`) as
// `client_team_added | client_team_updated | client_team_removed`, with the
// whole row before / after.

import {
  CLIENTS_PERM_KEY,
  clientTeamValues,
  permAllows,
  pickClientTeam,
} from '@theone/shared';
import type { ClientTeam, ClientTeamForForm, ClientTeamInput, ClientTeamsResponse } from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { requirePerm } from './permissions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
};

type TeamRow = { id: string; billing_entity: string; tl: string | null; atl: string | null; sales: string | null; am: string | null; updated_at: Date };
const mapTeam = (r: TeamRow): ClientTeam => ({
  id: r.id,
  billing_entity: r.billing_entity,
  tl: r.tl,
  atl: r.atl,
  sales: r.sales,
  am: r.am,
  updated_at: r.updated_at.toISOString(),
});
const snap = (t: ClientTeam) => ({ billing_entity: t.billing_entity, tl: t.tl, atl: t.atl, sales: t.sales, am: t.am });

/** The Comp values a team may be filed under: the field's own options. */
async function billingEntities(): Promise<string[]> {
  const r = await query<{ options: unknown }>(
    `SELECT type_config->'options' AS options FROM field_def WHERE key = '21. Comp' ORDER BY position NULLS LAST LIMIT 1`,
  );
  const opts = r.rows[0]?.options;
  return Array.isArray(opts) ? opts.map((o) => String(typeof o === 'string' ? o : (o as { name?: string })?.name ?? '')).filter(Boolean) : [];
}

/** Active people's display names — what a team name is matched against. */
export async function activePeopleNames(): Promise<string[]> {
  const r = await query<{ name: string }>(
    `SELECT display_name AS name FROM principal WHERE kind = 'human' AND status <> 'disabled' ORDER BY lower(display_name)`,
  );
  return r.rows.map((x) => x.name);
}

async function clientName(id: string): Promise<string> {
  if (!UUID_RE.test(id)) throw notFound('Client not found');
  const r = await query<{ name: string }>(`SELECT name FROM client WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!r.rows[0]) throw notFound('Client not found');
  return r.rows[0].name;
}

async function loadTeams(clientId: string): Promise<ClientTeam[]> {
  const r = await query<TeamRow>(
    `SELECT id::text AS id, billing_entity, tl, atl, sales, am, updated_at
       FROM client_team WHERE client_id = $1 ORDER BY upper(billing_entity)`,
    [clientId],
  );
  return r.rows.map(mapTeam);
}

export async function listClientTeams(clientId: string, actor: ActingPrincipal): Promise<ClientTeamsResponse> {
  requirePerm(actor, CLIENTS_PERM_KEY, 'view', 'You cannot open Clients');
  await clientName(clientId);
  const [teams, entities, people] = await Promise.all([loadTeams(clientId), billingEntities(), activePeopleNames()]);
  return {
    teams,
    billing_entities: entities,
    people,
    can_edit: permAllows(actor.perms, CLIENTS_PERM_KEY, 'edit', actor.isSuperAdmin),
  };
}

function cleanInput(input: ClientTeamInput): Required<ClientTeamInput> {
  const entity = clean(input.billing_entity)?.toUpperCase() ?? null;
  if (!entity) throw badRequest('Pick the company (Comp) this team works under', { field: 'billing_entity' });
  return { billing_entity: entity, tl: clean(input.tl), atl: clean(input.atl), sales: clean(input.sales), am: clean(input.am) };
}

/** Adds a team, or replaces the one with `teamId`. One team per Comp. */
export async function saveClientTeam(
  clientId: string,
  teamId: string | null,
  input: ClientTeamInput,
  actor: ActingPrincipal,
): Promise<ClientTeamsResponse> {
  requirePerm(actor, CLIENTS_PERM_KEY, 'edit', 'You cannot edit clients');
  const name = await clientName(clientId);
  const v = cleanInput(input);
  if (teamId !== null && !UUID_RE.test(teamId)) throw notFound('Team not found');
  const { before, after } = await withTransaction(async (tx) => {
    const clash = await tx.query<{ id: string }>(
      `SELECT id::text AS id FROM client_team WHERE client_id = $1 AND upper(btrim(billing_entity)) = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [clientId, v.billing_entity, teamId],
    );
    if (clash.rows[0]) throw conflict(`${name} already has a team under ${v.billing_entity}. Edit that one instead.`, { field: 'billing_entity' });
    let prev: ClientTeam | null = null;
    if (teamId) {
      const cur = await tx.query<TeamRow>(
        `SELECT id::text AS id, billing_entity, tl, atl, sales, am, updated_at FROM client_team WHERE id = $1 AND client_id = $2 FOR UPDATE`,
        [teamId, clientId],
      );
      if (!cur.rows[0]) throw notFound('Team not found');
      prev = mapTeam(cur.rows[0]);
      const r = await tx.query<TeamRow>(
        `UPDATE client_team SET billing_entity = $2, tl = $3, atl = $4, sales = $5, am = $6, updated_at = now(), updated_by = $7
          WHERE id = $1 RETURNING id::text AS id, billing_entity, tl, atl, sales, am, updated_at`,
        [teamId, v.billing_entity, v.tl, v.atl, v.sales, v.am, actor.id],
      );
      return { before: prev, after: mapTeam(r.rows[0]) };
    }
    const r = await tx.query<TeamRow>(
      `INSERT INTO client_team (client_id, billing_entity, tl, atl, sales, am, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id, billing_entity, tl, atl, sales, am, updated_at`,
      [clientId, v.billing_entity, v.tl, v.atl, v.sales, v.am, actor.id],
    );
    return { before: prev, after: mapTeam(r.rows[0]) };
  });
  const changed = !before || JSON.stringify(snap(before)) !== JSON.stringify(snap(after));
  if (changed) {
    await logAdminEvent({
      actorId: actor.id,
      entity: 'client',
      entityId: clientId,
      action: before ? 'client_team_updated' : 'client_team_added',
      field: `team:${after.id}`,
      before: before ? { name, ...snap(before) } : null,
      after: { name, ...snap(after) },
    });
  }
  return listClientTeams(clientId, actor);
}

export async function deleteClientTeam(clientId: string, teamId: string, actor: ActingPrincipal): Promise<ClientTeamsResponse> {
  requirePerm(actor, CLIENTS_PERM_KEY, 'edit', 'You cannot edit clients');
  const name = await clientName(clientId);
  if (!UUID_RE.test(teamId)) throw notFound('Team not found');
  const r = await query<TeamRow>(
    `DELETE FROM client_team WHERE id = $1 AND client_id = $2 RETURNING id::text AS id, billing_entity, tl, atl, sales, am, updated_at`,
    [teamId, clientId],
  );
  if (!r.rows[0]) throw notFound('Team not found');
  await logAdminEvent({
    actorId: actor.id,
    entity: 'client',
    entityId: clientId,
    action: 'client_team_removed',
    field: `team:${teamId}`,
    before: { name, ...snap(mapTeam(r.rows[0])) },
  });
  return listClientTeams(clientId, actor);
}

/** Every active client's teams, for the create form (names as stored).
 *  Decoration-grade: the form must open even when the teams cannot be read
 *  (a database 0096 has not reached yet answers 42P01), so a failure is
 *  logged and reads as "no teams" — never as a form with no fields. */
export async function teamsForForm(): Promise<ClientTeamForForm[]> {
  try {
    const r = await query<ClientTeamForForm>(
      `SELECT c.name AS client, t.billing_entity, t.tl, t.atl, t.sales, t.am
         FROM client_team t JOIN client c ON c.id = t.client_id
        WHERE c.deleted_at IS NULL AND c.is_active
        ORDER BY lower(c.name), upper(t.billing_entity)`,
    );
    return r.rows;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('client teams unavailable', { code: err.code, message: err.message });
    return [];
  }
}

/**
 * `createWorkOrder`'s half: AM, TL and ATL the form left empty are filled
 * from the client's team for the Comp (or its only team), when the name on
 * the team resolves to one active person. A value the bag already holds is
 * never touched.
 */
export async function fillFromClientTeam(bag: Record<string, unknown>): Promise<void> {
  const client = typeof bag['Client'] === 'string' ? bag['Client'] : null;
  if (!client) return;
  const comp = typeof bag['21. Comp'] === 'string' ? bag['21. Comp'] : null;
  const [teams, people] = await Promise.all([teamsForForm(), activePeopleNames()]);
  const team = pickClientTeam(teams, client, comp);
  if (!team) return;
  const { values } = clientTeamValues(team, people);
  for (const [k, v] of Object.entries(values)) {
    const cur = bag[k];
    if (cur === undefined || cur === null || (typeof cur === 'string' && cur.trim() === '')) bag[k] = v;
  }
}
