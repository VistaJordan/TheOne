// Principals service — the read side of the pre-auth actor surface (S4.1).
// Humans only: service accounts (Seed Bot, n8n Automation) are attribution
// identities, never something a person can "view as".

import { query } from '../db.js';
import { isDispatcherRole, type AssigneeAvailabilityResponse, type AvailabilityPerson, type PrincipalListItem } from '@theone/shared';
import { ASSIGNEE_SQL, OPEN_SQL } from './maintenance.js';

interface PrincipalRow {
  id: string;
  display_name: string;
  kind: 'human' | 'service';
  role: string | null;
}

/** Every human principal, ordered by name (GET /api/principals). */
export async function listPrincipals(): Promise<PrincipalListItem[]> {
  const res = await query<PrincipalRow>(
    `SELECT id, display_name, kind, role
       FROM principal
      WHERE kind = 'human'
      ORDER BY display_name ASC`,
  );
  return res.rows.map((p) => ({
    id: p.id,
    name: p.display_name,
    kind: p.kind,
    role: p.role,
  }));
}

// ── Who is free to take a work order ─────────────────────────────────────────
//
// GET /principals/availability?client=<name>. Everyone who could be picked,
// each with ALL their active work orders (every client — a light load on this
// account means nothing if they are drowning on another) split by status, and
// whether Admin › Users lists them on the named client. The two lists the
// picker shows (for this client / all dispatchers), the sort and the
// "everyone else" fold are the pure helpers in @theone/shared.
//
// "Active" and "assigned to" are the Assignment Manager's own definitions
// (OPEN_SQL / ASSIGNEE_SQL), which are the 0026 scope's: the count here is the
// length of that person's "Only theirs" list. Names are matched lower/trimmed
// because the bag stores display names, comma-joined when shared.

interface AvailabilityPersonRow {
  id: string;
  name: string;
  role: string | null;
  role_label: string | null;
  for_client: boolean;
}

interface AvailabilityLoadRow {
  who: string;
  status_name: string;
  status_group: string;
  color: string | null;
  n: number | string;
}

export async function assigneeAvailability(clientRaw: string | null | undefined): Promise<AssigneeAvailabilityResponse> {
  const client = (clientRaw ?? '').trim() || null;
  const [people, load] = await Promise.all([
    query<AvailabilityPersonRow>(
      `SELECT p.id::text AS id, p.display_name AS name, p.role, r.label AS role_label,
              ($1::text IS NOT NULL AND EXISTS (
                 SELECT 1
                   FROM principal_client pc
                   JOIN client c ON c.id = pc.client_id AND c.deleted_at IS NULL
                  WHERE pc.principal_id = p.id
                    AND lower(btrim(c.name)) = lower(btrim($1::text)))) AS for_client
         FROM principal p
         LEFT JOIN role r ON r.code = p.role
        WHERE p.kind = 'human' AND p.status <> 'disabled'
        ORDER BY lower(p.display_name)`,
      [client],
    ),
    query<AvailabilityLoadRow>(
      `SELECT lower(btrim(asg.n)) AS who, st.name AS status_name, st.status_group::text AS status_group,
              st.color, count(*)::int AS n
         FROM task t
         JOIN status st ON st.id = t.status_id,
              unnest(string_to_array(${ASSIGNEE_SQL}, ',')) AS asg(n)
        WHERE ${OPEN_SQL} AND btrim(asg.n) <> ''
        GROUP BY 1, 2, 3, 4, st.position
        ORDER BY 1, st.position, 2`,
    ),
  ]);

  const byWho = new Map<string, AvailabilityLoadRow[]>();
  for (const row of load.rows) {
    const list = byWho.get(row.who) ?? [];
    list.push(row);
    byWho.set(row.who, list);
  }

  const items: AvailabilityPerson[] = people.rows.map((p) => {
    const rows = byWho.get(p.name.trim().toLowerCase()) ?? [];
    const by_status = rows.map((r) => ({ name: r.status_name, group: r.status_group, color: r.color, n: Number(r.n) }));
    return {
      id: p.id,
      name: p.name,
      role: p.role,
      role_label: p.role_label,
      dispatcher: isDispatcherRole(p.role),
      for_client: Boolean(p.for_client),
      active: by_status.reduce((sum, s) => sum + s.n, 0),
      by_status,
    };
  });

  return { client, items };
}
