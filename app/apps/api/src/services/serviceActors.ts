// Service principals — the "who" on audit rows a machine writes.
//
// The rules engine has its own ('Automations', automations.ts); this is the
// same idea for the other machines: the Ecotrak sync raising an acceptance
// task (0036, rule 7.1.1) must not sign the row as a person, and must not
// sign it as the rules engine either — the trail has to say which system
// acted. Resolved lazily and re-created if missing: seed.ts truncates
// principal, and a sync that dies after every re-seed would be a support
// ticket.

import { query } from '../db.js';

const cache = new Map<string, string>();

export async function serviceActorId(displayName: string, initials: string): Promise<string> {
  const cached = cache.get(displayName);
  if (cached) {
    const still = await query<{ id: string }>(`SELECT id FROM principal WHERE id = $1`, [cached]);
    if (still.rows[0]) return cached;
    cache.delete(displayName);
  }
  const found = await query<{ id: string }>(
    `SELECT id FROM principal WHERE kind = 'service' AND display_name = $1 LIMIT 1`,
    [displayName],
  );
  if (found.rows[0]) {
    cache.set(displayName, found.rows[0].id);
    return found.rows[0].id;
  }
  const made = await query<{ id: string }>(
    `INSERT INTO principal (kind, display_name, role, initials)
     VALUES ('service', $1, 'service', $2) RETURNING id`,
    [displayName, initials],
  );
  cache.set(displayName, made.rows[0].id);
  return made.rows[0].id;
}

/** The Ecotrak inbound sync, when it creates a work order. */
export function ecotrakSyncActorId(): Promise<string> {
  return serviceActorId('Ecotrak sync', 'ES');
}
