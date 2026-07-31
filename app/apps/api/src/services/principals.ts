// Principals service — the read side of the pre-auth actor surface (S4.1).
// Humans only: service accounts (Seed Bot, n8n Automation) are attribution
// identities, never something a person can "view as".

import { query } from '../db.js';
import type { PrincipalListItem } from '@theone/shared';

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
