// Which work orders the acting principal may see at all (0026 · rule 8.5).
//
// The permission tree answers field by field; this is the ROW answer on top
// of it: `resolveWoScope` in @theone/shared turns the person's grants into
// "everything" or "assigned to them + these billing entities", and this file
// turns that into SQL every list-shaped read appends to its WHERE. One
// predicate, built once here, so the list, the export, the inbox, the queues,
// the dashboard and the per-work-order routes can never disagree about what a
// dispatcher is allowed to open.
//
// "Assigned to them" matches the bag's `Assignee` (a comma-joined list of
// display names — that is what the field stores, see woFields
// customDistinctOptions) against the acting principal's display name, with
// the legacy free-text `Assignee Name TXT` as the backstop the header uses.
//
// 0072 · "their clients" is the third OR: every work order whose Client is
// one of the clients assigned to the person in Admin › Users
// (principal_client), matched by name the way client records are (0062:
// lower + btrim, no FK). It is how the sales team's dashboard knows what to
// count, and it widens a dispatcher's book the same way an entity tick does.

import { resolveWoScope, type WoScope } from '@theone/shared';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { Params } from './woFields.js';
import type { ActingPrincipal } from './activity.js';

export function woScopeOf(actor: ActingPrincipal): WoScope {
  return resolveWoScope(actor.perms, actor.isSuperAdmin);
}

/**
 * The predicate over the task alias (`t` by default), or null when the actor
 * sees everything — callers skip the AND in that case so the unrestricted
 * query stays exactly what it was.
 */
export function woScopeSql(actor: ActingPrincipal, p: Params, alias = 't'): string | null {
  const scope = woScopeOf(actor);
  // 0062 · a person restricted to a list of sites sees only the work orders
  // AT those sites — on top of (AND) whatever the role scope says. A work
  // order with no site is at none of them.
  const sites =
    actor.siteRestricted && !actor.isSuperAdmin
      ? `${alias}.site_id IN (SELECT ps.site_id FROM principal_site ps WHERE ps.principal_id = ${p.add(actor.id)})`
      : null;
  if (scope.all) return sites;
  const name = p.add(actor.name);
  const parts = [
    `EXISTS (
       SELECT 1
         FROM unnest(string_to_array(
                COALESCE(NULLIF(${alias}.fields->>'Assignee', ''), ${alias}.fields->>'Assignee Name TXT', ''),
                ',')) AS asg(n)
        WHERE lower(btrim(asg.n)) = lower(btrim(${name})))`,
  ];
  if (scope.entities.length > 0) {
    parts.push(`${alias}.billing_entity IN (${scope.entities.map((e) => p.add(e)).join(', ')})`);
  }
  if (actor.hasClients) {
    parts.push(
      `lower(btrim(COALESCE(${alias}.client, ''))) IN (
         SELECT lower(btrim(c.name))
           FROM principal_client pc
           JOIN client c ON c.id = pc.client_id AND c.deleted_at IS NULL
          WHERE pc.principal_id = ${p.add(actor.id)})`,
    );
  }
  const mine = `(${parts.join(' OR ')})`;
  return sites ? `(${mine} AND ${sites})` : mine;
}

/** The 403 a scoped person gets for a work order that exists but is not theirs. */
export function outOfScope(): ApiError {
  return new ApiError('FORBIDDEN', 'This work order is not assigned to you', {
    required_permission: 'work_orders/scope:view',
  });
}

/** Bulk edit / delete: every selected id must be inside the scope, or nothing
    happens — a selection that mixes theirs and not-theirs is a mistake, not a
    request to do half of it. */
export async function assertIdsInScope(actor: ActingPrincipal, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const p = new Params();
  const scope = woScopeSql(actor, p);
  if (!scope) return;
  const holes = ids.map((id) => p.add(id)).join(', ');
  const res = await query<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM task t WHERE t.id IN (${holes}) AND NOT ${scope}`,
    p.values,
  );
  if (Number(res.rows[0]?.n ?? 0) > 0) {
    throw new ApiError('FORBIDDEN', 'Some of the selected work orders are not assigned to you', {
      required_permission: 'work_orders/scope:view',
    });
  }
}
