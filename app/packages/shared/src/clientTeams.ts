/**
 * The account team per client and billing entity (migration 0096, Elise,
 * 2026-10-27).
 *
 * Who looks after a client depends on which of our companies bills the work:
 * PH has one team under BKR, another under AF, TPM and RF. So a team is a row
 * per (client, Comp): the Team Lead, the Assistant Team Lead, the salesperson
 * and the Account Manager. It is kept on the client record (Clients › a
 * client › Account team) so it can always be adjusted, and "Add work order"
 * fills AM, TL and ATL from it once the Client and the Comp are picked. The
 * dispatcher is never filled: it is always picked by hand.
 *
 * The names are stored as typed ("Josh", "Fady", "House") — the team sheet
 * uses first names. `resolvePersonName` turns one into an account's display
 * name when exactly one active person answers to it; a name nobody answers to
 * is shown on the form and left out of the work order, never guessed.
 */

/** The bag keys the team fills on a new work order, and where each comes from. */
export const CLIENT_TEAM_FIELDS: readonly { key: string; from: 'am' | 'tl' | 'atl' }[] = [
  { key: 'AM', from: 'am' },
  { key: 'TL', from: 'tl' },
  { key: 'ATL', from: 'atl' },
];

/** The salesperson column's "nobody in particular". */
export const CLIENT_TEAM_HOUSE = 'House';

export interface ClientTeam {
  id: string;
  /** The billing entity, a `21. Comp` value (SFM, BKR, AF, TPM, RF, EDS). */
  billing_entity: string;
  tl: string | null;
  atl: string | null;
  sales: string | null;
  am: string | null;
  updated_at: string;
}

/** One team as the create form reads it: which client it belongs to. */
export interface ClientTeamForForm extends Omit<ClientTeam, 'id' | 'updated_at'> {
  client: string;
}

export interface ClientTeamInput {
  billing_entity: string;
  tl?: string | null;
  atl?: string | null;
  sales?: string | null;
  am?: string | null;
}

export interface ClientTeamsResponse {
  teams: ClientTeam[];
  /** The Comp values a team may be filed under. */
  billing_entities: string[];
  /** Active people's display names, for the pickers. */
  people: string[];
  can_edit: boolean;
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The team for a client under a Comp. With no Comp picked yet, a client that
 * has exactly one team uses it; one with several waits for the Comp.
 */
export function pickClientTeam<T extends { client?: string; billing_entity: string }>(
  teams: readonly T[],
  client: string | null | undefined,
  comp: string | null | undefined,
): T | null {
  const c = norm(client);
  if (c === '') return null;
  const mine = teams.filter((t) => t.client === undefined || norm(t.client) === c);
  const e = norm(comp);
  if (e !== '') return mine.find((t) => norm(t.billing_entity) === e) ?? null;
  return mine.length === 1 ? mine[0] : null;
}

/**
 * The account a team name stands for: an exact display name (any case), else
 * the one person whose first name it is (or whose name starts with it). Null
 * when nobody, or more than one person, answers to it — and for "House".
 */
export function resolvePersonName(raw: string | null | undefined, names: readonly string[]): string | null {
  const want = norm(raw);
  if (want === '' || want === norm(CLIENT_TEAM_HOUSE)) return null;
  const exact = names.filter((n) => norm(n) === want);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const first = names.filter((n) => norm(n).split(' ')[0] === want);
  if (first.length === 1) return first[0];
  if (first.length > 1) return null;
  const prefix = names.filter((n) => norm(n).startsWith(want));
  return prefix.length === 1 ? prefix[0] : null;
}

/**
 * What a team writes on a work order: AM, TL and ATL as account names. A
 * name that does not resolve is reported in `unmatched` (key → the name on
 * file) and written nowhere.
 */
export function clientTeamValues(
  team: Pick<ClientTeam, 'am' | 'tl' | 'atl'> | null,
  names: readonly string[],
): { values: Record<string, string>; unmatched: Record<string, string> } {
  const values: Record<string, string> = {};
  const unmatched: Record<string, string> = {};
  if (!team) return { values, unmatched };
  for (const { key, from } of CLIENT_TEAM_FIELDS) {
    const raw = (team[from] ?? '').trim();
    if (raw === '') continue;
    const name = resolvePersonName(raw, names);
    if (name) values[key] = name;
    else if (norm(raw) !== norm(CLIENT_TEAM_HOUSE)) unmatched[key] = raw;
  }
  return { values, unmatched };
}
